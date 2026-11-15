import { getAllWindows } from "@tauri-apps/api/window";
import { useAppStore } from "../state/store";

/** Shared by the custom close button and native close requests (Alt+F4). */
export async function requestApplicationClose(quit: () => Promise<void>): Promise<void> {
  const state = useAppStore.getState();
  let detachedCount: number;
  try {
    detachedCount = (await getAllWindows()).filter((win) => win.label.startsWith("detached-")).length;
  } catch {
    state.addToast("Could not check detached terminals. Try closing Netrix again.", "error");
    return;
  }
  const activeCount = state.terminalTabs.filter((tab) => tab.isConnected || state.tabStatuses[tab.id] === "connecting").length;
  const needsConfirmation = detachedCount > 0
    || Object.keys(state.terminalTransfers).length > 0
    || (state.settings.security.confirmBeforeDisconnect && activeCount > 0)
    || (state.settings.window.confirmCloseMultipleTabs && state.terminalTabs.length > 1);
  if (!needsConfirmation) { await quit(); return; }
  state.showConfirm({
    title: "Close Netrix?",
    message: detachedCount > 0
      ? `Closing Netrix will disconnect ${activeCount} terminal${activeCount === 1 ? "" : "s"} in this window and close ${detachedCount} detached terminal window${detachedCount === 1 ? "" : "s"}.`
      : `Closing Netrix will close ${state.terminalTabs.length} terminal tab${state.terminalTabs.length === 1 ? "" : "s"} and disconnect active sessions.`,
    confirmText: "Quit Netrix",
    cancelText: "Keep working",
    type: "danger",
    onConfirm: quit,
  });
}
