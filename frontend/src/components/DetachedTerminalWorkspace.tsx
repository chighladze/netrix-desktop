import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useAppStore } from "../state/store";
import { findTerminalGroup, terminalStripEntries } from "../features/workspace/groups";
import { TerminalMoveCancelledError } from "../terminal/windowHandoff";
import { moveTerminalGroup } from "../terminal/moveTerminalPane";
import type { DockPlacement } from "../terminal/docking";
import DetachedTerminalFrame from "./DetachedTerminalFrame";
import TerminalWorkspace from "./TerminalWorkspace";
import TerminalTransferOverlay from "./TerminalTransferOverlay";
import ToastContainer from "./ToastContainer";
import ConfirmModal from "./ConfirmModal";
import PaneConnectionPicker from "./PaneConnectionPicker";
import TerminalDockTarget from "./TerminalDockTarget";
import TerminalTabsBar from "./TerminalTabsBar";
import QuickActionBar from "./QuickActionBar";

export default function DetachedTerminalWorkspace({ allowClose }: { allowClose: MutableRefObject<boolean> }) {
  const tabs = useAppStore((state) => state.terminalTabs);
  const active = useAppStore((state) => state.activeTabId);
  const statuses = useAppStore((state) => state.tabStatuses);
  const groups = useAppStore((state) => state.terminalGroups);
  const [closing, setClosing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [returning, setReturning] = useState(false);
  const [picker, setPicker] = useState<{ groupId: string; index: number } | null>(null);
  const closingSessions = useRef(false);
  const returningAll = useRef(false);
  const hadTabs = useRef(false);
  const title = tabs.map((tab) => tab.host.name).join(" + ") || "Terminal group";
  const entries = terminalStripEntries(tabs, groups);
  const showTabs = entries.length > 1 || entries.some((entry) => !entry.group);
  const returnToMain = useCallback(async (placement?: DockPlacement) => {
    const state = useAppStore.getState();
    if (!state.activeTabId || returningAll.current || closingSessions.current || Object.keys(state.terminalTransfers).length) return;
    const entries = terminalStripEntries(state.terminalTabs, state.terminalGroups);
    const selected = entries.find((entry) => entry.tab.id === state.activeTabId || entry.group?.tabIds.includes(state.activeTabId!));
    if (!selected) return;
    returningAll.current = true;
    setReturning(true);
    setClosing(false);
    try {
      if (placement?.pane && state.terminalTabs.length > 1) throw new Error("Return individual sessions to an empty pane.");
      // Return independent tabs/groups through the existing bounded handoff,
      // keeping the selected entry last so it stays active in the destination.
      for (const entry of [...entries.filter((item) => item !== selected), selected]) {
        if (useAppStore.getState().terminalTabs.some((tab) => tab.id === entry.tab.id)) {
          await moveTerminalGroup(entry.tab.id, placement ?? { windowLabel: "main", beforeTabId: null });
        }
      }
    } catch (error) {
      allowClose.current = false;
      if (!(error instanceof TerminalMoveCancelledError)) state.addToast(error instanceof Error ? error.message : "Could not return terminal group", "error");
    } finally {
      returningAll.current = false;
      setReturning(false);
    }
  }, [allowClose]);
  const requestClose = useCallback(() => {
    if (!closingSessions.current && !returningAll.current && !Object.keys(useAppStore.getState().terminalTransfers).length) setClosing(true);
  }, []);
  const disconnectAll = async () => {
    const state = useAppStore.getState();
    if (closingSessions.current || returningAll.current || Object.keys(state.terminalTransfers).length) return;
    closingSessions.current = true;
    setDisconnecting(true);
    try {
      await Promise.all(tabs.map((tab) => state.removeTerminalTab(tab.id)));
      setClosing(false);
    } catch (error) {
      state.addToast(error instanceof Error ? error.message : "Could not disconnect terminal group", "error");
    } finally {
      closingSessions.current = false;
      setDisconnecting(false);
    }
  };
  useEffect(() => {
    let disposed = false;
    let stop = () => {};
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (allowClose.current) void invoke("close_terminal_window");
      else requestClose();
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop(); };
  }, [allowClose, requestClose]);
  useEffect(() => {
    if (tabs.length) hadTabs.current = true;
    else if (hadTabs.current) { allowClose.current = true; void invoke("close_terminal_window"); }
  }, [tabs.length, allowClose]);
  return <div data-terminal-dock-surface className="terminal-window-root relative flex h-screen flex-col overflow-hidden bg-transparent">
    {active && <TerminalTransferOverlay tabId={active} />}
    <DetachedTerminalFrame title={title} sessionCount={tabs.length} isConnected={tabs.some((tab) => statuses[tab.id] === "connected")} onReturn={returnToMain} onClose={requestClose}>
      {showTabs && <TerminalTabsBar disabled={returning || disconnecting} onDetachTab={moveTerminalGroup} />}
      {tabs.length ? <TerminalWorkspace onBack={() => {}} onAddConnection={(index) => {
        const group = findTerminalGroup(useAppStore.getState().terminalGroups, useAppStore.getState().activeTabId);
        if (group) setPicker({ groupId: group.id, index });
      }} /> : <div role="status" className="p-6 text-sm text-slate-400">Preparing terminal group...</div>}
      <QuickActionBar rounded={false} />
    </DetachedTerminalFrame>
    <ConfirmModal />
    <ToastContainer />
    <TerminalDockTarget enabled={!picker && !closing && !disconnecting && !returning} tabPosition="top" allowTabStrip={showTabs} />
    {picker && <PaneConnectionPicker {...picker} onClose={() => setPicker(null)} />}
    <Dialog open={closing} onClose={() => { if (!disconnecting) setClosing(false); }} className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md">
      <DialogPanel className="w-full max-w-sm ui-dialog rounded-dialog p-5 text-slate-200 shadow-2xl">
        <DialogTitle className="text-sm font-semibold">Close terminal group?</DialogTitle>
        <p className="mt-3 text-xs leading-5 text-slate-400">Return all {tabs.length} sessions to the main window, or disconnect them and close this window.</p>
        <div className="mt-5 flex flex-col gap-2 text-xs">
          <button disabled={disconnecting} className="rounded-lg border border-blue-400/25 bg-blue-400/10 p-3 text-blue-200 disabled:opacity-50" onClick={() => void returnToMain()}>Return to main window</button>
          <button disabled={disconnecting} className="rounded-lg border border-red-400/25 bg-red-400/10 p-3 text-red-200 disabled:opacity-50" onClick={() => void disconnectAll()}>{disconnecting ? "Disconnecting..." : "Disconnect all sessions"}</button>
          <button disabled={disconnecting} className="rounded-lg p-3 text-slate-400 disabled:opacity-50" onClick={() => setClosing(false)}>Cancel</button>
        </div>
      </DialogPanel>
    </Dialog>
  </div>;
}
