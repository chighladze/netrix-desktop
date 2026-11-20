// Exercise the extracted production desktop on disposable create/reopen profiles.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { evaluate, invoke, until, views } from "./lib/webview-smoke.mjs";

const [phase, directory, version, fixture] = process.argv.slice(2);
assert.equal(process.platform, "win32");
assert.ok(["create", "reopen"].includes(phase) && /^[a-f0-9]{32}$/.test(fixture));
assert.ok(path.isAbsolute(directory) && (await stat(path.join(directory, "Netrix.portable"))).isFile());
const files = await readdir(path.join(directory, "Data"));
const create = phase === "create";
if (create) assert.deepEqual(files, [], "Create requires a new Portable extraction");
else assert.ok(files.includes("database.db") && files.includes(".database-key"), "Missing transferred workspace");

const password = createHash("sha256").update("Netrix disposable QA " + fixture).digest("hex");
const host = { name: "Portable QA " + fixture.slice(0, 8), hostname: "portable.example.invalid", port: 2227, username: "portable-qa", connection_type: "ssh" };
const itemName = "Portable vault " + fixture.slice(0, 8);
const socket = createServer().listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const child = spawn(path.join(directory, "Netrix.exe"), [], {
  cwd: process.cwd(), windowsHide: true, stdio: "ignore",
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
});
const stopped = once(child, "exit");
try {
  const main = await until("Portable main webview", async () => (await views(port)).find(p => !new URL(p.url).search), 150_000);
  console.log("Opened the Portable webview on " + path.parse(directory).root);
  const js = expression => evaluate(main, expression, 30_000);
  const present = selector => js(`!!document.querySelector(${JSON.stringify(selector)})`);
  const waitFor = selector => until(selector, () => present(selector), 150_000);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  })()`);
  // Only the fixture's own webview obtains its per-launch token via normal IPC.
  const api = (route, body) => js(`(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const response = await fetch("http://127.0.0.1:" + await invoke("get_backend_port") + ${JSON.stringify(route)}, {
      method: ${JSON.stringify(body === undefined ? "GET" : "POST")},
      headers: { "Content-Type": "application/json", "X-API-Token": await invoke("get_api_token") },
      body: ${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))}
    });
    return { status: response.status, data: await response.json() };
  })()`);
  await waitFor("#workspace-master-password");
  assert.equal(await js("window.__NETRIX_PORTABLE__"), true, "Main webview must use the Portable profile");
  assert.equal((await js(invoke("get_problem_report_diagnostics"))).app_version, version);
  assert.equal(await js(invoke("read_vault_password")), null);
  await assert.rejects(js(invoke("save_vault_password", { password: "disposable" })), /Portable/);
  assert.equal(await present("#workspace-confirm-password"), create, "Wrong workspace setup/open mode");
  const submit = '.workspace-lock-form button[type="submit"]';
  async function openWorkspace(value) {
    await change("#workspace-master-password", value);
    if (create) await change("#workspace-confirm-password", value);
    await until("Enabled password form", () => present(submit + ":enabled"));
    await click(submit);
  }
  if (!create) {
    await openWorkspace("incorrect-disposable-password");
    await waitFor("#app-unlock-error");
    assert.equal(await present("[data-workspace-ready=true]"), false);
  }
  await openWorkspace(password);
  await waitFor("[data-workspace-ready=true]");
  console.log("Opened the encrypted workspace");
  assert.equal((await api("/security/status")).data.database_encrypted, true);

  const unlocked = await api("/vault/unlock", { master_password: password });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.data.unlocked, true);
  if (create) {
    assert.equal((await api("/hosts", host)).status, 201);
    assert.equal((await api("/vault/items", { name: itemName, plaintext: "synthetic-" + fixture })).status, 201);
  }
  const hosts = await api("/hosts");
  assert.equal(hosts.status, 200);
  const saved = hosts.data.find(h => h.name === host.name);
  for (const [key, value] of Object.entries(host)) assert.equal(saved?.[key], value, "Saved host field " + key);
  assert.equal((await api("/vault/lock", {})).data.unlocked, false);
  assert.equal((await api("/vault/unlock", { master_password: "incorrect-disposable-password" })).status, 401);
  assert.equal((await api("/vault/status")).data.unlocked, false);
  const reopened = await api("/vault/unlock", { master_password: password });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.bootstrapped, false, "Must open the original Vault");
  assert.equal(reopened.data.unlocked, true);
  assert.ok((await api("/vault/items")).data.some(item => item.name === itemName));
  console.log("Verified the saved SSH host, password checks and Vault item");

  const guideClose = '[role="dialog"][aria-labelledby="help-center-title"] header button';
  if (await present(guideClose)) await click(guideClose);
  await click('button[title="Settings"]');
  const font = 'input[type="number"][min="10"][max="24"]';
  const family = 'select:has(option[value="Cascadia Code"])';
  // Settings can initially select Security after the explicit Vault lock test.
  // Navigate to Terminal as a user would before reading the font controls.
  await until("Terminal category in Settings", async () => {
    if (await present(font)) return true;
    await js(`[...document.querySelectorAll("nav button[aria-pressed]")].find(
      button => button.querySelector("span")?.textContent.trim() === "Terminal"
    )?.click()`);
    return false;
  }, 30_000);
  if (create) {
    await change(font, "19");
    await change(family, "Cascadia Code");
  }
  await until("Restored font size and family in Settings", () => js(`
    document.querySelector('${font}').value === "19" &&
    document.querySelector('${family}').value === "Cascadia Code" &&
    JSON.parse(localStorage.getItem("appSettings")).terminal.fontSize === 19`));

  await js(`(void ${invoke("quit_app")}, true)`).catch(() => {});
  const [code] = await Promise.race([stopped, new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Portable did not exit cleanly")), 35_000).unref())]);
  assert.equal(code, 0);
  console.log(`PASS ${phase}: encrypted workspace, SSH host, Settings 19 px / Cascadia Code, original Vault password, wrong-password rejection, existing Vault item and clean exit.`);
} catch (error) {
  console.log(`FAIL ${phase}: ${error.message}${error.cause ? " (" + error.cause.message + ")" : ""}`);
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await stopped;
  }
}
