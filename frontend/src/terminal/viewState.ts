/** In-memory only. Serialized terminal screens can contain sensitive output. */
export interface TerminalViewState {
  serialized: string;
  cols: number;
  rows: number;
  viewportY: number;
  selection?: { column: number; row: number; length: number };
  outputOffset: number;
  decoderTail: number[];
  parserTail?: string;
}

/** Keep an unfinished VT escape sequence across a screen checkpoint. A screen
 * serializer restores cells/modes, but does not serialize the parser state. */
export class TerminalParserCheckpoint {
  private state: "text" | "escape" | "csi" | "string" = "text";
  private tail = "";
  private osc = false;
  private stringEscape = false;
  private overflow = false;

  feed(data: string): void {
    for (const char of data) {
      const code = char.charCodeAt(0);
      if (this.state === "text") {
        if (char === "\x1b") { this.state = "escape"; this.tail = char; }
        else if (code === 0x9b) { this.state = "csi"; this.tail = char; }
        else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
          this.state = "string"; this.tail = char; this.osc = code === 0x9d;
        }
        continue;
      }
      if (this.tail.length < 64 * 1024) this.tail += char;
      else this.overflow = true;
      if (char === "\x18" || char === "\x1a") { this.reset(); continue; }
      if (this.state === "string") {
        if (code === 0x9c || (this.osc && char === "\x07") || (this.stringEscape && char === "\\")) this.reset();
        else this.stringEscape = char === "\x1b";
      } else if (char === "\x1b") {
        this.state = "escape"; this.tail = char;
      } else if (this.state === "escape" && char === "[") this.state = "csi";
      else if (this.state === "escape" && ["]", "P", "X", "^", "_"].includes(char)) {
        this.state = "string"; this.osc = char === "]"; this.stringEscape = false;
      } else if ((this.state === "csi" && code >= 0x40 && code <= 0x7e)
        || (this.state === "escape" && code >= 0x30 && code <= 0x7e)) this.reset();
    }
  }

  checkpoint(): string {
    if (this.overflow) throw new Error("The terminal is receiving a large control sequence. Try moving it again when output settles.");
    return this.tail;
  }

  reset(): void { this.state = "text"; this.tail = ""; this.stringEscape = false; this.osc = false; this.overflow = false; }
}

export interface TerminalRendererAdapter {
  capture: () => Promise<Omit<TerminalViewState, "outputOffset" | "decoderTail">>;
  restore: (view: TerminalViewState) => Promise<void>;
  flush: () => Promise<void>;
}

/** TextDecoder has no exportable state; carry its unfinished UTF-8 prefix. */
export function incompleteUtf8Tail(previous: Uint8Array, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(previous.length + data.length);
  bytes.set(previous);
  bytes.set(data, previous.length);
  let start = bytes.length - 1;
  while (start >= Math.max(0, bytes.length - 4) && (bytes[start] & 0xc0) === 0x80) start--;
  if (start < 0) return new Uint8Array();
  const lead = bytes[start];
  const width = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  return width > bytes.length - start ? bytes.slice(start) : new Uint8Array();
}
