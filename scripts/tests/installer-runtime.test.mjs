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
use std::{env, fs, path::PathBuf, process};
fn main() {
    let root = PathBuf::from(env::var("NETRIX_NSIS_FIXTURE_DIR").unwrap());
    let mode = env::var("NETRIX_NSIS_FIXTURE_MODE").unwrap();
    if env::args().nth(1).as_deref() == Some("--check-webview2") {
        let mut count = fs::read_to_string(root.join("probes")).unwrap_or_default();
        count.push('x'); fs::write(root.join("probes"), count).unwrap();
        if mode == "probe-fails" { process::exit(42); }
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
    const setup = path.join(directory, 'hook-test.exe');
    const hook = path.resolve(import.meta.dirname, '../../src-tauri/windows/runtime-hooks.nsh');
    const script = path.join(directory, 'hook-test.nsi');
    writeFileSync(script, `Unicode true
!include LogicLib.nsh
!define INSTALLWEBVIEW2MODE "offlineInstaller"
!define MAINBINARYSRCPATH "${executable}"
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
`);
    const makensis = path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe');
    const packed = run(makensis, ['/V2', script]);
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    for (const [mode, success, install, probes] of [
      ['available', true, false, 1], ['missing', true, true, 2],
      ['repair-fails', false, true, 2], ['still-missing', false, true, 2],
      ['probe-fails', false, false, 1],
    ]) {
      const evidence = path.join(directory, mode);
      mkdirSync(evidence);
      const result = run(setup, ['/S'], { env: { ...process.env,
        NETRIX_NSIS_FIXTURE_DIR: evidence, NETRIX_NSIS_FIXTURE_MODE: mode } });
      assert.equal(result.status === 0, success, `${mode}: ${result.status}, ${result.stdout}${result.stderr}`);
      assert.equal(readFileSync(path.join(evidence, 'probes'), 'utf8').length, probes, mode);
      if (install) assert.equal(readFileSync(path.join(evidence, 'installer-called'), 'utf8'), 'yes', mode);
      else assert.throws(() => readFileSync(path.join(evidence, 'installer-called')));
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('netrix-runtime-hook-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
