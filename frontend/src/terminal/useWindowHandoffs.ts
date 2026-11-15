import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, type MutableRefObject } from "react";
import { useAppStore } from "../state/store";
import type { Host } from "../types/host";
import { ensureTerminalSessionController, getTerminalSessionController } from "./TerminalSessionController";
import { HANDOFF_EVENT, receiveTerminalWindow, TerminalMoveCancelledError, type HandoffAddress, type HandoffMessage, type HandoffOffer, type PreparedHandoff } from "./windowHandoff";
import { placeTerminalTab } from "./docking";
import { canFillTerminalPane, terminalGroupSlots } from "../features/workspace/groups";

export function waitForTerminalRenderer(tabId: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const finish = (error?: Error) => {
      stop(); clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error("Terminal move cancelled."));
    const timer = setTimeout(() => finish(new Error("The terminal view is not ready. Select it and try again.")), 5_000);
    const check = () => { if (useAppStore.getState().terminalInstances[tabId]) finish(); };
    stop = useAppStore.subscribe(check);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort(); else check();
  });
}

function waitForTerminalCapture(signal: AbortSignal, offer?: HandoffOffer): Promise<void> {
  const sessionIds = new Set((offer?.workspace?.terminals ?? (offer ? [offer] : [])).flatMap((terminal) =>
    typeof terminal.session.sessionId === "number" ? [terminal.session.sessionId] : []));
  return new Promise((resolve, reject) => {
    let stop = () => {};
    const finish = (cancelled = false) => {
      stop();
      signal.removeEventListener("abort", abort);
      if (cancelled) reject(new TerminalMoveCancelledError()); else resolve();
    };
    const abort = () => finish(true);
    const check = () => {
      const state = useAppStore.getState();
      const conflict = Object.entries(state.terminalTransfers).some(([id, transfer]) => {
        const sid = state.sessionIds[id];
        return transfer.direction === "incoming" || transfer.phase === "preparing" || (typeof sid === "number" && sessionIds.has(sid));
      });
      if (!conflict) finish();
    };
    stop = useAppStore.subscribe(check);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else check();
  });
}

