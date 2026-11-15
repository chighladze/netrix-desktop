import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuCloudUpload, LuFolderOpen, LuLaptop } from "react-icons/lu";
import { authenticatedFetch, fetchJsonOrThrow, getApiBase, getApiErrorMessage } from "../api";
import { visitDirectory, type DirectoryHistory } from "../features/sftp/api";
import FileList from "../features/sftp/FileList";
import FilePathBar from "../features/sftp/FilePathBar";
import type { SftpDirectoryEntry, SftpDirectoryStatus } from "../state/store";

interface Directory {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; is_directory: boolean; size: number }[];
  truncated: boolean;
}

export default function LocalFilePanel({ disabled, remotePath, onUpload }: {
  disabled: boolean;
  remotePath: string;
  onUpload: (file: File) => Promise<void>;
}) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [selected, setSelected] = useState<SftpDirectoryEntry | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<SftpDirectoryStatus>("idle");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [history, setHistory] = useState<DirectoryHistory>();
  const requestRef = useRef<AbortController | null>(null);
  const attemptedPath = useRef("");
  const pathInputRef = useRef<HTMLInputElement>(null);
  const entries = useMemo(() => directory?.entries.map((entry) => ({
    name: entry.name, path: entry.path, size: entry.size, entry_type: entry.is_directory ? "directory" : "file",
  })) || [], [directory]);
  const load = useCallback(async (next: string, historyIndex?: number) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    attemptedPath.current = next;
    setStatus("loading"); setError(""); setUploadError(""); setSelected(null);
    try {
      const result = await fetchJsonOrThrow<Directory>(
        `${await getApiBase()}/local-files?${new URLSearchParams({ path: next })}`, { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setDirectory(result); setStatus("ready");
        setHistory((previous) => visitDirectory(previous, result.path, historyIndex));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error instanceof Error ? error.message : "Cannot open local directory");
        setStatus("error");
      }
    }
  }, []);
  useEffect(() => { void load(""); return () => requestRef.current?.abort(); }, [load]);

  const uploadSelected = async () => {
    if (!selected || disabled || uploading || status !== "ready") return;
    const entry = selected;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setUploading(true); setUploadError("");
    try {
      const response = await authenticatedFetch(
        `${await getApiBase()}/local-files/content?${new URLSearchParams({ path: entry.path })}`, { signal: controller.signal },
      );
      if (!response.ok) throw new Error(await getApiErrorMessage(response, "Cannot read local file"));
      const blob = await response.blob();
      if (!controller.signal.aborted) await onUpload(new File([blob], entry.name));
    } catch (error) {
      if (!controller.signal.aborted) setUploadError(error instanceof Error ? error.message : "Upload failed");
    } finally { if (!controller.signal.aborted) setUploading(false); }
  };
  const isFolder = selected?.entry_type === "directory";
  const oversized = (selected?.size || 0) > 128 * 1024 * 1024;
  return <section aria-label="Local file workspace" className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-white/[0.07] bg-[#0b131e]/60 p-4 md:border-b-0 md:border-r"
    onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault(); event.stopPropagation(); pathInputRef.current?.focus(); pathInputRef.current?.select();
      }
    }}>
    <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-xs font-semibold text-gray-300"><LuLaptop size={15} className="text-gray-400" />Local files</h2>
      <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">This computer</span>
    </div>
    <FilePathBar label="Local" path={status === "ready" ? directory?.path || "" : attemptedPath.current} home="" parent={directory?.parent ?? null} history={history}
      inputRef={pathInputRef} busy={status === "loading"} disabled={uploading} onNavigate={(path, index) => void load(path, index)} />
    <div className="mb-3 flex min-h-9 shrink-0 items-center gap-2">
      {isFolder ? <button disabled={uploading || status !== "ready"} className="files-button" onClick={() => selected && void load(selected.path)}><LuFolderOpen size={15} />Open folder</button>
        : <button disabled={disabled || uploading || status !== "ready" || !selected || oversized} className="files-button border-sky-400/30 bg-sky-400/10 text-sky-200" onClick={() => void uploadSelected()}><LuCloudUpload size={15} />{uploading ? "Uploading…" : "Upload selected"}</button>}
      <span className="truncate text-[11px] text-gray-500" title={remotePath}>to {remotePath}</span>
    </div>
    {uploadError && <p role="alert" className="mb-3 shrink-0 text-xs text-red-300">{uploadError}</p>}
    {oversized && !isFolder && <p role="status" className="mb-3 shrink-0 text-xs text-amber-300">This file exceeds the 128 MiB upload limit.</p>}
    {directory?.truncated && <p className="mb-3 shrink-0 text-xs text-amber-300">Showing the first 10,000 entries. Filtering applies to these entries.</p>}
    <FileList label="Local files" locationKey={directory?.path || ""} entries={entries} status={status} error={error} compact
      selected={selected} disabled={uploading} onSelect={setSelected}
      onOpen={(entry) => { if (entry.entry_type === "directory" && !uploading) void load(entry.path); }}
      onRetry={() => void load(attemptedPath.current)} />
  </section>;
}
