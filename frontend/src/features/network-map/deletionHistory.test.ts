import { describe, expect, it, vi } from "vitest";
import { remapDeletedNode, restoreDeletedItem, type DeletedMapItem } from "./deletionHistory";
import { mapEdge, mapNode } from "./testFixtures";

describe("map deletion recovery", () => {
  it("restores device dimensions and the complete configuration of every link", async () => {
    const node = mapNode("a", { width: 240, height: 90, color: "#123456", x: -90 });
    const edge = mapEdge("e", "a", "b", { label: "Backbone", color: "#abcdef", style: "dotted", stroke_width: 7, connection_type: "fiber", ports_count: 12, waypoints: '[{"x":1,"y":2}]', connection_properties: '{"strands":24}' });
    const createNode = vi.fn(async () => ({ ...node, id: "new-a" })), createEdge = vi.fn(async () => ({ ...edge, id: "new-e" }));
    await restoreDeletedItem({ id: "delete-a", mapId: "map-a", node, pendingEdges: [edge] }, { createNode, createEdge, isCurrent: () => true, checkpoint: vi.fn(), onNode: vi.fn(), onEdge: vi.fn() });
    expect(createNode.mock.calls[0][0]).toMatchObject({ map_id: "map-a", width: 240, height: 90, color: "#123456", x: -90 });
    expect(createEdge.mock.calls[0][0]).toMatchObject({ source_node_id: "new-a", target_node_id: "b", map_id: "map-a", label: edge.label, waypoints: edge.waypoints, connection_type: "fiber", connection_properties: edge.connection_properties, style: "dotted", ports_count: 12, stroke_width: 7 });
  });
  it("resumes after a partial failure without duplicating acknowledged restores", async () => {
    const node = mapNode("a"), edges = [mapEdge("e1", "a", "b"), mapEdge("e2", "a", "c")];
    let checkpoint: DeletedMapItem = { id: "a", mapId: "map", node, pendingEdges: edges };
    const createNode = vi.fn(async () => ({ ...node, id: "new-a" }));
    const createEdge = vi.fn().mockResolvedValueOnce({ ...edges[0], id: "new-e1" }).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ...edges[1], id: "new-e2" });
    const operations = { createNode, createEdge, isCurrent: () => true, checkpoint: (value: DeletedMapItem) => { checkpoint = value; }, onNode: vi.fn(), onEdge: vi.fn() };
    await expect(restoreDeletedItem(checkpoint, operations)).rejects.toThrow("offline");
    expect(checkpoint.pendingEdges).toHaveLength(1);
    await expect(restoreDeletedItem(checkpoint, operations)).resolves.toBe(true);
    expect(createNode).toHaveBeenCalledOnce();
    expect(createEdge).toHaveBeenCalledTimes(3);
  });
  it("remaps older history after a neighbor was restored under a new ID", () => {
    const item = { id: "a", mapId: "map", node: mapNode("a"), pendingEdges: [mapEdge("e", "a", "b")] };
    expect(remapDeletedNode(item, "b", "new-b").pendingEdges[0].target_node_id).toBe("new-b");
    expect(item.pendingEdges[0].target_node_id).toBe("b");
  });
  it("does not apply an old map response or start more writes after switching maps", async () => {
    const onNode = vi.fn(), createEdge = vi.fn();
    let current = true;
    const result = await restoreDeletedItem({ id: "a", mapId: "map", node: mapNode("a"), pendingEdges: [mapEdge("e", "a", "b")] }, { createNode: async () => { current = false; return mapNode("new-a"); }, createEdge, isCurrent: () => current, onNode, onEdge: vi.fn(), checkpoint: vi.fn() });
    expect(result).toBe(false); expect(onNode).not.toHaveBeenCalled(); expect(createEdge).not.toHaveBeenCalled();
  });
});
