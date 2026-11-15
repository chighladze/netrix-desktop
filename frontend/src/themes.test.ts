import { describe, expect, it } from "vitest";
import { getThemeColors, normalizeTerminalColor, terminalThemes } from "./themes";

describe("terminal color overrides", () => {
  it("normalizes hex colors and rejects other CSS color syntax", () => {
    expect(normalizeTerminalColor(" #AbC ")).toBe("#aabbcc");
    expect(normalizeTerminalColor("#A1B2C3")).toBe("#a1b2c3");
    for (const value of ["red", "#12345678", "var(--color)", "#zzzzzz", "", null]) {
      expect(normalizeTerminalColor(value)).toBeNull();
    }
  });

  it("overrides the canvas and plain text without changing ANSI colors or the shared theme", () => {
    const original = { ...terminalThemes.nord.colors };
    const colors = getThemeColors("nord", { terminal_background: "#112233", terminal_foreground: "#abcdef" });
    expect(colors).toEqual({ ...original, background: "#112233", foreground: "#abcdef", cursor: "#abcdef", cursorAccent: "#112233" });
    expect(terminalThemes.nord.colors).toEqual(original);
    expect(getThemeColors("nord", { terminal_background: null, terminal_foreground: "invalid" })).toEqual(original);
    for (const name of ["missing-theme", "__proto__", "constructor", "toString"]) {
      expect(getThemeColors(name)).toEqual(terminalThemes.default.colors);
    }
  });
});
