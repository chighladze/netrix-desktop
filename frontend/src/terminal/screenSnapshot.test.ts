import { describe, expect, it, vi } from "vitest";

describe("real xterm screen checkpoints", () => {
  it("restores scrollback, colors, cursor and alternate screen using the installed serializer", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { Terminal } = await import("xterm");
    const { SerializeAddon } = await import("@xterm/addon-serialize");
    const source = new Terminal({ cols: 32, rows: 5, scrollback: 200, allowProposedApi: true });
    const target = new Terminal({ cols: 32, rows: 5, scrollback: 200, allowProposedApi: true });
    const addon = new SerializeAddon(); source.loadAddon(addon);
    const write = (terminal: typeof source, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
    try {
      await write(source, Array.from({ length: 40 }, (_, i) => `\x1b[32mrow ${i}\x1b[0m\r\n`).join(""));
      await write(target, addon.serialize());
      expect(target.buffer.active.baseY).toBe(source.buffer.active.baseY);
      expect(target.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
      expect(target.buffer.active.getLine(4)?.translateToString(true)).toBe(source.buffer.active.getLine(4)?.translateToString(true));
      await write(source, "\x1b[?1049h\x1b[2J\x1b[2;4H\x1b[31mactive editor\x1b[0m");
      target.reset(); await write(target, addon.serialize());
      expect(target.buffer.active.type).toBe("alternate");
      expect(target.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
      expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
      expect(target.buffer.active.getLine(1)?.translateToString(true)).toContain("active editor");
      expect(target.buffer.active.getLine(1)?.getCell(3)?.getFgColor()).toBe(source.buffer.active.getLine(1)?.getCell(3)?.getFgColor());
      await write(source, "\x1b[?1049l"); await write(target, "\x1b[?1049l");
      expect(target.buffer.active.baseY).toBe(source.buffer.active.baseY);
      expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe(source.buffer.active.getLine(0)?.translateToString(true));
    } finally { source.dispose(); target.dispose(); }
  });
});
