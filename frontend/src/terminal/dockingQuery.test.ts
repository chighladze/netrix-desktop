import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => "detached-target" as string | null), handlers: new Set<(event: { payload: unknown }) => void>(), emit: vi.fn(async (_name: string, _payload: unknown) => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, callback: (event: { payload: unknown }) => void) => { mocks.handlers.add(callback); return () => mocks.handlers.delete(callback); },
  emit: mocks.emit,
}));
import { queryTerminalDock } from "./docking";

describe("cross-window dock discovery", () => {
  beforeEach(() => { mocks.handlers.clear(); mocks.invoke.mockResolvedValue("detached-target"); });
  it("queries only the top visible native destination and ignores replies from overlapping windows", async () => {
    mocks.emit.mockImplementation(async (_name, payload) => {
      const probe = payload as { id: string; source: string; target: string };
      for (const callback of mocks.handlers) {
        callback({ payload: { ...probe, target: "window-behind", armed: false } });
        callback({ payload: { ...probe, armed: true, placement: { beforeTabId: null, pane: { groupId: "g", index: 3 } } } });
      }
    });
    const result = await queryTerminalDock({ x: -900, y: 350 }, { excludeSource: false, sessionCount: 1 });
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_dock_target", { x: -900, y: 350, excludeSource: false });
    expect(result?.placement).toEqual({ beforeTabId: null, windowLabel: "detached-target", pane: { groupId: "g", index: 3 } });
    expect(mocks.emit).toHaveBeenCalledWith("terminal-dock-probe", expect.objectContaining({ target: "detached-target", sessionCount: 1 }));
    expect(mocks.handlers.size).toBe(0);
  });
  it("does not advertise a target through a foreign application and excludes the dragged native window by default", async () => {
    mocks.invoke.mockResolvedValue(null);
    expect(await queryTerminalDock({ x: 100, y: 200 })).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("terminal_dock_target", { x: 100, y: 200, excludeSource: true });
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("stops waiting and removes its listener immediately when a gesture is cancelled", async () => {
    mocks.emit.mockImplementation(async () => {});
    const abort = new AbortController();
    const pending = queryTerminalDock({ x: 100, y: 200 }, { signal: abort.signal });
    await vi.waitFor(() => expect(mocks.handlers.size).toBe(1));
    abort.abort();
    expect(await pending).toBeNull();
    expect(mocks.handlers.size).toBe(0);
    const count = mocks.invoke.mock.calls.length;
    expect(await queryTerminalDock({ x: 100, y: 200 }, { signal: abort.signal })).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(count);
  });
});
