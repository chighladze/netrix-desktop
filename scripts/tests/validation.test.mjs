import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyFinding, validateSqlcipherEvidence } from "../lib/backend-audit.mjs";
import { assertE2eIdentifier, fileHash, removeProfile, verifyBuild } from "../lib/desktop-profile.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const policy = JSON.parse(await readFile(path.join(root, "scripts/backend-audit-policy.json"), "utf8"));
const sqlite = { advisory: { id: "RUSTSEC-2026-0459" }, package: { name: "libsqlite3-sys", version: "0.30.1" } };
test("audit accepts only the reviewed patched SQLCipher source and linked runtime", () => {
  assert.match(classifyFinding(sqlite, true, policy, policy), /verified patched/);
  for (const alter of [
    evidence => { evidence.runtime.sqlite_version = "3.53.4"; },
    evidence => { evidence.runtime.cipher_version = ""; },
    evidence => { evidence.runtime.sqlite_source_id = "unreviewed"; },
    evidence => { evidence.source.checksum = "unreviewed"; },
    evidence => { evidence.adapter_path = "registry/libsqlite3-sys"; },
    evidence => { evidence.adapter_hashes["build.rs"] = "unreviewed"; },
  ]) {
    const evidence = structuredClone(policy); alter(evidence);
    assert.throws(() => classifyFinding(sqlite, true, evidence, policy));
  }
  const vulnerable = structuredClone(policy); vulnerable.runtime.sqlite_version = "3.53.4";
  assert.throws(() => validateSqlcipherEvidence(vulnerable, vulnerable), /vulnerable/);
});
test("audit rejects an active RSA advisory and unknown active findings", () => {
  for (const id of ["RUSTSEC-2023-0071", "RUSTSEC-2099-0001"]) {
    const finding = { advisory: { id }, package: { name: "rsa", version: "0.10.0-rc.18" } };
    assert.throws(() => classifyFinding(finding, true, policy, policy), /Active vulnerability/);
    assert.match(classifyFinding(finding, false, policy, policy), /inactive/);
  }
});
test("desktop preflight rejects production, substituted and changed binaries before launch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "netrix-e2e-preflight-"));
  try {
    const identifier = "com.netrix.e2e.0123456789abcdef0123456789abcdef";
    const binary = path.join(directory, "test.exe");
    const backend = path.join(directory, "backend.exe");
    await writeFile(binary, identifier); await writeFile(backend, "isolated sidecar");
    const manifest = { version: 1, identifier, binary, backend,
      binary_sha256: await fileHash(binary), backend_sha256: await fileHash(backend) };
    assert.equal(await verifyBuild(manifest), binary);
    await assert.rejects(verifyBuild({ ...manifest, identifier: "com.netrix.app" }));
    await assert.rejects(verifyBuild(manifest, path.join(directory, "production.exe")));
    await writeFile(binary, "ordinary production executable");
    await assert.rejects(verifyBuild(manifest));
    await assert.rejects(verifyBuild({ ...manifest, binary_sha256: await fileHash(binary) }));
    await assert.rejects(removeProfile(directory, directory, identifier));
    assert.throws(() => assertE2eIdentifier("com.netrix.e2e.../com.netrix.app"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("native regression suite is required by CI and release gates", async () => {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:tauri"], /cargo test .*--manifest-path src-tauri\/Cargo.toml/);
  assert.match(pkg.scripts["release:check"], /&& npm run test:tauri &&/);
  const ci = await readFile(path.join(root, ".github/workflows/windows.yml"), "utf8");
  const windowsJob = ci.split("  windows:")[1];
  assert.match(windowsJob, /runs-on: windows-latest/);
  assert.match(windowsJob, /run: npm run test:tauri/);
});

test("Windows CI and the release gate prepare the debug sidecar before Tauri checks", async () => {
  const [manifest, ci] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, ".github/workflows/windows.yml"), "utf8"),
  ]);
  const { scripts } = JSON.parse(manifest);
  const windowsJob = ci.split(/^  windows:\r?$/m)[1]?.split(/^  [\w-]+:\r?$/m)[0];
  assert.ok(windowsJob, "Windows Tauri job is missing");
  const ciCommands = Array.from(windowsJob.matchAll(/^ +run: (.+)$/gm), ([, command]) => command.trim());

  for (const [gate, commands] of [
    ["Windows CI", ciCommands],
    ["release:check", scripts["release:check"].split(/\s*&&\s*/)],
  ]) {
    const prepare = commands.indexOf("npm run build:sidecar:debug");
    assert.ok(prepare >= 0, `${gate} must build and stage the debug sidecar`);
    for (const check of ["check:tauri", "test:tauri"]) {
      assert.ok(commands.indexOf(`npm run ${check}`) > prepare, `${gate} must prepare the sidecar before ${check}`);
    }
  }

  assert.deepEqual(scripts["build:sidecar:debug"]?.split(/\s*&&\s*/), [
    "cargo build --locked --manifest-path backend-rs/Cargo.toml",
    "npm run prepare:sidecar:debug",
  ]);
  assert.equal(scripts["prepare:sidecar:debug"], "node scripts/prepare-sidecar.mjs debug");
  assert.match(ci, /if: github.event_name == 'workflow_dispatch' && inputs.build_installer/);
  for (const command of ["build", "test:installer", "check:windows:binaries", "hash:installers"]) {
    assert.ok(ci.split(/\r?\n/).some(line => line.trim() === `npm run ${command}`),
      `Manual installer workflow must run ${command}`);
  }
});

test("Node support stays aligned across packages, lockfiles and the minimum-version CI gate", async () => {
  for (const directory of ["", "frontend"]) {
    const pkg = JSON.parse(await readFile(path.join(root, directory, "package.json"), "utf8"));
    const lock = JSON.parse(await readFile(path.join(root, directory, "package-lock.json"), "utf8"));
    assert.equal(pkg.engines.node, "^24.0.0");
    assert.deepEqual(lock.packages[""].engines, pkg.engines);
  }
  assert.equal((await readFile(path.join(root, ".nvmrc"), "utf8")).trim(), "24");
  const ci = await readFile(path.join(root, ".github/workflows/windows.yml"), "utf8");
  const frontendJob = ci.split("  frontend:")[1].split("  windows:")[0];
  assert.match(frontendJob, /node: \["24\.0\.0", "24"\]/);
  assert.match(frontendJob, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(frontendJob, /npm ci --engine-strict --prefix frontend/);
  const release = ci.split("  windows:")[1];
  assert.match(release, /node-version: 24/);
  assert.match(release, /run: npm ci --engine-strict\r?\n/);
  assert.match(release, /run: npm ci --engine-strict --prefix frontend/);
});
