/** WebSocket boundary double; terminal rendering and session/store logic stay real. */
export class TestTerminalSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  static instances: TestTerminalSocket[] = [];
  readyState = 0;
  binaryType = "arraybuffer";
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { TestTerminalSocket.instances.push(this); }
  send(data: string | Uint8Array) { this.sent.push(data); }
  open() { this.readyState = 1; this.onopen?.(); }
  control(data: object) { this.onmessage?.({ data: "__JSON__" + JSON.stringify(data) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  input() { return this.sent.filter((frame) => typeof frame !== "string").map((frame) => new TextDecoder().decode(frame as Uint8Array)).join(""); }
}
