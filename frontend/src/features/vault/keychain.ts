import { invoke } from "@tauri-apps/api/core";

// A detached connection picker can unlock the backend vault manually. Native
// remembered-password access remains exclusive to the main webview's ACL.
export const canUseVaultKeychain = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get("detached") !== "true" && params.get("detachedMap") !== "true";
};

// Fixed-purpose commands; no arbitrary credential-store keys or persistent JS secrets.
export const readVaultPassword = async (): Promise<string | null> => {
  if (!canUseVaultKeychain()) return null;
  const value = await invoke<unknown>("read_vault_password");
  if (value === null) return null;
  if (typeof value !== "string" || !value) throw new Error("Invalid credential-store response");
  return value;
};
export const saveVaultPassword = (password: string) =>
  invoke<void>("save_vault_password", { password });
export const removeVaultPassword = () => invoke<void>("remove_vault_password");
