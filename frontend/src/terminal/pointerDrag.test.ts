import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { watchTerminalPointer, type DragRelease } from "./pointerDrag";

describe("native pointer release fallback", () => {
  beforeEach(() => { mocks.invoke.mockReset(); });
  it("uses the physical release point exactly once and does not cancel a completed observer", async () => {
    const result = { released: true, point: { x: -1500, y: 700 } };
    mocks.invoke.mockResolvedValue(result);
    const received = vi.fn();
    const stop = watchTerminalPointer("gesture", received);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(result));
    stop(); stop();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it("cancels only its own observer and ignores its late native reply", async () => {
    let finish = (_result: DragRelease) => {};
    mocks.invoke.mockImplementation((command) => command === "wait_terminal_drag_release"
      ? new Promise<DragRelease>((resolve) => { finish = resolve; }) : Promise.resolve());
    const received = vi.fn();
    const stop = watchTerminalPointer("cancelled", received);
    stop(); stop();
    expect(mocks.invoke).toHaveBeenLastCalledWith("cancel_terminal_drag", { gestureId: "cancelled" });
    finish({ released: true, point: { x: 800, y: 100 } });
    await Promise.resolve();
    expect(received).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
  it("retains the DOM fallback when native observation is unavailable", async () => {
    mocks.invoke.mockRejectedValue(new Error("unsupported"));
    const unavailable = vi.fn();
    watchTerminalPointer("unsupported", vi.fn(), true, unavailable);
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
  });
});
