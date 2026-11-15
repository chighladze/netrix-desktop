import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../state/store";

let clearTimer: ReturnType<typeof window.setTimeout> | null = null;

export const cancelClipboardAutoClear = (): void => {
  if (clearTimer !== null) {
    window.clearTimeout(clearTimer);
    clearTimer = null;
  }
};

const writeClipboard = async (text: string): Promise<void> => {
  try {
    await writeText(text);
  } catch (tauriError) {
    if (!navigator.clipboard?.writeText) throw tauriError;
    await navigator.clipboard.writeText(text);
  }
};

const readClipboard = async (): Promise<string> => {
  try {
    return await readText();
  } catch (tauriError) {
    if (!navigator.clipboard?.readText) throw tauriError;
    return navigator.clipboard.readText();
  }
};

export const scheduleClipboardAutoClear = (copiedText: string): void => {
  if (!copiedText) return;
  cancelClipboardAutoClear();

  const timeoutSeconds = useAppStore.getState().settings.security.clearClipboardAfter;
  if (timeoutSeconds <= 0) return;

  clearTimer = window.setTimeout(async () => {
    clearTimer = null;
    try {
      // Never erase content the user copied elsewhere after copying from Netrix.
      if (await readClipboard() === copiedText) {
        await writeClipboard("");
      }
    } catch {
      // Clipboard access can be unavailable while the app is in the background.
    }
  }, timeoutSeconds * 1000);
};

export const copyTextWithAutoClear = async (text: string): Promise<void> => {
  await writeClipboard(text);
  scheduleClipboardAutoClear(text);
};
