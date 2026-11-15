import React from "react";
import { createPortal } from "react-dom";
import { VscLinkExternal } from "react-icons/vsc";
import { IoAdd, IoClose, IoExpandOutline, IoTerminalOutline } from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../state/store";
import { findTerminalGroup, terminalGroupSlots, visibleTerminalSlots } from "../features/workspace/groups";
import TerminalCanvas from "./TerminalCanvas";
import TerminalLayoutControl from "./TerminalLayoutControl";
import { useTerminalPaneDrag } from "../terminal/useTerminalPaneDrag";

export default function TerminalWorkspace({ onBack, onAddConnection }: { onBack: () => void; onAddConnection?: (index: number) => void }) {
  const { tabs, active, setActive, layout: savedLayout, setLayout, statuses, transfers, groups, closures } = useAppStore(
    useShallow((state) => ({
      tabs: state.terminalTabs,
      active: state.activeTabId,
      setActive: state.setActiveTabId,
      layout: state.terminalLayout,
      setLayout: state.setTerminalLayout,
      statuses: state.tabStatuses,
      transfers: state.terminalTransfers,
      closures: state.terminalClosures,
      groups: state.terminalGroups,
    })),
  );
  const group = findTerminalGroup(groups, active);
  const paneDrag = useTerminalPaneDrag();
  // Every member needs a live renderer for the handoff's capture/replay barrier.
  const movingGroup = group?.tabIds.every((id) => transfers[id]);
  const layout = movingGroup && group && group.tabIds.length > 1
    ? terminalGroupSlots(group).slice(2).some(Boolean) ? "grid" : savedLayout === "single" ? "columns" : savedLayout : savedLayout;
  const split = layout !== "single";
  const moving = Object.keys(transfers).length > 0;
  const panes = React.useMemo(() => group ? visibleTerminalSlots(group, active, layout) : active ? [active] : [], [group, active, layout]);
  // Once shown, a session owns the same renderer until its tab closes or moves
  // to another window. Hiding it must not rebuild xterm from a truncated replay.
  const [opened, setOpened] = React.useState<ReadonlySet<string>>(() => new Set(panes.filter((id): id is string => !!id)));
  React.useEffect(() => {
    setOpened((previous) => {
      const next = new Set(tabs.filter((tab) => previous.has(tab.id) || panes.includes(tab.id)).map((tab) => tab.id));
      return next.size === previous.size && [...next].every((id) => previous.has(id)) ? previous : next;
    });
  }, [tabs, panes]);
  const renderedTabs = tabs.filter((tab) => opened.has(tab.id) || panes.includes(tab.id));
  const panePosition = (index: number) => ({
    gridColumn: layout === "columns" || layout === "grid" ? index % 2 + 1 : 1,
    gridRow: layout === "rows" ? index + 1 : layout === "grid" ? Math.floor(index / 2) + 1 : 1,
  });
  const chooseConnection = (index: number) => {
    onAddConnection?.(index);
    useAppStore.getState().reserveTerminalPane(index);
  };

  const closeSession = (id: string) => {
    const state = useAppStore.getState();
    const tab = state.terminalTabs.find((item) => item.id === id);
    if (!tab || state.terminalTransfers[id]) return;
    if (state.settings.security.confirmBeforeDisconnect
      && (tab.isConnected || state.tabStatuses[id] === "connected" || state.tabStatuses[id] === "connecting")) {
      state.showConfirm({
        title: "Active Connection",
        message: "This tab has an active connection. Are you sure you want to close it? All unsaved work will be lost.",
        confirmText: "Close Connection", cancelText: "Stay Connected", type: "danger",
        onConfirm: () => useAppStore.getState().removeTerminalTab(id),
      });
    } else state.removeTerminalTab(id);
  };

  const focusPane = (event: React.SyntheticEvent<HTMLElement>, id: string) => {
    if (event.target instanceof Element && event.target.closest("[data-terminal-workspace-controls]")) return;
    if (active !== id) setActive(id);
  };

  return (
    <div data-terminal-workspace className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-terminal-workspace-controls className="terminal-workspace-toolbar shrink-0 border-b border-[var(--terminal-chrome-border)] bg-[var(--terminal-chrome-bg)]">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-0.5">
          <p className="whitespace-nowrap text-[10px] text-slate-500" aria-live="polite">
            {panes.filter(Boolean).length} of {tabs.length} session{tabs.length === 1 ? "" : "s"} visible
          </p>
          <TerminalLayoutControl value={layout} onChange={setLayout} disabled={moving || !!paneDrag.preview} />
        </div>
      </div>
      <div
        data-terminal-pane-grid
        data-layout={layout}
        className={`grid min-h-0 min-w-0 flex-1 bg-[#080d15] ${split ? "gap-2 p-2" : "gap-0"} ${layout === "columns" ? "grid-cols-2 grid-rows-1" : layout === "rows" ? "grid-cols-1 grid-rows-2" : layout === "grid" ? "grid-cols-2 grid-rows-2" : "grid-cols-1 grid-rows-1"}`}
      >
        {panes.map((id, index) => !id ? (
            <div key={`empty-${index}`} data-terminal-empty-pane={index + 1} data-terminal-group-id={group?.id} data-terminal-pane-index={index}
              style={panePosition(index)}
              aria-label={`Empty terminal pane ${index + 1}`} className="terminal-empty-pane flex min-h-0 min-w-0 items-center justify-center overflow-auto rounded-lg border border-dashed border-slate-500/20 bg-[#0b121d] p-4 text-center">
              <div className="my-auto flex flex-col items-center">
                <span aria-hidden="true" className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.025] text-slate-500"><IoTerminalOutline size={18} /></span>
                <p className="text-xs font-medium text-slate-400">Pane {index + 1} is ready</p>
                <p className="mt-1 text-[11px] text-slate-500">Drop a session here</p>
                {onAddConnection && <button type="button" disabled={moving} aria-label={`Choose a connection for pane ${index + 1}`} onClick={() => chooseConnection(index)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-400/20 bg-blue-500/[0.07] px-3 text-[11px] font-medium text-blue-300 transition-colors hover:border-blue-400/40 hover:bg-blue-500/[0.14] disabled:opacity-40">
                  <IoAdd size={14} /> Choose a connection
                </button>}
              </div>
            </div>
          ) : null)}
        {renderedTabs.map((tab) => {
          const id = tab.id;
          const index = panes.indexOf(id);
          const visible = index >= 0;
          const status = statuses[id] ?? (tab.isConnected ? "connected" : "disconnected");
          return (
            <section
              key={id}
              data-terminal-pane={visible ? id : undefined}
              data-active={active === id}
              data-split={split}
              hidden={!visible}
              style={visible ? panePosition(index) : { display: "none" }}
              aria-label={visible ? `Terminal pane ${index + 1}: ${tab.host.name}` : `Terminal: ${tab.host.name}`}
              onFocusCapture={(event) => focusPane(event, id)}
              onPointerDownCapture={(event) => focusPane(event, id)}
              className={`terminal-workspace-pane relative flex min-h-0 min-w-0 flex-col bg-[#0d1117] ${split ? "overflow-hidden rounded-lg border" : ""}`}
            >
              {split && visible && (
                <div data-terminal-workspace-controls className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--terminal-chrome-border)] bg-[var(--terminal-chrome-bg)] px-2 text-xs">
                  <button type="button" data-terminal-pane-drag-handle={id} disabled={moving}
                    aria-label={`Drag ${tab.host.name} to move this session`}
                    title="Drag this session to a tab strip, an empty pane, or outside the window"
                    onPointerDown={(event) => paneDrag.start(event, id)}
                    className="flex h-6 w-7 shrink-0 touch-none cursor-grab items-center justify-center rounded-md border border-transparent bg-white/[0.04] font-mono text-[10px] text-slate-400 hover:border-blue-400/25 hover:text-blue-200 active:cursor-grabbing disabled:cursor-wait disabled:opacity-40">
                    <span aria-hidden="true">⠿</span><span className="ml-0.5">{index + 1}</span>
                  </button>
                  <span title={status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : status === "error" ? "Connection failed" : "Disconnected"} className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === "connected" ? "bg-emerald-400" : status === "connecting" ? "bg-amber-300" : status === "error" ? "bg-rose-400" : "bg-slate-500"}`} />
                  <select
                    aria-label={`Session in pane ${index + 1}`}
                    value={id}
                    disabled={moving}
                    onChange={(event) => {
                      if (group) useAppStore.getState().replaceTerminalPane(group.id, id, event.target.value);
                    }}
                    className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent py-1 pl-1 text-[11px] text-slate-300 outline-none hover:bg-white/[0.04] disabled:opacity-50"
                  >
                    {tabs.filter((item) => item.id === id || !findTerminalGroup(groups, item.id)).map((item) => (
                      <option key={item.id} value={item.id}>{item.host.name}</option>
                    ))}
                  </select>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button type="button" disabled={moving} title="Move this session to a separate window" aria-label={`Detach ${tab.host.name}`}
                      className="terminal-tab-action" onClick={() => paneDrag.detach(id)}><VscLinkExternal size={13} /></button>
                    <button
                      type="button" disabled={moving} title="Show only this terminal" aria-label={`Maximize ${tab.host.name}`}
                      className="terminal-tab-action"
                      onClick={() => useAppStore.getState().maximizeTerminalPane(id)}
                    >
                      <IoExpandOutline size={13} />
                    </button>
                    <button
                      type="button" disabled={moving} title="Close session" aria-label={`Close ${tab.host.name}`}
                      className="terminal-tab-action terminal-tab-close" onClick={() => closeSession(id)}
                    >
                      <IoClose size={15} />
                    </button>
                  </div>
                </div>
              )}
              <div className="min-h-0 min-w-0 flex-1">
                <TerminalCanvas tabId={id} host={tab.host} onBack={onBack} />
              </div>
              {closures[id] && <div role="status" className="absolute inset-0 z-[70] flex flex-col items-center justify-center gap-4 bg-[#0d1117]/95 p-6 text-center text-sm text-slate-200">
                <p>{closures[id] === "closing" ? "Closing session..." : "Session closure could not be confirmed."}</p>
                {closures[id] === "failed" && <>
                  <p className="max-w-sm text-xs text-slate-400">The backend may be unreachable. Keep this tab open and retry closing it.</p>
                  <button type="button" className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2 text-red-200" onClick={() => void useAppStore.getState().removeTerminalTab(id)}>Retry closing</button>
                </>}
              </div>}
            </section>
          );
        })}
      </div>
      {paneDrag.preview && createPortal(<div aria-hidden="true" data-terminal-pane-drag-preview className="pointer-events-none fixed z-[150] flex max-w-xs items-center gap-2 rounded-xl border border-blue-400/40 bg-[#122037] px-4 py-3 text-xs text-blue-100 shadow-2xl" style={{ left: paneDrag.preview.x + 16, top: paneDrag.preview.y + 18 }}><VscLinkExternal size={14} /><span className="truncate">{paneDrag.preview.title}</span></div>, document.body)}
    </div>
  );
}
