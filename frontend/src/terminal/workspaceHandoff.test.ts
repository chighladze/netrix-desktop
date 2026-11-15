import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "xterm";
import { useAppStore } from "../state/store";
import { prepareWorkspaceHandoff } from "./useWindowHandoffs";
import type { HandoffOffer } from "./windowHandoff";

const mocks = vi.hoisted(() => ({
  controllers: new Map<string, { prepareIncomingHandoff: ReturnType<typeof vi.fn>; setExternalSessionId: ReturnType<typeof vi.fn>; waitForHandoffReady: ReturnType<typeof vi.fn>; commitIncomingHandoff: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>(),
  show: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ show: mocks.show, unminimize: async () => {}, setFocus: async () => {} }) }));
vi.mock("./TerminalSessionController", () => ({
  ensureTerminalSessionController: (id: string) => {
    const controller = { prepareIncomingHandoff: vi.fn(), setExternalSessionId: vi.fn(), waitForHandoffReady: vi.fn(async () => {}), commitIncomingHandoff: vi.fn(), dispose: vi.fn() };
    mocks.controllers.set(id, controller);
    return controller;
  },
  getTerminalSessionController: (id: string) => mocks.controllers.get(id),
  disposeTerminalSessionController: (id: string, options: unknown) => { mocks.controllers.get(id)?.dispose(options); },
}));

const host = { id: 1, revision: 0, name: "test", hostname: "example.test", port: 22, username: "test", connection_type: "ssh" as const };
const view = { serialized: "prompt", cols: 80, rows: 24, viewportY: 0, outputOffset: 17, decoderTail: [] };
const offer = (): HandoffOffer => ({
  host, originTabId: "origin-1", view, session: { status: "connected", sessionId: 41 } as HandoffOffer["session"],
  placement: { beforeTabId: "standalone" },
  workspace: {
    group: { id: "incoming-group", layout: "rows", tabIds: ["origin-1", "origin-2"] }, activeTabId: "origin-2",
    terminals: [1, 2].map((id) => ({ host, originTabId: `origin-${id}`, view, session: { status: "connected", sessionId: 40 + id } as HandoffOffer["session"] })),
  },
});

