import { normalizeTerminalColor, terminalThemes } from "../themes";
import { APPEARANCE_COLOR_KEYS, type TerminalAppearance, type TerminalAppearancePreset } from "../types/terminalAppearance";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const inRange = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const validWeight = (value: unknown) => inRange(value, 100, 900) && Number(value) % 100 === 0;
const validFamily = (value: unknown) => typeof value === "string" && Boolean(value.trim()) && value.length <= 128 && !/[\x00-\x1f\x7f-\x9f]/.test(value);

export function sanitizeTerminalAppearance(input: unknown): TerminalAppearance | null {
  const value = object(input), result: TerminalAppearance = {};
  if (validFamily(value.font_family)) result.font_family = String(value.font_family).trim();
  if (validWeight(value.font_weight)) result.font_weight = Number(value.font_weight);
  if (validWeight(value.font_weight_bold)) result.font_weight_bold = Number(value.font_weight_bold);
  if (inRange(value.line_height, 1, 2)) result.line_height = Number(value.line_height);
  if (inRange(value.letter_spacing, -1, 5)) result.letter_spacing = Number(value.letter_spacing);
  if (value.cursor_style === "block" || value.cursor_style === "bar" || value.cursor_style === "underline") result.cursor_style = value.cursor_style;
  if (typeof value.cursor_blink === "boolean") result.cursor_blink = value.cursor_blink;
  if (typeof value.bold_bright === "boolean") result.bold_bright = value.bold_bright;
  const colors = object(value.colors);
  for (const key of APPEARANCE_COLOR_KEYS) {
    const color = typeof colors[key] === "string" ? normalizeTerminalColor(colors[key]) : null;
    if (color) (result.colors ??= {})[key] = color;
  }
  return Object.keys(result).length ? result : null;
}

export function appearanceErrors(value: TerminalAppearance): Record<string, string> {
  const errors: Record<string, string> = {};
  if (value.font_family !== undefined && !validFamily(value.font_family)) errors.appearance_font_family = "Enter a font name (up to 128 characters).";
  for (const key of ["font_weight", "font_weight_bold"] as const) {
    if (value[key] !== undefined && !validWeight(value[key])) errors[`appearance_${key}`] = "Choose a weight from 100 to 900.";
  }
  if (value.line_height !== undefined && !inRange(value.line_height, 1, 2)) errors.appearance_line_height = "Use a value from 1 to 2.";
  if (value.letter_spacing !== undefined && !inRange(value.letter_spacing, -1, 5)) errors.appearance_letter_spacing = "Use a value from -1 to 5 px.";
  for (const key of APPEARANCE_COLOR_KEYS) {
    const color = value.colors?.[key];
    if (color && !normalizeTerminalColor(color)) errors[`appearance_color_${key}`] = "Enter a hex color, e.g. #8ce5bb.";
  }
  return errors;
}

/** Explicit allowlist keeps host identity and secrets out of remembered defaults. */
export function sanitizeAppearancePreset(input: unknown): TerminalAppearancePreset | null {
  const value = object(input);
  if (typeof value.terminal_theme !== "string" || !Object.prototype.hasOwnProperty.call(terminalThemes, value.terminal_theme)
    || !inRange(value.terminal_font_size, 6, 72) || !Number.isInteger(value.terminal_font_size)) return null;
  return {
    terminal_theme: value.terminal_theme,
    terminal_font_size: Number(value.terminal_font_size),
    terminal_background: typeof value.terminal_background === "string" ? normalizeTerminalColor(value.terminal_background) : null,
    terminal_foreground: typeof value.terminal_foreground === "string" ? normalizeTerminalColor(value.terminal_foreground) : null,
    terminal_appearance: sanitizeTerminalAppearance(value.terminal_appearance),
  };
}
