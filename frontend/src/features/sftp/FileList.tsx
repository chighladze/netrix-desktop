import { useEffect, useMemo, useRef, useState } from "react";
import { LuArrowDown, LuArrowUp, LuCircleAlert, LuEye, LuEyeOff, LuFileText, LuFolderOpen, LuLink, LuRefreshCw, LuSearch, LuX } from "react-icons/lu";
import type { SftpDirectoryEntry, SftpDirectoryStatus } from "../../state/store";
import { formatBytes, formatDate } from "./filePresentation";
import "./files.css";

type SortKey = "name" | "size" | "modified_at";
interface Props {
  label: string;
  locationKey: string;
  entries: SftpDirectoryEntry[];
  status: SftpDirectoryStatus;
  error?: string | null;
  selected: SftpDirectoryEntry | null;
  selection?: SftpDirectoryEntry[];
  onSelectionChange?: (entries: SftpDirectoryEntry[]) => void;
  disabled?: boolean;
  compact?: boolean;
  onSelect: (entry: SftpDirectoryEntry | null) => void;
  onOpen: (entry: SftpDirectoryEntry) => void;
  onRetry: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  emptyAction?: React.ReactNode;
}

export default function FileList({ label, locationKey, entries, status, error, selected, selection, onSelectionChange, disabled, compact,
  onSelect, onOpen, onRetry, onRename, onDelete, emptyAction }: Props) {
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "name", descending: false });
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const anchorRef = useRef<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  useEffect(() => { setQuery(""); setFocusedPath(null); anchorRef.current = null; }, [locationKey]);
  const chosen = useMemo(() => selection ?? (selected ? [selected] : []), [selection, selected]);
  const chosenPaths = new Set(chosen.map((entry) => entry.path));
  const visible = useMemo(() => {
    const needle = query.toLocaleLowerCase();
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    return entries.filter((entry) => (showHidden || !entry.name.startsWith("."))
      && entry.name.toLocaleLowerCase().includes(needle)).sort((left, right) => {
      const folders = Number(right.entry_type === "directory") - Number(left.entry_type === "directory");
      if (folders) return folders;
      const names = collator.compare(left.name, right.name);
      const value = sort.key === "size" ? (left.size ?? 0) - (right.size ?? 0)
        : sort.key === "modified_at" ? (Date.parse(left.modified_at || "") || 0) - (Date.parse(right.modified_at || "") || 0)
          : names;
      return (value || names) * (sort.descending ? -1 : 1);
    });
  }, [entries, query, showHidden, sort]);
  useEffect(() => {
    if (status !== "ready") return;
    const remaining = chosen.filter((entry) => visible.some((item) => item.path === entry.path));
    if (remaining.length !== chosen.length) {
      if (onSelectionChange) onSelectionChange(remaining);
      else onSelect(null);
    }
  }, [visible, chosen, status, onSelect, onSelectionChange]);
  const hiddenCount = entries.filter((entry) => entry.name.startsWith(".")).length;
  const focusPath = visible.some((entry) => entry.path === focusedPath) ? focusedPath
    : visible.find((entry) => chosenPaths.has(entry.path))?.path ?? visible[0]?.path;
  const choose = (entry: SftpDirectoryEntry, toggle = false, range = false) => {
    if (disabled) return;
    if (!onSelectionChange) { onSelect(entry); return; }
    const anchor = visible.findIndex((item) => item.path === anchorRef.current);
    if (range && anchor >= 0) {
      const end = visible.findIndex((item) => item.path === entry.path);
      const rangeEntries = visible.slice(Math.min(anchor, end), Math.max(anchor, end) + 1);
      onSelectionChange(toggle ? [...chosen.filter((item) => !rangeEntries.some((value) => value.path === item.path)), ...rangeEntries] : rangeEntries);
    } else {
      anchorRef.current = entry.path;
      onSelectionChange(toggle ? chosenPaths.has(entry.path) ? chosen.filter((item) => item.path !== entry.path) : [...chosen, entry] : [entry]);
    }
  };
  const clear = () => { if (onSelectionChange) onSelectionChange([]); else onSelect(null); };
  const changeSort = (key: SortKey) => setSort((previous) => ({ key, descending: previous.key === key && !previous.descending }));
  const sortButton = (key: SortKey, text: string) => (
    <button type="button" onClick={() => changeSort(key)} aria-label={`Sort ${label.toLowerCase()} by ${text.toLowerCase()}`}
      className={`inline-flex items-center gap-1 py-2 text-[11px] font-medium ${sort.key === key ? "text-sky-200" : "text-gray-400"}`}>
      {text}{sort.key === key && (sort.descending ? <LuArrowDown size={12} /> : <LuArrowUp size={12} />)}
      {sort.key === key && <span className="sr-only">{sort.descending ? "descending" : "ascending"}</span>}
    </button>
  );

  return <div className={`files-list flex min-h-0 min-w-0 flex-1 flex-col ${compact ? "files-list-compact" : ""}`}>
    <div className="mb-3 flex shrink-0 items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <LuSearch size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input aria-label={`Search ${label.toLowerCase()}`} placeholder="Filter by name…" value={query}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); setQuery(""); }
          }} className="h-9 w-full rounded-lg border border-white/10 bg-black/15 pl-9 pr-8 text-xs text-gray-200 placeholder:text-gray-500" />
        {query && <button type="button" aria-label={`Clear ${label.toLowerCase()} search`} onClick={() => setQuery("")}
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded text-gray-400 hover:text-white"><LuX size={14} /></button>}
      </div>
      <button type="button" aria-label={`Show hidden ${label.toLowerCase()}`} aria-pressed={showHidden}
        title={showHidden ? "Hide dotfiles" : "Show dotfiles"} onClick={() => setShowHidden(!showHidden)}
        className={`files-icon-button ${showHidden ? "border-sky-400/30 bg-sky-400/10 text-sky-200" : "text-gray-400"}`}>
        {showHidden ? <LuEye size={16} /> : <LuEyeOff size={16} />}
      </button>
    </div>
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-white/[0.08] bg-white/[0.015]" aria-busy={status === "loading"}>
      <div className="files-row sticky top-0 z-10 border-b border-white/[0.08] bg-[#0d1520] px-3" role="group" aria-label={`Sort ${label.toLowerCase()}`}>
        <span>{sortButton("name", "Name")}</span>
        <span className="text-right">{sortButton("size", "Size")}</span>
        {!compact && <><span className="files-modified">{sortButton("modified_at", "Modified")}</span><span className="files-mode py-2 text-[11px] text-gray-400">Permissions</span></>}
      </div>
      {(status === "loading" || status === "idle") ? <div role="status" className="flex min-h-40 flex-col items-center justify-center gap-3 p-5 text-xs text-gray-400">
        <LuRefreshCw size={23} className="animate-spin text-sky-300" />Loading files…
      </div> : status === "error" ? <div role="alert" className="flex min-h-40 flex-col items-center justify-center gap-3 p-5 text-center">
        <LuCircleAlert size={25} className="text-amber-300" /><p className="text-sm font-medium text-gray-100">Cannot open this folder</p>
        <p className="max-w-md break-words text-xs leading-5 text-gray-400">{error}</p>
        <button type="button" onClick={onRetry} disabled={disabled} className="files-button"><LuRefreshCw size={14} />Retry</button>
      </div> : visible.length === 0 ? <div role="status" className="flex min-h-40 flex-col items-center justify-center gap-2 p-5 text-center">
        {entries.length ? <LuSearch size={26} className="mb-1 text-gray-500" /> : <LuFolderOpen size={26} className="mb-1 text-sky-300" />}
        <p className="text-sm font-medium text-gray-200">{entries.length ? "No matching files" : "This folder is empty"}</p>
        <p className="text-xs text-gray-400">{entries.length ? "Try another name or show hidden files." : "Your files will appear here."}</p>
        {entries.length > 0 ? <button type="button" className="files-button mt-2" onClick={() => { setQuery(""); setShowHidden(true); }}>Show all files</button> : emptyAction}
      </div> : <div role="list" aria-label={label}>
        {visible.map((entry, index) => {
          const folder = entry.entry_type === "directory";
          const isSelected = chosenPaths.has(entry.path);
          return <div role="listitem" key={entry.path}>
            <button type="button" ref={(node) => { if (node) rowRefs.current.set(entry.path, node); else rowRefs.current.delete(entry.path); }}
              aria-label={entry.name} aria-pressed={isSelected} title={entry.name}
              tabIndex={focusPath === entry.path ? 0 : -1}
              onClick={(event) => choose(entry, event.ctrlKey || event.metaKey, event.shiftKey)}
              onFocus={() => { setFocusedPath(entry.path); if (!onSelectionChange && !disabled) onSelect(entry); }}
              onDoubleClick={(event) => { if (!disabled && !event.ctrlKey && !event.metaKey && !event.shiftKey) onOpen(entry); }}
              onKeyDown={(event) => {
                if (disabled) return;
                const modified = event.ctrlKey || event.metaKey;
                if (onSelectionChange && modified && event.key.toLowerCase() === "a") {
                  event.preventDefault(); onSelectionChange(visible); anchorRef.current = visible[0]?.path ?? null; return;
                }
                let next: number | undefined;
                if (event.key === "ArrowDown") next = Math.min(index + 1, visible.length - 1);
                if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
                if (event.key === "Home") next = 0;
                if (event.key === "End") next = visible.length - 1;
                if (next !== undefined) {
                  event.preventDefault();
                  if (!modified || event.shiftKey) choose(visible[next], modified, event.shiftKey);
                  rowRefs.current.get(visible[next].path)?.focus();
                }
                else if (event.key === "Enter") { event.preventDefault(); if (!disabled) onOpen(entry); }
                else if (event.key === " " && onSelectionChange) { event.preventDefault(); choose(entry, modified, event.shiftKey); }
                else if (event.key === "Escape") { event.preventDefault(); clear(); }
                else if (event.key === "F2" && onRename && chosen.length === 1) { event.preventDefault(); onRename(); }
                else if (event.key === "Delete" && onDelete && chosen.length === 1) { event.preventDefault(); onDelete(); }
              }}
              className={`files-row min-h-11 w-full border-b border-white/[0.04] px-3 text-left text-xs transition-colors ${isSelected ? "bg-sky-400/[0.12] shadow-[inset_2px_0_0_#38bdf8]" : "hover:bg-white/[0.04]"}`}>
              <span className="flex min-w-0 items-center gap-2.5">
                {folder ? <LuFolderOpen size={17} className="shrink-0 text-sky-300" /> : entry.entry_type === "symlink" ? <LuLink size={16} className="shrink-0 text-violet-300" /> : <LuFileText size={16} className="shrink-0 text-gray-500" />}
                <span className="truncate text-gray-200">{entry.name}</span>
              </span>
              <span className="text-right text-[11px] tabular-nums text-gray-400">{folder ? "—" : formatBytes(entry.size)}</span>
              {!compact && <><span className="files-modified truncate text-[11px] text-gray-400">{formatDate(entry.modified_at)}</span><span className="files-mode font-mono text-[11px] text-gray-400">{entry.permissions || "—"}</span></>}
            </button>
          </div>;
        })}
      </div>}
    </div>
    <div className="flex min-h-8 shrink-0 items-center justify-between gap-2 pt-2 text-[11px] text-gray-500">
      <span role="status">{status === "ready" ? `${visible.length} of ${entries.length} items${!showHidden && hiddenCount ? ` · ${hiddenCount} hidden` : ""}` : status === "error" ? "Folder unavailable" : "Loading…"}</span>
      <span className="truncate" title={chosen.length > 1 ? "Ctrl-click to toggle files; Shift-click to select a range" : selected?.name}>
        {chosen.length > 1 ? `${chosen.length} selected${chosen.some((entry) => entry.entry_type === "directory") ? " · Select files only to download" : ""}`
          : chosen[0]?.name || (compact ? "Select a file to upload" : onSelectionChange ? "Ctrl-click to select multiple · Enter to open" : "Double-click or Enter to open")}
      </span>
    </div>
  </div>;
}
