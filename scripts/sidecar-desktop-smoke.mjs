// Real Windows WebView2/sidecar lifecycle checks, restricted to a verified E2E build.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { removeProfile, verifyBuild } from "./lib/desktop-profile.mjs";

assert.equal(process.platform, "win32");
const project = path.resolve(import.meta.dirname, "..");
const root = path.resolve(process.env.NETRIX_E2E_BUILD_ROOT || path.join(project, "backend-rs/target/desktop-e2e"));
const manifest = JSON.parse(await readFile(path.join(root, "build.json"), "utf8"));
const binary = await verifyBuild(manifest);
const installed = process.argv.includes("--installed");
if (installed) assert.equal(path.dirname(binary), path.dirname(manifest.backend), "Installed payload must use its sibling sidecar");
const powershell = async (code, env = process.env) => (await promisify(execFile)("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { env, windowsHide: true, timeout: 10_000 })).stdout.trim();
const profileParents = JSON.parse(await powershell("@([Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData')) | ConvertTo-Json -Compress"));
const profile = path.join(profileParents[0], manifest.identifier);
const logFile = path.join(profile, "tauri_main.log");
const temporary = await mkdtemp(path.join(os.tmpdir(), "netrix-lifecycle-"));
const launched = [];

async function until(description, check, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let failure;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { failure = error; }
    await delay(100);
  }
  throw new Error(`${description} timed out`, { cause: failure });
}

async function views(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(500) });
  return (await response.json()).filter(page => page.type === "page" && /^https?:\/\/tauri\.localhost\//.test(page.url));
}

async function evaluate(view, expression, timeoutMs = 8000) {
  const socket = new WebSocket(view.webSocketDebuggerUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await once(socket, "open", { signal });
    const message = once(socket, "message", { signal });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const response = JSON.parse((await message)[0].data);
    if (response.error || response.result.exceptionDetails) {
      const exception = response.result?.exceptionDetails?.exception;
      throw new Error(response.error?.message || exception?.description || exception?.value || "Isolated webview evaluation failed");
    }
    return response.result.result.value;
  } finally { socket.close(); }
}

function invoke(command, args) {
  return `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args || {})})`;
}

async function start(backendPath = manifest.backend) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const debugPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = {
    ...process.env,
    NETRIX_E2E_IDENTIFIER: manifest.identifier,
    NETRIX_E2E_BACKEND: backendPath,
    WEBVIEW2_USER_DATA_FOLDER: path.join(temporary, randomUUID()),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
  };
  delete env.NETRIX_DEV;
  const child = spawn(binary, [], { cwd: root, env, stdio: "ignore", windowsHide: true });
  await once(child, "spawn");
  const stopped = once(child, "exit");
  const run = { child, stopped, debugPort };
  launched.push(run);
  run.main = await until("Isolated main webview", async () => (await views(debugPort)).find(page => !new URL(page.url).search));
  return run;
}

async function sidecarPid(parent) {
  const rawPid = await powershell(`
    $owner = [int] $env:NETRIX_FIXTURE_PARENT
    $process = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $owner AND Name = 'netrix_backend.exe'")
    if ($process.Count -ne 1 -or $process[0].ExecutablePath -ne $env:NETRIX_FIXTURE_BACKEND) { throw 'Expected one verified child of the test shell' }
    $process[0].ProcessId
  `, { ...process.env, NETRIX_FIXTURE_PARENT: String(parent.pid), NETRIX_FIXTURE_BACKEND: manifest.backend });
  const pid = Number(rawPid);
  assert.ok(Number.isInteger(pid) && pid > 0);
  return pid;
}

async function backend(run) {
  const status = await until("Shell startup result", async () => {
    const status = await evaluate(run.main, invoke("get_backend_status"));
    return status.status === "starting" ? null : status;
  }, 25_000);
  assert.equal(status.status, "ready", status.message);
  const port = await evaluate(run.main, invoke("get_backend_port"));
  return { pid: await sidecarPid(run.child), port };
}

function exists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function assertReleased({ pid, port }) {
  await until("Sidecar process release", () => !exists(pid));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }));
}

