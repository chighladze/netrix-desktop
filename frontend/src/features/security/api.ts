import { emit } from "@tauri-apps/api/event";
import { fetchJsonOrThrow, getApiBase } from "../../api";

export const SECURITY_CHANGED_EVENT = "netrix-security-changed";
export interface SecuritySnapshot {
  locked: boolean;
  revision: number;
  vault_unlocked: boolean;
  vault_initialized: boolean;
  database_mode?: "setup" | "upgrade" | "encrypted" | "open";
  database_encrypted?: boolean;
  database_busy?: boolean;
}

export async function securityRequest(path: string, body?: object): Promise<SecuritySnapshot> {
  const base = await getApiBase();
  const abort = new AbortController();
  // A stalled check must not leave previously unlocked content visible forever.
  // Password derivation gets a longer bound on slower machines.
  const timeout = window.setTimeout(() => abort.abort(), path === "unlock" ? 300000 : 5000);
  let value: unknown;
  try {
    value = await fetchJsonOrThrow<unknown>(`${base}/security/${path}`, {
      cache: "no-store", signal: abort.signal,
      ...(path === "status" ? {} : { method: "POST", headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) }),
    });
  } finally { window.clearTimeout(timeout); }
  if (!value || typeof value !== "object") throw new Error("Unable to verify the application lock");
  const data = value as Partial<SecuritySnapshot>;
  if (typeof data.locked !== "boolean" || !Number.isSafeInteger(data.revision)
    || typeof data.vault_unlocked !== "boolean" || typeof data.vault_initialized !== "boolean") {
    throw new Error("Unable to verify the application lock");
  }
  return data as SecuritySnapshot;
}

export async function notifySecurityChanged(): Promise<void> {
  // Only a refresh hint: every window reads authoritative state from the backend.
  window.dispatchEvent(new Event(SECURITY_CHANGED_EVENT));
  await emit(SECURITY_CHANGED_EVENT).catch(() => undefined);
}

export async function lockApplication(): Promise<SecuritySnapshot> {
  const snapshot = await securityRequest("lock");
  await notifySecurityChanged();
  return snapshot;
}
