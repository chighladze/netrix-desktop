import assert from "node:assert/strict";

export const picomatchAdvisory = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const reviewedPicomatchVersions = new Set(["2.3.2", "4.0.7"]);

export function reviewFrontendAudit(report, packages) {
  assert.equal(report?.auditReportVersion, 2, "Invalid npm audit report");
  assert.ok(report.vulnerabilities && typeof report.vulnerabilities === "object" &&
    !Array.isArray(report.vulnerabilities) && !report.error, "npm did not return vulnerability data");
  const findings = Object.entries(report.vulnerabilities);
  assert.equal(report.metadata?.vulnerabilities?.total, findings.length, "Incomplete npm audit report");
  if (!findings.length) return 0;

  const picomatch = report.vulnerabilities.picomatch;
  const advisory = picomatch?.via?.[0];
  assert.ok(picomatch?.isDirect === false && picomatch.via?.length === 1 &&
    advisory?.name === "picomatch" && advisory.url === picomatchAdvisory,
    "Expected only the reviewed transitive picomatch advisory");

  for (const [name, { nodes, via }] of findings) {
    assert.ok(Array.isArray(nodes) && nodes.length && Array.isArray(via) && via.length,
      "Missing affected locations or advisory causes for " + name);
    for (const node of nodes) {
      const dependency = packages[node];
      assert.ok(node.endsWith("/" + name) && dependency?.dev === true,
        "Affected dependency is not dev-only in the lockfile: " + node);
      if (name === "picomatch") {
        assert.ok(reviewedPicomatchVersions.has(dependency.version),
          "Unreviewed picomatch version: " + dependency.version);
      }
    }
  }

  // npm lists affected parents separately. Each cause must trace back to
  // the reviewed finding before its parent can be accepted.
  const accepted = new Set(["picomatch"]);
  while (accepted.size < findings.length) {
    const previousSize = accepted.size;
    for (const [name, { via }] of findings) {
      if (via.every(cause => accepted.has(cause))) accepted.add(name);
    }
    if (accepted.size === previousSize) {
      const unresolved = findings.filter(([name]) => !accepted.has(name)).map(([name]) => name);
      throw new Error("Unreviewed frontend audit findings: " + unresolved.join(", "));
    }
  }
  return findings.length;
}
