// Real HTTP + SQLite restart check. Never uses the user's Netrix data directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(import.meta.dirname, "..");
const binary = process.env.NETRIX_SMOKE_BACKEND || path.join(root, "backend-rs", "target", "debug", process.platform === "win32" ? "netrix_backend.exe" : "netrix_backend");
const directory = await mkdtemp(path.join(os.tmpdir(), "netrix-appearance-smoke-"));
const token = randomBytes(32).toString("hex");
const password = randomBytes(32).toString("base64url");
let backend;
let backendClosed;
let origin;

async function start() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, NETRIX_DATA_DIR: directory };
  delete env.NETRIX_DEV;
  backend = spawn(binary, [String(port), String(process.pid)], { cwd: root, env, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  backendClosed = new Promise(resolve => backend.once("close", resolve));
  let failure;
  backend.on("error", error => { failure = error; });
  backend.stderr.resume();
  backend.stdin.on("error", () => {});
  backend.stdin.end(`${token}\n`);
  origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    if (backend.exitCode !== null) throw new Error(`Backend exited: ${backend.exitCode}`);
    try {
      const response = await fetch(`${origin}/health`, { headers: { "X-API-Token": token, Connection: "close" }, signal: AbortSignal.timeout(500) });
      await response.text();
      if (response.ok) break;
    } catch { /* Wait for the isolated backend to bind. */ }
    await delay(100);
    if (attempt === 99) throw new Error("Backend did not become ready");
  }
  // Health is available while encrypted storage is locked. A fresh profile and
  // every restart require the same explicit password before any database CRUD.
  await api("GET", "/hosts", undefined, 423);
  await api("POST", "/security/unlock", { master_password: password });
  await api("GET", "/hosts");
}

async function stop() {
  if (!backend) return;
  if (backend.pid && backend.exitCode === null) backend.kill();
  let timer;
  try {
    await Promise.race([backendClosed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Backend did not close within 10 seconds")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
  backend = undefined;
}

async function api(method, route, body, expected = 200) {
  const response = await fetch(`${origin}${route}`, {
    method, headers: { "X-API-Token": token, "Content-Type": "application/json", Connection: "close" },
    ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route}: ${text}`);
  return text ? JSON.parse(text) : null;
}

try {
  await start();
  const keys = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite", "cursor", "selectionBackground"];
  const appearance = {
    font_family: "Consolas", font_weight: 500, font_weight_bold: 800,
    line_height: 1.4, letter_spacing: 0, cursor_style: "underline", cursor_blink: false, bold_bright: false,
    colors: Object.fromEntries(keys.map((key, i) => [key, `#${(0x223344 + i * 0x030303).toString(16)}`])),
  };
  const profile = { name: "Appearance smoke", hostname: "example.test", terminal_theme: "nord",
    terminal_font_size: 18, terminal_background: "#010203", terminal_foreground: "#fefdfc", terminal_appearance: appearance };
  const created = await api("POST", "/hosts", profile, 201);
  const route = `/hosts/${created.id}`;
  const verify = host => {
    for (const key of Object.keys(profile)) assert.deepEqual(host[key], profile[key], key);
    for (const key of ["password", "private_key", "passphrase"]) assert.equal(key in host, false);
  };
  verify(created);
  verify(await api("GET", route));
  verify((await api("GET", "/hosts"))[0]);
  await api("POST", `/recent-connections/${created.id}`);
  const recent = (await api("GET", "/recent-connections"))[0].host;
  assert.deepEqual(recent.terminal_appearance, appearance);
  console.log("PASS: create/read/list/recent preserve every appearance field and all 18 colors");
  for (const invalid of [{ line_height: 0 }, { letter_spacing: 6 }, { font_weight: 450 }, { font_family: "bad\u0085font" }, { colors: { green: "red" } }]) {
    await api("PATCH", route, { revision: created.revision, terminal_appearance: invalid }, 400);
  }
  // Serde rejects wrong types and unknown properties before entering the handler.
  for (const invalid of [{ cursor_blink: "false" }, { command: "never-run" }]) {
    const response = await fetch(`${origin}${route}`, { method: "PATCH", headers: { "X-API-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ revision: created.revision, terminal_appearance: invalid }) });
    assert.equal(response.status, 422);
    await response.text();
  }
  assert.equal((await api("GET", route)).revision, created.revision);
  await stop();
  await start();
  verify(await api("GET", route));
  console.log("PASS: real backend restart restores the saved SQLite appearance; invalid writes changed nothing");
  const changed = await api("PATCH", route, { revision: created.revision, name: "Renamed" });
  assert.deepEqual(changed.terminal_appearance, appearance);
  const replaced = await api("PATCH", route, { revision: changed.revision, terminal_appearance: { cursor_blink: true, letter_spacing: -1 } });
  assert.deepEqual(replaced.terminal_appearance, { cursor_blink: true, letter_spacing: -1 });
  const reset = await api("PATCH", route, { revision: replaced.revision, terminal_appearance: null, terminal_background: null, terminal_foreground: null });
  await stop();
  await start();
  const loaded = await api("GET", route);
  for (const key of ["terminal_appearance", "terminal_background", "terminal_foreground"]) assert.equal(loaded[key], null);
  assert.equal(loaded.revision, reset.revision);
  assert.equal(loaded.terminal_theme, "nord");
  console.log("PASS: partial edit, whole appearance replacement and reset survive restart");
} finally {
  await stop();
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith("netrix-appearance-smoke-"));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
