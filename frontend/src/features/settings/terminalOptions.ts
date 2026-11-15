import type { AppSettings } from "../../state/store";
import type { Terminal } from "xterm";
import type { TerminalAppearance } from "../../types/terminalAppearance";

/** Options supported for both a new xterm renderer and an already open one. */
export const terminalRuntimeOptions = (settings: AppSettings, appearance?: TerminalAppearance | null) => ({
  cursorStyle: appearance?.cursor_style ?? settings.terminal.cursorStyle,
  cursorBlink: appearance?.cursor_blink ?? settings.terminal.cursorBlink,
  fontFamily: `${appearance?.font_family ?? settings.terminal.fontFamily}, Menlo, Consolas, monospace`,
  fontWeight: appearance?.font_weight ?? 400,
  fontWeightBold: appearance?.font_weight_bold ?? 700,
  lineHeight: appearance?.line_height ?? 1.2,
  letterSpacing: appearance?.letter_spacing ?? .5,
  drawBoldTextInBrightColors: appearance?.bold_bright ?? true,
  scrollback: settings.terminal.scrollbackLines,
  scrollOnUserInput: settings.keyboard.scrollOnKeyPress,
});

export const terminalBellGain = (settings: AppSettings) =>
  settings.terminal.bellSound ? settings.terminal.bellVolume / 1000 : 0;

export const applyTerminalPreferences = (
  terminal: Pick<Terminal, "options">,
  settings: AppSettings,
  appearance?: TerminalAppearance | null,
) => {
  Object.assign(terminal.options, terminalRuntimeOptions(settings, appearance));
};
