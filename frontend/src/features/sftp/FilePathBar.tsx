import { useEffect, useState, type RefObject } from "react";
import { LuArrowLeft, LuArrowRight, LuArrowUp, LuHouse, LuRefreshCw } from "react-icons/lu";
import type { DirectoryHistory } from "./api";

interface Props {
  label: string;
  path: string;
  home: string;
  parent: string | null;
  history?: DirectoryHistory;
  disabled?: boolean;
  busy?: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onNavigate: (path: string, historyIndex?: number) => void;
}

export default function FilePathBar({ label, path, home, parent, history, disabled, busy, inputRef, onNavigate }: Props) {
  const [draft, setDraft] = useState(path);
  useEffect(() => setDraft(path), [path]);
  const button = "inline-flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-white/5 hover:text-white disabled:opacity-25";
  return <form className="mb-3 flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-black/15 p-1"
    onSubmit={(event) => { event.preventDefault(); if (!disabled && !busy && draft) onNavigate(draft); }}>
    <button type="button" className={button} aria-label={`${label} back`} title="Back"
      disabled={disabled || busy || !history || history.index <= 0}
      onClick={() => history && onNavigate(history.paths[history.index - 1], history.index - 1)}><LuArrowLeft size={15} /></button>
    <button type="button" className={button} aria-label={`${label} forward`} title="Forward"
      disabled={disabled || busy || !history || history.index >= history.paths.length - 1}
      onClick={() => history && onNavigate(history.paths[history.index + 1], history.index + 1)}><LuArrowRight size={15} /></button>
    <button type="button" className={button} aria-label={`${label} parent folder`} title="Parent folder"
      disabled={disabled || busy || parent === null || parent === path} onClick={() => parent !== null && onNavigate(parent)}><LuArrowUp size={15} /></button>
    <button type="button" className={button} aria-label={`${label} home`} title="Home"
      disabled={disabled || busy} onClick={() => onNavigate(home)}><LuHouse size={15} /></button>
    <input ref={inputRef} aria-label={`${label} directory path`} title="Enter a path · Ctrl+L" spellCheck={false}
      value={draft} onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setDraft(path); event.currentTarget.blur(); } }}
      className="h-8 min-w-0 flex-1 rounded border-0 bg-transparent px-2 font-mono text-xs text-gray-200" />
    <button type="submit" aria-label={`Go to ${label.toLowerCase()} path`} title="Go to path" disabled={disabled || busy || !draft} className={button}><LuArrowRight size={15} /></button>
    <button type="button" aria-label={`Refresh ${label.toLowerCase()} files`} title="Refresh" disabled={disabled || busy}
      className={button} onClick={() => onNavigate(path)}><LuRefreshCw size={14} className={busy ? "animate-spin" : ""} /></button>
  </form>;
}
