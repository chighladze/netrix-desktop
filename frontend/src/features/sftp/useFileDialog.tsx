import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import { LuDownload, LuFile, LuFilePenLine, LuLaptop, LuTriangleAlert, LuX } from "react-icons/lu";
import { formatBytes } from "./filePresentation";

export interface DownloadDetails {
  files: readonly { name: string; size?: number | null }[];
  destination: "file" | "folder";
}

export interface FileDialogOptions {
  title: string;
  description: string;
  inputLabel?: string;
  initialValue?: string;
  confirmLabel?: string;
  destructive?: boolean;
  validate?: (value: string) => string | null;
  download?: DownloadDetails;
  signal?: AbortSignal;
}

function DownloadSummary({ files, destination }: DownloadDetails) {
  const visibleFiles = files.slice(0, 4);
  const remaining = files.length - visibleFiles.length;
  return (
    <div className="files-dialog-summary">
      <div className="files-dialog-destination">
        <LuLaptop size={18} aria-hidden="true" />
        <div>
          <div className="files-dialog-caption">Destination</div>
          <div className="text-sm font-medium text-slate-100">Selected {destination} on this computer</div>
        </div>
      </div>
      <div className="files-dialog-downloads">
        <div className="files-dialog-caption">{files.length} {files.length === 1 ? "file" : "files"} to download</div>
        <ul aria-label="Files to download" className="mt-2 space-y-2">
          {visibleFiles.map((file, index) => (
            <li key={index} className="flex min-w-0 items-start gap-2.5 text-xs">
              <LuFile className="mt-0.5 shrink-0 text-sky-300/65" size={14} aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words font-mono text-slate-200">{file.name}</span>
              {file.size != null && <span className="shrink-0 tabular-nums text-slate-400">{formatBytes(file.size)}</span>}
            </li>
          ))}
        </ul>
        {remaining > 0 && <p className="mt-2 text-xs text-slate-400">+ {remaining} more</p>}
      </div>
    </div>
  );
}

export function useFileDialog() {
  const [options, setOptions] = useState<FileDialogOptions | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const resolveRef = useRef<((value: string | null) => void) | null>(null);
  const close = useCallback((answer: string | null) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(answer);
    setOptions(null);
  }, []);
  useEffect(() => () => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(null);
  }, []);
  const ask = useCallback(
    (next: FileDialogOptions) =>
      new Promise<string | null>((resolve) => {
        if (next.signal?.aborted) { resolve(null); return; }
        const cancel = () => close(null);
        resolveRef.current?.(null);
        resolveRef.current = (answer) => {
          next.signal?.removeEventListener("abort", cancel);
          resolve(answer);
        };
        next.signal?.addEventListener("abort", cancel, { once: true });
        setValue(next.initialValue || "");
        setError(null);
        setOptions(next);
      }),
    [close],
  );
  const Icon = options?.download ? LuDownload : options?.destructive ? LuTriangleAlert : LuFilePenLine;
  const dialog = options ? (
    <Dialog open onClose={() => close(null)} className="relative z-[100]">
      <DialogBackdrop className="fixed inset-0 bg-[#050a10]/75 backdrop-blur-[2px]" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="files-dialog-panel">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const message = options.validate?.(value);
              if (message) {
                setError(message);
                return;
              }
              close(value);
            }}
          >
            <div className="files-dialog-heading">
              <div className={`files-dialog-icon${options.destructive ? " files-dialog-icon-danger" : ""}`}>
                <Icon size={20} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="files-dialog-caption">{options.download ? "Files / Local access" : "Files"}</p>
                <DialogTitle className="mt-1 text-base font-semibold leading-tight text-white">{options.title}</DialogTitle>
              </div>
              <button type="button" aria-label="Close dialog" className="files-dialog-close" onClick={() => close(null)}>
                <LuX size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="files-dialog-body">
              <Description className="break-words text-sm leading-relaxed text-slate-300">{options.description}</Description>
              {options.download && <DownloadSummary {...options.download} />}
              {options.inputLabel && (
                <label className="mt-4 block text-xs font-medium text-slate-300">
                  {options.inputLabel}
                  <input
                    autoFocus
                    required
                    value={value}
                    onFocus={(event) => event.currentTarget.select()}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? errorId : undefined}
                    onChange={(event) => { setValue(event.target.value); setError(null); }}
                    className="files-dialog-input"
                  />
                </label>
              )}
              {error && <p id={errorId} role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
            </div>
            <div className="files-dialog-footer">
              <button
                type="button"
                data-autofocus={!options.inputLabel || undefined}
                className="files-button"
                onClick={() => close(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`files-button ${options.destructive ? "files-dialog-danger" : "files-dialog-primary"}`}
              >
                {options.download && <LuDownload size={15} aria-hidden="true" />}
                {options.confirmLabel || "Save"}
              </button>
            </div>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  ) : null;
  return { ask, dialog, close };
}
