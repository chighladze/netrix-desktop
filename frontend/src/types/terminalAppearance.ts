export const ANSI_COLOR_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
export const APPEARANCE_COLOR_KEYS = [...ANSI_COLOR_KEYS, "cursor", "selectionBackground"] as const;
export type AppearanceColorKey = typeof APPEARANCE_COLOR_KEYS[number];

/** Renderer preferences only. No shell commands or connection credentials. */
export interface TerminalAppearance {
  font_family?: string;
  font_weight?: number;
  font_weight_bold?: number;
  line_height?: number;
  letter_spacing?: number;
  cursor_style?: "block" | "bar" | "underline";
  cursor_blink?: boolean;
  bold_bright?: boolean;
  colors?: Partial<Record<AppearanceColorKey, string>>;
}

export interface TerminalAppearancePreset {
  terminal_theme: string;
  terminal_font_size: number;
  terminal_background: string | null;
  terminal_foreground: string | null;
  terminal_appearance: TerminalAppearance | null;
}
