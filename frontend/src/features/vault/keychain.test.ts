import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
import { readVaultPassword, saveVaultPassword, removeVaultPassword } from "./keychain";

beforeEach(() => {
  native.invoke.mockReset();
});
describe("fixed-scope native credential commands", () => {
  it("uses dedicated commands without arbitrary credential-store selectors", async () => {
    native.invoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("test-password")
      .mockResolvedValueOnce(undefined);
    await saveVaultPassword("test-password");
    expect(await readVaultPassword()).toBe("test-password");
    await removeVaultPassword();
    expect(native.invoke.mock.calls).toEqual([
      ["save_vault_password", { password: "test-password" }],
      ["read_vault_password"],
      ["remove_vault_password"],
    ]);
  });
  it("distinguishes an absent entry from a malformed or failed response", async () => {
    native.invoke
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ password: "legacy-shape" })
      .mockRejectedValueOnce(new Error("unavailable"));
    expect(await readVaultPassword()).toBeNull();
    await expect(readVaultPassword()).rejects.toThrow("Invalid credential-store response");
    await expect(readVaultPassword()).rejects.toThrow("unavailable");
  });
  it("does not request native remembered-password access from a detached connection picker", async () => {
    const previous = window.location.href;
    try {
      window.history.replaceState(null, "", "/?detached=true&workspace=true");
      expect(await readVaultPassword()).toBeNull();
      expect(native.invoke).not.toHaveBeenCalled();
    } finally { window.history.replaceState(null, "", previous); }
  });
});
