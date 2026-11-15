import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchJsonOrThrow: vi.fn(),
  getApiBase: vi.fn(),
  getWsBase: vi.fn(),
  refreshApiToken: vi.fn(),
}));
const nativeMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../api", () => {
  class ApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }

  return {
    ApiError,
    ...apiMocks,
  };
});

vi.mock("@tauri-apps/api/core", () => nativeMocks);
vi.mock("xterm", () => ({ Terminal: class Terminal {} }));

import { useAppStore } from "./store";
import { createDefaultSettings, loadAppSettings } from "../features/settings/settings";
import {
  disposeTerminalSessionController,
  getTerminalSessionController,
} from "../terminal/TerminalSessionController";

describe("settings store actions", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.fetchJsonOrThrow.mockReset();
    apiMocks.getApiBase.mockResolvedValue("http://127.0.0.1:3210");
    apiMocks.getWsBase.mockResolvedValue("ws://127.0.0.1:3210");
    apiMocks.refreshApiToken.mockResolvedValue("test-token");
    useAppStore.setState(
      {
        ...useAppStore.getInitialState(),
        settings: createDefaultSettings(),
        terminalTheme: "default",
        terminalFontSize: 14,
        terminalTabs: [],
        toasts: [],
      },
      true,
    );
  });
  afterEach(() => {
    for (const tab of useAppStore.getState().terminalTabs) disposeTerminalSessionController(tab.id);
  });

  it("closes a disconnected session over HTTP and retains the tab until acknowledgement", async () => {
    const state = useAppStore.getState();
    const tabId = state.addTerminalTab({ id: 7, name: "test", hostname: "example.test", port: 22, username: "test", connection_type: "ssh" }, 41);
    let acknowledge!: (value: { ok: boolean }) => void;
    apiMocks.fetchJsonOrThrow.mockReturnValue(new Promise((resolve) => { acknowledge = resolve; }));
    const closing = state.removeTerminalTab(tabId);
    await Promise.resolve();
    expect(apiMocks.fetchJsonOrThrow).toHaveBeenCalledWith("http://127.0.0.1:3210/sessions/41", expect.objectContaining({ method: "DELETE" }), { retries: 2 });
    expect(useAppStore.getState().terminalTabs.some((tab) => tab.id === tabId)).toBe(true);
    expect(useAppStore.getState().terminalClosures[tabId]).toBe("closing");
    expect(await state.removeTerminalTab(tabId)).toBe(false);
    expect(apiMocks.fetchJsonOrThrow).toHaveBeenCalledTimes(1);
    acknowledge({ ok: true });
    expect(await closing).toBe(true);
    expect(useAppStore.getState().terminalTabs).toEqual([]);
    expect(getTerminalSessionController(tabId)).toBeUndefined();
  });

  it("retains a failed closure and retries the same ID without touching another tab on the host", async () => {
    const state = useAppStore.getState();
    const host = { id: 7, name: "test", hostname: "example.test", port: 22, username: "test", connection_type: "ssh" as const };
    const first = state.addTerminalTab(host, 41);
    const second = state.addTerminalTab(host, 42);
    apiMocks.fetchJsonOrThrow.mockRejectedValueOnce(new Error("Offline"));
    expect(await state.removeTerminalTab(first)).toBe(false);
    expect(useAppStore.getState().terminalClosures[first]).toBe("failed");
    expect(useAppStore.getState().terminalTabs).toHaveLength(2);
    apiMocks.fetchJsonOrThrow.mockResolvedValueOnce({ ok: true, terminated: false });
    expect(await state.removeTerminalTab(first)).toBe(true);
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual([second]);
    expect(apiMocks.fetchJsonOrThrow.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3210/sessions/41", "http://127.0.0.1:3210/sessions/41",
    ]);
  });

  it("releases a moved tab immediately without terminating its backend session", async () => {
    const state = useAppStore.getState();
    const id = state.addTerminalTab({ id: 7, name: "test", hostname: "example.test", port: 22, username: "test", connection_type: "ssh" }, 41);
    const released = state.removeTerminalTab(id, { preserveSession: true });
    expect(useAppStore.getState().terminalTabs).toEqual([]);
    expect(await released).toBe(true);
    expect(apiMocks.fetchJsonOrThrow).not.toHaveBeenCalled();
  });

  it("uses one appearance snapshot for legacy actions, category reset and restart", () => {
    localStorage.setItem("terminalFontSize", "24");
    localStorage.setItem("terminalTheme", '"dracula"');
    const state = useAppStore.getState();
    state.setTerminalTheme("dracula");
    state.setTerminalFontSize(20);
    state.updateSettings("connection", { defaultSSHPort: 2222 });
    expect(loadAppSettings().terminal).toMatchObject({ theme: "dracula", fontSize: 20 });
    expect(state.resetSettings("terminal")).toBe(true);
    expect(useAppStore.getState()).toMatchObject({
      terminalTheme: "default",
      terminalFontSize: 14,
    });
    expect(loadAppSettings().terminal).toMatchObject({ theme: "default", fontSize: 14 });
    expect(loadAppSettings().connection.defaultSSHPort).toBe(2222);
  });

  it("keeps the active snapshot and reports failure when saving or resetting cannot persist", () => {
    const state = useAppStore.getState();
    state.updateSettings("terminal", { fontSize: 20 });
    const before = useAppStore.getState().settings;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    expect(state.updateSettings("terminal", { fontSize: 22 })).toBe(false);
    expect(state.resetSettings()).toBe(false);
    expect(useAppStore.getState().settings).toBe(before);
    expect(useAppStore.getState().terminalFontSize).toBe(20);
    expect(useAppStore.getState().toasts.at(-1)).toMatchObject({ type: "error" });
  });

  it("preserves database-owned highlighting through resets without duplicating it in preferences", () => {
    const rules = [
      {
        id: "db-rule",
        keyword: "error",
        color: "#ff0000",
        highlightType: "foreground" as const,
        isActive: true,
      },
    ];
    useAppStore.getState().setHighlightRules(rules);
    useAppStore.getState().resetSettings();
    expect(useAppStore.getState().settings.terminal.highlightRules).toEqual(rules);
    expect(JSON.parse(localStorage.getItem("appSettings")!).terminal).not.toHaveProperty(
      "highlightRules",
    );
  });

  it("updates hidden controllers without creating transports or losing quick-connect credentials", async () => {
    const state = useAppStore.getState();
    const id = state.addTerminalTab({
      id: -1,
      name: "temporary",
      hostname: "example.test",
      port: 22,
      username: "admin",
      password: "ephemeral",
      connection_type: "ssh",
    });
    const controller = getTerminalSessionController(id)!;
    const configure = vi.spyOn(controller, "configure");
    const connect = vi.spyOn(controller, "connect");
    state.updateSettings("connection", { autoReconnect: true, connectionTimeout: 45 });
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ autoReconnect: true, connectionTimeout: 45 }),
      }),
    );
    expect(controller.getSocket()).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalTabs[0].host).not.toHaveProperty("password");
    // Preparing the next connection still uses only the controller's private credential.
    apiMocks.getApiBase.mockResolvedValue("http://127.0.0.1:3210");
    apiMocks.fetchJsonOrThrow.mockRejectedValueOnce(new Error("stop before socket"));
    await controller.connect();
    expect(JSON.parse(apiMocks.fetchJsonOrThrow.mock.calls.at(-1)![1].body)).toMatchObject({
      password: "ephemeral",
      timeout: 45,
    });
  });
});

