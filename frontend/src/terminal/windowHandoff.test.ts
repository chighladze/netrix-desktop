import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Set<(event: { payload: unknown }) => void>();
  const state = { terminalTransfers: {} as Record<string, { cancel: () => void }>, setTerminalTransfer: vi.fn(), activeTabId: "tab-1", activeView: "terminal", terminalInstances: { "tab-1": { focus: vi.fn() } } };
  return { handlers, state, getController: vi.fn() };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, callback) => { mocks.handlers.add(callback); return () => mocks.handlers.delete(callback); }),
  emit: vi.fn(async (_name, payload) => { for (const callback of [...mocks.handlers]) callback({ payload }); }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("../state/store", () => ({ useAppStore: { getState: () => mocks.state } }));
vi.mock("./TerminalSessionController", () => ({ getTerminalSessionController: mocks.getController }));
import { emit } from "@tauri-apps/api/event";
import { HANDOFF_EVENT, HANDOFF_TIMEOUT_MS, receiveTerminalWindow, transferTerminalWindow, TerminalMoveCancelledError, type PreparedHandoff, type HandoffAddress } from "./windowHandoff";

const host = { id: -1, name: "test", hostname: "example.test", port: 22, username: "test", connection_type: "ssh" as const, password: "never-in-offer" };
const view = { serialized: "prompt", cols: 80, rows: 24, viewportY: 0, outputOffset: 17, decoderTail: [] };
const controller = { captureView: vi.fn(), getSnapshot: vi.fn(), setHandoffBusy: vi.fn(), markDetaching: vi.fn() };
const deferred = () => { let resolve = () => {}; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

describe("window handoff transaction", () => {
  beforeEach(() => {
    mocks.handlers.clear(); mocks.state.terminalTransfers = {};
    mocks.state.activeTabId = "tab-1";
    mocks.state.setTerminalTransfer.mockImplementation((id, transfer) => { if (transfer) mocks.state.terminalTransfers[id] = transfer; else delete mocks.state.terminalTransfers[id]; });
    mocks.getController.mockReturnValue(controller);
    controller.captureView.mockResolvedValue(view);
    controller.getSnapshot.mockReturnValue({ status: "connected", sessionId: 42 });
  });
  afterEach(() => { vi.useRealTimers(); mocks.handlers.clear(); });

  it("captures and commits the entire workspace together, redacting every host", async () => {
    const second = { ...controller, captureView: vi.fn(async () => ({ ...view, serialized: "second" })), getSnapshot: vi.fn(() => ({ status: "connected", sessionId: 43 })), setHandoffBusy: vi.fn(), markDetaching: vi.fn() };
    mocks.getController.mockImplementation((id) => id === "tab-2" ? second : controller);
    const ready = deferred();
    const release = vi.fn();
    let receiving: Promise<void> | undefined;
    const moving = transferTerminalWindow({ tabId: "tab-1", host, target: "detached-group", release,
      workspace: { group: { id: "g", layout: "rows", tabIds: ["tab-1", "tab-2"] }, tabs: [{ id: "tab-1", host }, { id: "tab-2", host }] },
      open: async (address) => { receiving = receiveTerminalWindow(address, async (offer) => {
        expect(offer.workspace?.group.layout).toBe("rows");
        expect(offer.workspace?.terminals.map((terminal) => terminal.session.sessionId)).toEqual([42, 43]);
        expect(offer.workspace?.terminals.every((terminal) => !("password" in terminal.host))).toBe(true);
        return { ready: () => ready.promise, commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}) };
      }, new AbortController().signal); },
    });
    await vi.waitFor(() => expect(second.captureView).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();
    expect(Object.keys(mocks.state.terminalTransfers)).toEqual(["tab-1", "tab-2"]);
    ready.resolve(); await moving; await receiving;
    expect(release).toHaveBeenCalledOnce();
    expect(second.markDetaching).toHaveBeenCalledOnce();
    expect(mocks.state.terminalTransfers).toEqual({});
  });

  it("keeps all source members when one workspace screen cannot be captured", async () => {
    const second = { ...controller, captureView: vi.fn(async () => { throw new Error("second screen failed"); }), markDetaching: vi.fn(), setHandoffBusy: vi.fn() };
    mocks.getController.mockImplementation((id) => id === "tab-2" ? second : controller);
    const release = vi.fn(); const open = vi.fn();
    await expect(transferTerminalWindow({ tabId: "tab-1", host, target: "detached-group", release, open,
      workspace: { group: { id: "g", layout: "columns", tabIds: ["tab-1", "tab-2"] }, tabs: [{ id: "tab-1", host }, { id: "tab-2", host }] },
    })).rejects.toThrow("second screen failed");
    expect(release).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(second.markDetaching).not.toHaveBeenCalled();
    expect(second.setHandoffBusy).toHaveBeenLastCalledWith(false);
    expect(mocks.state.terminalTransfers).toEqual({});
  });

  it("keeps the original until the destination has rendered and committed, with no credentials in the offer", async () => {
    const ready = deferred(); const commit = vi.fn(async () => {}); const release = vi.fn(); const rollback = vi.fn();
    let receive: Promise<void> | undefined;
    const prepare = vi.fn(async (offer) => {
      expect(offer.host).not.toHaveProperty("password");
      expect(offer.session.sessionId).toBe(42);
      expect(offer.view.outputOffset).toBe(17);
      return { ready: () => ready.promise, commit, rollback };
    });
    const moving = transferTerminalWindow({ tabId: "tab-1", host, target: "detached-test", placement: { beforeTabId: "right-neighbor" }, release,
      open: async (address) => { receive = receiveTerminalWindow(address, prepare, new AbortController().signal); },
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();
    expect(controller.markDetaching).not.toHaveBeenCalled();
    ready.resolve(); await moving; await receive;
    expect(prepare.mock.calls[0][0].placement).toEqual({ beforeTabId: "right-neighbor" });
    expect(commit).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce(); expect(rollback).not.toHaveBeenCalled();
    expect(mocks.handlers.size).toBe(0);
  });

  it("restores source controls when window creation fails", async () => {
    const release = vi.fn(); const discard = vi.fn(async () => {});
    await expect(transferTerminalWindow({ tabId: "tab-1", host, target: "detached-test", release, discard, open: async () => { throw new Error("window failed"); } })).rejects.toThrow("window failed");
    expect(release).not.toHaveBeenCalled(); expect(controller.markDetaching).not.toHaveBeenCalled();
    expect(controller.setHandoffBusy).toHaveBeenLastCalledWith(false); expect(discard).toHaveBeenCalledOnce();
    expect(mocks.state.terminalInstances["tab-1"].focus).toHaveBeenCalledOnce();
    expect(mocks.state.terminalTransfers).toEqual({}); expect(mocks.handlers.size).toBe(0);
  });

  it("times out without closing the original when the main window does not respond", async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const moving = transferTerminalWindow({ tabId: "tab-1", host, target: "main", release, open: async () => {} });
    const rejected = expect(moving).rejects.toThrow("did not confirm");
    await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS + 1); await rejected;
    expect(release).not.toHaveBeenCalled(); expect(mocks.handlers.size).toBe(0);
  });

  it("rolls back only the speculative attachment when destination replay fails", async () => {
    const release = vi.fn(); const rollback = vi.fn(async () => {}); let receiving: Promise<unknown> | undefined;
    const moving = transferTerminalWindow({ tabId: "tab-1", host, target: "detached-test", release,
      open: async (address) => { receiving = receiveTerminalWindow(address, async () => ({ ready: async () => { throw new Error("cursor expired"); }, commit: vi.fn(), rollback }), new AbortController().signal).catch(() => {}); },
    });
    await expect(moving).rejects.toThrow("cursor expired"); await receiving;
    expect(release).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalledOnce();
  });

  it("cancels pending readiness and disposes a late prepared attachment exactly once", async () => {
    const address: HandoffAddress = { id: "cancel", source: "main", target: "detached" };
    const rollback = vi.fn(async () => {}); const preparation = deferred();
    const receiving = receiveTerminalWindow(address, async () => { await preparation.promise; return { ready: vi.fn(), commit: vi.fn(), rollback } as PreparedHandoff; }, new AbortController().signal);
    const rejected = expect(receiving).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(mocks.handlers.size).toBe(1));
    await emit(HANDOFF_EVENT, { ...address, type: "offer", offer: { host, view, session: { sessionId: 42 } } });
    await emit(HANDOFF_EVENT, { ...address, type: "cancel" });
    preparation.resolve(); await rejected;
    expect(rollback).toHaveBeenCalledOnce(); expect(mocks.handlers.size).toBe(0);
  });

  it("preserves cancellation as a normal outcome across windows", async () => {
    const release = vi.fn();
    const moving = transferTerminalWindow({ tabId: "tab-1", host, target: "main", release, open: async (address) => {
      await emit(HANDOFF_EVENT, { ...address, type: "failed", cancelled: true, error: "Terminal move cancelled." });
    } });
    await expect(moving).rejects.toBeInstanceOf(TerminalMoveCancelledError);
    expect(release).not.toHaveBeenCalled();
    expect(controller.setHandoffBusy).toHaveBeenLastCalledWith(false);
  });

  it("ignores a queued cancellation after commit has begun, then acknowledges exactly once", async () => {
    const address = { id: "commit-cancel-race", source: "detached", target: "main" };
    const gate = deferred();
    const rollback = vi.fn();
    const commit = vi.fn(() => gate.promise);
    const abort = new AbortController();
    const receiving = receiveTerminalWindow(address, async () => ({ ready: async () => {}, commit, rollback }), abort.signal);
    await vi.waitFor(() => expect(mocks.handlers.size).toBe(1));
    await emit(HANDOFF_EVENT, { ...address, type: "offer", offer: { host, view, session: { sessionId: 42 } } });
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(HANDOFF_EVENT, { ...address, type: "ready" }));
    await emit(HANDOFF_EVENT, { ...address, type: "commit" });
    abort.abort();
    await emit(HANDOFF_EVENT, { ...address, type: "cancel" });
    expect(rollback).not.toHaveBeenCalled();
    gate.resolve(); await receiving;
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(vi.mocked(emit).mock.calls.filter(([, message]) => (message as { type: string }).type === "committed")).toHaveLength(1);
  });

  it("does not take focus from another tab after a failed move", async () => {
    mocks.state.activeTabId = "other-tab";
    await expect(transferTerminalWindow({ tabId: "tab-1", host, target: "detached", release: vi.fn(), open: async () => { throw new Error("window failed"); } })).rejects.toThrow("window failed");
    expect(mocks.state.terminalInstances["tab-1"].focus).not.toHaveBeenCalled();
  });
});
