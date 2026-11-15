import assert from "node:assert/strict";

export function validateSqlcipherEvidence(evidence, policy) {
  assert.equal(evidence.adapter_path, policy.adapter_path, "Unexpected SQLite adapter");
  assert.deepEqual(evidence.adapter_hashes, policy.adapter_hashes, "SQLite adapter changed; review its native build before updating policy");
  assert.deepEqual(evidence.source, policy.source, "SQLCipher source/checksum does not match the reviewed release");
  assert.deepEqual(evidence.runtime, policy.runtime, "Linked SQLCipher/SQLite differs from the reviewed source");
  const version = evidence.runtime.sqlite_version.split(".").map(Number);
  assert.ok(version.length === 3 && version.every(Number.isInteger));
  assert.ok(version[0] * 1_000_000 + version[1] * 1_000 + version[2] >= 3_054_000, "SQLite remains vulnerable to RUSTSEC-2026-0459");
}

export function classifyFinding(finding, active, evidence, policy) {
  if (!active) return "inactive on the selected build target";
  if (finding.advisory.id === "RUSTSEC-2026-0459" && finding.package.name === "libsqlite3-sys" && finding.package.version === "0.30.1") {
    validateSqlcipherEvidence(evidence, policy);
    return "verified patched SQLCipher source and linked runtime (adapter ABI version only)";
  }
  throw new Error(`Active vulnerability: ${finding.advisory.id} (${finding.package.name} ${finding.package.version})`);
}
