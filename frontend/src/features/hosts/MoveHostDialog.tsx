import { Dialog, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import { useState } from "react";
import type { SavedHostDto } from "../../types/host";
import { useAppStore } from "../../state/store";
import { normalizeGroupPath } from "../../utils/groupUtils";

export default function MoveHostDialog({ host, groups, onClose }: { host: SavedHostDto; groups: string[]; onClose: () => void }) {
  const [group, setGroup] = useState(normalizeGroupPath(host.group));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Dialog open onClose={() => { if (!busy) onClose(); }} className="relative z-[100]">
    <div className="fixed inset-0 bg-black/60" aria-hidden="true" />
    <div className="fixed inset-0 flex items-center justify-center p-4">
      <DialogPanel className="ui-dialog w-full max-w-md p-5 shadow-2xl">
        <form onSubmit={(event) => {
          event.preventDefault();
          if (busy || group === normalizeGroupPath(host.group)) return;
          setBusy(true); setError("");
          void useAppStore.getState().moveHostToGroup(host.id, group || null).then(() => {
            useAppStore.getState().addToast(`Moved ${host.name} to ${group || "Ungrouped"}`, "success"); onClose();
          }).catch((reason: unknown) => {
            setError(reason instanceof Error ? reason.message : "Could not move host"); setBusy(false);
          });
        }}>
          <DialogTitle className="text-base font-semibold text-white">Move host</DialogTitle>
          <Description className="mt-2 break-words text-sm text-gray-400">Choose a folder for {host.name}.</Description>
          <label className="mt-4 block text-xs text-gray-400">Destination folder
            <select autoFocus disabled={busy} value={group} onChange={(event) => setGroup(event.target.value)} className="ui-input mt-2">
              <option value="">Ungrouped</option>{groups.map((path) => <option key={path} value={path}>{path}</option>)}
            </select>
          </label>
          {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
          <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className="ui-button">Cancel</button><button disabled={busy || group === normalizeGroupPath(host.group)} className="ui-button ui-button-primary">{busy ? "Moving…" : "Move host"}</button></div>
        </form>
      </DialogPanel>
    </div>
  </Dialog>;
}
