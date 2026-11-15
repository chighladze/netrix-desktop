import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
import { containsPhysicalPoint, dockSlot, isOutsideTabStrip, placeTerminalTab } from "./docking";

describe("terminal dock coordinates", () => {
  it.each([1, 1.25, 1.5, 2])("uses the actual client bounds at scale %s", (scale) => {
    const origin = { x: -1920, y: 240 };
    const rect = { x: 256, y: 75, width: 900, height: 41 };
    expect(containsPhysicalPoint(rect, origin, scale, { x: origin.x + 300 * scale, y: origin.y + 90 * scale })).toBe(true);
    expect(containsPhysicalPoint(rect, origin, scale, { x: origin.x + 300 * scale, y: origin.y + 120 * scale })).toBe(false);
    expect(containsPhysicalPoint(rect, origin, scale, { x: origin.x + 250 * scale, y: origin.y + 90 * scale })).toBe(false);
  });
});

describe("tab window gestures and placement", () => {
  const bounds = { x: 250, y: 40, width: 1000, height: 40 };
  it("allows horizontal reordering anywhere inside the strip and uses hysteresis outside", () => {
    expect(isOutsideTabStrip({ x: 1100, y: 60 }, bounds, false)).toBe(false);
    expect(isOutsideTabStrip({ x: 500, y: 117 }, bounds, false)).toBe(true);
    expect(isOutsideTabStrip({ x: 500, y: 105 }, bounds, true)).toBe(true);
    expect(isOutsideTabStrip({ x: 500, y: 90 }, bounds, true)).toBe(false);
  });
  it("chooses the left or right edge by midpoint, clamping scrolled tabs to the visible strip", () => {
    const tabs = [ { id: "left", rect: { ...bounds, x: 100, width: 200 } }, { id: "right", rect: { ...bounds, x: 300, width: 200 } } ];
    expect(dockSlot(tabs, 260, bounds)).toEqual({ placement: { beforeTabId: "right" }, x: 300 });
    expect(dockSlot(tabs, 460, bounds)).toEqual({ placement: { beforeTabId: null }, x: 500 });
    expect(dockSlot(tabs, 0, bounds).x).toBe(252);
  });
  it("inserts exactly once and appends if the destination neighbor disappeared", () => {
    const tabs = [{ id: "a" }, { id: "b" }, { id: "returning" }];
    expect(placeTerminalTab(tabs, "returning", { beforeTabId: "b" }).map(t => t.id)).toEqual(["a", "returning", "b"]);
    expect(placeTerminalTab(tabs, "returning", { beforeTabId: "removed" })).toEqual(tabs);
    expect(tabs.map(t => t.id)).toEqual(["a", "b", "returning"]);
  });
  it("inserts before the entire destination group even when its representative is later in raw tab order", () => {
    const tabs = ["a", "member", "representative", "returning"].map((id) => ({ id }));
    expect(placeTerminalTab(tabs, "returning", { beforeTabId: "representative" }, [{ tabIds: ["representative", "member"] }]).map((tab) => tab.id))
      .toEqual(["a", "returning", "member", "representative"]);
  });
});
