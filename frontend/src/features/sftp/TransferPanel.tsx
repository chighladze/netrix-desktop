import { useEffect, useId, useState } from "react";
import { LuArrowDownToLine, LuArrowUpFromLine, LuChevronDown, LuChevronUp } from "react-icons/lu";
import { cancelTransfer, isTransferFinished, sftpRequest, type TransferJob } from "./api";
import { formatBytes } from "./filePresentation";

const statusLabels: Record<TransferJob["status"], string> = {
  queued: "Queued", connecting: "Connecting", running: "Transferring", finalizing: "Verifying",
  committing: "Saving", cancelling: "Cancelling", completed: "Completed", cancelled: "Cancelled", failed: "Failed",
};

export default function TransferPanel({ hostId }: { hostId: number }) {
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const contentId = useId();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setJobs([]); setError(""); setActionError(""); setDismissed([]);
    const poll = async () => {
      let delay = 1500;
      try {
        const response = await sftpRequest<{ transfers: TransferJob[] }>("/transfers", undefined, controller.signal);
        if (!controller.signal.aborted) {
          const current = response.transfers.filter((job) => job.host_id === hostId);
          setJobs(current); setError("");
          if (current.some((job) => !isTransferFinished(job))) delay = 600;
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Cannot load transfers");
      } finally { if (!controller.signal.aborted) timer = setTimeout(poll, delay); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [hostId]);
  const visible = jobs.filter((job) => !dismissed.includes(job.id));
  const active = visible.filter((job) => !isTransferFinished(job));
  const finished = visible.filter(isTransferFinished);
  const failed = finished.filter((job) => job.status === "failed").length;
  const shown = [...active, ...finished.slice(0, 12)];
  if (!visible.length && !error && !actionError) return null;
  return <section aria-label="SFTP transfers" className="shrink-0 border-t border-white/10 bg-[#0b131e]">
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <button onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-controls={contentId} className="flex min-w-0 items-center gap-2 text-xs text-gray-300">
        {expanded ? <LuChevronDown size={15} /> : <LuChevronUp size={15} />}<span className="font-semibold">Transfers</span>
        <span className="text-[11px] text-gray-400">{active.length ? `${active.length} active` : `${finished.length} finished`}{failed ? ` · ${failed} failed` : ""}</span>
      </button>
      {finished.length > 0 && <button className="text-[11px] text-gray-400 hover:text-white" onClick={() => setDismissed((previous) => [...new Set([...previous, ...finished.map((job) => job.id)])])}>Clear finished</button>}
    </div>
    {(error || actionError) && <p role="alert" className="px-4 pb-2 text-xs text-red-300">{actionError || error}</p>}
    <div id={contentId} hidden={!expanded} className="max-h-40 space-y-2 overflow-y-auto px-4 pb-3">
      {shown.map((job) => {
        const percent = job.status === "completed" ? 100 : job.bytes_total ? Math.min(100, Math.floor(job.bytes_done / job.bytes_total * 100)) : 0;
        return <div key={job.id} className="rounded-lg border border-white/[0.06] px-3 py-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 text-gray-300" title={job.path}>
              {job.kind === "upload" ? <LuArrowUpFromLine size={14} className="shrink-0 text-sky-300" /> : <LuArrowDownToLine size={14} className="shrink-0 text-emerald-300" />}
              <span className="sr-only">{job.kind}</span><span className="truncate">{job.path}</span>
            </span>
            <div className="flex shrink-0 items-center gap-3">
              <span className={job.status === "failed" ? "text-red-300" : job.status === "completed" ? "text-emerald-300" : "text-gray-400"}>{statusLabels[job.status]}</span>
              {!isTransferFinished(job) && <button aria-label={`Cancel transfer ${job.path}`} disabled={job.status === "committing" || job.status === "cancelling"}
                className="text-amber-300 disabled:opacity-40" onClick={() => {
                  setActionError("");
                  void cancelTransfer(job.id).catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Cannot cancel transfer"));
                }}>Cancel</button>}
            </div>
          </div>
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-gray-400"><span>{formatBytes(job.bytes_done)}{job.bytes_total !== null ? ` / ${formatBytes(job.bytes_total)}` : ""}</span><span>{job.bytes_total !== null || job.status === "completed" ? `${percent}%` : ""}</span></div>
          {job.error && <p className="mt-1 break-words text-amber-200">{job.error}</p>}
          {job.warning && !job.error && <p className="mt-1 break-words text-sky-200">{job.warning}</p>}
          <div role="progressbar" aria-label={`Transfer ${job.path}`} aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={job.bytes_total !== null || isTransferFinished(job) ? percent : undefined} aria-valuetext={statusLabels[job.status]} className="mt-2 h-1 rounded bg-white/5">
            <div className={`h-full rounded ${job.status === "failed" ? "bg-red-400" : job.status === "completed" ? "bg-emerald-400" : "bg-sky-400"}`} style={{ width: `${percent}%` }} />
          </div>
        </div>;
      })}
    </div>
  </section>;
}
