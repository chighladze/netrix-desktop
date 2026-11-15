import type { SecuritySettings } from "../../state/store";

interface Result {
  ok: boolean;
  error?: string;
}
interface Actions {
  getStoredVaultPassword: () => Promise<string | null>;
  unlockVault: (password: string) => Promise<Result>;
  lockVault: () => Promise<Result>;
  clearStoredVaultPassword: () => Promise<void>;
  refreshStoredVaultPasswordState: () => Promise<void>;
}

/** Startup policy has precedence over whether a password is remembered. */
export async function applyVaultStartupPolicy(
  security: SecuritySettings,
  initialized: boolean | undefined,
  actions: Actions,
): Promise<Result> {
  if (security.vaultUnlockMode === "every_start") return actions.lockVault();
  if (!security.vaultRememberPassword || initialized === undefined) return { ok: true };
  const stored = await actions.getStoredVaultPassword();
  if (!stored) return { ok: true };
  if (initialized) return actions.unlockVault(stored);
  // Never initialize a new/reset vault using an old remembered password.
  await actions.clearStoredVaultPassword();
  await actions.refreshStoredVaultPasswordState();
  return { ok: true };
}
