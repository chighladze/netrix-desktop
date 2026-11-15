import { StrictMode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
const mocks = vi.hoisted(() => ({ receive: vi.fn(), invoke: vi.fn(async () => {}), show: vi.fn(async () => {}), unminimize: vi.fn(async () => {}), handlers: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn(async (name, callback) => { mocks.handlers.set(name, callback); return () => mocks.handlers.delete(name); }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "detached-test", show: mocks.show, unminimize: mocks.unminimize }) }));
vi.mock("./windowHandoff", () => ({ HANDOFF_EVENT: "terminal-window-handoff", receiveTerminalWindow: mocks.receive, TerminalMoveCancelledError: class extends Error {} }));
import { useWindowHandoffs } from "./useWindowHandoffs";
import type { HandoffAddress, HandoffOffer } from "./windowHandoff";

beforeEach(() => {
  mocks.receive.mockReset();
  mocks.handlers.clear();
  mocks.show.mockResolvedValue(undefined);
  mocks.unminimize.mockResolvedValue(undefined);
  useAppStore.setState(useAppStore.getInitialState(), true);
});

const deliver = async (type: string, id: string, source = "source-window") => {
  await act(async () => { mocks.handlers.get("terminal-window-handoff")?.({ payload: { type, id, source, target: "detached-test" } }); });
};
const mainOptions = () => ({ isMainWindow: true, detachedAddress: null, setDetachedHost: vi.fn(), allowDetachedClose: { current: false } });

