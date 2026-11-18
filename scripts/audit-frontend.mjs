import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { picomatchAdvisory, reviewFrontendAudit } from "./lib/frontend-audit.mjs";

const root = path.resolve(import.meta.dirname, "..");
const npm = process.env.npm_execpath;
assert.ok(npm, "Run npm run audit:frontend from the repository root.");
const result = spawnSync(process.execPath, [
  npm, "audit", "--prefix", "frontend", "--include=dev", "--audit-level=info", "--json",
], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);

let findings;
try {
  const lock = JSON.parse(await readFile(path.join(root, "frontend/package-lock.json"), "utf8"));
  findings = reviewFrontendAudit(JSON.parse(result.stdout), lock.packages);
  assert.equal(result.status, findings ? 1 : 0, "Unexpected npm audit exit code");
} catch (error) {
  if (result.stdout) process.stderr.write(result.stdout);
  throw error;
}

console.log(findings
  ? "Full frontend audit reported " + findings + " dev-only findings linked to " + picomatchAdvisory + "."
  : "Full frontend audit found no vulnerabilities.");
