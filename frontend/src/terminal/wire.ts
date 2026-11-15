/** Binary frames carry terminal bytes; text frames carry transport controls. */
export type TerminalSocket = WebSocket & { __netrixHandoffBusy?: boolean; __netrixInputReady?: boolean };

export function sendTerminalInput(socket: TerminalSocket, text: string): boolean {
  if (socket.__netrixHandoffBusy || socket.__netrixInputReady === false) return false;
  socket.send(new TextEncoder().encode(text));
  return true;
}
