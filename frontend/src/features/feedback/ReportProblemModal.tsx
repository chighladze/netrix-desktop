import { Description, Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useRef, useState } from "react";
import { LuBug, LuX } from "react-icons/lu";
import { buildProblemReport, diagnosticText, parseReportDiagnostics, REPORT_AREAS, unavailableDiagnostics, type ProblemReportDraft, type ReportDiagnostics } from "./problemReport";
import "./feedback.css";

export default function ReportProblemModal({ onClose, serviceFailure = false }: {
  onClose: () => void;
  serviceFailure?: boolean;
}) {
  const [draft, setDraft] = useState<ProblemReportDraft>({
    area: serviceFailure ? "Installer or startup" : "Other", reproduce: "",
    expected: "", actual: serviceFailure ? "Netrix reports that the local service is unavailable." : "",
  });
  const [diagnostics, setDiagnostics] = useState<ReportDiagnostics | null>();
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState<{ role: "status" | "alert"; text: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const previewRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    const deadline = window.setTimeout(() => {
      if (active) { active = false; setDiagnostics(null); }
    }, 3000);
    void invoke<unknown>("get_problem_report_diagnostics").then((value) => {
      if (active) setDiagnostics(parseReportDiagnostics(value));
    }).catch(() => {
      if (active) setDiagnostics(null);
    }).finally(() => window.clearTimeout(deadline));
    return () => { active = false; window.clearTimeout(deadline); };
  }, []);

  useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview]);

  const loading = diagnostics === undefined;
  const reportDiagnostics = diagnostics ?? unavailableDiagnostics();
  const report = buildProblemReport(draft, reportDiagnostics);
  const edit = (key: keyof ProblemReportDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };
  const copy = async () => {
    try {
      await writeText(report.text);
      setNotice({ role: "status", text: "Report copied." });
    } catch {
      setNotice({ role: "alert", text: "Could not copy. Select the report text below and copy it manually." });
    }
  };
  const open = async () => {
    if (openingRef.current) return;
    openingRef.current = true; setOpening(true); setNotice(null);
    try {
      await invoke("open_problem_report", { url: report.url ?? report.manualUrl });
      setNotice({ role: "status", text: report.url
        ? "GitHub opened. Review and submit the form there; the report has not been sent yet."
        : "GitHub opened. Paste the copied report into the matching fields, then submit it there." });
    } catch {
      setNotice({ role: "alert", text: "Could not open GitHub. Copy the report and open github.com/chighladze/netrix-releases/issues/new manually." });
    } finally { openingRef.current = false; setOpening(false); }
  };

  return <Dialog open onClose={onClose} className="problem-report-layer relative z-[2147483645]">
    <div className="fixed inset-0 bg-black/70" aria-hidden="true" />
    <div className="fixed inset-0 flex items-center justify-center p-3 sm:p-6">
      <DialogPanel className="problem-report ui-dialog">
        <header className="problem-report-header">
          <LuBug size={22} aria-hidden="true" />
          <div><DialogTitle>Report problem</DialogTitle>
            <Description>{preview ? "Review your report before opening GitHub." : "Tell us what happened. Technical details are collected locally."}</Description></div>
          <button type="button" onClick={onClose} aria-label="Close problem report"><LuX size={20} /></button>
        </header>
        <div className="problem-report-body">
          <p className="problem-report-privacy">Reports submitted to GitHub are public and require a GitHub account. Remove passwords, private server details and personal information from your description. Logs, terminal contents and workspace files are not attached.</p>
          {preview ? <>
            {!report.url && <p role="status" className="problem-report-notice">This report is too long for a prefilled link. Copy it, then paste its sections into the GitHub form. Version and system details will still be filled in.</p>}
            <pre ref={previewRef} tabIndex={0} aria-label="Report preview" className="problem-report-preview">{report.text}</pre>
          </> : <form id="problem-report-form" onSubmit={(event) => {
            event.preventDefault();
            if (loading) return;
            if (![draft.reproduce, draft.expected, draft.actual].every((value) => value.trim())) {
              setNotice({ role: "alert", text: "Describe the steps, expected result and actual result." });
              return;
            }
            setNotice(null); setPreview(true);
          }}>
            <label>Affected area<select value={draft.area} onChange={(event) => edit("area", event.target.value)}>
              {REPORT_AREAS.map((area) => <option key={area}>{area}</option>)}
            </select></label>
            <label>What were you doing?<textarea autoFocus required maxLength={2000} rows={3} value={draft.reproduce}
              placeholder="The steps that led to the problem" onChange={(event) => edit("reproduce", event.target.value)} /></label>
            <label>What did you expect?<textarea required maxLength={2000} rows={2} value={draft.expected}
              onChange={(event) => edit("expected", event.target.value)} /></label>
            <label>What happened?<textarea required maxLength={2000} rows={3} value={draft.actual}
              placeholder="Describe the result or error" onChange={(event) => edit("actual", event.target.value)} /></label>
            <details className="problem-report-diagnostics"><summary>Technical diagnostics</summary><pre>{diagnosticText(reportDiagnostics)}</pre></details>
            {loading && <p role="status">Collecting technical details…</p>}
            {diagnostics === null && <p role="status">Some technical details are unavailable. You can still describe and report the problem.</p>}
          </form>}
          {notice && <p role={notice.role} className={notice.role === "alert" ? "problem-report-error" : "problem-report-notice"}>{notice.text}</p>}
        </div>
        <footer className="problem-report-footer">
          {preview ? <>
            <button type="button" disabled={opening} onClick={() => { setPreview(false); setNotice(null); }}>Edit report</button>
            <button type="button" onClick={() => { void copy(); }}>Copy report</button>
            <button type="button" className="problem-report-primary" disabled={opening} onClick={() => { void open(); }}>{opening ? "Opening GitHub…" : "Open GitHub form"}</button>
          </> : <>
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" form="problem-report-form" className="problem-report-primary" disabled={loading}>Preview report</button>
          </>}
        </footer>
      </DialogPanel>
    </div>
  </Dialog>;
}
