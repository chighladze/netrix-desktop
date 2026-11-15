import { readText } from "@tauri-apps/plugin-clipboard-manager";
import type { Terminal } from "xterm";
import { useAppStore } from "../state/store";
import type { TerminalSessionController } from "./TerminalSessionController";
import type { TerminalSocket } from "./wire";
import { broadcastUserInput } from "./userInput";

const MAX_TERMINAL_PASTE_CHARS = 1024 * 1024;

/** One gate for DOM and native clipboard paste, scoped to this renderer's lifetime. */
export function createTerminalPasteHandler(tabId: string, terminal: Terminal, controller: TerminalSessionController) {
  let revision = 0;
  let disposed = false;
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.activeTabId !== previous.activeTabId || state.activeView !== previous.activeView
      || state.terminalSockets !== previous.terminalSockets || state.sessionIds !== previous.sessionIds
      || state.tabStatuses !== previous.tabStatuses || state.terminalClosures !== previous.terminalClosures
      || state.terminalTransfers !== previous.terminalTransfers || state.broadcastMode !== previous.broadcastMode
      || state.broadcastTargets !== previous.broadcastTargets) revision += 1;
  });

  const prepare = () => {
    const request = ++revision;
    const state = useAppStore.getState();
    const source = controller.getSocket();
    const sessionId = controller.getSnapshot().sessionId;
    const targetIds = new Set([tabId, ...(state.broadcastMode ? state.broadcastTargets : [])]);
    const canSend = (socket: TerminalSocket | null | undefined): socket is TerminalSocket =>
      socket?.readyState === WebSocket.OPEN && socket.__netrixInputReady !== false && !socket.__netrixHandoffBusy;
    // Disconnected broadcast peers are skipped, as in the normal input path.
    // Any later connection/selection change still invalidates this request.
    const targets = [...targetIds].map((id) => state.terminalSockets[id] as TerminalSocket | undefined).filter(canSend);
    const current = () => !disposed && request === revision && sessionId !== null && source === state.terminalSockets[tabId]
      && useAppStore.getState().terminalInstances[tabId] === terminal
      && controller.getSocket() === source && controller.getSnapshot().sessionId === sessionId
      && controller.getSnapshot().status === "connected" && !controller.getSnapshot().handoffPending
      && canSend(source) && targets.every(canSend);
    if (!current()) return null;
    return (text: string | null): boolean => {
      if (!current()) return true; // The clipboard read outlived its destination.
      if (!text) return false;
      if (text.length > MAX_TERMINAL_PASTE_CHARS) {
        useAppStore.getState().addToast("Clipboard text is too large to paste safely", "error");
        return true;
      }
      let sent = false;
      const send = () => {
        if (sent) return;
        sent = true;
        if (!current()) {
          useAppStore.getState().addToast("Paste cancelled because the terminal destination changed", "info");
          return;
        }
        // Only the synchronous public paste call is a known user-input source.
        // Focus and terminal query responses must never enter this broadcast path.
        const input = terminal.onData((data) => broadcastUserInput(tabId, data));
        try { terminal.paste(text); } finally { input.dispose(); }
        terminal.focus();
      };
      if (/[\r\n]/.test(text)) {
        const recipients = targets.length > 1 ? ` into ${targets.length} terminals` : "";
        useAppStore.getState().showConfirm({
          title: "Paste into terminal?",
          message: `The clipboard contains ${text.split(/\r\n|\r|\n/).length} lines and may execute commands immediately${recipients}.`,
          confirmText: "Paste", type: "warning", onConfirm: send,
        });
      } else send();
      return true;
    };
  };

  return {
    paste: (text: string) => prepare()?.(text),
    readClipboard: async () => {
      const deliver = prepare(); // Capture before the asynchronous native read.
      return deliver ? deliver(await readText()) : true;
    },
    dispose: () => { disposed = true; revision += 1; unsubscribe(); },
  };
}
