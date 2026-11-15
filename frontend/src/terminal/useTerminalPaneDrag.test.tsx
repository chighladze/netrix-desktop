import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
import type { DockMatch } from "./docking";
const mocks = vi.hoisted(() => ({ query: vi.fn<() => Promise<DockMatch | null>>(async () => null), target: vi.fn(async () => null as string | null), move: vi.fn(async () => {}), emit: vi.fn(async () => {}), nativeMouse: false, nativeRelease: undefined as undefined | ((result: import("./pointerDrag").DragRelease) => void) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@tauri-apps/api/window", () => ({ cursorPosition: async () => ({ x: 600, y: 400 }), getCurrentWindow: () => ({ label: "detached-grid" }) }));
vi.mock("./docking", () => ({ queryTerminalDock: mocks.query, terminalDockWindow: mocks.target }));
vi.mock("./moveTerminalPane", () => ({ moveTerminalPane: mocks.move }));
vi.mock("./pointerDrag", async (original) => ({ ...await original<typeof import("./pointerDrag")>(), isNativeMouseGesture: () => mocks.nativeMouse, watchTerminalPointer: (_id: string, callback: typeof mocks.nativeRelease, enabled: boolean) => { if (enabled) mocks.nativeRelease = callback; return () => { mocks.nativeRelease = undefined; }; } }));
import { useTerminalPaneDrag } from "./useTerminalPaneDrag";
function Fixture() {
  const drag = useTerminalPaneDrag();
  return <><button onPointerDown={(event) => drag.start(event, "t2")}>Move pane</button>{drag.preview && <span>Dragging host-2</span>}</>;
}
describe("individual pane drag gesture", () => {
  beforeEach(() => {
    mocks.nativeMouse = false; mocks.nativeRelease = undefined;
    mocks.query.mockResolvedValue(null); mocks.target.mockResolvedValue(null);
    useAppStore.setState({ ...useAppStore.getInitialState(),
      terminalTabs: [1, 2].map((id) => ({ id: `t${id}`, host: { id, revision: 0, name: `host-${id}`, hostname: "example.test", port: 22, username: "test", connection_type: "ssh" }, isConnected: true })),
      terminalGroups: [{ id: "g", layout: "columns", tabIds: ["t1", "t2"] }], activeTabId: "t1", terminalLayout: "columns",
    });
  });
  const begin = () => {
    render(<Fixture />);
    fireEvent.pointerDown(screen.getByRole("button"), { button: 0, pointerId: 5, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 120, clientY: 115 });
  };
  it("drags exactly the chosen member to another window's tab strip", async () => {
    const placement = { windowLabel: "main", beforeTabId: "neighbor" };
    mocks.query.mockResolvedValue({ placement });
    begin();
    expect(useAppStore.getState().activeTabId).toBe("t2");
    fireEvent.pointerUp(window, { pointerId: 5 });
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith("t2", placement));
  });
  it("creates a floating terminal only when dropped outside Netrix windows", async () => {
    begin();
    fireEvent.pointerUp(window, { pointerId: 5 });
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith("t2", undefined, { x: 600, y: 400 }));
  });
  it("cancels on Escape or an occupied destination without moving the group", async () => {
    mocks.target.mockResolvedValue("detached-occupied");
    begin();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 5 });
    expect(mocks.move).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button"), { button: 0, pointerId: 6, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 6, clientX: 120, clientY: 115 });
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 6 }); });
    expect(mocks.target).toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t1", "t2"]);
  });
  it("treats a header click or tiny movement as pane focus only", async () => {
    render(<Fixture />);
    fireEvent.pointerDown(screen.getByRole("button"), { button: 0, pointerId: 9, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 9, clientX: 103, clientY: 102 });
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 9 }); });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("cancels a released pane while destination geometry is still pending and ignores duplicate pointerup", async () => {
    let finish = (_match: DockMatch | null) => {};
    mocks.query.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    begin();
    await act(async () => { fireEvent.pointerUp(window, { pointerId: 5 }); });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 5 });
    await act(async () => { finish({ placement: { windowLabel: "main", beforeTabId: null } }); });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["t1", "t2"]);
  });
  it("survives capture loss and blur during a native mouse gesture, then uses its release point once", async () => {
    mocks.nativeMouse = true;
    const placement = { windowLabel: "main", beforeTabId: null };
    mocks.query.mockResolvedValue({ placement });
    begin();
    fireEvent.lostPointerCapture(screen.getByRole("button"), { pointerId: 5 });
    fireEvent.blur(window);
    fireEvent.pointerUp(window, { pointerId: 5 });
    expect(mocks.move).not.toHaveBeenCalled();
    const nativeRelease = mocks.nativeRelease!;
    await act(async () => { nativeRelease({ released: true, point: { x: -1234, y: 600 } }); });
    await waitFor(() => expect(mocks.move).toHaveBeenCalledOnce());
    expect(mocks.move).toHaveBeenCalledWith("t2", placement);
    expect(mocks.query).toHaveBeenLastCalledWith({ x: -1234, y: 600 }, expect.anything());
    await act(async () => { nativeRelease({ released: true, point: { x: 9000, y: 1 } }); });
    expect(mocks.move).toHaveBeenCalledOnce();
  });
});
