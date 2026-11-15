import { describe, expect, it } from "vitest";
import {
  edgePath,
  getDeviceShape,
  nodeBounds,
  nodeCenter,
  parseWaypoints,
  snapCoordinate,
} from "./geometry";
import type { MapNode } from "./types";

const node = (overrides: Partial<MapNode> = {}): MapNode => ({
  id: "node-1",
  host_id: null,
  label: null,
  icon: "server",
  x: 10,
  y: 20,
  color: "#3b82f6",
  width: 120,
  height: 60,
  ...overrides,
});

describe("network map geometry", () => {
  it("snaps only when grid snapping is enabled", () => {
    expect(snapCoordinate(31, true)).toBe(40);
    expect(snapCoordinate(31, false)).toBe(31);
    expect(snapCoordinate(-11, true, 10)).toBe(-10);
  });

  it("keeps the established router silhouette and server fallback", () => {
    expect(getDeviceShape("router", 100, 60).d).toBe(
      "M 50 0 L 100 30 L 50 60 L 0 30 Z",
    );
    expect(getDeviceShape("unknown", 100, 60)).toEqual(
      getDeviceShape("server", 100, 60),
    );
  });

  it("builds a direct path when no waypoints are present", () => {
    expect(edgePath(0, 10, 100, 50)).toBe("M 0 10 L 100 50");
  });

  it("rounds a non-degenerate waypoint without moving endpoints", () => {
    const path = edgePath(0, 0, 100, 100, [{ x: 100, y: 0 }]);
    expect(path).toBe("M 0 0 L 86 0 Q 100 0 100 14 L 100 100");
  });

  it("parses numeric waypoints and drops malformed entries", () => {
    expect(parseWaypoints('[{"x":1,"y":2},{"x":"3","y":4}]')).toEqual([
      { x: 1, y: 2 },
    ]);
    expect(parseWaypoints('[{"x":1,"y":2},null]')).toEqual([{ x: 1, y: 2 }]);
    expect(parseWaypoints("not-json")).toEqual([]);
    expect(parseWaypoints('{"x":1,"y":2}')).toEqual([]);
  });

  it("uses the established minimum node size for connection centers", () => {
    expect(nodeCenter(node())).toEqual({ x: 100, y: 52 });
    expect(nodeCenter(node({ width: 220, height: 100 }))).toEqual({ x: 120, y: 70 });
  });

  it("includes the actual minimum rendered size in padded bounds", () => {
    expect(nodeBounds([
      node({ x: 10, y: 20, width: 0, height: 0 }),
      node({ id: "node-2", x: 200, y: 150, width: 80, height: 40 }),
    ], 20)).toEqual({ x: -10, y: 0, w: 410, h: 234 });
  });

  it("returns the minimap default for an empty graph", () => {
    expect(nodeBounds([], 80)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});
