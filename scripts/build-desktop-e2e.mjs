import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileHash } from "./lib/desktop-profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const buildRoot = path.resolve(process.env.NETRIX_E2E_BUILD_ROOT || path.join(root, "backend-rs/target/desktop-e2e"));
const backendTarget = path.resolve(process.env.NETRIX_E2E_BACKEND_TARGET || path.join(buildRoot, "backend"));
const shellTarget = path.resolve(process.env.NETRIX_E2E_SHELL_TARGET || path.join(buildRoot, "shell"));
const identifier = `com.netrix.e2e.${randomUUID().replaceAll("-", "")}`;
await mkdir(buildRoot, { recursive: true });

async function run(command, args, extra = {}) {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: "inherit", ...extra });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, `${command} failed`);
}

// Run through npm's JS entry point: no command-string interpolation on Windows.
assert.ok(process.env.npm_execpath, "Use npm run test:e2e:desktop:build");
await run(process.execPath, [process.env.npm_execpath, "run", "build", "--prefix", "frontend"]);
await run("cargo", ["build", "--locked", "--manifest-path", "backend-rs/Cargo.toml", "--target-dir", backendTarget]);
const config = path.join(buildRoot, "tauri.e2e.json");
await writeFile(config, JSON.stringify({ identifier, build: { beforeBuildCommand: "" }, bundle: { externalBin: [] } }));
await run(process.execPath, [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--debug", "--no-bundle", "--config", config], {
  env: { ...process.env, CARGO_TARGET_DIR: shellTarget },
});
const extension = process.platform === "win32" ? ".exe" : "";
const binary = path.join(shellTarget, "debug", `netrix${extension}`);
const backend = path.join(backendTarget, "debug", `netrix_backend${extension}`);
const manifest = { version: 1, identifier, binary, backend, binary_sha256: await fileHash(binary), backend_sha256: await fileHash(backend) };
await writeFile(path.join(buildRoot, "build.json"), JSON.stringify(manifest, null, 2));
console.log(`Verified E2E build: ${identifier}`);
const testScript = process.argv.includes("--lifecycle") ? "sidecar-desktop-smoke.mjs" : "desktop-e2e.mjs";
await run(process.execPath, [path.join(root, "scripts", testScript)], { env: { ...process.env, NETRIX_E2E_BUILD_ROOT: buildRoot } });
