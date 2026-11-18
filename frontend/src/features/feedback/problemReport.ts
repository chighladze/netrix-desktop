import { version } from "../../../package.json";

export const BUG_REPORT_URL = "https://github.com/chighladze/netrix-releases/issues/new";
export const MAX_REPORT_URL_LENGTH = 6000;
export const REPORT_AREAS = [
  "Installer or startup", "SSH, Telnet or Serial", "Terminal tabs or panes", "SFTP or files",
  "Hosts or folders", "Vault or encrypted storage", "Tunnels or network tools",
  "Website or documentation", "Other",
] as const;

const REASONS = [
  "workspace_busy", "workspace_key_missing", "workspace_database_missing", "workspace_key_invalid",
  "workspace_access_denied", "data_directory_unavailable", "workspace_unavailable", "listener_denied",
  "local_port_in_use", "listener_unavailable", "missing_runtime_library", "invalid_binary",
  "library_initialization_failed", "backend_crashed", "backend_exited",
] as const;

export interface ReportDiagnostics {
  app_version: string;
  operating_system: string;
  architecture: string;
  backend_status: string;
  reason: string | null;
  exit_code: number | null;
  signal: number | null;
  os_error: number | null;
}

export interface ProblemReportDraft {
  area: typeof REPORT_AREAS[number];
  reproduce: string;
  expected: string;
  actual: string;
}

export function unavailableDiagnostics(): ReportDiagnostics {
  return {
    app_version: version, operating_system: "Unavailable", architecture: "Unavailable",
    backend_status: "unavailable", reason: null, exit_code: null, signal: null, os_error: null,
  };
}

/** Select only bounded, known fields. Never serialize an IPC object wholesale. */
export function parseReportDiagnostics(value: unknown): ReportDiagnostics {
  if (!value || typeof value !== "object") throw new Error("Diagnostics unavailable");
  const record = value as Record<string, unknown>;
  const fallback = unavailableDiagnostics();
  const integer = (value: unknown) => typeof value === "number" && Number.isInteger(value)
    && value >= -2147483648 && value <= 2147483647 ? value : null;
  const selected = (value: unknown, allowed: readonly string[], missing: string) =>
    typeof value === "string" && allowed.includes(value) ? value : missing;
  return {
    app_version: typeof record.app_version === "string" && record.app_version.length <= 64
      && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(record.app_version) ? record.app_version : fallback.app_version,
    operating_system: typeof record.operating_system === "string"
      && /^(Windows \d{1,3}\.\d{1,3} \(build \d{1,10}\)|Windows \(build unavailable\)|linux|macos|freebsd|openbsd|netbsd)$/.test(record.operating_system)
      ? record.operating_system : fallback.operating_system,
    architecture: selected(record.architecture, ["x86_64", "aarch64", "x86", "arm"], fallback.architecture),
    backend_status: selected(record.backend_status, ["starting", "ready", "failed", "unavailable"], "unavailable"),
    reason: selected(record.reason, REASONS, "") || null,
    exit_code: integer(record.exit_code), signal: integer(record.signal), os_error: integer(record.os_error),
  };
}

export function diagnosticText(diagnostics: ReportDiagnostics): string {
  const lines = [
    `Netrix version: ${diagnostics.app_version}`,
    `Operating system: ${diagnostics.operating_system}`,
    `Architecture: ${diagnostics.architecture}`,
    `Backend status: ${diagnostics.backend_status}`,
    `Reason: ${diagnostics.reason ?? "unavailable"}`,
  ];
  if (diagnostics.exit_code !== null) lines.push(`Backend exit code: ${diagnostics.exit_code} (0x${(diagnostics.exit_code >>> 0).toString(16).toUpperCase().padStart(8, "0")})`);
  if (diagnostics.signal !== null) lines.push(`Signal: ${diagnostics.signal}`);
  if (diagnostics.os_error !== null) lines.push(`OS error: ${diagnostics.os_error}`);
  return lines.join("\n");
}

export function buildProblemReport(draft: ProblemReportDraft, diagnostics: ReportDiagnostics) {
  const fields = {
    template: "bug-report.yml",
    title: `[Bug]: ${Array.from(draft.actual.trim().split(/\r?\n/)[0]).slice(0, 100).join("")}`,
    version: diagnostics.app_version,
    environment: `${diagnostics.operating_system}; ${diagnostics.architecture}`,
    area: draft.area,
    reproduce: draft.reproduce.trim(), expected: draft.expected.trim(), actual: draft.actual.trim(),
    evidence: `Technical diagnostics (reviewed by the reporter):\n\n\`\`\`text\n${diagnosticText(diagnostics)}\n\`\`\``,
  };
  const url = new URL(BUG_REPORT_URL);
  url.search = new URLSearchParams(fields).toString();
  const manual = new URL(BUG_REPORT_URL);
  manual.search = new URLSearchParams({ template: fields.template, title: fields.title,
    version: fields.version, environment: fields.environment, area: fields.area }).toString();
  return {
    url: url.href.length <= MAX_REPORT_URL_LENGTH ? url.href : null,
    manualUrl: manual.href,
    text: `# ${fields.title}\n\n### Netrix version\n${fields.version}\n\n### Operating system\n${fields.environment}\n\n### Affected area\n${fields.area}\n\n### Steps to reproduce\n${fields.reproduce}\n\n### Expected result\n${fields.expected}\n\n### Actual result\n${fields.actual}\n\n### Additional context\n${fields.evidence}`,
  };
}