export async function prepareWorkspaceHandoff(offer: HandoffOffer, cancel: () => void, allowStandalone = false): Promise<PreparedHandoff> {
  const incoming = offer.workspace?.terminals ?? [offer];
  const destination = offer.placement?.pane;
  if ((!offer.workspace && !destination && !allowStandalone) || !incoming.length || incoming.length > 4
    || new Set(incoming.map((terminal) => terminal.originTabId)).size !== incoming.length) {
    throw new Error("Invalid terminal workspace.");
  }
  const state = useAppStore.getState();
  if (Object.values(state.terminalTransfers).some((transfer) => transfer.direction === "incoming" || transfer.phase === "preparing")
    || incoming.some((terminal) => terminal.session.sessionId !== null && state.terminalTabs.some((tab) => state.sessionIds[tab.id] === terminal.session.sessionId && state.terminalTransfers[tab.id]))) {
    throw new Error("Finish the current terminal move first.");
  }
  if (destination && (incoming.length !== 1 || !canFillTerminalPane(state.terminalGroups.find((group) => group.id === destination.groupId), destination.index))) {
    throw new Error("The destination pane is no longer empty. Your session is still in its original window.");
  }
  if (destination && state.terminalGroups.find((group) => group.id === destination.groupId)?.tabIds.some((id) => state.terminalTransfers[id])) {
    // Refuse before allocating a speculative tab: this group may disappear as
    // its outgoing handoff completes, even though the requested cell is empty.
    throw new Error("The destination workspace is being moved. Your session is still in its original window.");
  }
  const previous = { active: state.activeTabId, view: state.activeView, groups: state.terminalGroups, layout: state.terminalLayout, tabs: state.terminalTabs };
  useAppStore.setState({ pendingTerminalGroupId: null, pendingTerminalPaneIndex: null });
  const members = incoming.map((terminal) => {
    const sid = terminal.session.sessionId;
    const existing = sid ? useAppStore.getState().terminalTabs.find((tab) => useAppStore.getState().sessionIds[tab.id] === sid) : undefined;
    const id = existing?.id ?? state.addTerminalTab(terminal.host, sid ?? undefined);
    const controller = getTerminalSessionController(id) ?? ensureTerminalSessionController(id, { host: terminal.host });
    if (!existing) controller.prepareIncomingHandoff(terminal.view, terminal.session);
    state.setSessionId(id, sid);
    return { id, existing, controller, origin: terminal.originTabId };
  });
  if (destination) {
    if (!state.insertTerminalPane(destination.groupId, destination.index, members[0].id)) throw new Error("Could not insert the terminal into this pane.");
  } else if (offer.workspace) {
    const remap = (id: string | null) => members.find((member) => member.origin === id)?.id ?? null;
    state.setTerminalGroup({ ...offer.workspace.group, tabIds: members.map((member) => member.id), paneSlots: terminalGroupSlots(offer.workspace.group).map(remap) });
  }
  state.setActiveTabId(members.find((member) => member.origin === (offer.workspace?.activeTabId ?? offer.originTabId))?.id ?? members[0].id);
  for (const { id } of members) state.setTerminalTransfer(id, { direction: "incoming", phase: "connecting", cancel });
  state.setActiveView("terminal");
  if (offer.placement && !destination) {
    // Insert the members together, retaining their pane order.
    for (const member of members) state.reorderTerminalTabs(placeTerminalTab(useAppStore.getState().terminalTabs, member.id, offer.placement, previous.groups));
  }
  return {
    ready: async (signal) => {
      await Promise.all(members.map(async ({ id, existing, controller }) => {
        await waitForTerminalRenderer(id, signal);
        if (existing) {
          if (controller.getSnapshot().status !== "connected") throw new Error("The existing terminal is no longer connected.");
          await controller.captureView();
        } else await controller.waitForHandoffReady(signal);
      }));
    },
    commit: async () => {
      if (destination && terminalGroupSlots(useAppStore.getState().terminalGroups.find((group) => group.id === destination.groupId) ?? { id: "", layout: "single", tabIds: [] })[destination.index] !== members[0].id) {
        throw new Error("The destination pane changed while moving the terminal.");
      }
      const win = getCurrentWindow();
      await win.show();
      await win.unminimize().catch(() => {});
      for (const { id, controller } of members) {
        controller.commitIncomingHandoff();
        state.setTerminalTransfer(id, null);
      }
      await win.setFocus().catch(() => {});
    },
    rollback: async () => {
      for (const { id, existing } of members) {
        state.setTerminalTransfer(id, null);
        if (!existing) state.removeTerminalTab(id, { preserveSession: true });
      }
      useAppStore.setState({ terminalGroups: previous.groups, terminalLayout: previous.layout });
      const currentTabs = useAppStore.getState().terminalTabs;
      state.reorderTerminalTabs([
        ...previous.tabs.flatMap((tab) => currentTabs.filter((item) => item.id === tab.id)),
        ...currentTabs.filter((tab) => !previous.tabs.some((item) => item.id === tab.id)),
      ]);
      state.setActiveTabId(previous.active);
      state.setActiveView(previous.view);
    },
  };
}

