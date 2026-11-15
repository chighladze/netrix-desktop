import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoRedistributable, parseDependencies } from '../lib/windows-binaries.mjs';

test('dependency inspection rejects normal and delayed Visual C++ runtime imports', () => {
  const output = 'Image has the following dependencies:\n    KERNEL32.dll\n    api-ms-win-crt-runtime-l1-1-0.dll\n' +
    'Image has the following delay load dependencies:\n    VCRUNTIME140_1.dll\n    KERNEL32.dll\n';
  const dependencies = parseDependencies(output);
  assert.equal(dependencies.length, 3);
  assert.throws(() => assertNoRedistributable(dependencies, 'backend.exe'), /vcruntime140_1.dll/);
  for (const name of ['VCRUNTIME140.dll', 'MSVCP140.dll', 'MSVCR120D.dll', 'CONCRT140.dll', 'VCOMP140.dll', 'ucrtbased.dll']) {
    assert.throws(() => assertNoRedistributable([name], 'fixture.exe'));
  }
  assert.doesNotThrow(() => assertNoRedistributable(['kernel32.dll', 'ucrtbase.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'], 'fixture.exe'));
  assert.throws(() => parseDependencies('LINK : fatal error LNK1107'), /inspection failed/);
});

test('Windows release validation and draft publication fail closed', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-File',
    path.join(import.meta.dirname, 'windows-release-fixtures.ps1')], { encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /All release safety scenarios passed/);
});

test('release commands use PowerShell 7 and hash exactly one installer', { skip: process.platform !== 'win32' }, () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const name of ['hash:installers', 'audit:tauri']) {
    const executable = scripts[name].split(/\s+/)[0];
    const probe = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command',
      'if ($PSVersionTable.PSVersion.Major -lt 7) { throw "Release commands require PowerShell 7" }; Get-Command Get-FileHash -ErrorAction Stop | Out-Null'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.ifError(probe.error);
    assert.equal(probe.status, 0, `${name}: ${probe.stdout}${probe.stderr}`);
  }

  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = mkdtempSync(path.join(temporaryRoot, 'netrix-hash-fixture-'));
  try {
    mkdirSync(path.join(directory, 'scripts'));
    copyFileSync(path.join(root, 'scripts/write-installer-hashes.ps1'), path.join(directory, 'scripts/write-installer-hashes.ps1'));
    const bundle = 'src-tauri/target/release/bundle';
    mkdirSync(path.join(directory, bundle, 'nsis'), { recursive: true });
    const filename = 'Netrix fixture [x64] setup.exe';
    const relativeInstaller = `${bundle}/nsis/${filename}`;
    const bytes = Buffer.from('non-executable installer checksum fixture\0\xff', 'latin1');
    writeFileSync(path.join(directory, relativeInstaller), bytes);
    const run = () => spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', scripts['hash:installers']],
      { cwd: directory, encoding: 'utf8', timeout: 15000, windowsHide: true });
    const result = run();
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const rows = readFileSync(path.join(directory, bundle, 'installer-hashes.sha256'), 'utf8')
      .split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    assert.deepEqual(rows, [`${createHash('sha256').update(bytes).digest('hex').toUpperCase()}  ${relativeInstaller}`]);

    writeFileSync(path.join(directory, bundle, 'nsis', 'unexpected.exe'), bytes);
    const ambiguous = run();
    assert.ifError(ambiguous.error);
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stdout + ambiguous.stderr, /Expected exactly one publishable NSIS installer/);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    assert.ok(path.basename(directory).startsWith('netrix-hash-fixture-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
