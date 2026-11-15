import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { useEffect, useRef, useState } from "react";
import { IoAdd, IoClose, IoRefresh, IoSearchOutline } from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { getApiBase } from "../api";
import { canFillTerminalPane } from "../features/workspace/groups";
import { useAppStore, type Host } from "../state/store";
import HostFormModal from "./HostFormModal";

export default function PaneConnectionPicker({ groupId, index, onClose }: { groupId: string; index: number; onClose: () => void }) {
  const { hosts, loading, error, tabs, transfers } = useAppStore(useShallow((state) => ({
    hosts: state.hosts, loading: state.hostsLoading, error: state.hostsError, tabs: state.terminalTabs, transfers: state.terminalTransfers,
  })));
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [apiBase, setApiBase] = useState("");
  const choosing = useRef(false);
  const reload = () => { void useAppStore.getState().fetchHosts().catch(() => {}); };
  useEffect(() => {
    reload();
    void useAppStore.getState().refreshVaultStatus();
    let disposed = false;
    void getApiBase().then((base) => { if (!disposed) setApiBase(base); }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  const close = () => {
    useAppStore.setState({ pendingTerminalGroupId: null, pendingTerminalPaneIndex: null });
    onClose();
  };
  const available = () => {
    const state = useAppStore.getState();
    if (choosing.current || Object.keys(state.terminalTransfers).length) return false;
    if (!canFillTerminalPane(state.terminalGroups.find((group) => group.id === groupId), index)) {
      state.addToast("This pane is no longer empty. Choose another pane.", "error");
      close();
      return false;
    }
    return true;
  };
  const connect = (host: Host) => {
    if (!available()) return;
    choosing.current = true;
    const state = useAppStore.getState();
    useAppStore.setState({ pendingTerminalGroupId: groupId, pendingTerminalPaneIndex: index });
    state.addTerminalTab(host);
    state.setActiveView("terminal");
    void state.addRecentConnection(host);
    close();
  };
  const query = search.trim().toLocaleLowerCase();
  const matches = (host: Host) => `${host.name} ${host.hostname} ${host.group ?? ""}`.toLocaleLowerCase().includes(query);
  const busy = Object.keys(transfers).length > 0;
  return <>
    <Dialog open={!formOpen} onClose={close} className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md">
      <DialogPanel className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden ui-dialog rounded-dialog text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <DialogTitle className="text-sm font-semibold">Choose a connection for pane {index + 1}</DialogTitle>
          <button aria-label="Close connection picker" onClick={close} className="terminal-tab-action"><IoClose size={18} /></button>
        </div>
        <div className="flex gap-2 px-5 py-3">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 px-3 text-slate-500"><IoSearchOutline /><input autoFocus aria-label="Search connections" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search connections" className="h-9 min-w-0 flex-1 bg-transparent text-xs text-slate-200 outline-none" /></label>
          <button aria-label="Refresh connections" disabled={loading} onClick={reload} className="terminal-tab-action h-9 w-9"><IoRefresh size={16} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 pb-4">
          {tabs.filter((tab) => matches(tab.host)).length > 0 && <>
            <p className="py-2 text-[10px] uppercase tracking-wide text-slate-500">Open sessions in this window</p>
            {tabs.filter((tab) => matches(tab.host)).map((tab) => <button key={tab.id} disabled={busy} onClick={() => {
              if (!available()) return;
              if (useAppStore.getState().insertTerminalPane(groupId, index, tab.id)) close();
            }} className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-xs hover:bg-white/[0.05] disabled:opacity-40"><span>{tab.host.name}</span><span className="text-[10px] text-blue-300">Move here</span></button>)}
          </>}
          <p className="py-2 text-[10px] uppercase tracking-wide text-slate-500">Saved connections</p>
          {loading && <p role="status" className="py-2 text-xs text-slate-400">Loading connections...</p>}
          {error && <p role="alert" className="py-2 text-xs text-rose-300">{error}</p>}
          {hosts.filter(matches).map((host) => <button key={host.id} disabled={busy} onClick={() => connect(host)} className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-white/[0.05] disabled:opacity-40"><span className="min-w-0"><span className="block truncate text-xs">{host.name}</span><span className="mt-1 block truncate font-mono text-[10px] text-slate-500">{host.hostname}:{host.port}</span></span><span className="text-[10px] uppercase text-blue-300">{host.connection_type}</span></button>)}
          {!loading && !error && !hosts.filter(matches).length && <p className="py-3 text-xs text-slate-500">No saved connections found.</p>}
        </div>
        <div className="border-t border-white/[0.06] px-5 py-3"><button disabled={!apiBase || busy} onClick={() => setFormOpen(true)} className="inline-flex items-center gap-2 rounded-lg border border-blue-400/20 bg-blue-400/10 px-3 py-2 text-xs text-blue-200 disabled:opacity-40"><IoAdd /> New connection / Quick Connect</button></div>
      </DialogPanel>
    </Dialog>
    {formOpen && <HostFormModal isOpen onClose={() => setFormOpen(false)} onSave={() => { setFormOpen(false); reload(); }} apiBase={apiBase} onQuickConnect={(host) => connect({ ...host, id: -1 })} />}
  </>;
}
