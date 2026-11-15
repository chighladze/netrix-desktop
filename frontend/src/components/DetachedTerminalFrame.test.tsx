import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  cursor: vi.fn(async () => ({ x: 500, y: 100 })),
  emit: vi.fn(async () => {}),
  moved: undefined as undefined | (() => Promise<void>),
  release: () => {},
  drag: vi.fn(),
  nativeRelease: vi.fn(),
  finishNative: (_result: { released: boolean; point: { x: number; y: number } }) => {},
  store: { terminalTransfers: {}, addToast: vi.fn() },
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: mocks.cursor,
  getCurrentWindow: () => ({
    label: "detached-test",
    isMaximized: async () => false,
    onResized: async () => () => {},
    onMoved: async (callback: () => Promise<void>) => { mocks.moved = callback; return () => { mocks.moved = undefined; }; },
    startDragging: mocks.drag,
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string) => command === "wait_terminal_drag_release" ? mocks.nativeRelease() : Promise.resolve() }));
vi.mock("../terminal/docking", () => ({ queryTerminalDock: mocks.query }));
vi.mock("../terminal/pointerDrag", async (original) => ({ ...await original<typeof import("../terminal/pointerDrag")>(), isNativeMouseGesture: () => true }));
vi.mock("../state/store", () => ({ useAppStore: Object.assign((selector: (state: typeof mocks.store) => unknown) => selector(mocks.store), { getState: () => mocks.store }) }));
import DetachedTerminalFrame from "./DetachedTerminalFrame";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue(null);
  mocks.cursor.mockResolvedValue({ x: 500, y: 100 });
  mocks.nativeRelease.mockImplementation(() => new Promise((resolve) => { mocks.finishNative = resolve; }));
  mocks.drag.mockImplementation(() => new Promise<void>((resolve) => { mocks.release = resolve; }));
});
afterEach(() => { vi.useRealTimers(); });

function setup(onReturn = vi.fn(async () => {}), sessionCount = 1) {
  const view = render(<DetachedTerminalFrame title="Router" isConnected onReturn={onReturn} onClose={() => {}} sessionCount={sessionCount}><div data-testid="live-terminal" /></DetachedTerminalFrame>);
  const stage = view.container.querySelector<HTMLElement>("[data-dock-armed]")!;
  const start = async () => {
    await act(async () => { fireEvent.pointerDown(view.container.querySelector("[data-terminal-window-drag-region]")!, { button: 0, clientX: 100, clientY: 12, pointerId: 1 }); fireEvent.pointerMove(window, { clientX: 112, clientY: 12, pointerId: 1 }); });
    expect(mocks.moved).toBeDefined();
  };
  return { ...view, stage, start, onReturn };
}

