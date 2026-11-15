import { beforeEach, describe, expect, it } from "vitest";
import {
  createDefaultSettings,
  loadAppSettings,
  normalizeSettings,
  parseSettingNumber,
  saveAppSettings,
} from "./settings";

beforeEach(() => {
  localStorage.clear();
});
describe("settings persistence boundary", () => {
  it("protects new installations while preserving explicit existing security choices", () => {
    expect(loadAppSettings().security).toMatchObject({
      autoLockEnabled: true, autoLockTimeout: 15, clearClipboardAfter: 30,
      vaultUnlockMode: "every_start", vaultAutoLockEnabled: true,
      vaultAutoLockTimeout: 30, vaultRememberPassword: false,
    });
    const existing = { ...createDefaultSettings().security, autoLockEnabled: false,
      clearClipboardAfter: 0, vaultUnlockMode: "session" as const,
      vaultAutoLockEnabled: false, vaultRememberPassword: true };
    localStorage.setItem("appSettings", JSON.stringify({ security: existing }));
    expect(loadAppSettings().security).toEqual(existing);
  });
  it("persists an allowlisted new-host appearance and removes identity, commands and secrets", () => {
    const settings = normalizeSettings({ terminal: { newHostAppearance: {
      terminal_theme: "nord", terminal_font_size: 16, terminal_foreground: "#abc", hostname: "private-host", password: "secret",
      terminal_appearance: { font_family: "Consolas", line_height: 1.4, cursor_blink: false, command: "do-not-run", colors: { green: "#123", invalid: "#ffffff" } },
    } } });
    saveAppSettings(settings);
    expect(loadAppSettings().terminal.newHostAppearance).toEqual({ terminal_theme: "nord", terminal_font_size: 16, terminal_background: null, terminal_foreground: "#aabbcc", terminal_appearance: { font_family: "Consolas", line_height: 1.4, cursor_blink: false, colors: { green: "#112233" } } });
    expect(localStorage.getItem("appSettings")).not.toMatch(/private-host|secret|do-not-run/);
    expect(normalizeSettings({ terminal: { newHostAppearance: { terminal_theme: "__proto__", terminal_font_size: 14 } } }).terminal.newHostAppearance).toBeNull();
  });
  it("recovers valid fields without trusting malformed types, enums, sizes or secret-shaped extras", () => {
    localStorage.setItem(
      "appSettings",
      JSON.stringify({
        terminal: {
          fontSize: 18,
          scrollbackLines: 1e12,
          cursorStyle: "sideways",
          theme: "__proto__",
          highlightRules: "broken",
          password: "do-not-store",
        },
        connection: {
          defaultSSHPort: -1,
          keepaliveInterval: 0,
          connectionTimeout: "30",
          autoReconnect: "false",
        },
        security: { vaultUnlockMode: "every_start", vaultAutoLockTimeout: 0 },
        unknown: { private_key: "do-not-store" },
      }),
    );
    const settings = loadAppSettings();
    expect(settings.terminal.fontSize).toBe(18);
    expect(settings.terminal.scrollbackLines).toBe(10000);
    expect(settings.terminal.cursorStyle).toBe("block");
    expect(settings.terminal.theme).toBe("default");
    expect(settings.terminal.highlightRules).toEqual([]);
    expect(settings.connection).toMatchObject({
      defaultSSHPort: 22,
      keepaliveInterval: 0,
      connectionTimeout: 30,
      autoReconnect: false,
    });
    expect(settings.security.vaultAutoLockTimeout).toBe(30);
    saveAppSettings(settings);
    expect(localStorage.getItem("appSettings")).not.toContain("do-not-store");
  });

  it("migrates legacy appearance once while canonical settings win on subsequent launches", () => {
    localStorage.setItem("terminalFontSize", "18");
    localStorage.setItem("terminalTheme", '"dracula"');
    expect(loadAppSettings().terminal).toMatchObject({ fontSize: 18, theme: "dracula" });
    saveAppSettings(createDefaultSettings());
    expect(loadAppSettings().terminal).toMatchObject({ fontSize: 14, theme: "default" });
    localStorage.setItem("terminalFontSize", "damaged");
    expect(loadAppSettings().terminal.fontSize).toBe(14);
  });

  it("ignores corrupt categories and inherited keys without breaking startup", () => {
    localStorage.setItem(
      "appSettings",
      '{"terminal":null,"keyboard":[],"window":{"tabPosition":"bottom"},"__proto__":{"polluted":true}}',
    );
    expect(loadAppSettings().window.tabPosition).toBe("bottom");
    expect(loadAppSettings().terminal.fontSize).toBe(14);
    expect(
      normalizeSettings(Object.create({ connection: { defaultSSHPort: 999 } })).connection
        .defaultSSHPort,
    ).toBe(22);
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(
      loadAppSettings({
        getItem: () => {
          throw new Error("Storage denied");
        },
      }),
    ).toEqual(createDefaultSettings());
  });

  it("does not share mutable defaults and does not duplicate backend-owned rules in storage", () => {
    const first = createDefaultSettings();
    first.terminal.fontSize = 24;
    first.terminal.highlightRules.push({
      id: "rule",
      keyword: "error",
      color: "#ff0000",
      highlightType: "foreground",
      isActive: true,
    });
    saveAppSettings(first);
    expect(localStorage.getItem("appSettings")).not.toContain("highlightRules");
    expect(createDefaultSettings().terminal.fontSize).toBe(14);
    expect(createDefaultSettings().terminal.highlightRules).toEqual([]);
  });

  it("commits only bounded values aligned with the number input step", () => {
    expect(parseSettingNumber("", 1, 65535)).toBeNull();
    expect(parseSettingNumber("Infinity", 1, 65535)).toBeNull();
    expect(parseSettingNumber("-1", 1, 65535)).toBe(1);
    expect(parseSettingNumber("65536", 1, 65535)).toBe(65535);
    expect(parseSettingNumber("29.3", 5, 120, 5)).toBe(30);
  });
});