describe("vault store actions", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMocks.fetchJsonOrThrow.mockReset();
    apiMocks.getApiBase.mockReset();
    apiMocks.getApiBase.mockResolvedValue("http://127.0.0.1:3210");
    nativeMocks.invoke.mockReset().mockResolvedValue(null);
    const settings = createDefaultSettings();
    settings.security.vaultRememberPassword = true;
    settings.security.vaultUnlockMode = "session";
    useAppStore.setState({
      settings,
      hasStoredVaultPassword: false,
      toasts: [],
      isVaultUnlocked: true,
      vaultInitialized: false,
      vaultStatusLoaded: false,
      vaultSecretItems: 0,
      vaultLinkedHosts: 0,
    });
  });

  it("remembers only after a successful native save, keeping plaintext out of snapshots", async () => {
    apiMocks.fetchJsonOrThrow.mockResolvedValue({ unlocked: true, initialized: true });
    await expect(useAppStore.getState().unlockVault("test-only-master")).resolves.toEqual({
      ok: true,
    });
    expect(nativeMocks.invoke).toHaveBeenCalledWith("save_vault_password", {
      password: "test-only-master",
    });
    expect(useAppStore.getState().hasStoredVaultPassword).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain("test-only-master");
    expect(JSON.stringify(useAppStore.getState())).not.toContain("test-only-master");
  });

  it("reports remembering failure without misreporting the successful Vault unlock", async () => {
    apiMocks.fetchJsonOrThrow.mockResolvedValue({ unlocked: true, initialized: true });
    nativeMocks.invoke.mockRejectedValue(new Error("native failure with sensitive detail"));
    await expect(useAppStore.getState().unlockVault("test-only-master")).resolves.toEqual({
      ok: true,
    });
    expect(useAppStore.getState()).toMatchObject({
      isVaultUnlocked: true,
      hasStoredVaultPassword: false,
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("could not be remembered");
    expect(JSON.stringify(useAppStore.getState().toasts)).not.toContain("sensitive detail");
  });

  it("does not claim the remembered password was removed when native storage rejects deletion", async () => {
    useAppStore.setState({ hasStoredVaultPassword: true });
    nativeMocks.invoke.mockRejectedValue(new Error("native deletion failed"));
    await useAppStore.getState().clearStoredVaultPassword();
    expect(useAppStore.getState().hasStoredVaultPassword).toBe(true);
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain(
      "may still be in Windows Credential Manager",
    );
  });

  it("blocks saved-password reads when remembering is disabled or manual startup is required", async () => {
    useAppStore.getState().updateSettings("security", { vaultUnlockMode: "every_start" });
    expect(await useAppStore.getState().getStoredVaultPassword()).toBeNull();
    expect(nativeMocks.invoke).not.toHaveBeenCalled();
    useAppStore
      .getState()
      .updateSettings("security", { vaultUnlockMode: "session", vaultRememberPassword: false });
    nativeMocks.invoke.mockClear();
    expect(await useAppStore.getState().getStoredVaultPassword()).toBeNull();
    expect(nativeMocks.invoke).not.toHaveBeenCalled();
  });

  it("removes a late save if remembering was disabled while unlock was in flight", async () => {
    apiMocks.fetchJsonOrThrow.mockResolvedValue({ unlocked: true, initialized: true });
    let finishSave!: () => void;
    const saved = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    nativeMocks.invoke.mockImplementation((command) =>
      command === "save_vault_password" ? saved : Promise.resolve(null),
    );
    const unlocking = useAppStore.getState().unlockVault("test-only-master");
    await vi.waitFor(() =>
      expect(nativeMocks.invoke).toHaveBeenCalledWith("save_vault_password", expect.anything()),
    );
    useAppStore.getState().updateSettings("security", { vaultRememberPassword: false });
    finishSave();
    await unlocking;
    expect(useAppStore.getState().hasStoredVaultPassword).toBe(false);
    expect(
      nativeMocks.invoke.mock.calls.filter(([command]) => command === "remove_vault_password"),
    ).toHaveLength(2);
  });

  it("keeps the vault unlocked when the backend lock request fails", async () => {
    apiMocks.fetchJsonOrThrow.mockRejectedValue(new Error("lock failed"));

    const result = await useAppStore.getState().lockVault();

    expect(result).toEqual({ ok: false, error: "lock failed" });
    expect(useAppStore.getState().isVaultUnlocked).toBe(true);
    expect(apiMocks.fetchJsonOrThrow).toHaveBeenCalledWith("http://127.0.0.1:3210/vault/lock", {
      method: "POST",
    });
  });

  it("changes local state only after a valid successful lock response", async () => {
    apiMocks.fetchJsonOrThrow.mockResolvedValue({ unlocked: false });

    await expect(useAppStore.getState().lockVault()).resolves.toEqual({ ok: true });
    expect(useAppStore.getState().isVaultUnlocked).toBe(false);
  });

  it("marks vault status as loaded after a successful status response", async () => {
    apiMocks.fetchJsonOrThrow.mockResolvedValue({
      unlocked: false,
      initialized: true,
      secret_items: 3,
      linked_hosts: 2,
    });

    await expect(useAppStore.getState().refreshVaultStatus()).resolves.toEqual({
      unlocked: false,
      initialized: true,
      secretItems: 3,
      linkedHosts: 2,
    });
    expect(useAppStore.getState()).toMatchObject({
      isVaultUnlocked: false,
      vaultInitialized: true,
      vaultStatusLoaded: true,
      vaultSecretItems: 3,
      vaultLinkedHosts: 2,
    });
  });

  it("does not present an unknown vault status as a clean vault", async () => {
    apiMocks.fetchJsonOrThrow.mockRejectedValue(new Error("status unavailable"));

    await expect(useAppStore.getState().refreshVaultStatus()).resolves.toBeNull();
    expect(useAppStore.getState().vaultStatusLoaded).toBe(false);
  });
});
