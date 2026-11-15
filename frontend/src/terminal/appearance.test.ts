import { describe, expect, it } from "vitest";
import { appearanceErrors, sanitizeTerminalAppearance } from "./appearance";
import { APPEARANCE_COLOR_KEYS } from "../types/terminalAppearance";

describe("terminal appearance validation", () => {
  it("keeps every supported color and false/zero values, without unknown fields", () => {
    const colors = Object.fromEntries(APPEARANCE_COLOR_KEYS.map(key => [key, " #AbC "]));
    expect(sanitizeTerminalAppearance({ font_family: " Consolas ", font_weight: 100,
      font_weight_bold: 900, line_height: 1, letter_spacing: 0, cursor_style: "underline",
      cursor_blink: false, bold_bright: false, colors: { ...colors, command: "ignored" },
      password: "never-store", command: "never-run",
    })).toEqual({ font_family: "Consolas", font_weight: 100, font_weight_bold: 900,
      line_height: 1, letter_spacing: 0, cursor_style: "underline", cursor_blink: false,
      bold_bright: false, colors: Object.fromEntries(APPEARANCE_COLOR_KEYS.map(key => [key, "#aabbcc"])),
    });
  });

  it("uses the same Unicode font-name limits as the API and input maxlength", () => {
    const name = "Ш".repeat(128);
    expect(appearanceErrors({ font_family: name })).toEqual({});
    expect(sanitizeTerminalAppearance({ font_family: name })?.font_family).toBe(name);
    for (const invalid of [" ", "A".repeat(129), "Ш".repeat(129), "font\nname", "font\u0085name"]) {
      expect(appearanceErrors({ font_family: invalid }).appearance_font_family).toBeTruthy();
      expect(sanitizeTerminalAppearance({ font_family: invalid })).toBeNull();
    }
  });

  it("rejects invalid numeric values and colors instead of submitting preview fallbacks", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(Object.keys(appearanceErrors({ line_height: value, letter_spacing: value }))).toHaveLength(2);
      expect(sanitizeTerminalAppearance({ line_height: value, letter_spacing: value })).toBeNull();
    }
    const errors = appearanceErrors({ font_weight: 450, font_weight_bold: 1000,
      line_height: .9, letter_spacing: 6, colors: { brightBlue: "invalid", cursor: "red" } });
    expect(Object.keys(errors)).toHaveLength(6);
  });
});
