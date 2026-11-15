import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { classifyFinding, validateSqlcipherEvidence } from "./lib/backend-audit.mjs";

const root = path.resolve(import.meta.dirname, "..");
const manifest = "backend-rs/Cargo.toml";
function run(command, args, allowFindings = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.ok(result.status === 0 || (allowFindings && result.status === 1), `${command} failed: ${result.stderr}`);
  return result;
}
const policy = JSON.parse(await readFile(path.join(root, "scripts/backend-audit-policy.json"), "utf8"));
const metadata = JSON.parse(run("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifest]).stdout);
const adapter = metadata.packages.find(pkg => pkg.name === "libsqlite3-sys" && pkg.version === "0.30.1");
assert.ok(adapter && adapter.source === null, "The reviewed local SQLCipher adapter must be active");
const adapterPath = path.relative(root, path.dirname(adapter.manifest_path)).replaceAll("\\", "/");
const hashes = {};
for (const file of Object.keys(policy.adapter_hashes)) {
  const source = (await readFile(path.join(root, adapterPath, file), "utf8")).replaceAll("\r\n", "\n");
  hashes[file] = createHash("sha256").update(source).digest("hex");
}
const lock = await readFile(path.join(root, "backend-rs/Cargo.lock"), "utf8");
const sourceBlock = lock.split("[[package]]").find(block => /^name = "sqlcipher-src"$/m.test(block));
assert.ok(sourceBlock, "Missing checksummed SQLCipher source");
const field = name => sourceBlock.match(new RegExp(`^${name} = "([^"]+)"$`, "m"))?.[1];
const runtimeResult = run("cargo", ["run", "--quiet", "--locked", "--manifest-path", manifest, "--bin", "netrix_backend", "--", "--storage-build-info"]);
const { binary_sha256, ...runtime } = JSON.parse(runtimeResult.stdout);
assert.match(binary_sha256, /^[a-f0-9]{64}$/);
const evidence = { adapter_path: adapterPath, adapter_hashes: hashes,
  source: { name: "sqlcipher-src", version: field("version"), source: field("source"), checksum: field("checksum") },
  runtime };
validateSqlcipherEvidence(evidence, policy);
const audit = run("cargo", ["audit", "--file", "backend-rs/Cargo.lock", "--json"], true);
const report = JSON.parse(audit.stdout);
assert.ok(report.vulnerabilities && Array.isArray(report.vulnerabilities.list), "Invalid cargo-audit report");
assert.ok(audit.status === 0 || report.vulnerabilities.count > 0, "cargo-audit failed without reporting findings");
const target = process.env.CARGO_BUILD_TARGET || run("rustc", ["-vV"]).stdout.match(/^host: (.+)$/m)?.[1];
assert.ok(target);
for (const finding of report.vulnerabilities.list) {
  const tree = run("cargo", ["tree", "--locked", "--manifest-path", manifest, "--target", target, "--edges", "normal,build", "--invert", `${finding.package.name}@${finding.package.version}`]);
  const classification = classifyFinding(finding, tree.stdout.trim().length > 0, evidence, policy);
  console.log(`${finding.advisory.id}: ${classification}`);
}
console.log(JSON.stringify({ target, binary_sha256, native_storage: evidence.runtime, source_checksum: evidence.source.checksum, advisory_database: report.database }, null, 2));
console.log("Backend audit passed: no accepted active vulnerability and no blanket advisory ignores.");
