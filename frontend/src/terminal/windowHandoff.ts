import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../state/store";
import { redactHostSecrets, type Host } from "../types/host";
import { getTerminalSessionController, type TerminalSessionSnapshot } from "./TerminalSessionController";
import type { TerminalViewState } from "./viewState";
import type { DockPlacement } from "./docking";
import type { TerminalGroup } from "../features/workspace/groups";

export const HANDOFF_EVENT = "terminal-window-handoff";
export const HANDOFF_TIMEOUT_MS = 20_000;

export class TerminalMoveCancelledError extends Error {
  constructor() { super("Terminal move cancelled. Your session is still here."); this.name = "TerminalMoveCancelledError"; }
}

export interface HandoffOffer {
  host: Host;
  originTabId: string;
  session: TerminalSessionSnapshot;
  view: TerminalViewState;
  placement?: DockPlacement;
  workspace?: { group: TerminalGroup; activeTabId: string; terminals: Omit<HandoffOffer, "workspace" | "placement">[] };
}

export interface HandoffAddress { id: string; source: string; target: string }
export interface HandoffMessage extends HandoffAddress {
  type: "open" | "request" | "offer" | "ready" | "commit" | "committed" | "cancel" | "failed";
  offer?: HandoffOffer;
  error?: string;
  cancelled?: boolean;
}

