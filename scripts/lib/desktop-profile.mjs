import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

export function assertE2eIdentifier(identifier) {
  assert.match(identifier, /^com\.netrix\.e2e\.[0-9a-f]{32}$/, "Refusing a production or unscoped desktop build");
}

export async function fileHash(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function verifyBuild(manifest, binaryOverride) {
  assert.equal(manifest.version, 1);
  assertE2eIdentifier(manifest.identifier);
  const binary = path.resolve(binaryOverride || manifest.binary);
  assert.equal(binary, path.resolve(manifest.binary), "An arbitrary desktop binary cannot be substituted");
  assert.equal(await fileHash(binary), manifest.binary_sha256, "Desktop build changed; rebuild E2E first");
  assert.equal(await fileHash(manifest.backend), manifest.backend_sha256, "E2E sidecar changed; rebuild E2E first");
  assert.ok((await readFile(binary)).includes(Buffer.from(manifest.identifier)), "The binary does not contain the isolated identifier");
  return binary;
}

export async function removeProfile(directory, parent, identifier) {
  assertE2eIdentifier(identifier);
  assert.equal(path.resolve(directory), path.join(path.resolve(parent), identifier));
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

export async function identitySnapshot(directories) {
  const snapshot = {};
  for (const directory of directories) {
    for (const name of [".secret_key", ".vault_salt", ".database-key", "known_hosts", "database.db", "database.db-wal"]) {
      const file = path.join(directory, name);
      try { snapshot[file] = await fileHash(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; snapshot[file] = null; }
    }
  }
  return snapshot;
}