describe("receiving a terminal workspace group", () => {
  beforeEach(() => {
    mocks.controllers.clear();
    useAppStore.setState({ ...useAppStore.getInitialState(), terminalTabs: [{ id: "standalone", host, isConnected: false }], activeTabId: "standalone" });
  });

  const attachRenderers = () => {
    const state = useAppStore.getState();
    for (const id of state.terminalGroups[0].tabIds) state.setTerminalInstance(id, {} as Terminal);
  };

  it("remaps pane IDs, preserves focus/order and waits for every member's replay", async () => {
    const prepared = await prepareWorkspaceHandoff(offer(), vi.fn());
    const state = useAppStore.getState();
    const group = state.terminalGroups[0];
    expect(group.layout).toBe("rows");
    expect(state.activeTabId).toBe(group.tabIds[1]);
    expect(state.terminalTabs.map((tab) => tab.id)).toEqual([...group.tabIds, "standalone"]);
    let finishReplay = () => {};
    const second = mocks.controllers.get(group.tabIds[1])!;
    second.waitForHandoffReady.mockImplementation(() => new Promise<void>((resolve) => { finishReplay = resolve; }));
    attachRenderers();
    let ready = false;
    const waiting = prepared.ready(new AbortController().signal).then(() => { ready = true; });
    await vi.waitFor(() => expect(second.waitForHandoffReady).toHaveBeenCalledOnce());
    expect(ready).toBe(false);
    expect(mocks.show).not.toHaveBeenCalled();
    finishReplay(); await waiting; await prepared.commit();
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(state.terminalGroups[0].tabIds.every((id) => mocks.controllers.get(id)?.commitIncomingHandoff.mock.calls.length === 1)).toBe(true);
    expect(useAppStore.getState().terminalTransfers).toEqual({});
  });
  it("receives an independent tab in a floating workspace without replacing its siblings", async () => {
    const incoming = { ...offer(), workspace: undefined, placement: { beforeTabId: null, windowLabel: "detached-target" } };
    const prepared = await prepareWorkspaceHandoff(incoming, vi.fn(), true);
    const state = useAppStore.getState();
    const id = state.activeTabId!;
    expect(id).not.toBe("standalone");
    expect(state.terminalTabs.map((tab) => tab.id)).toEqual(["standalone", id]);
    expect(state.terminalGroups).toEqual([]);
    state.setTerminalInstance(id, {} as Terminal);
    await prepared.ready(new AbortController().signal);
    await prepared.commit();
    expect(useAppStore.getState().terminalTabs).toHaveLength(2);
  });

  it("rolls back all speculative members and restores the previous view on replay failure", async () => {
    const prepared = await prepareWorkspaceHandoff(offer(), vi.fn());
    const ids = useAppStore.getState().terminalGroups[0].tabIds;
    mocks.controllers.get(ids[1])!.waitForHandoffReady.mockRejectedValue(new Error("checkpoint expired"));
    attachRenderers();
    await expect(prepared.ready(new AbortController().signal)).rejects.toThrow("checkpoint expired");
    await prepared.rollback();
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["standalone"]);
    expect(useAppStore.getState().terminalGroups).toEqual([]);
    expect(useAppStore.getState().activeTabId).toBe("standalone");
    expect(useAppStore.getState().activeView).toBe("hosts");
    for (const id of ids) expect(mocks.controllers.get(id)?.dispose).toHaveBeenCalledWith({ preserveSession: true });
  });

  it("inserts a live incoming terminal in pane four and preserves the existing group's empty pane positions", async () => {
    useAppStore.getState().setTerminalGroup({ id: "target", layout: "grid", tabIds: ["standalone"] });
    const incoming = { ...offer(), workspace: undefined, placement: { beforeTabId: null, windowLabel: "detached-target", pane: { groupId: "target", index: 3 } } };
    const prepared = await prepareWorkspaceHandoff(incoming, vi.fn());
    const state = useAppStore.getState();
    const newId = state.activeTabId!;
    expect(state.terminalGroups[0].paneSlots).toEqual(["standalone", null, null, newId]);
    expect(state.sessionIds[newId]).toBe(41);
    expect(state.terminalGroups).toHaveLength(1);
    state.setTerminalInstance(newId, {} as Terminal);
    await prepared.ready(new AbortController().signal);
    await prepared.commit();
    expect(mocks.controllers.get(newId)?.commitIncomingHandoff).toHaveBeenCalledOnce();
    expect(useAppStore.getState().terminalTransfers).toEqual({});
  });

  it("restores a target group after failed pane replay and refuses occupied, missing or invalid destinations before creating attachments", async () => {
    useAppStore.getState().setTerminalGroup({ id: "target", layout: "grid", tabIds: ["standalone"] });
    const incoming = { ...offer(), workspace: undefined, placement: { beforeTabId: null, pane: { groupId: "target", index: 3 } } };
    const prepared = await prepareWorkspaceHandoff(incoming, vi.fn());
    const newId = useAppStore.getState().activeTabId!;
    mocks.controllers.get(newId)!.waitForHandoffReady.mockRejectedValue(new Error("replay failed"));
    useAppStore.getState().setTerminalInstance(newId, {} as Terminal);
    await expect(prepared.ready(new AbortController().signal)).rejects.toThrow("replay failed");
    await prepared.rollback();
    expect(useAppStore.getState().terminalGroups[0].paneSlots).toEqual(["standalone", null, null, null]);
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["standalone"]);
    for (const pane of [{ groupId: "target", index: 0 }, { groupId: "gone", index: 3 }, { groupId: "target", index: 4 }]) {
      await expect(prepareWorkspaceHandoff({ ...incoming, placement: { beforeTabId: null, pane } }, vi.fn())).rejects.toThrow("no longer empty");
    }
    await expect(prepareWorkspaceHandoff({ ...offer(), placement: incoming.placement }, vi.fn())).rejects.toThrow("no longer empty");
    expect(useAppStore.getState().terminalTabs).toHaveLength(1);
  });

  it("rejects a pane in an outgoing group before creating a tab, while allowing an independent group return", async () => {
    const state = useAppStore.getState();
    state.setTerminalGroup({ id: "target", layout: "grid", tabIds: ["standalone"] });
    state.setTerminalTransfer("standalone", { direction: "outgoing", phase: "connecting", cancel: vi.fn() });
    const incoming = { ...offer(), workspace: undefined, placement: { beforeTabId: null, pane: { groupId: "target", index: 3 } } };
    await expect(prepareWorkspaceHandoff(incoming, vi.fn())).rejects.toThrow("workspace is being moved");
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["standalone"]);
    expect(mocks.controllers.size).toBe(0);
    const prepared = await prepareWorkspaceHandoff(offer(), vi.fn());
    expect(useAppStore.getState().terminalGroups).toHaveLength(2);
    expect(useAppStore.getState().terminalTransfers.standalone.direction).toBe("outgoing");
    await prepared.rollback();
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["standalone"]);
  });
});
