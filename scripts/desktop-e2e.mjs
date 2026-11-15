import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { identitySnapshot, removeProfile, verifyBuild } from "./lib/desktop-profile.mjs";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const reservations = [createServer(), createServer()];
for (const server of reservations) await new Promise((resolve, reject) => {
  server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
});
const [driverPort, nativePort] = reservations.map(server => server.address().port);
await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
const DRIVER_ORIGIN = `http://127.0.0.1:${driverPort}`;
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const projectRoot = path.resolve(import.meta.dirname, "..");
const buildRoot = path.resolve(process.env.NETRIX_E2E_BUILD_ROOT || path.join(projectRoot, "backend-rs/target/desktop-e2e"));
const manifest = JSON.parse(await readFile(path.join(buildRoot, "build.json"), "utf8"));
// All checks precede driver creation and application launch.
const binary = await verifyBuild(manifest, process.env.NETRIX_E2E_BINARY);
const parents = process.platform === "win32"
  ? JSON.parse((await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", "@([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData')) | ConvertTo-Json -Compress"], { windowsHide: true })).stdout)
  : [process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")];
const productionDirectories = parents.flatMap(parent => [path.join(parent, "com.netrix.app"), path.join(parent, "Netrix")]);
const productionBefore = await identitySnapshot(productionDirectories);
for (const parent of parents) await removeProfile(path.join(parent, manifest.identifier), parent, manifest.identifier);

const defaultDriver = path.join(
  os.homedir(),
  ".cargo",
  "bin",
  process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver",
);
const driverCommand = process.env.NETRIX_TAURI_DRIVER
  || (existsSync(defaultDriver) ? defaultDriver : "tauri-driver");
const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), "netrix-desktop-e2e-"));


let sessionId;
let stopping = false;
const driverLogs = [];
const driverEnv = { ...process.env, NETRIX_E2E_IDENTIFIER: manifest.identifier, NETRIX_E2E_BACKEND: manifest.backend,
  WEBVIEW2_USER_DATA_FOLDER: path.join(isolatedRoot, "webview") };
delete driverEnv.NETRIX_DEV;
delete driverEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
const driver = spawn(driverCommand, ["--port", String(driverPort), "--native-port", String(nativePort)], {
  cwd: projectRoot, env: driverEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
const driverClosed = new Promise(resolve => driver.once("close", resolve));

for (const stream of [driver.stdout, driver.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const text = String(chunk);
    driverLogs.push(text);
    process.stdout.write(text);
  });
}

driver.on("error", (error) => {
  if (!stopping) {
    console.error(`Unable to start ${driverCommand}:`, error.message);
  }
});

driver.on("exit", (code) => {
  if (!stopping && code !== null) {
    console.error(`tauri-driver exited unexpectedly with code ${code}`);
  }
});

async function webdriver(method, endpoint, body) {
  const response = await fetch(`${DRIVER_ORIGIN}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.value?.error) {
    const detail = payload?.value?.message || payload?.value?.error || response.statusText;
    throw new Error(`WebDriver ${method} ${endpoint} failed: ${detail}`);
  }
  return payload.value;
}

async function waitForDriver(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (driver.exitCode !== null) throw new Error(`tauri-driver exited: ${driver.exitCode}`);
    try {
      await webdriver("GET", "/status");
      return;
    } catch {
      await delay(200);
    }
  }
  throw new Error(`tauri-driver did not become ready.\n${driverLogs.slice(-20).join("")}`);
}

async function bodyText() {
  const element = await webdriver("POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: "body",
  });
  const elementId = element?.[ELEMENT_KEY];
  assert.ok(elementId, "WebDriver did not return a W3C element id for <body>");
  return webdriver("GET", `/session/${sessionId}/element/${elementId}/text`);
}

async function waitForApplication(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    try {
      lastText = String(await bodyText());
      if (lastText.includes("Backend failed to start")) {
        throw new Error(`Netrix reported a backend startup failure:\n${lastText}`);
      }
      if (lastText.includes("Netrix") && /(Protect your workspace|Encrypt your workspace|Open your workspace|Local Workspace)/.test(lastText)) {
        return lastText;
      }
    } catch (error) {
      if (String(error).includes("backend startup failure")) throw error;
    }
    await delay(250);
  }
  throw new Error(`Netrix main shell did not become ready. Last body text:\n${lastText}`);
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  if (sessionId) {
    await webdriver("DELETE", `/session/${sessionId}`).catch(() => undefined);
  }
  if (driver.exitCode === null && driver.pid) driver.kill();
  let timer;
  try {
    await Promise.race([driverClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Driver did not close")), 10_000); })]);
  } finally { clearTimeout(timer); }
  assert.equal(path.dirname(isolatedRoot), os.tmpdir());
  assert.ok(path.basename(isolatedRoot).startsWith("netrix-desktop-e2e-"));
  await rm(isolatedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  for (const parent of parents) await removeProfile(path.join(parent, manifest.identifier), parent, manifest.identifier);
  assert.deepEqual(await identitySnapshot(productionDirectories), productionBefore, "Production/legacy identities changed during E2E");
  console.log("PASS: production and legacy identity canaries unchanged; isolated profiles removed");
}

const shutdownSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
if (process.platform === "win32") shutdownSignals.push("SIGBREAK");
for (const signal of shutdownSignals) {
  process.once(signal, () => {
    process.exitCode = 1;
    void cleanup();
  });
}

try {
  await waitForDriver();
  const session = await webdriver("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "wry",
        "tauri:options": { application: binary },
      },
      firstMatch: [{}],
    },
  });
  sessionId = session?.sessionId;
  assert.ok(sessionId, "WebDriver did not return a session id");

  let text = await waitForApplication();
  assert.ok(text.includes("Protect your workspace"), "Refusing to enter a test password into an existing workspace");
  if (text.includes("Protect your workspace")) {
    const inputs = await webdriver("POST", `/session/${sessionId}/elements`, {
      using: "css selector", value: "[data-netrix-lock-screen] input[type=password]",
    });
    assert.equal(inputs.length, 2, "Fresh encrypted storage requires password confirmation");
    for (const input of inputs) {
      await webdriver("POST", `/session/${sessionId}/element/${input[ELEMENT_KEY]}/value`, { text: "isolated-desktop-workspace-password" });
    }
    const button = await webdriver("POST", `/session/${sessionId}/element`, {
      using: "css selector", value: "[data-netrix-lock-screen] button[type=submit]",
    });
    await webdriver("POST", `/session/${sessionId}/element/${button[ELEMENT_KEY]}/click`, {});
    const deadline = Date.now() + 90_000;
    do {
      await delay(250);
      text = String(await bodyText());
    } while (!text.includes("Local Workspace") && Date.now() < deadline);
  }
  assert.match(text, /Netrix/);
  assert.match(text, /(Hosts|Terminal|Vault)/);
  assert.match(text, /Local Workspace/);
  console.log("Desktop E2E smoke passed: encrypted startup reached the Netrix shell after password confirmation.");
} finally {
  await cleanup();
}