export interface PreparedHandoff {
  ready: (signal: AbortSignal) => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

const messageError = (error: unknown) => error instanceof Error ? error.message : "Could not move this terminal. Try again.";
const matches = (message: HandoffMessage, address: HandoffAddress) =>
  message.id === address.id && message.source === address.source && message.target === address.target;

/** The source retains its live transport until the destination is rendered and
 * has explicitly committed. No terminal screens or credentials enter storage. */
export async function transferTerminalWindow(options: {
  tabId: string;
  host: Host;
  originTabId?: string;
  placement?: DockPlacement;
  workspace?: { group: TerminalGroup; tabs: { id: string; host: Host }[] };
  prepare?: () => Promise<void>;
  target: string;
  open: (address: HandoffAddress) => Promise<void>;
  release: () => Promise<void> | void;
  discard?: () => Promise<void>;
}): Promise<void> {
  const state = useAppStore.getState();
  const tabs = options.workspace?.tabs ?? [{ id: options.tabId, host: options.host }];
  const focusedIndex = tabs.findIndex((tab) => tab.id === options.tabId);
  if (!tabs.length || tabs.length > 4 || new Set(tabs.map((tab) => tab.id)).size !== tabs.length || focusedIndex < 0) {
    throw new Error("Invalid terminal workspace.");
  }
  if (tabs.some((tab) => state.terminalTransfers[tab.id])) return;
  const controllers = tabs.map((tab) => {
    const item = getTerminalSessionController(tab.id);
    if (!item) throw new Error("Select this terminal before moving it.");
    if (tab.host.id === -1 && !item.getSnapshot().sessionId) throw new Error("Quick Connect can be moved after the session is established.");
    return item;
  });
  const updateTransfer = (transfer: Parameters<typeof state.setTerminalTransfer>[1]) => {
    for (const tab of tabs) state.setTerminalTransfer(tab.id, transfer);
  };
  const controller = controllers[focusedIndex];
  const address = { id: crypto.randomUUID(), source: getCurrentWindow().label, target: options.target };
  const abort = new AbortController();
  let commitSent = false;
  let stop = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTransfer: (error: Error) => void = () => {};
  let finished = false;
  let releasing = false;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  let stopCapture = () => {};
  const fail = () => rejectTransfer(new TerminalMoveCancelledError());
  abort.signal.addEventListener("abort", fail, { once: true });
  controllers.forEach((item) => item.setHandoffBusy(true));
  updateTransfer({ direction: "outgoing", phase: "preparing", cancel: () => abort.abort() });
  try {
    await options.prepare?.();
    if (abort.signal.aborted) throw new TerminalMoveCancelledError();
    const views = await new Promise<TerminalViewState[]>((resolve, reject) => {
      const cancelCapture = () => reject(new TerminalMoveCancelledError());
      abort.signal.addEventListener("abort", cancelCapture, { once: true });
      stopCapture = () => abort.signal.removeEventListener("abort", cancelCapture);
      captureTimer = setTimeout(() => reject(new Error("The terminal screen did not become ready. Your session is still here.")), 5_000);
      void Promise.all(controllers.map((item) => item.captureView())).then(resolve, reject);
    });
    if (captureTimer) clearTimeout(captureTimer);
    stopCapture();
    const offer: HandoffOffer = {
      host: redactHostSecrets(options.host),
      originTabId: options.originTabId ?? options.tabId,
      session: controller.getSnapshot(),
      view: views[focusedIndex],
      placement: options.placement,
      workspace: options.workspace ? {
        group: options.workspace.group,
        activeTabId: options.tabId,
        terminals: tabs.map((tab, index) => ({ host: redactHostSecrets(tab.host), originTabId: tab.id, session: controllers[index].getSnapshot(), view: views[index] })),
      } : undefined,
    };
    if (abort.signal.aborted) throw new TerminalMoveCancelledError();
    const completed = new Promise<void>((resolve, reject) => {
      rejectTransfer = reject;
      timer = setTimeout(() => reject(new Error("The other window did not confirm the move. Your original terminal is still here.")), HANDOFF_TIMEOUT_MS);
      void listen<HandoffMessage>(HANDOFF_EVENT, ({ payload }) => {
        if (!matches(payload, address)) return;
        if (payload.type === "request") {
          void emit(HANDOFF_EVENT, { ...address, type: "offer", offer }).catch(reject);
        } else if (payload.type === "ready" && !commitSent) {
          commitSent = true;
          updateTransfer({ direction: "outgoing", phase: "finishing", cancel: () => {} });
          void emit(HANDOFF_EVENT, { ...address, type: "commit" }).catch(reject);
        } else if (payload.type === "committed" && commitSent) resolve();
        else if (payload.type === "failed" || payload.type === "cancel") {
          reject(payload.type === "cancel" || payload.cancelled ? new TerminalMoveCancelledError() : new Error(payload.error || "Could not move this terminal. Your session is still here."));
        }
      }).then((unlisten) => {
        stop = unlisten;
        if (finished || abort.signal.aborted) { unlisten(); fail(); return; }
        updateTransfer({ direction: "outgoing", phase: "connecting", cancel: () => abort.abort() });
        void options.open(address).catch(reject);
      }, reject);
    });
    await completed;
    releasing = true;
    controllers.forEach((item) => item.markDetaching());
    await options.release();
  } catch (error) {
    if (releasing) controllers.forEach((item) => item.markDetaching(false));
    await emit(HANDOFF_EVENT, { ...address, type: "cancel" }).catch(() => {});
    if (!commitSent) await options.discard?.().catch(() => {});
    throw error;
  } finally {
    finished = true;
    stopCapture();
    if (captureTimer) clearTimeout(captureTimer);
    if (timer) clearTimeout(timer);
    stop();
    abort.signal.removeEventListener("abort", fail);
    controllers.forEach((item) => item.setHandoffBusy(false));
    const current = useAppStore.getState();
    updateTransfer(null);
    if (current.activeTabId === options.tabId && (current.activeView === "terminal" || options.tabId === "detached")) {
      current.terminalInstances[options.tabId]?.focus();
    }
  }
}

/** Prepare is speculative. Rollback closes only this window's attachment. */
export async function receiveTerminalWindow(
  address: HandoffAddress,
  prepare: (offer: HandoffOffer) => Promise<PreparedHandoff>,
  signal: AbortSignal,
): Promise<void> {
  let prepared: PreparedHandoff | undefined;
  let preparation: Promise<void> | undefined;
  let committed = false;
  let cancelled = false;
  let ready = false;
  let stop = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const preparationAbort = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => {
        // Commit is the point of no return. A queued Cancel click must not
        // race the destination becoming active and leave two live views.
        if (committed) return;
        cancelled = true; preparationAbort.abort(); reject(new TerminalMoveCancelledError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => reject(new Error("Terminal move timed out.")), HANDOFF_TIMEOUT_MS);
      void listen<HandoffMessage>(HANDOFF_EVENT, ({ payload }) => {
        if (!matches(payload, address)) return;
        if (payload.type === "cancel") { onAbort(); return; }
        if (payload.type === "offer" && payload.offer && !preparation) {
          preparation = (async () => {
            prepared = await prepare(payload.offer!);
            if (cancelled) return;
            await prepared.ready(preparationAbort.signal);
            if (cancelled) return;
            ready = true;
            await emit(HANDOFF_EVENT, { ...address, type: "ready" });
          })();
          void preparation.catch(reject);
        } else if (payload.type === "commit" && ready && prepared && !committed && !cancelled) {
          committed = true;
          void prepared.commit().then(async () => {
            await emit(HANDOFF_EVENT, { ...address, type: "committed" });
            resolve();
          }).catch((error) => { committed = false; reject(error); });
        }
      }).then((unlisten) => {
        stop = unlisten;
        if (cancelled || signal.aborted) { unlisten(); onAbort(); return; }
        void emit(HANDOFF_EVENT, { ...address, type: "request" }).catch(reject);
      }, reject);
    });
  } catch (error) {
    cancelled = true;
    preparationAbort.abort();
    await emit(HANDOFF_EVENT, { ...address, type: "failed", error: messageError(error), cancelled: error instanceof TerminalMoveCancelledError }).catch(() => {});
    // Preparation can finish after cancellation. Wait for it before disposing
    // so a late React mount cannot leave an orphan attachment behind.
    await preparation?.catch(() => {});
    if (!committed) await prepared?.rollback();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    stop();
  }
}
