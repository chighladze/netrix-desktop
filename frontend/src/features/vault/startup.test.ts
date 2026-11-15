import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings } from "../settings/settings";
import { applyVaultStartupPolicy } from "./startup";

const actions = () => ({
  getStoredVaultPassword: vi.fn().mockResolvedValue("test-password"),
  unlockVault: vi.fn().mockResolvedValue({ ok: true }),
  lockVault: vi.fn().mockResolvedValue({ ok: true }),
  clearStoredVaultPassword: vi.fn().mockResolvedValue(undefined),
  refreshStoredVaultPasswordState: vi.fn().mockResolvedValue(undefined),
});
const rememberedSession = () => ({ ...createDefaultSettings().security,
  vaultUnlockMode: "session" as const, vaultRememberPassword: true });
describe("Vault startup settings", () => {
  it("keeps password-required startup locked even when keychain remembering is enabled", async () => {
    const api = actions();
    const security = {
      ...createDefaultSettings().security,
      vaultUnlockMode: "every_start" as const,
      vaultRememberPassword: true,
    };
    await expect(applyVaultStartupPolicy(security, true, api)).resolves.toEqual({ ok: true });
    expect(api.lockVault).toHaveBeenCalledOnce();
    expect(api.getStoredVaultPassword).not.toHaveBeenCalled();
    expect(api.unlockVault).not.toHaveBeenCalled();
  });
  it("auto-unlocks an existing vault only under the remembered-session policy", async () => {
    const api = actions();
    await applyVaultStartupPolicy(rememberedSession(), true, api);
    expect(api.unlockVault).toHaveBeenCalledWith("test-password");
    expect(api.lockVault).not.toHaveBeenCalled();
  });
  it("does not initialize a reset vault or auto-unlock when status is unknown", async () => {
    const api = actions();
    await applyVaultStartupPolicy(rememberedSession(), false, api);
    expect(api.clearStoredVaultPassword).toHaveBeenCalledOnce();
    expect(api.unlockVault).not.toHaveBeenCalled();
    api.getStoredVaultPassword.mockClear();
    await applyVaultStartupPolicy(rememberedSession(), undefined, api);
    expect(api.getStoredVaultPassword).not.toHaveBeenCalled();
  });
  it("surfaces failure to enforce the configured lock instead of auto-unlocking", async () => {
    const api = actions();
    api.lockVault.mockResolvedValue({ ok: false, error: "Lock unavailable" });
    await expect(
      applyVaultStartupPolicy(
        { ...createDefaultSettings().security, vaultUnlockMode: "every_start" },
        true,
        api,
      ),
    ).resolves.toEqual({ ok: false, error: "Lock unavailable" });
    expect(api.unlockVault).not.toHaveBeenCalled();
  });
});