describe("detached terminal docking preview", () => {
  it("shrinks on entry and restores on exit without replacing the live terminal", async () => {
    const view = setup();
    const terminal = screen.getByTestId("live-terminal");
    await view.start();
    mocks.query.mockResolvedValue({ placement: { beforeTabId: "tab-right" } });
    await act(async () => { await mocks.moved?.(); });
    expect(view.stage.getAttribute("data-dock-armed")).toBe("true");
    expect(screen.getByTestId("live-terminal")).toBe(terminal);
    mocks.query.mockResolvedValue(null);
    await act(async () => { await mocks.moved?.(); });
    expect(view.stage.getAttribute("data-dock-armed")).toBe("false");
    expect(screen.getByTestId("live-terminal")).toBe(terminal);
    await act(async () => { mocks.finishNative({ released: true, point: { x: 500, y: 100 } }); mocks.release(); });
    expect(view.onReturn).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith("terminal-dock-end", expect.objectContaining({ source: "detached-test" }));
  });

  it("keeps the destination alive while paused, stops probing on release, and stays compact until return completes", async () => {
    let finishReturn = () => {};
    vi.useFakeTimers();
    const onReturn = vi.fn(() => new Promise<void>((resolve) => { finishReturn = resolve; }));
    const view = setup(onReturn);
    mocks.drag.mockResolvedValue(undefined);
    mocks.nativeRelease.mockImplementation(() => new Promise((resolve) => { mocks.release = () => resolve({ released: true, point: { x: 500, y: 100 } }); }));
    await view.start();
    mocks.query.mockResolvedValue({ placement: { beforeTabId: "tab-right" } });
    const before = mocks.query.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_440); });
    expect(onReturn).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.length - before).toBeGreaterThanOrEqual(10);
    expect(view.stage.getAttribute("data-dock-armed")).toBe("true");
    await act(async () => { fireEvent.pointerUp(window); });
    expect(onReturn).not.toHaveBeenCalled();
    await act(async () => { mocks.release(); });
    expect(onReturn).toHaveBeenCalledOnce();
    expect(onReturn).toHaveBeenCalledWith({ beforeTabId: "tab-right" });
    expect(view.stage.getAttribute("data-dock-armed")).toBe("true");
    const after = mocks.query.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); mocks.release(); });
    expect(mocks.query).toHaveBeenCalledTimes(after);
    expect(onReturn).toHaveBeenCalledOnce();
    await act(async () => { finishReturn(); });
    expect(view.stage.getAttribute("data-dock-armed")).toBe("false");
  });

  it("clears both previews when native dragging fails", async () => {
    const view = setup();
    mocks.drag.mockRejectedValue(new Error("Drag unavailable"));
    fireEvent.pointerDown(view.container.querySelector("[data-terminal-window-drag-region]")!, { button: 0, clientX: 100, clientY: 12, pointerId: 1 }); fireEvent.pointerMove(window, { clientX: 112, clientY: 12, pointerId: 1 });
    await waitFor(() => expect(mocks.emit).toHaveBeenCalledWith("terminal-dock-end", expect.objectContaining({ source: "detached-test" })));
    expect(view.stage.getAttribute("data-dock-armed")).toBe("false");
    expect(view.onReturn).not.toHaveBeenCalled();
  });

  it("cancels docking on native Escape even over an armed destination", async () => {
    const view = setup();
    await view.start();
    mocks.query.mockResolvedValue({ placement: { beforeTabId: "tab-right" } });
    await act(async () => { await mocks.moved?.(); });
    await act(async () => { mocks.finishNative({ released: false, point: { x: 500, y: 100 } }); });
    await act(async () => { fireEvent.pointerUp(window); });
    expect(view.onReturn).not.toHaveBeenCalled();
    await act(async () => { mocks.release(); });
    expect(view.stage.getAttribute("data-dock-armed")).toBe("false");
    expect(view.onReturn).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith("terminal-dock-end", expect.objectContaining({ source: "detached-test" }));
  });

  it("leaves a title click and a tiny pointer movement as ordinary clicks", async () => {
    const view = setup();
    fireEvent.pointerDown(view.container.querySelector("[data-terminal-window-drag-region]")!, { button: 0, clientX: 100, clientY: 12, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 103, clientY: 12, pointerId: 1 });
    fireEvent.pointerUp(window);
    expect(mocks.drag).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(view.onReturn).not.toHaveBeenCalled();
    expect(view.stage.dataset.phase).toBe("idle");
  });

  it("ignores a late hover response after Escape and starts a fresh drag", async () => {
    const view = setup();
    await view.start();
    let late = (_value: unknown) => {};
    mocks.query.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    const pending = mocks.moved?.();
    await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
    await act(async () => { late({ placement: { beforeTabId: null } }); await pending; });
    expect(view.stage.dataset.phase).toBe("idle");
    expect(view.onReturn).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue(null);
    await view.start();
    expect(view.stage.dataset.phase).toBe("dragging");
  });

  it("uses the same compact return animation for the button without starting a native drag", async () => {
    let done = () => {};
    const onReturn = vi.fn(() => new Promise<void>((resolve) => { done = resolve; }));
    const view = setup(onReturn);
    fireEvent.click(screen.getByRole("button", { name: "Return terminal to main window" }));
    expect(view.stage.dataset.phase).toBe("returning");
    expect(view.stage.dataset.dockArmed).toBe("true");
    expect(onReturn).toHaveBeenCalledWith(undefined);
    expect(mocks.drag).not.toHaveBeenCalled();
    await act(async () => { done(); });
    expect(view.stage.dataset.phase).toBe("idle");
  });
  it.each([1, 4])("finishes a %i-session native drop even before the OS move acknowledgement arrives", async (sessionCount) => {
    const placement = { windowLabel: "main", beforeTabId: "neighbor" };
    mocks.query.mockResolvedValue({ placement });
    const view = setup(vi.fn(async () => {}), sessionCount);
    await view.start();
    expect(mocks.nativeRelease.mock.invocationCallOrder[0]).toBeLessThan(mocks.drag.mock.invocationCallOrder[0]);
    expect(view.onReturn).not.toHaveBeenCalled();
    await act(async () => { mocks.finishNative({ released: true, point: { x: 901, y: 62 } }); });
    expect(view.onReturn).toHaveBeenCalledExactlyOnceWith(placement);
    expect(mocks.query).toHaveBeenLastCalledWith({ x: 901, y: 62 }, expect.objectContaining({ sessionCount }));
    await act(async () => { mocks.release(); });
    expect(view.onReturn).toHaveBeenCalledOnce();
  });
  it.each([1, 4])("accepts a matching DOM release for %i sessions without waiting on the native observer", async (sessionCount) => {
    const placement = { windowLabel: "main", beforeTabId: null };
    mocks.query.mockResolvedValue({ placement });
    const view = setup(vi.fn(async () => {}), sessionCount);
    await view.start();
    await act(async () => { fireEvent.pointerUp(window, { button: 0, pointerId: 8 }); });
    expect(view.onReturn).not.toHaveBeenCalled();
    await act(async () => { fireEvent.pointerUp(window, { button: 0, pointerId: 1 }); });
    await waitFor(() => expect(view.onReturn).toHaveBeenCalledExactlyOnceWith(placement));
    await act(async () => { mocks.release(); mocks.finishNative({ released: true, point: { x: 999, y: 999 } }); });
    expect(view.onReturn).toHaveBeenCalledOnce();
  });
  it("honors a native Escape following DOM release before committing a dock", async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({ placement: { windowLabel: "main", beforeTabId: null } });
    const view = setup();
    await view.start();
    await act(async () => { fireEvent.pointerUp(window, { button: 0, pointerId: 1 }); });
    await act(async () => { mocks.finishNative({ released: false, point: { x: 500, y: 100 } }); await vi.advanceTimersByTimeAsync(100); });
    expect(view.onReturn).not.toHaveBeenCalled();
    expect(view.stage.dataset.phase).toBe("idle");
  });
  it("uses the native physical release point when a DOM point differs across monitors", async () => {
    const placement = { windowLabel: "main", beforeTabId: null };
    mocks.query.mockImplementation(async (point) => point.x === -1400 ? { placement } : null);
    mocks.cursor.mockResolvedValue({ x: -1400, y: 160 });
    const view = setup();
    await view.start();
    mocks.cursor.mockResolvedValue({ x: -1120, y: 128 });
    await act(async () => { fireEvent.pointerUp(window, { button: 0, pointerId: 1 }); });
    await act(async () => { mocks.finishNative({ released: true, point: { x: -1400, y: 160 } }); });
    expect(view.onReturn).toHaveBeenCalledExactlyOnceWith(placement);
    expect(mocks.query).toHaveBeenLastCalledWith({ x: -1400, y: 160 }, expect.anything());
  });
  it("adopts a late native point while a DOM drop is being revalidated", async () => {
    vi.useFakeTimers();
    const placement = { windowLabel: "main", beforeTabId: null };
    mocks.query.mockImplementation(async (point) => point.x === -1400 ? { placement } : null);
    mocks.cursor.mockResolvedValue({ x: -1400, y: 160 });
    const view = setup();
    await view.start();
    mocks.cursor.mockResolvedValue({ x: -1120, y: 128 });
    await act(async () => { fireEvent.pointerUp(window, { button: 0, pointerId: 1 }); await vi.advanceTimersByTimeAsync(49); });
    expect(view.onReturn).not.toHaveBeenCalled();
    await act(async () => { mocks.finishNative({ released: true, point: { x: -1400, y: 160 } }); await vi.advanceTimersByTimeAsync(100); });
    expect(view.onReturn).toHaveBeenCalledExactlyOnceWith(placement);
  });
  it("rechecks an armed destination after a transient native hit-test miss", async () => {
    vi.useFakeTimers();
    const placement = { windowLabel: "main", beforeTabId: null };
    mocks.query.mockResolvedValue({ placement });
    const view = setup();
    await view.start();
    mocks.query.mockResolvedValueOnce(null).mockResolvedValue({ placement });
    await act(async () => { mocks.finishNative({ released: true, point: { x: 500, y: 100 } }); await vi.advanceTimersByTimeAsync(60); });
    expect(view.onReturn).toHaveBeenCalledExactlyOnceWith(placement);
  });
  it("does not use a cached armed placement for a drop outside the destination", async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({ placement: { windowLabel: "main", beforeTabId: null } });
    const view = setup();
    await view.start();
    mocks.query.mockResolvedValue(null);
    await act(async () => { mocks.finishNative({ released: true, point: { x: 9000, y: 9000 } }); await vi.advanceTimersByTimeAsync(150); });
    expect(view.onReturn).not.toHaveBeenCalled();
    expect(view.stage.dataset.phase).toBe("idle");
  });
  it("cancels a pending destination retry on Escape", async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValue({ placement: { windowLabel: "main", beforeTabId: null } });
    const view = setup();
    await view.start();
    mocks.query.mockResolvedValue(null);
    await act(async () => { mocks.finishNative({ released: true, point: { x: 500, y: 100 } }); });
    await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); await vi.advanceTimersByTimeAsync(200); });
    expect(view.onReturn).not.toHaveBeenCalled();
    expect(view.stage.dataset.phase).toBe("idle");
  });
});
