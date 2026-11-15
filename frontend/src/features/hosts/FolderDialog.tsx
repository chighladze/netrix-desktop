import { Description, Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { useState } from "react";
import { IoFolderOutline, IoArrowForward } from "react-icons/io5";
import { getGroupName, getParentPath } from "../../utils/groupUtils";
import { inFolder, validateFolderDestination } from "./folders";

export interface FolderOperation { mode: "create" | "rename" | "move"; path: string }
export default function FolderDialog({ operation, paths, hostCount, onSubmit, onClose }: {
  operation: FolderOperation; paths: string[]; hostCount: number;
  onSubmit: (destination: string) => Promise<void>; onClose: () => void;
}) {
  const { mode, path } = operation;
  const [name, setName] = useState(mode === "create" ? "" : getGroupName(path));
  const [parent, setParent] = useState(mode === "create" ? path : getParentPath(path) || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const destination = [parent, name.trim()].filter(Boolean).join("/");
  const title = mode === "create" ? "New folder" : mode === "rename" ? "Rename folder" : "Move folder";
  return <Dialog open onClose={() => { if (!busy) onClose(); }} className="relative z-[150]">
    <div className="fixed inset-0 bg-black/65" aria-hidden="true" />
    <div className="fixed inset-0 flex items-center justify-center p-4">
      <DialogPanel className="ui-dialog hosts-workspace max-h-[calc(100dvh-32px)] w-full max-w-md overflow-y-auto rounded-dialog p-5 shadow-2xl">
        <form onSubmit={async event => {
          event.preventDefault(); if (busy) return;
          const invalid = !name.trim() || name.includes("/") ? "Enter one folder name without /." : validateFolderDestination(mode === "create" ? null : path, destination, paths);
          if (invalid) { setError(invalid); return; }
          setBusy(true); setError("");
          try { await onSubmit(destination); onClose(); }
          catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update folder"); setBusy(false); }
        }}>
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-sky-400/20 bg-sky-400/10 text-sky-300"><IoFolderOutline size={19} /></div>
          <DialogTitle className="text-base font-semibold text-white">{title}</DialogTitle>
          <Description className="mt-2 text-xs leading-5 text-slate-400">{mode === "create" ? "Organize your connections into a folder." : `Includes all subfolders and ${hostCount} saved host${hostCount === 1 ? "" : "s"}. Connections stay open.`}</Description>
          {mode !== "move" && <label className="mt-4 block text-xs text-slate-400">Folder name
            <input autoFocus disabled={busy} value={name} onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} placeholder="e.g. Production" className="ui-input mt-2" />
          </label>}
          {mode !== "rename" && <label className="mt-4 block text-xs text-slate-400">Parent folder
            <select autoFocus={mode === "move"} disabled={busy} value={parent} onChange={event => setParent(event.target.value)} className="ui-input mt-2">
              <option value="">Root</option>{paths.filter(candidate => mode === "create" || !inFolder(candidate, path)).map(candidate => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>
          </label>}
          <div className="mt-4 rounded-lg border border-white/[0.06] bg-white/[0.025] p-3 text-xs">
            {mode !== "create" && <p className="mb-2 break-all text-slate-500">{path}</p>}
            <p className="flex items-start gap-2 text-sky-200"><IoArrowForward className="mt-0.5 shrink-0" /><span className="break-all">{destination || "Folder path"}</span></p>
          </div>
          {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="ui-button">Cancel</button><button disabled={busy || !name.trim() || (mode !== "create" && destination === path)} className="ui-button ui-button-primary">{busy ? "Saving…" : mode === "create" ? "Create folder" : "Save changes"}</button></div>
        </form>
      </DialogPanel>
    </div>
  </Dialog>;
}