async function testPipeFallback() {
  // A test parent keeps stdin open without assigning the backend to its Job.
  const code = `
    const { spawn } = require('node:child_process');
    const { randomUUID } = require('node:crypto');
    const sidecar = spawn(process.env.NETRIX_FIXTURE_BACKEND, ['--managed'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    });
    sidecar.stdout.pipe(process.stdout);
    sidecar.stdin.write(randomUUID() + '\\n');
  `;
  const env = { ...process.env, NETRIX_FIXTURE_BACKEND: manifest.backend, NETRIX_DATA_DIR: path.join(temporary, "pipe-fallback") };
  delete env.NETRIX_DEV;
  const child = spawn(process.execPath, ["-e", code], { env, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const stopped = once(child, "exit");
  launched.push({ child, stopped });
  const lines = createInterface({ input: child.stdout });
  const [frame] = await once(lines, "line", { signal: AbortSignal.timeout(15000) });
  lines.close();
  const port = Number(/^NETRIX_LISTENING:(\d+)$/.exec(frame)?.[1]);
  assert.ok(port > 0);
  const pid = await sidecarPid(child);
  assert.ok(child.kill("SIGKILL"));
  await stopped;
  await assertReleased({ pid, port });
  console.log("PASS: abrupt loss of a parent without a Netrix Job Object closes the backend via stdin EOF");
}

async function cleanExit(run, prompt = true) {
  let close;
  if (prompt) {
    await until("Lock screen ready", () => evaluate(run.main, `!!document.querySelector('[data-netrix-lock-screen]')`));
    await evaluate(run.main, invoke("plugin:window|close", { label: "main" }));
    await until("Exit confirmation", () => evaluate(run.main, `!![...document.querySelectorAll('button')].find(button => button.textContent === 'Exit Netrix')`));
    close = evaluate(run.main, `[...document.querySelectorAll('button')].find(button => button.textContent === 'Exit Netrix').click()`);
  } else {
    // The renderer can send two commands before the shell has finished draining.
    close = evaluate(run.main, `(void Promise.allSettled([${invoke("quit_app")}, ${invoke("quit_app")}]), true)`);
  }
  // Netrix can destroy the webview before CDP gets the reply to the click.
  await Promise.race([close.catch(() => undefined), run.stopped]);
  await until("Shell exit", () => run.child.exitCode !== null);
  assert.equal((await run.stopped)[0], 0);
}

const password = randomUUID();
async function unlock(run) {
  const result = await evaluate(run.main, `(async () => {
    const port = await ${invoke("get_backend_port")};
    const token = await ${invoke("get_api_token")};
    const response = await fetch('http://127.0.0.1:' + port + '/security/unlock', {
      method: 'POST', headers: { 'X-API-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ master_password: ${JSON.stringify(password)} })
    });
    return response.status;
  })()`, 30_000).catch(error => { throw new Error("Isolated workspace unlock stalled", { cause: error }); });
  assert.equal(result, 200, "A new backend must open the same isolated workspace");
  await until("Unlocked workspace", () => evaluate(run.main, `!document.body.hasAttribute('data-app-locked')`));
}

async function auxiliaryWindows(run) {
  const label = "detached-terminal-" + randomUUID();
  const mapLabel = "map-lifecycle";
  await evaluate(run.main, invoke("open_terminal_window", {
    targetLabel: label, handoffId: randomUUID(), originTabId: "test", title: "Lifecycle test", workspace: true,
  }));
  await evaluate(run.main, invoke("plugin:webview|create_webview_window", {
    options: { label: mapLabel, url: "/?detachedMap=true&mapId=lifecycle&mapName=Lifecycle", decorations: false },
  }));
  for (const { query, close, args } of [
    { query: "detached=true", close: "close_terminal_window" },
    { query: "detachedMap=true", close: "plugin:window|close", args: { label: mapLabel } },
  ]) {
    const page = await until(`Detached webview ${query}`, async () => (await views(run.debugPort)).find(page => page.url.includes(query)));
    await assert.rejects(evaluate(page, invoke("quit_app")), /quit_app.*not allowed|Only the main window/i);
    // Window destruction can interrupt delivery of the IPC response.
    await evaluate(page, `(void ${invoke(close, args)}, true)`).catch(() => undefined);
    await until(`Detached webview closed ${query}`, async () => !(await views(run.debugPort)).some(view => view.id === page.id));
    assert.equal((await evaluate(run.main, invoke("get_backend_status"))).status, "ready");
  }
}

try {
  const locked = await start();
  const lockedBackend = await backend(locked);
  await cleanExit(locked);
  await assertReleased(lockedBackend);
  assert.match(await readFile(logFile, "utf8"), /Backend exited normally after shutdown request/);
  console.log("PASS: normal exit before unlocking, real sidecar and port released");

  const active = await start();
  const activeBackend = await backend(active);
  await unlock(active);
  await auxiliaryWindows(active);
  console.log("PASS: a detached terminal and map close themselves and cannot invoke quit_app");
  assert.ok(active.child.kill("SIGKILL"));
  await active.stopped;
  const restarted = await start();
  const restartedBackend = await backend(restarted);
  if (restartedBackend.port === activeBackend.port) {
    await until("Previous sidecar process released", () => !exists(activeBackend.pid));
  } else {
    await assertReleased(activeBackend);
  }
  const jobFailed = (await readFile(logFile, "utf8")).includes("Backend Job Object setup failed");
  console.log(jobFailed ? "Parent-crash case used the pipe fallback." : "Parent-crash case used the Windows Job Object.");

  await unlock(restarted);
  await cleanExit(restarted, false);
  await assertReleased(restartedBackend);
  console.log("PASS: forced shell exit, port/workspace released, immediate restart and duplicate quit");

  const failed = await start();
  const failedBackend = await backend(failed);
  await unlock(failed);
  process.kill(failedBackend.pid, "SIGKILL");
  await until("Fail-closed workspace", () => evaluate(failed.main, `document.body.hasAttribute('data-app-locked') && document.body.innerText.includes('Netrix service unavailable')`));
  await cleanExit(failed);
  await assertReleased(failedBackend);
  console.log("PASS: loss of a running backend locks the UI, main close still works");

  if (!installed) {
    const missing = await start(path.join(temporary, "missing-sidecar.exe"));
    await until("Startup failure", async () => (await evaluate(missing.main, invoke("get_backend_status"))).status === "failed");
    await cleanExit(missing);
    console.log("PASS: shell exits after a sidecar launch error");
  }
  await testPipeFallback();
} finally {
  for (const { child, stopped } of launched) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await stopped;
  }
  for (const parent of profileParents) await removeProfile(path.join(parent, manifest.identifier), parent, manifest.identifier);
  // Each WebView directory is isolated under a generated temp root.
  assert.equal(path.dirname(temporary), os.tmpdir());
  assert.ok(path.basename(temporary).startsWith("netrix-lifecycle-"));
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
