import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => Promise<void> | void>(),
  origin: vi.fn(async () => ({ x: 0, y: 0 })),
  emit: vi.fn(async () => {}),
  label: "main",
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: async (name: string, callback: (event: { payload: unknown }) => Promise<void> | void) => {
    mocks.listeners.set(name, callback);
    return () => { mocks.listeners.delete(name); };
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: mocks.label, innerPosition: mocks.origin, isMinimized: async () => false }) }));
import TerminalDockTarget from "./TerminalDockTarget";

describe("terminal dock destination", () => {
  beforeEach(() => {
    mocks.label = "main";
    mocks.origin.mockResolvedValue({ x: 0, y: 0 });
    useAppStore.setState({ terminalTransfers: {}, terminalGroups: [] });
  });
  it("does not resurrect a shelf from a geometry request that completes after drag ended", async () => {
    let resolveOrigin = (_origin: { x: number; y: number }) => {};
    mocks.origin.mockImplementationOnce(() => new Promise((resolve) => { resolveOrigin = resolve; }));
    const view = render(<><main data-terminal-dock-surface /><TerminalDockTarget enabled tabPosition="top" /></>);
    vi.spyOn(view.container.querySelector("main")!, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 1000, height: 700, bottom: 700 } as DOMRect);
    let pending: Promise<void> | void;
    await act(async () => { pending = mocks.listeners.get("terminal-dock-probe")?.({ payload: { id: "probe", source: "detached-test", point: { x: 100, y: 20 } } }); });
    await act(async () => { await mocks.listeners.get("terminal-dock-end")?.({ payload: null }); });
    await act(async () => { resolveOrigin({ x: 0, y: 0 }); await pending; });
    expect(screen.queryByText("Release to return terminal")).toBeNull();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("advertises an exact empty pane in a detached workspace and refuses an occupied pane or a multi-session source", async () => {
    mocks.label = "detached-grid";
    useAppStore.setState({ terminalGroups: [{ id: "g", layout: "grid", tabIds: ["a", "b"] }] });
    const view = render(<><main data-terminal-dock-surface><div data-terminal-empty-pane="4" data-terminal-group-id="g" data-terminal-pane-index="3" /></main><TerminalDockTarget enabled tabPosition="top" allowTabStrip={false} /></>);
    const rect = { x: 200, y: 200, width: 300, height: 250, bottom: 450 } as DOMRect;
    vi.spyOn(view.container.querySelector("main")!, "getBoundingClientRect").mockReturnValue(rect);
    vi.spyOn(view.container.querySelector("[data-terminal-empty-pane]")!, "getBoundingClientRect").mockReturnValue(rect);
    const probe = async (sessionCount = 1, target = "detached-grid") => {
      await act(async () => { await mocks.listeners.get("terminal-dock-probe")?.({ payload: { id: "probe", source: "main", target, sessionCount, point: { x: 250, y: 250 } } }); });
    };
    await probe();
    expect(mocks.emit).toHaveBeenLastCalledWith("terminal-dock-result", expect.objectContaining({ target: "detached-grid", armed: true, placement: { beforeTabId: null, windowLabel: "detached-grid", pane: { groupId: "g", index: 3 } } }));
    expect(screen.getByText("Release to insert in pane 4")).toBeTruthy();
    await probe(2);
    expect(mocks.emit).toHaveBeenLastCalledWith("terminal-dock-result", expect.objectContaining({ armed: false }));
    useAppStore.setState({ terminalGroups: [{ id: "g", layout: "grid", tabIds: ["a", "b", "c"], paneSlots: ["a", "b", null, "c"] }] });
    await probe();
    expect(mocks.emit).toHaveBeenLastCalledWith("terminal-dock-result", expect.objectContaining({ armed: false }));
    mocks.emit.mockClear();
    await probe(1, "other-window");
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("answers overlapping hover and final-drop requests while keeping only the newest hint", async () => {
    let finishSlow = (_origin: { x: number; y: number }) => {};
    mocks.origin.mockImplementationOnce(() => new Promise((resolve) => { finishSlow = resolve; }));
    const view = render(<><main data-terminal-dock-surface /><TerminalDockTarget enabled tabPosition="top" /></>);
    vi.spyOn(view.container.querySelector("main")!, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 1000, height: 700, bottom: 700 } as DOMRect);
    const probe = mocks.listeners.get("terminal-dock-probe")!;
    let slow: Promise<void> | void;
    await act(async () => { slow = probe({ payload: { id: "hover", source: "detached-test", gestureId: "drag", title: "Old hover", point: { x: 100, y: 20 } } }); });
    await act(async () => { await probe({ payload: { id: "drop", source: "detached-test", gestureId: "drag", title: "Final drop", point: { x: 100, y: 20 } } }); });
    await act(async () => { finishSlow({ x: 0, y: 0 }); await slow; });
    expect(mocks.emit).toHaveBeenCalledWith("terminal-dock-result", expect.objectContaining({ id: "hover", armed: true }));
    expect(mocks.emit).toHaveBeenCalledWith("terminal-dock-result", expect.objectContaining({ id: "drop", armed: true }));
    expect(screen.getByText("Final drop")).toBeTruthy();
    expect(screen.queryByText("Old hover")).toBeNull();
    await act(async () => { await mocks.listeners.get("terminal-dock-end")?.({ payload: { source: "other-window", gestureId: "old-drag" } }); });
    expect(screen.getByText("Final drop")).toBeTruthy();
  });
});
