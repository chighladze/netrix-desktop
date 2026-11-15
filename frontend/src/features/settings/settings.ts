import type { AppSettings } from "../../state/store";
import { terminalThemes } from "../../themes";
import { sanitizeAppearancePreset } from "../../terminal/appearance";

/** A fresh object: resets must never share mutable defaults or backend-owned rules. */
export const createDefaultSettings = (): AppSettings => ({
  terminal: {
    newHostAppearance: null,
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    type: "xterm-256color",
    theme: "default",
    cursorStyle: "block",
    cursorBlink: true,
    scrollbackLines: 10000,
    bellSound: true,
    bellVolume: 50,
    highlightRules: [],
    searchMatchBackground: "#ffffff20",
    searchActiveMatchBackground: "#eab30899",
    rowsMultiplier: 1,
  },
  connection: {
    defaultSSHPort: 22,
    defaultTelnetPort: 23,
    connectionTimeout: 30,
    keepaliveInterval: 60,
    autoReconnect: false,
    maxReconnectAttempts: 3,
  },
  keyboard: {
    copyOnSelect: false,
    rightClickAction: "copy",
    pasteOnMiddleClick: true,
    scrollOnOutput: true,
    scrollOnKeyPress: true,
  },
  window: {
    alwaysOnTop: false,
    rememberWindowPosition: true,
    tabPosition: "top",
    showTabCloseButton: true,
    confirmCloseMultipleTabs: true,
  },
  security: {
    autoLockEnabled: true,
    autoLockTimeout: 15,
    clearClipboardAfter: 30,
    confirmBeforeDisconnect: true,
    vaultUnlockMode: "every_start",
    vaultAutoLockEnabled: true,
    vaultAutoLockTimeout: 30,
    vaultRememberPassword: false,
  },
});

type Validator = (value: unknown) => unknown;
export function parseSettingNumber(
  input: string,
  min: number,
  max: number,
  step = 1,
): number | null {
  if (!input.trim()) return null;
  const value = Number(input);
  if (!Number.isFinite(value)) return null;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.min(max, Math.max(min, min + Math.round((clamped - min) / step) * step));
}
const integer =
  (min: number, max: number): Validator =>
  (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
      ? value
      : undefined;
const boolean: Validator = (value) => (typeof value === "boolean" ? value : undefined);
const choice =
  (...choices: string[]): Validator =>
  (value) =>
    typeof value === "string" && choices.includes(value) ? value : undefined;
const color: Validator = (value) =>
  typeof value === "string" && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value)
    ? value.length === 7
      ? `${value}ff`
      : value
    : undefined;
const schema: Record<keyof AppSettings, Record<string, Validator>> = {
  terminal: {
    newHostAppearance: (value) => value === null ? null : sanitizeAppearancePreset(value) ?? undefined,
    fontFamily: (value) =>
      typeof value === "string" &&
      value.trim() &&
      value.length <= 128 &&
      !/[\x00-\x1f\x7f]/.test(value)
        ? value
        : undefined,
    fontSize: integer(6, 72),
    type: choice("linux", "xterm-256color", "xterm", "vt100"),
    theme: (value) =>
      typeof value === "string" && Object.prototype.hasOwnProperty.call(terminalThemes, value)
        ? value
        : undefined,
    cursorStyle: choice("block", "underline", "bar"),
    cursorBlink: boolean,
    scrollbackLines: integer(0, 100000),
    bellSound: boolean,
    bellVolume: integer(0, 100),
    searchMatchBackground: color,
    searchActiveMatchBackground: color,
    rowsMultiplier: integer(1, 5),
  },
  connection: {
    defaultSSHPort: integer(1, 65535),
    defaultTelnetPort: integer(1, 65535),
    connectionTimeout: integer(5, 120),
    keepaliveInterval: integer(0, 300),
    autoReconnect: boolean,
    maxReconnectAttempts: integer(1, 10),
  },
  keyboard: {
    copyOnSelect: boolean,
    rightClickAction: choice("paste", "contextMenu", "copy"),
    pasteOnMiddleClick: boolean,
    scrollOnOutput: boolean,
    scrollOnKeyPress: boolean,
  },
  window: {
    alwaysOnTop: boolean,
    rememberWindowPosition: boolean,
    tabPosition: choice("top", "bottom"),
    showTabCloseButton: boolean,
    confirmCloseMultipleTabs: boolean,
  },
  security: {
    autoLockEnabled: boolean,
    autoLockTimeout: integer(1, 60),
    clearClipboardAfter: integer(0, 300),
    confirmBeforeDisconnect: boolean,
    vaultUnlockMode: choice("session", "every_start"),
    vaultAutoLockEnabled: boolean,
    vaultAutoLockTimeout: integer(5, 240),
    vaultRememberPassword: boolean,
  },
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Used by storage, UI mutations and backup restore; unknown/invalid fields are ignored. */
export function sanitizeSettingsPatch<K extends keyof AppSettings>(
  category: K,
  incoming: unknown,
): Partial<AppSettings[K]> {
  const validators = Object.prototype.hasOwnProperty.call(schema, category)
    ? schema[category]
    : undefined;
  if (!validators) return {};
  const source = record(incoming);
  const result: Record<string, unknown> = {};
  for (const [key, validate] of Object.entries(validators)) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = validate(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<AppSettings[K]>;
}

export function normalizeSettings(incoming: unknown): AppSettings {
  const source = record(incoming);
  const result = createDefaultSettings();
  for (const category of Object.keys(result) as (keyof AppSettings)[]) {
    const value = Object.prototype.hasOwnProperty.call(source, category)
      ? source[category]
      : undefined;
    Object.assign(result[category], sanitizeSettingsPatch(category, value));
  }
  return result;
}

export function loadAppSettings(storage?: Pick<Storage, "getItem">): AppSettings {
  try {
    const source = storage ?? globalThis.localStorage;
    const read = (key: string): unknown => {
      try {
        return JSON.parse(source.getItem(key) ?? "null");
      } catch {
        return undefined;
      }
    };
    const saved = record(read("appSettings"));
    const legacy = {
      theme: read("terminalTheme"),
      fontSize: read("terminalFontSize"),
    };
    return normalizeSettings({ ...saved, terminal: { ...legacy, ...record(saved.terminal) } });
  } catch {
    return createDefaultSettings();
  }
}

export function saveAppSettings(
  settings: AppSettings,
  storage: Pick<Storage, "setItem"> = globalThis.localStorage,
) {
  // Highlighting is authoritative in SQLite and loaded through its own API.
  // Never duplicate it, unknown fields or secrets in the preferences snapshot.
  const clean = normalizeSettings(settings);
  const { highlightRules, ...terminal } = clean.terminal;
  void highlightRules;
  storage.setItem("appSettings", JSON.stringify({ ...clean, terminal }));
}