export function useWindowHandoffs(options: {
  isMainWindow: boolean;
  isWorkspaceWindow?: boolean;
  detachedAddress: HandoffAddress | null;
  setDetachedHost: (host: Host) => void;
  allowDetachedClose: MutableRefObject<boolean>;
}) {
  const { isMainWindow, isWorkspaceWindow = false, detachedAddress, setDetachedHost, allowDetachedClose } = options;
  useEffect(() => {
    const running = new Map<string, { abort: AbortController; address: HandoffAddress }>();
    const completed = new Set<string>();
    let disposed = false;
    let stop = () => {};
    let receiveTail = Promise.resolve();
    const receive = async (address: HandoffAddress) => {
      if (disposed || running.has(address.id) || completed.has(address.id)) return;
      const abort = new AbortController();
      const closeOnFailure = !isMainWindow && (!isWorkspaceWindow || useAppStore.getState().terminalTabs.length === 0);
      running.set(address.id, { abort, address });
      // Only one incoming workspace can own the active renderer at a time.
      // Register queued addresses immediately so cancellation cannot be lost.
      const preceding = receiveTail;
      let releaseQueue = () => {};
      receiveTail = new Promise<void>((resolve) => { releaseQueue = resolve; });
      try {
        await preceding;
        await waitForTerminalCapture(abort.signal);
        await receiveTerminalWindow(address, async (offer) => {
          // A minimized existing webview must be restored before xterm replay,
          // otherwise background rendering can prevent readiness confirmation.
          if (!closeOnFailure) {
            const win = getCurrentWindow();
            await win.show();
            await win.unminimize();
          }
          // Independent opposite-direction moves may proceed after their screen
          // capture. Waiting for both commits here would deadlock a window swap.
          await waitForTerminalCapture(abort.signal, offer);
          if (abort.signal.aborted) throw new TerminalMoveCancelledError();
          if (offer.workspace || offer.placement?.pane || isWorkspaceWindow) {
            return prepareWorkspaceHandoff(offer, () => abort.abort(), isWorkspaceWindow);
          }
          const state = useAppStore.getState();
          const previousTab = state.activeTabId;
          const previousView = state.activeView;
          const sid = offer.session.sessionId;
          // A plain Return creates an independent tab. A previously opened
          // connection picker must not consume it as the next new connection.
          useAppStore.setState({ pendingTerminalGroupId: null, pendingTerminalPaneIndex: null });
          const existing = isMainWindow && sid
            ? state.terminalTabs.find((tab) => state.sessionIds[tab.id] === sid)
            : undefined;
          const tabId = isMainWindow ? existing?.id ?? state.addTerminalTab(offer.host, sid ?? undefined) : "detached";
          if (isMainWindow && !existing && offer.placement) {
            state.reorderTerminalTabs(placeTerminalTab(useAppStore.getState().terminalTabs, tabId, offer.placement, state.terminalGroups));
          }
          const controller = getTerminalSessionController(tabId) ?? ensureTerminalSessionController(tabId, { host: offer.host });
          if (!existing) controller.prepareIncomingHandoff(offer.view, offer.session);
          state.setSessionId(tabId, sid);
          state.setActiveTabId(tabId);
          state.setActiveView("terminal");
          state.setTerminalTransfer(tabId, { direction: "incoming", phase: "connecting", cancel: () => abort.abort() });
          if (!isMainWindow) setDetachedHost(offer.host);
          return {
            ready: async (signal) => {
              await waitForTerminalRenderer(tabId, signal);
              if (existing) {
                if (controller.getSnapshot().status !== "connected") throw new Error("The existing terminal is no longer connected.");
                await controller.captureView();
              } else await controller.waitForHandoffReady(signal);
            },
            commit: async () => {
              state.setTerminalTransfer(tabId, { direction: "incoming", phase: "finishing", cancel: () => {} });
              if (isMainWindow && existing && offer.placement) state.reorderTerminalTabs(placeTerminalTab(useAppStore.getState().terminalTabs, tabId, offer.placement, useAppStore.getState().terminalGroups));
              const win = getCurrentWindow();
              await win.show();
              await win.unminimize().catch(() => {});
              controller.commitIncomingHandoff();
              state.setTerminalTransfer(tabId, null);
              await win.setFocus().catch(() => {});
            },
            rollback: async () => {
              const restorePrevious = isMainWindow && useAppStore.getState().activeTabId === tabId;
              state.setTerminalTransfer(tabId, null);
              if (!existing) {
                if (isMainWindow) state.removeTerminalTab(tabId, { preserveSession: true });
                else {
                  controller.dispose({ preserveSession: true });
                  allowDetachedClose.current = true;
                  await invoke("close_terminal_window");
                }
              }
              if (restorePrevious) {
                state.setActiveTabId(previousTab);
                state.setActiveView(previousView);
              }
            },
          };
        }, abort.signal);
      } catch (error) {
        if (!disposed && !closeOnFailure && !(error instanceof TerminalMoveCancelledError)) useAppStore.getState().addToast(error instanceof Error ? error.message : "Could not restore terminal", "error");
        if (closeOnFailure) {
          allowDetachedClose.current = true;
          await invoke("close_terminal_window").catch(() => {});
        }
      } finally {
        releaseQueue();
        running.delete(address.id);
        completed.add(address.id);
        if (completed.size > 256) completed.delete(completed.values().next().value!);
      }
    };
    if (isMainWindow || isWorkspaceWindow) {
      void listen<HandoffMessage>(HANDOFF_EVENT, ({ payload }) => {
        if (payload.type === "open" && payload.target === getCurrentWindow().label) void receive(payload);
        if (payload.type === "cancel") {
          const queued = running.get(payload.id);
          if (queued && queued.address.source === payload.source && queued.address.target === payload.target) queued.abort.abort();
        }
      }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; });
    }
    if (!isMainWindow && detachedAddress) {
      // React StrictMode replays mount effects in development. Do not start an
      // external transaction from the setup that is immediately disposed.
      queueMicrotask(() => { if (!disposed) void receive(detachedAddress); });
    }
    return () => {
      disposed = true;
      stop();
      running.forEach(({ abort }) => abort.abort());
    };
  }, [isMainWindow, isWorkspaceWindow, detachedAddress?.id, detachedAddress?.source, detachedAddress?.target, setDetachedHost, allowDetachedClose]);
}

export const openMainTerminalHandoff = (address: HandoffAddress) => emit(HANDOFF_EVENT, { ...address, type: "open" });
