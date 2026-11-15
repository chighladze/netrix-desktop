import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAppStore } from "../state/store";
import { placeTerminalTab, type DockPlacement } from "./docking";
import { transferTerminalWindow } from "./windowHandoff";
import { openMainTerminalHandoff, waitForTerminalRenderer } from "./useWindowHandoffs";
import type { DragPoint } from "./pointerDrag";
import { findTerminalGroup } from "../features/workspace/groups";

/** A floating workspace tab can represent one session or one split group. */
export async function moveTerminalGroup(tabId: string, destination?: DockPlacement, releasePoint?: DragPoint): Promise<void> {
  const state = useAppStore.getState();
  const group = findTerminalGroup(state.terminalGroups, tabId);
  if ((group?.tabIds ?? [tabId]).some((id) => state.terminalClosures[id])) throw new Error("Finish closing this session first.");
  if (!group) return moveTerminalPane(tabId, destination, releasePoint);
  if (Object.keys(state.terminalTransfers).length || destination?.windowLabel === getCurrentWindow().label) throw new Error("Finish the current terminal move first.");
  if (destination?.pane && group.tabIds.length > 1) throw new Error("A split group cannot fit into one pane.");
  const members = group.tabIds.flatMap((id) => state.terminalTabs.filter((tab) => tab.id === id));
  const focused = members.find((tab) => tab.id === state.activeTabId) ?? members.find((tab) => tab.id === group.activeTabId) ?? members.find((tab) => tab.id === tabId);
  if (!focused || members.length !== group.tabIds.length) throw new Error("This terminal group is no longer available.");
  const target = destination?.windowLabel ?? `detached-terminal-${crypto.randomUUID()}`;
  state.setActiveTabId(focused.id);
  await transferTerminalWindow({
    tabId: focused.id, host: focused.host, target, placement: destination,
    workspace: { group, tabs: members },
    prepare: () => Promise.all(members.map((tab) => waitForTerminalRenderer(tab.id))).then(() => {}),
    open: destination ? openMainTerminalHandoff : (address) => invoke<void>("open_terminal_window", {
      targetLabel: target, handoffId: address.id, originTabId: focused.id, title: members.map((tab) => tab.host.name).join(" + "), workspace: true,
      ...(releasePoint ? { dropPoint: { x: Math.round(releasePoint.x), y: Math.round(releasePoint.y) } } : {}),
    }),
    release: () => members.forEach((tab) => state.removeTerminalTab(tab.id, { preserveSession: true })),
    discard: destination ? undefined : async () => { const window = await WebviewWindow.getByLabel(target); await window?.close(); },
  });
}

/** A pane move transfers exactly one session. Group membership changes only
 * after destination commit; local moves keep the same controller and socket. */
export async function moveTerminalPane(tabId: string, destination?: DockPlacement, releasePoint?: DragPoint): Promise<void> {
  const state = useAppStore.getState();
  const tab = state.terminalTabs.find((item) => item.id === tabId);
  if (state.terminalClosures[tabId]) throw new Error("Finish closing this session first.");
  if (!tab || Object.keys(state.terminalTransfers).length) throw new Error("Finish the current terminal move first.");
  if (destination?.windowLabel === getCurrentWindow().label) {
    if (destination.pane) {
      if (!state.insertTerminalPane(destination.pane.groupId, destination.pane.index, tabId)) throw new Error("This pane is no longer available.");
    } else {
      if (!state.extractTerminalTab(tabId)) throw new Error("Could not extract this session.");
      state.reorderTerminalTabs(placeTerminalTab(useAppStore.getState().terminalTabs, tabId, destination, useAppStore.getState().terminalGroups));
    }
    return;
  }
  const target = destination?.windowLabel ?? `detached-terminal-${crypto.randomUUID()}`;
  state.setActiveTabId(tabId);
  await waitForTerminalRenderer(tabId);
  await transferTerminalWindow({
    tabId, host: tab.host, target, placement: destination,
    open: destination ? openMainTerminalHandoff : (address) => invoke<void>("open_terminal_window", {
      targetLabel: target, handoffId: address.id, originTabId: tabId, title: tab.host.name, workspace: true,
      ...(releasePoint ? { dropPoint: { x: Math.round(releasePoint.x), y: Math.round(releasePoint.y) } } : {}),
    }),
    release: () => { void state.removeTerminalTab(tabId, { preserveSession: true }); },
    discard: destination ? undefined : async () => { const window = await WebviewWindow.getByLabel(target); await window?.close(); },
  });
}
