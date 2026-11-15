import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
import type { HandoffAddress } from "./windowHandoff";
const mocks = vi.hoisted(() => ({
  transfer: vi.fn(async (_options: Parameters<typeof import("./windowHandoff").transferTerminalWindow>[0]) => {}),
  invoke: vi.fn(async () => {}), open: vi.fn(async () => {}), renderer: vi.fn(async () => {}),
  window: "main",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: mocks.window }) }));
vi.mock("./windowHandoff", () => ({ transferTerminalWindow: mocks.transfer }));
vi.mock("./useWindowHandoffs", () => ({ waitForTerminalRenderer: mocks.renderer, openMainTerminalHandoff: mocks.open }));
import { moveTerminalGroup, moveTerminalPane } from "./moveTerminalPane";

describe("moving one group member", () => {
  beforeEach(() => {
    mocks.window = "main";
    mocks.transfer.mockResolvedValue(undefined);
    useAppStore.setState({ ...useAppStore.getInitialState(),
      terminalTabs: [1, 2, 3, 4].map((id) => ({ id: `t${id}`, host: { id, revision: 0, name: `host-${id}`, hostname: "example.test", port: 22, username: "test", connection_type: "ssh" }, isConnected: true })),
      terminalGroups: [{ id: "g", layout: "grid", tabIds: ["t1", "t2", "t3", "t4"] }], terminalLayout: "grid", activeTabId: "t1", activeView: "terminal",
      sessionIds: { t1: 101, t2: 102, t3: 103, t4: 104 },
    });
  });
  it("extracts one local pane to the tab strip without disposing any session", async () => {
    const before = useAppStore.getState();
    await moveTerminalPane("t2", { windowLabel: "main", beforeTabId: null });
    const after = useAppStore.getState();
    expect(after.terminalGroups[0].paneSlots).toEqual(["t1", null, "t3", "t4"]);
    expect(after.activeTabId).toBe("t2");
    expect(after.terminalLayout).toBe("single");
    expect(after.sessionIds).toBe(before.sessionIds);
    expect(after.terminalSockets).toBe(before.terminalSockets);
    expect(after.terminalTabs.map((tab) => tab.id)).toEqual(["t1", "t3", "t4", "t2"]);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it("uses a single-session offer from a detached group and releases only that member after commit", async () => {
    mocks.window = "detached-grid";
    await moveTerminalPane("t3", undefined, { x: -1300, y: 500 });
    const options = mocks.transfer.mock.calls[0][0];
    expect(options.tabId).toBe("t3");
    expect(options.workspace).toBeUndefined();
    expect(options.target).toMatch(/^detached-terminal-/);
    expect(useAppStore.getState().terminalGroups[0].tabIds).toHaveLength(4);
    await options.open({ id: "handoff-id", source: "detached-grid", target: options.target });
    expect(mocks.invoke).toHaveBeenCalledWith("open_terminal_window", { targetLabel: options.target, handoffId: "handoff-id", originTabId: "t3", title: "host-3", workspace: true, dropPoint: { x: -1300, y: 500 } });
    await options.release();
    expect(useAppStore.getState().terminalGroups[0].paneSlots).toEqual(["t1", "t2", null, "t4"]);
    expect(useAppStore.getState().sessionIds).toEqual({ t1: 101, t2: 102, t4: 104 });
  });
  it("routes one pane into another window and keeps all source members when the move fails", async () => {
    const destination = { windowLabel: "main", beforeTabId: "neighbor" };
    mocks.window = "detached-grid";
    await moveTerminalPane("t4", destination);
    const options = mocks.transfer.mock.calls[0][0];
    expect(options).toMatchObject({ tabId: "t4", target: "main", placement: destination });
    const address: HandoffAddress = { id: "h", source: "detached-grid", target: "main" };
    await options.open(address);
    expect(mocks.open).toHaveBeenCalledWith(address);
    mocks.transfer.mockRejectedValueOnce(new Error("Replay failed"));
    await expect(moveTerminalPane("t2", destination)).rejects.toThrow("Replay failed");
    expect(useAppStore.getState().terminalTabs).toHaveLength(4);
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t1", "t2", "t3", "t4"]);
  });
  it("moves a floating group tab without including independent siblings", async () => {
    mocks.window = "detached-grid";
    useAppStore.setState({ terminalGroups: [{ id: "g", layout: "rows", tabIds: ["t2", "t4"], activeTabId: "t4" }], activeTabId: "t4" });
    await moveTerminalGroup("t2");
    const options = mocks.transfer.mock.calls[0][0];
    expect(options.tabId).toBe("t4");
    expect(options.workspace?.tabs.map((tab) => tab.id)).toEqual(["t2", "t4"]);
    await options.open({ id: "handoff", source: mocks.window, target: options.target });
    expect(mocks.invoke).toHaveBeenCalledWith("open_terminal_window", expect.objectContaining({ workspace: true, originTabId: "t4" }));
    await options.release();
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["t1", "t3"]);
  });
});
