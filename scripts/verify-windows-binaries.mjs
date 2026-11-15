import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoRedistributable, parseDependencies } from './lib/windows-binaries.mjs';

if (process.platform !== 'win32') throw new Error('Windows binary inspection requires Windows.');
const root = path.resolve(import.meta.dirname, '..');
const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
const dumpbin = execFileSync(vswhere, ['-latest', '-products', '*',
  '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
  '-find', 'VC/Tools/MSVC/**/bin/Hostx64/x64/dumpbin.exe'], {
  encoding: 'utf8', windowsHide: true,
}).trim().split(/\r?\n/).filter(Boolean).sort().at(-1);
if (!dumpbin) throw new Error('Microsoft dumpbin was not found.');
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const binaries = ['src-tauri/target/release/netrix.exe', 'src-tauri/target/release/netrix_backend.exe'];
const inspected = binaries.map(relative => {
  const file = path.join(root, relative);
  const output = execFileSync(dumpbin, ['/nologo', '/dependents', file], { encoding: 'utf8', windowsHide: true });
  const dependencies = parseDependencies(output);
  assertNoRedistributable(dependencies, relative);
  return { path: relative, sha256: sha256(file), dependencies };
});
const builtBackend = path.join(root, 'backend-rs/target/x86_64-pc-windows-msvc/release/netrix_backend.exe');
const stagedBackend = path.join(root, 'src-tauri/binaries/netrix_backend-x86_64-pc-windows-msvc.exe');
if ([builtBackend, stagedBackend].some(file => sha256(file) !== inspected[1].sha256)) {
  throw new Error('Bundled backend does not match the statically built and staged sidecar.');
}
const storage = JSON.parse(execFileSync(path.join(root, binaries[1]), ['--storage-build-info'], {
  encoding: 'utf8', timeout: 15000, windowsHide: true,
}));
const { binary_sha256, ...runtime } = storage;
assert.equal(binary_sha256, inspected[1].sha256, 'Storage probe must run the bundled backend');
const policy = JSON.parse(readFileSync(path.join(root, 'scripts/backend-audit-policy.json'), 'utf8'));
assert.deepEqual(runtime, policy.runtime, 'Static backend must retain the reviewed SQLCipher runtime');

// This exact release EXE must handle the probe without starting Tauri/backend.
// It touches no Netrix profile; a provisioned runner is only the healthy baseline.
const probe = spawnSync(path.join(root, binaries[0]), ['--check-webview2'], {
  encoding: 'utf8', timeout: 15000, windowsHide: true,
});
if (probe.error || probe.status !== 0 || !probe.stdout.includes('WebView2 loader version:')) {
  throw new Error(`Release WebView2 probe failed: ${probe.error || probe.status}; ${probe.stdout}${probe.stderr}`);
}
// A child-only documented loader override exercises failed discovery without
// uninstalling a runtime, changing registry values or touching an app profile.
const emptyRuntime = mkdtempSync(path.join(os.tmpdir(), 'netrix-webview-probe-'));
let missingRuntimeProbe;
try {
  const missing = spawnSync(path.join(root, binaries[0]), ['--check-webview2'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: emptyRuntime },
  });
  if (missing.error || missing.status !== 10 || !missing.stderr.includes('WebView2 loader failed:')) {
    throw new Error(`Missing-runtime probe failed: ${missing.error || missing.status}; ${missing.stdout}${missing.stderr}`);
  }
  missingRuntimeProbe = { exitCode: missing.status, output: missing.stderr.trim(),
    baseline: 'child environment points to an empty directory; installed runtimes unchanged' };
} finally {
  // The probe must leave this directory empty; never recursively remove it.
  rmdirSync(emptyRuntime);
}
const report = { schemaVersion: 1, inspectedAt: new Date().toISOString(), tool: dumpbin,
  binaries: inspected, storageProbe: storage,
  webview2Probe: { exitCode: probe.status, output: probe.stdout.trim() },
  missingRuntimeProbe,
  cleanMachineRuntimeQa: 'pending; hosted runner has prerequisites installed' };
mkdirSync(path.join(root, 'tmp'), { recursive: true });
writeFileSync(path.join(root, 'tmp/windows-binary-dependencies.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('Verified packaged EXE imports, sidecar hashes, SQLCipher and the read-only WebView2 probe.');
