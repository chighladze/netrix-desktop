import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore, type SavedHostDto } from "../../state/store";
import { terminalGroupSlots, terminalStripEntries } from "./groups";

const host = (id: number): SavedHostDto => ({ id, revision: 0, name: `host-${id}`, hostname: "example.test", port: 22, username: "test", connection_type: "ssh", has_password: false, has_private_key: false });

describe("terminal groups", () => {
  beforeEach(() => useAppStore.setState({
    terminalTabs: [1, 2, 3, 4, 5].map((id) => ({ id: `t${id}`, host: host(id), isConnected: false })),
    terminalGroups: [], activeTabId: "t1", terminalLayout: "single", terminalTransfers: {},
    terminalInstances: {}, terminalSockets: {}, pendingTerminalGroupId: null, pendingTerminalPaneIndex: null,
  }));

  it("keeps multiple layouts independent and excludes grouped sessions from a new group", () => {
    const state = useAppStore.getState();
    state.setTerminalLayout("columns");
    state.insertTerminalPane(useAppStore.getState().terminalGroups[0].id, 1, "t2");
    state.setActiveTabId("t3");
    state.setTerminalLayout("rows");
    state.insertTerminalPane(useAppStore.getState().terminalGroups.find((group) => group.tabIds.includes("t3"))!.id, 1, "t4");
    const groups = useAppStore.getState().terminalGroups;
    expect(groups.map((group) => [group.layout, group.tabIds])).toEqual([["columns", ["t1", "t2"]], ["rows", ["t3", "t4"]]]);
    state.setActiveTabId("t5");
    expect(useAppStore.getState().terminalLayout).toBe("single");
    state.setActiveTabId("t2");
    expect(useAppStore.getState().terminalLayout).toBe("columns");
    expect(terminalStripEntries(useAppStore.getState().terminalTabs, groups).map((entry) => entry.tab.id)).toEqual(["t1", "t3", "t5"]);
  });

  it("releases a replaced pane and leaves other groups intact", () => {
    const state = useAppStore.getState();
    state.setTerminalLayout("columns");
    const group = useAppStore.getState().terminalGroups[0];
    state.insertTerminalPane(group.id, 1, "t2");
    state.replaceTerminalPane(group.id, "t2", "t5");
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t1", "t5"]);
    expect(useAppStore.getState().activeTabId).toBe("t5");
    state.removeTerminalTab("t5");
    expect(useAppStore.getState().activeTabId).toBe("t1");
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t1"]);
    expect(useAppStore.getState().terminalLayout).toBe("columns");
  });

  it.each(["columns", "rows", "grid"] as const)("creates %s from only the selected session and never auto-fills a layout change", (layout) => {
    const state = useAppStore.getState();
    state.setActiveTabId("t3");
    state.setTerminalLayout(layout);
    const group = useAppStore.getState().terminalGroups[0];
    expect(group.tabIds).toEqual(["t3"]);
    expect(terminalGroupSlots(group)).toEqual(["t3", null, null, null]);
    expect(terminalStripEntries(useAppStore.getState().terminalTabs, useAppStore.getState().terminalGroups)).toHaveLength(5);
    state.setTerminalLayout("grid");
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t3"]);
    state.insertTerminalPane(group.id, 3, "t5");
    state.setTerminalLayout("rows");
    state.setTerminalLayout("grid");
    expect(terminalGroupSlots(useAppStore.getState().terminalGroups[0])).toEqual(["t3", null, null, "t5"]);
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t3", "t5"]);
  });

  it("adds only a connection explicitly chosen for an empty pane to its group", () => {
    const state = useAppStore.getState();
    state.setTerminalGroup({ id: "g", layout: "grid", tabIds: ["t1", "t2"] });
    state.reserveTerminalPane();
    const added = state.addTerminalTab(host(6));
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t1", "t2", added]);
    expect(useAppStore.getState().terminalLayout).toBe("grid");
    const standalone = state.addTerminalTab(host(7));
    expect(useAppStore.getState().terminalGroups[0].tabIds).not.toContain(standalone);
    expect(useAppStore.getState().terminalLayout).toBe("single");
    state.removeTerminalTab(added);
    state.removeTerminalTab(standalone);
  });

  it.each(["columns", "rows", "grid"] as const)("inserts a standalone session into an exact empty %s pane without reconnecting it", (layout) => {
    const state = useAppStore.getState();
    state.setTerminalGroup({ id: "g", layout, tabIds: ["t1"] });
    const index = layout === "grid" ? 3 : 1;
    expect(state.insertTerminalPane("g", index, "t5")).toBe(true);
    expect(terminalGroupSlots(useAppStore.getState().terminalGroups[0])[index]).toBe("t5");
    expect(useAppStore.getState().activeTabId).toBe("t5");
    expect(state.insertTerminalPane("g", index, "t4")).toBe(false);
    state.removeTerminalTab("t1");
    expect(terminalGroupSlots(useAppStore.getState().terminalGroups[0])[0]).toBeNull();
    expect(terminalGroupSlots(useAppStore.getState().terminalGroups[0])[index]).toBe("t5");
  });

  it("reserves pane four while keeping pane three vacant and cancels a stale reservation", () => {
    const state = useAppStore.getState();
    state.setTerminalGroup({ id: "g", layout: "grid", tabIds: ["t1", "t2"] });
    state.reserveTerminalPane(3);
    const added = state.addTerminalTab(host(6));
    expect(terminalGroupSlots(useAppStore.getState().terminalGroups[0])).toEqual(["t1", "t2", null, added]);
    state.reserveTerminalPane(2);
    state.setActiveView("files");
    expect(useAppStore.getState().pendingTerminalGroupId).toBeNull();
    state.removeTerminalTab(added);
  });

  it("keeps the incoming renderer visible until its transfer completes, including shortcut-driven navigation", () => {
    const state = useAppStore.getState();
    state.setActiveView("terminal");
    state.setTerminalTransfer("t1", { direction: "incoming", phase: "connecting", cancel: () => {} });
    state.setActiveTabId("t2");
    state.setActiveView("hosts");
    expect(useAppStore.getState().activeTabId).toBe("t1");
    expect(useAppStore.getState().activeView).toBe("terminal");
    state.setTerminalTransfer("t1", null);
    state.setActiveTabId("t2");
    state.setActiveView("hosts");
    expect(useAppStore.getState().activeTabId).toBe("t2");
    expect(useAppStore.getState().activeView).toBe("hosts");
  });

  it.each(["columns", "rows", "grid"] as const)("extracts one %s member without dissolving its neighbors or closing transports", (layout) => {
    const state = useAppStore.getState();
    state.setTerminalGroup({ id: "g", layout, tabIds: ["t1", "t2"] });
    const sockets = state.terminalSockets;
    const sessions = state.sessionIds;
    expect(state.extractTerminalTab("t1")).toBe(true);
    expect(useAppStore.getState().terminalGroups[0].paneSlots).toEqual([null, "t2", null, null]);
    expect(useAppStore.getState().terminalLayout).toBe("single");
    expect(useAppStore.getState().terminalSockets).toBe(sockets);
    expect(useAppStore.getState().sessionIds).toBe(sessions);
    expect(state.extractTerminalTab("t2")).toBe(true);
    expect(useAppStore.getState().terminalGroups).toEqual([]);
    expect(useAppStore.getState().terminalTabs).toHaveLength(5);
  });
  it.each(["columns", "rows", "grid"] as const)("Single dissolves a one-session %s group and starts a fresh split from that session", (layout) => {
    const state = useAppStore.getState();
    state.setTerminalLayout(layout);
    state.reserveTerminalPane(1);
    const tabs = useAppStore.getState().terminalTabs;
    state.setTerminalLayout("single");
    const after = useAppStore.getState();
    expect(after.terminalGroups).toEqual([]);
    expect(after.terminalTabs).toBe(tabs);
    expect(after.activeTabId).toBe("t1");
    expect(after.pendingTerminalGroupId).toBeNull();
    expect(after.pendingTerminalPaneIndex).toBeNull();
    expect(terminalStripEntries(after.terminalTabs, after.terminalGroups).every((entry) => !entry.group)).toBe(true);
    state.setTerminalLayout(layout);
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t1"]);
  });
  it.each(["columns", "rows", "grid"] as const)("Single separates every %s member, keeps focus/transports and leaves another group intact", (layout) => {
    const state = useAppStore.getState();
    state.setTerminalGroup({ id: "other", layout: "rows", tabIds: ["t3", "t4"] });
    state.setTerminalGroup({ id: "selected", layout, tabIds: ["t1", "t2"], paneSlots: layout === "grid" ? ["t1", null, null, "t2"] : undefined });
    state.setActiveTabId("t2");
    const before = useAppStore.getState();
    state.setTerminalLayout("single");
    const after = useAppStore.getState();
    expect(after.terminalGroups).toEqual(before.terminalGroups.filter((group) => group.id === "other"));
    expect(after.activeTabId).toBe("t2");
    expect(after.terminalTabs).toBe(before.terminalTabs);
    expect(after.terminalSockets).toBe(before.terminalSockets);
    expect(after.terminalInstances).toBe(before.terminalInstances);
    expect(after.sessionIds).toBe(before.sessionIds);
    state.setTerminalLayout("grid");
    expect(useAppStore.getState().terminalGroups.find((group) => group.id !== "other")?.tabIds).toEqual(["t2"]);
  });
});
