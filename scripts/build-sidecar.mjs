import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const target = process.env.TAURI_ENV_TARGET_TRIPLE || execFileSync('rustc', ['-vV'], {
  encoding: 'utf8', windowsHide: true,
}).split(/\r?\n/).find(line => line.startsWith('host: '))?.slice(6).trim();
if (!target) throw new Error('Cannot determine the sidecar target triple.');

const env = { ...process.env, TAURI_ENV_TARGET_TRIPLE: target };
if (target.endsWith('-windows-msvc')) {
  // Explicit --target keeps host build scripts/proc macros separate. cc-rs also
  // receives crt-static for native SQLCipher/crypto code through Cargo's cfg.
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
    env.CARGO_ENCODED_RUSTFLAGS += `${env.CARGO_ENCODED_RUSTFLAGS ? '\x1f' : ''}-C\x1ftarget-feature=+crt-static`;
  } else {
    env.RUSTFLAGS = `${env.RUSTFLAGS || ''} -C target-feature=+crt-static`.trim();
  }
}
// Shell builds can use a custom Cargo target dir. Always build the sidecar
// into the directory that prepare-sidecar reads so it cannot stage stale code.
execFileSync('cargo', ['build', '--release', '--locked', '--target', target,
  '--target-dir', path.join(root, 'backend-rs', 'target'),
  '--manifest-path', 'backend-rs/Cargo.toml'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
execFileSync(process.execPath, ['scripts/prepare-sidecar.mjs', 'release'], {
  cwd: root, env, stdio: 'inherit', windowsHide: true,
});
