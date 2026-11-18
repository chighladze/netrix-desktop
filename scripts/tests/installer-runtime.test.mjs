import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Compile the production hook with harmless probe/installer stand-ins. Neither
// the real Microsoft installer nor the Netrix application is executed here.
test('NSIS runtime hook repairs missing discovery and fails closed', { skip: process.platform !== 'win32' }, () => {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = mkdtempSync(path.join(temporaryRoot, 'netrix-runtime-hook-'));
  const run = (file, args, extra = {}) => {
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, ...extra });
    assert.ifError(result.error);
    return result;
  };
  try {
    const fixture = path.join(directory, 'fixture.rs');
    writeFileSync(fixture, `
#![windows_subsystem = "windows"]
use std::{env, fs, path::PathBuf, process};
fn main() {
    let root = PathBuf::from(env::var("NETRIX_NSIS_FIXTURE_DIR").unwrap());
    let mode = env::var("NETRIX_NSIS_FIXTURE_MODE").unwrap();
    if env::args().nth(1).as_deref() == Some("--check-webview2") {
        let mut count = fs::read_to_string(root.join("probes")).unwrap_or_default();
        count.push('x'); fs::write(root.join("probes"), count).unwrap();
        if mode == "probe-fails" { process::exit(42); }
        if mode == "probe-timeout" { std::thread::sleep(std::time::Duration::from_secs(30)); }
        if mode == "repaired-probe-fails" && root.join("repaired").exists() { process::exit(42); }
        if mode == "available" || (root.join("repaired").exists() && mode != "still-missing") {
            println!("WebView2 loader version: 143.0.1.2"); return;
        }
        process::exit(10);
    }
    assert_eq!(env::args().skip(1).collect::<Vec<_>>(), ["/silent", "/install"]);
    fs::write(root.join("installer-called"), "yes").unwrap();
    if mode == "repair-fails" { process::exit(5); }
    fs::write(root.join("repaired"), "yes").unwrap();
}
`);
    const executable = path.join(directory, 'fixture.exe');
    const compiled = run('rustc', [fixture, '-C', 'target-feature=+crt-static', '-o', executable]);
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const hook = path.resolve(import.meta.dirname, '../../src-tauri/windows/runtime-hooks.nsh');
    const pack = (name, probe) => {
      const setup = path.join(directory, `${name}.exe`);
      const script = path.join(directory, `${name}.nsi`);
      writeFileSync(script, `Unicode true
!include LogicLib.nsh
!define INSTALLWEBVIEW2MODE "offlineInstaller"
!define NETRIX_RUNTIME_PROBE_TIMEOUT 2000
!define MAINBINARYSRCPATH "${probe}"
!define WEBVIEW2INSTALLERPATH "${executable}"
!include "${hook}"
Name "Netrix runtime hook fixture"
OutFile "${setup}"
RequestExecutionLevel user
SilentInstall silent
Section
!insertmacro NSIS_HOOK_PREINSTALL
SetErrorLevel 0
SectionEnd
Function .onInstFailed
ReadEnvStr $3 NETRIX_NSIS_FIXTURE_DIR
FileOpen $4 "$3\\failure.txt" w
FileWrite $4 "$NetrixRuntimeFailure"
FileClose $4
FunctionEnd
`);
      const makensis = path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe');
      const packed = run(makensis, ['/V2', script]);
      assert.equal(packed.status, 0, packed.stdout + packed.stderr);
      return setup;
    };
    const setup = pack('hook-test', executable);
    const invalidProbe = path.join(directory, 'invalid-probe.exe');
    writeFileSync(invalidProbe, 'Not an executable; exercise a real CreateProcess failure.');
    const invalidSetup = pack('invalid-probe-test', invalidProbe);
    for (const [mode, success, install, probes, reason] of [
      ['available', true, false, 1, null], ['missing', true, true, 2, null],
      ['repair-fails', false, true, 2, /WebView2 is still unavailable.*Microsoft installer: 5/],
      ['still-missing', false, true, 2, /WebView2 is still unavailable.*Microsoft installer: 0/],
      ['probe-fails', false, false, 1, /exited unexpectedly.*42/],
      ['probe-timeout', false, false, 1, /check timed out/],
      ['repaired-probe-fails', false, true, 2, /exited unexpectedly.*42/],
      ['probe-cannot-launch', false, false, 0, /Could not run the WebView2 check.*probe: error/],
    ]) {
      const evidence = path.join(directory, mode);
      mkdirSync(evidence);
      const result = run(mode === 'probe-cannot-launch' ? invalidSetup : setup, ['/S'], { env: { ...process.env,
        NETRIX_NSIS_FIXTURE_DIR: evidence, NETRIX_NSIS_FIXTURE_MODE: mode } });
      assert.equal(result.status === 0, success, `${mode}: ${result.status}, ${result.stdout}${result.stderr}`);
      if (probes) assert.equal(readFileSync(path.join(evidence, 'probes'), 'utf8').length, probes, mode);
      else assert.throws(() => readFileSync(path.join(evidence, 'probes')));
      if (reason) {
        const failure = readFileSync(path.join(evidence, 'failure.txt'), 'utf8');
        assert.match(failure, reason, mode);
        if (mode.startsWith('probe-') || mode === 'repaired-probe-fails') {
          assert.match(failure, /availability was not determined/, mode);
          assert.doesNotMatch(failure, /WebView2 is still unavailable/, mode);
        }
      }
      if (install) assert.equal(readFileSync(path.join(evidence, 'installer-called'), 'utf8'), 'yes', mode);
      else assert.throws(() => readFileSync(path.join(evidence, 'installer-called')));
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('netrix-runtime-hook-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
