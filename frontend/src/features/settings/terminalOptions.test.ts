import { describe, expect, it } from "vitest";
import { Terminal } from "xterm";
import { createDefaultSettings } from "./settings";
import { applyTerminalPreferences, terminalBellGain, terminalRuntimeOptions } from "./terminalOptions";
import { getThemeColors, terminalThemes } from "../../themes";
import { ANSI_COLOR_KEYS, type TerminalAppearance } from "../../types/terminalAppearance";

describe("live terminal preferences", () => {
  it("applies and resets the full appearance on real xterm while preserving ANSI output", async () => {
    const settings = createDefaultSettings();
    const colors = Object.fromEntries(ANSI_COLOR_KEYS.map((key, i) => [key, `#${(0x223344 + i * 0x030303).toString(16)}`]));
    const appearance: TerminalAppearance = { font_family: "Consolas", font_weight: 500,
      font_weight_bold: 800, line_height: 1.6, letter_spacing: -1, cursor_style: "bar",
      cursor_blink: false, bold_bright: false, colors: { ...colors, cursor: "#f0e0d0", selectionBackground: "#123456" } };
    const terminal = new Terminal({ cols: 80, rows: 24, ...terminalRuntimeOptions(settings, appearance),
      fontSize: 20, theme: getThemeColors("nord", { terminal_background: "#010203", terminal_foreground: "#fefdfc", terminal_appearance: appearance }) });
    try {
      const sequence = ANSI_COLOR_KEYS.map((_key, i) => `\x1b[${i < 8 ? 30 + i : 90 + i - 8}m${i.toString(16)}`).join("");
      await new Promise<void>(resolve => terminal.write(`${sequence}\x1b[0m\r\n\x1b[1;3;4;32mstyled\x1b[0m\r\n\x1b[38;2;17;34;51mRGB`, resolve));
      const buffer = terminal.buffer.active;
      expect(terminal.options).toMatchObject({ fontSize: 20, fontFamily: "Consolas, Menlo, Consolas, monospace",
        fontWeight: 500, fontWeightBold: 800, lineHeight: 1.6, letterSpacing: -1, cursorStyle: "bar",
        cursorBlink: false, drawBoldTextInBrightColors: false, theme: { ...colors, background: "#010203",
          foreground: "#fefdfc", cursor: "#f0e0d0", selectionBackground: "#12345666" } });
      for (let i = 0; i < 16; i++) expect(buffer.getLine(0)?.getCell(i)?.getFgColor()).toBe(i);
      const styled = buffer.getLine(1)?.getCell(0);
      expect(styled?.isBold()).toBeTruthy();
      expect(styled?.isItalic()).toBeTruthy();
      expect(styled?.isUnderline()).toBeTruthy();
      expect(buffer.getLine(2)?.getCell(0)?.getFgColor()).toBe(0x112233);
      for (const cursor_style of ["underline", "block"] as const) {
        applyTerminalPreferences(terminal, settings, { ...appearance, cursor_style, cursor_blink: true, bold_bright: true, letter_spacing: 0 });
        expect(terminal.options.cursorStyle).toBe(cursor_style);
        expect(terminal.options.cursorBlink).toBe(true);
        expect(terminal.options.drawBoldTextInBrightColors).toBe(true);
        expect(terminal.options.letterSpacing).toBe(0);
      }
      applyTerminalPreferences(terminal, settings, null);
      terminal.options.theme = getThemeColors("nord");
      expect(terminal.options).toMatchObject({ fontWeight: 400, fontWeightBold: 700,
        lineHeight: 1.2, letterSpacing: .5, cursorStyle: settings.terminal.cursorStyle,
        cursorBlink: settings.terminal.cursorBlink, drawBoldTextInBrightColors: true, theme: terminalThemes.nord.colors });
      expect(terminal.buffer.active).toBe(buffer);
      expect(buffer.getLine(0)?.translateToString(true)).toBe("0123456789abcdef");
      expect(buffer.getLine(2)?.getCell(0)?.getFgColor()).toBe(0x112233);
    } finally { terminal.dispose(); }
  });
  it("applies scrollback, cursor and keyboard settings to an existing xterm without losing output", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24 });
    try {
      await new Promise<void>((resolve) => terminal.write("session output", resolve));
      const settings = createDefaultSettings();
      settings.terminal.scrollbackLines = 20000;
      settings.terminal.cursorStyle = "bar";
      settings.keyboard.scrollOnKeyPress = false;
      applyTerminalPreferences(terminal, settings);
      expect(terminal.options.scrollback).toBe(20000);
      expect(terminal.options.cursorStyle).toBe("bar");
      expect(terminal.options.scrollOnUserInput).toBe(false);
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("session output");
    } finally {
      terminal.dispose();
    }
  });
  it("respects zero bell volume and the sound toggle", () => {
    const settings = createDefaultSettings();
    expect(terminalBellGain(settings)).toBe(0.05);
    settings.terminal.bellVolume = 0;
    expect(terminalBellGain(settings)).toBe(0);
    settings.terminal.bellVolume = 100;
    settings.terminal.bellSound = false;
    expect(terminalBellGain(settings)).toBe(0);
  });
});
