import { describe, expect, it } from "vitest";
import { buildProblemReport, MAX_REPORT_URL_LENGTH, parseReportDiagnostics, unavailableDiagnostics } from "./problemReport";

const draft = { area: "Installer or startup" as const, reproduce: "1. Open Netrix", expected: "Workspace opens", actual: "Service unavailable" };

describe("public problem report", () => {
  it("selects only known diagnostics and never copies raw errors, paths or extra fields", () => {
    const diagnostics = parseReportDiagnostics({
      app_version: "0.3.0-beta.8", operating_system: "Windows 10.0 (build 26100)", architecture: "x86_64",
      backend_status: "failed", reason: "missing_runtime_library", exit_code: -1073741515, os_error: 5,
      message: "password=private-value", details: "token=private-value", host: "private.example",
      log_path: "C:\\Users\\private-user\\tauri_main.log", api_token: "private-value",
    });
    const report = buildProblemReport(draft, diagnostics);
    expect(report.text).toContain("0xC0000135");
    expect(report.text).toContain("OS error: 5");
    expect(report.text).not.toContain("private");
    expect(decodeURIComponent(report.url!)).not.toContain("private");
    expect(Object.keys(diagnostics)).not.toContain("log_path");
  });

  it("rejects unbounded or secret-bearing strings even in expected diagnostic fields", () => {
    const diagnostics = parseReportDiagnostics({
      app_version: "token=private-value", operating_system: "Windows C:\\private-user", architecture: "private-machine",
      backend_status: "private-value", reason: "private-value", exit_code: "private-value", signal: Infinity, os_error: 1.5,
    });
    expect(diagnostics).toEqual(unavailableDiagnostics());
    expect(buildProblemReport(draft, diagnostics).text).not.toContain("private");
  });

  it("prefills the existing form IDs and preserves Unicode, newlines and URL metacharacters", () => {
    const text = "Ошибка: ქართულად & # ? = + \"quoted\"\nSecond line";
    const report = buildProblemReport({ ...draft, actual: text }, unavailableDiagnostics());
    const url = new URL(report.url!);
    expect(url.origin + url.pathname).toBe("https://github.com/chighladze/netrix-releases/issues/new");
    expect(url.searchParams.get("template")).toBe("bug-report.yml");
    expect(url.searchParams.get("reproduce")).toBe(draft.reproduce);
    expect(url.searchParams.get("expected")).toBe(draft.expected);
    expect(url.searchParams.get("actual")).toBe(text);
    expect(url.searchParams.get("area")).toBe(draft.area);
    expect(url.searchParams.get("evidence")).toContain("Technical diagnostics");
    expect(report.text).toContain(text);
    expect(url.hash).toBe("");
  });

  it("keeps a long report intact for copying instead of silently truncating its content", () => {
    const actual = "ქართული".repeat(400);
    const report = buildProblemReport({ ...draft, actual }, unavailableDiagnostics());
    expect(report.url).toBeNull();
    expect(report.text).toContain(actual);
    expect(report.manualUrl.length).toBeLessThan(MAX_REPORT_URL_LENGTH);
    expect(new URL(report.manualUrl).searchParams.get("version")).toBe(unavailableDiagnostics().app_version);
  });
});
