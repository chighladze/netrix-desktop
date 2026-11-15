import { describe, expect, it } from "vitest";
import { findMapNodes, nodeReachability } from "./presentation";
import { sampleNodes } from "./testFixtures";

describe("map device discovery", () => {
  it("combines search terms across identity, protocol, group and address", () => {
    expect(findMapNodes(sampleNodes, " PRODUCTION ssh 192.0.2.10 ", "all", {}, true).map(n => n.id)).toEqual(["core"]);
    expect(findMapNodes(sampleNodes, "  ", "all", {}, true)).toHaveLength(sampleNodes.length);
  });
  it("separates no ping response from unknown and paused monitoring", () => {
    const ping = { core: true, wifi: false, db: null };
    expect(findMapNodes(sampleNodes, "", "unreachable", ping, true).map(n => n.id)).toEqual(["wifi"]);
    expect(findMapNodes(sampleNodes, "", "reachable", ping, false)).toEqual([]);
    expect(nodeReachability(sampleNodes[0], { internet: true }, true)).toBe("unknown");
    expect(findMapNodes(sampleNodes, "", "unknown", ping, true).map(n => n.id)).toContain("db");
  });
});
