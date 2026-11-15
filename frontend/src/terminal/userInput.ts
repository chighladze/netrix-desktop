import { useAppStore } from "../state/store";
import { sendTerminalInput, type TerminalSocket } from "./wire";

/** Call only for positively identified human input, never general xterm onData. */
export function broadcastUserInput(tabId: string, data: string): void {
  const state = useAppStore.getState();
  const source = state.terminalSockets[tabId] as TerminalSocket | undefined;
  if (!source || source.readyState !== WebSocket.OPEN || source.__netrixHandoffBusy
    || source.__netrixInputReady === false || !state.broadcastMode) return;
  for (const targetId of new Set(state.broadcastTargets)) {
    if (targetId === tabId) continue;
    const target = state.terminalSockets[targetId];
    if (target?.readyState === WebSocket.OPEN) sendTerminalInput(target, data);
  }
}

/** Decode once: a literal escaped backslash must not become a second escape. */
export function decodeQuickAction(command: string): string {
  const escapes: Record<string, string> = { r: "\r", n: "\n", t: "\t", b: "\b", e: "\x1b", "\\": "\\" };
  return command.replace(/\\([rntbe\\])/g, (_match, key: string) => escapes[key]);
}

/** All action entry points send exactly the saved text; no implicit Enter. */
export function sendQuickAction(tabId: string, command: string): boolean {
  const state = useAppStore.getState();
  const socket = state.terminalSockets[tabId];
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const data = decodeQuickAction(command);
  if (!sendTerminalInput(socket, data)) return false;
  broadcastUserInput(tabId, data);
  state.terminalInstances[tabId]?.focus();
  return true;
}
