import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useAppStore } from "../state/store";
import type { DockMatch } from "../terminal/docking";
const mocks = vi.hoisted(() => ({
  end: undefined as ((event: DragEndEvent) => Promise<void>) | undefined,
  start: undefined as ((event: DragStartEvent) => void) | undefined,
  query: vi.fn<() => Promise<DockMatch | null>>(async () => null),
  transfer: vi.fn(async (_options: Parameters<typeof import("../terminal/windowHandoff").transferTerminalWindow>[0]) => {}),
  open: vi.fn(),
  target: vi.fn(async () => "detached-occupied" as string | null),
  cursor: vi.fn(async () => ({ x: 600, y: 400 })),
}));
vi.mock("@dnd-kit/core", async (original) => ({ ...await original<typeof import("@dnd-kit/core")>(), DndContext: ({ children, onDragStart, onDragEnd }: { children: React.ReactNode; onDragStart: typeof mocks.start; onDragEnd: typeof mocks.end }) => { mocks.start = onDragStart; mocks.end = onDragEnd; return <>{children}</>; } }));
vi.mock("@tauri-apps/api/window", () => ({ cursorPosition: mocks.cursor, getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}) }));
vi.mock("../terminal/docking", async (original) => ({ ...await original<typeof import("../terminal/docking")>(), queryTerminalDock: mocks.query, terminalDockWindow: mocks.target }));
vi.mock("../terminal/useWindowHandoffs", () => ({ waitForTerminalRenderer: async () => {}, openMainTerminalHandoff: mocks.open }));
vi.mock("../terminal/windowHandoff", () => ({ transferTerminalWindow: mocks.transfer, TerminalMoveCancelledError: class extends Error {} }));
import TerminalTabsBar from "./TerminalTabsBar";

describe("tab drops into empty panes", () => {
  beforeEach(() => {
    mocks.query.mockResolvedValue(null);
    mocks.target.mockResolvedValue("detached-occupied");
    mocks.cursor.mockResolvedValue({ x: 600, y: 400 });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    useAppStore.setState({ ...useAppStore.getInitialState(), terminalTabs: [1, 2, 3].map((id) => ({ id: `t${id}`, host: { id, revision: 0, name: `host-${id}`, hostname: "example.test", port: 22, username: "test", connection_type: "ssh" }, isConnected: true })), activeTabId: "t1", sessionIds: { t1: 101, t2: 102, t3: 103 }, terminalGroups: [{ id: "g", layout: "grid", tabIds: ["t1", "t2"] }], terminalLayout: "grid" });
  });
  afterEach(() => vi.unstubAllGlobals());
  const drop = async () => {
    render(<TerminalTabsBar onAddTab={() => {}} />);
    const active = { id: "t3", data: { current: {} }, rect: { current: { initial: null, translated: null } } };
    const activatorEvent = new MouseEvent("pointerdown", { clientX: 500, clientY: 20 });
    act(() => mocks.start?.({ active, activatorEvent }));
    await act(async () => { await mocks.end?.({ active, activatorEvent, collisions: null, over: null, delta: { x: 0, y: 250 } }); });
  };
  it("moves a local standalone tab into the selected cell without creating a window or transport", async () => {
    mocks.query.mockResolvedValue({ placement: { beforeTabId: null, windowLabel: "main", pane: { groupId: "g", index: 3 } } });
    await drop();
    expect(useAppStore.getState().terminalGroups[0].paneSlots).toEqual(["t1", "t2", null, "t3"]);
    expect(useAppStore.getState().sessionIds.t3).toBe(103);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });
  it("routes a standalone tab to another window's pane using the acknowledged handoff", async () => {
    const placement = { beforeTabId: null, windowLabel: "detached-target", pane: { groupId: "remote-group", index: 2 } };
    mocks.query.mockResolvedValue({ placement });
    await drop();
    expect(mocks.transfer).toHaveBeenCalledOnce();
    expect(mocks.transfer.mock.calls[0][0]).toMatchObject({ tabId: "t3", target: "detached-target", placement });
    expect(useAppStore.getState().terminalTabs).toHaveLength(3);
  });
  it("keeps a refused occupied-window drop at the source without opening a replacement window", async () => {
    await drop();
    expect(mocks.target).toHaveBeenCalled();
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalTabs).toHaveLength(3);
  });
  it("cancels a released tab while its final dock reply is delayed", async () => {
    let reply = (_result: DockMatch | null) => {};
    mocks.query.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    render(<TerminalTabsBar onAddTab={() => {}} />);
    const active = { id: "t3", data: { current: {} }, rect: { current: { initial: null, translated: null } } };
    const activatorEvent = new MouseEvent("pointerdown", { clientX: 500, clientY: 20 });
    act(() => mocks.start?.({ active, activatorEvent }));
    let pending: Promise<void> | undefined;
    await act(async () => { pending = mocks.end?.({ active, activatorEvent, collisions: null, over: null, delta: { x: 0, y: 250 } }); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    await act(async () => { reply({ placement: { beforeTabId: null, windowLabel: "detached-target" } }); await pending; });
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalTabs).toHaveLength(3);
  });
  it("clears the drag lock after cursor discovery fails", async () => {
    mocks.cursor.mockRejectedValue(new Error("window closed"));
    await drop();
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(document.querySelector('[data-terminal-tab-id="t3"]')?.getAttribute("aria-busy")).toBe("false");
  });
  it("does not resurrect a source tab removed while its destination was resolving", async () => {
    let reply = (_result: DockMatch | null) => {};
    mocks.query.mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    render(<TerminalTabsBar onAddTab={() => {}} />);
    const active = { id: "t3", data: { current: {} }, rect: { current: { initial: null, translated: null } } };
    const activatorEvent = new MouseEvent("pointerdown", { clientX: 500, clientY: 20 });
    act(() => mocks.start?.({ active, activatorEvent }));
    let pending: Promise<void> | undefined;
    await act(async () => { pending = mocks.end?.({ active, activatorEvent, collisions: null, over: null, delta: { x: 0, y: 250 } }); });
    act(() => useAppStore.setState((state) => ({ terminalTabs: state.terminalTabs.filter((tab) => tab.id !== "t3") })));
    await act(async () => { reply({ placement: { beforeTabId: null, windowLabel: "detached-target" } }); await pending; });
    expect(mocks.transfer).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
  });
});