describe("detached window startup", () => {
  it("starts one transfer under React StrictMode and never cancels the real source from a replayed mount", async () => {
    mocks.receive.mockImplementation(async (_address, _prepare, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const options = { isMainWindow: false, detachedAddress: { id: "move-1", source: "main", target: "detached-test" }, setDetachedHost: vi.fn(), allowDetachedClose: { current: false } };
    const hook = renderHook(() => useWindowHandoffs(options), { wrapper: StrictMode });
    await waitFor(() => expect(mocks.receive).toHaveBeenCalledOnce());
    expect(mocks.receive.mock.calls[0][2].aborted).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
    hook.unmount();
    await waitFor(() => expect(mocks.receive.mock.calls[0][2].aborted).toBe(true));
  });
  it("keeps an existing detached workspace open when an incoming pane move fails", async () => {
    useAppStore.setState({ terminalTabs: [{ id: "existing", host: { id: 1, revision: 0, name: "host", hostname: "example.test", username: "test", port: 22, connection_type: "ssh" }, isConnected: true }], toasts: [] });
    mocks.receive.mockRejectedValue(new Error("Destination occupied"));
    const hook = renderHook(() => useWindowHandoffs({ isMainWindow: false, isWorkspaceWindow: true, detachedAddress: null, setDetachedHost: vi.fn(), allowDetachedClose: { current: false } }));
    await waitFor(() => expect(mocks.handlers.has("terminal-window-handoff")).toBe(true));
    await act(async () => { mocks.handlers.get("terminal-window-handoff")?.({ payload: { type: "open", id: "incoming", source: "main", target: "detached-test" } }); });
    await waitFor(() => expect(useAppStore.getState().toasts.some((toast) => toast.message === "Destination occupied")).toBe(true));
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalTabs[0].id).toBe("existing");
    hook.unmount();
  });

  it("serializes incoming returns so a second window cannot hide the first renderer while it prepares", async () => {
    const finish = new Map<string, () => void>();
    mocks.receive.mockImplementation(async (address: HandoffAddress) => {
      useAppStore.setState({ activeTabId: address.id });
      await new Promise<void>((resolve) => finish.set(address.id, resolve));
    });
    const hook = renderHook(() => useWindowHandoffs(mainOptions()));
    await waitFor(() => expect(mocks.handlers.size).toBe(1));
    await deliver("open", "first");
    await deliver("open", "second");
    expect(mocks.receive).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().activeTabId).toBe("first");
    await act(async () => { finish.get("first")?.(); });
    await waitFor(() => expect(mocks.receive).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().activeTabId).toBe("second");
    await act(async () => { finish.get("second")?.(); });
    hook.unmount();
  });

  it("removes a cancelled queued return and continues with the following window", async () => {
    let finishFirst = () => {};
    mocks.receive.mockImplementation(async (address: HandoffAddress) => {
      if (address.id === "first") await new Promise<void>((resolve) => { finishFirst = resolve; });
    });
    const hook = renderHook(() => useWindowHandoffs(mainOptions()));
    await waitFor(() => expect(mocks.handlers.size).toBe(1));
    await deliver("open", "first");
    await deliver("open", "cancelled");
    await deliver("open", "third");
    await deliver("cancel", "cancelled");
    await act(async () => { finishFirst(); });
    await waitFor(() => expect(mocks.receive).toHaveBeenCalledTimes(2));
    expect(mocks.receive.mock.calls.map(([address]) => address.id)).toEqual(["first", "third"]);
    expect(useAppStore.getState().toasts).toEqual([]);
    hook.unmount();
  });

  it("waits for outgoing screen capture before accepting a return", async () => {
    useAppStore.getState().setTerminalTransfer("outgoing", { direction: "outgoing", phase: "preparing", cancel: vi.fn() });
    mocks.receive.mockResolvedValue(undefined);
    const hook = renderHook(() => useWindowHandoffs(mainOptions()));
    await waitFor(() => expect(mocks.handlers.size).toBe(1));
    await deliver("open", "returning");
    expect(mocks.receive).not.toHaveBeenCalled();
    await act(async () => { useAppStore.getState().setTerminalTransfer("outgoing", null); });
    await waitFor(() => expect(mocks.receive).toHaveBeenCalledOnce());
    hook.unmount();
  });

  it("allows an unrelated return after outgoing capture so opposite-direction window moves cannot deadlock", async () => {
    useAppStore.getState().setTerminalTransfer("outgoing", { direction: "outgoing", phase: "connecting", cancel: vi.fn() });
    mocks.receive.mockResolvedValue(undefined);
    const hook = renderHook(() => useWindowHandoffs(mainOptions()));
    await waitFor(() => expect(mocks.handlers.size).toBe(1));
    await deliver("open", "opposite-direction");
    await waitFor(() => expect(mocks.receive).toHaveBeenCalledOnce());
    expect(useAppStore.getState().terminalTransfers.outgoing.phase).toBe("connecting");
    hook.unmount();
  });

  it("restores an existing window before preparing and keeps a plain Return independent of a connection-picker reservation", async () => {
    const host = { id: 1, revision: 0, name: "host", hostname: "example.test", username: "test", port: 22, connection_type: "ssh" as const };
    useAppStore.setState({ terminalTabs: [{ id: "existing", host, isConnected: true }], activeTabId: "existing", terminalGroups: [{ id: "g", layout: "grid", tabIds: ["existing"] }], pendingTerminalGroupId: "g", pendingTerminalPaneIndex: 3 });
    let restore = () => {};
    let prepared = false;
    mocks.unminimize.mockImplementationOnce(() => new Promise<void>((resolve) => { restore = resolve; }));
    mocks.receive.mockImplementation(async (_address, prepare) => {
      const item: HandoffOffer = { host, originTabId: "returning", view: { serialized: "prompt", cols: 80, rows: 24, viewportY: 0, outputOffset: 0, decoderTail: [] }, session: { status: "connected", sessionId: 77 } as HandoffOffer["session"] };
      const transaction = await prepare(item);
      prepared = true;
      expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["existing"]);
      expect(useAppStore.getState().terminalTabs).toHaveLength(2);
      await transaction.rollback();
    });
    const hook = renderHook(() => useWindowHandoffs(mainOptions()));
    await waitFor(() => expect(mocks.handlers.size).toBe(1));
    await deliver("open", "returning");
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(prepared).toBe(false);
    expect(useAppStore.getState().terminalTabs).toHaveLength(1);
    await act(async () => { restore(); });
    await waitFor(() => expect(prepared).toBe(true));
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["existing"]);
    hook.unmount();
  });
});
