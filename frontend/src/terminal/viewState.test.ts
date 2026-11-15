import { describe, expect, it } from "vitest";
import { incompleteUtf8Tail, TerminalParserCheckpoint } from "./viewState";

describe("terminal checkpoints", () => {
  it("carries only the incomplete UTF-8 suffix at every split", () => {
    const bytes = new TextEncoder().encode("prompt Привет 🌍");
    for (let split = 0; split <= bytes.length; split++) {
      const first = bytes.slice(0, split);
      const tail = incompleteUtf8Tail(new Uint8Array(), first);
      const decoder = new TextDecoder();
      decoder.decode(tail, { stream: true });
      const prefix = new TextDecoder().decode(first.slice(0, first.length - tail.length));
      expect(prefix + decoder.decode(bytes.slice(split))).toBe("prompt Привет 🌍");
      expect(incompleteUtf8Tail(tail, bytes.slice(split))).toHaveLength(0);
    }
  });
  it.each(["\x1b[38;2;", "\x1b]0;router", "\x1bPqimage", "\x1b("])("preserves an unfinished VT sequence %j", (sequence) => {
    const checkpoint = new TerminalParserCheckpoint();
    checkpoint.feed("prompt \x1b[32mgreen\x1b[0m" + sequence);
    expect(checkpoint.checkpoint()).toBe(sequence);
  });
  it("finishes split CSI, OSC, charset and DCS sequences", () => {
    for (const sequence of ["\x1b[38;2;1;2;3m", "\x1b]0;router\x07", "\x1bPqimage\x1b\\", "\x1b(B"]) {
      const checkpoint = new TerminalParserCheckpoint();
      for (const char of sequence) checkpoint.feed(char);
      expect(checkpoint.checkpoint()).toBe("");
    }
  });
});
