import type { MapEdge, MapNode } from "./types";

export interface DeletedMapItem {
  id: string;
  mapId: string;
  node?: MapNode;
  restoredNodeId?: string;
  pendingEdges: MapEdge[];
}
export function remapDeletedNode(item: DeletedMapItem, oldId: string, newId: string): DeletedMapItem {
  return { ...item, pendingEdges: item.pendingEdges.map((edge) => ({ ...edge,
    source_node_id: edge.source_node_id === oldId ? newId : edge.source_node_id,
    target_node_id: edge.target_node_id === oldId ? newId : edge.target_node_id,
  })) };
}
export function nodeRestoreBody(node: MapNode, mapId: string) {
  const { host_id, label, icon, color, x, y, width, height } = node;
  return { map_id: mapId, host_id, label, icon, color, x, y, width, height };
}
export function edgeRestoreBody(edge: MapEdge, mapId: string) {
  const { source_node_id, target_node_id, label, color, stroke_width, style, waypoints, ports_count, connection_type, connection_properties } = edge;
  return { map_id: mapId, source_node_id, target_node_id, label, color, stroke_width, style, waypoints, ports_count, connection_type, connection_properties };
}

/** Checkpoint each acknowledged write so a failed restoration can resume. */
export async function restoreDeletedItem(item: DeletedMapItem, operations: {
  createNode: (body: ReturnType<typeof nodeRestoreBody>) => Promise<MapNode>;
  createEdge: (body: ReturnType<typeof edgeRestoreBody>) => Promise<MapEdge>;
  isCurrent: () => boolean;
  onNode: (oldId: string, node: MapNode) => void;
  onEdge: (edge: MapEdge) => void;
  checkpoint: (item: DeletedMapItem) => void;
}): Promise<boolean> {
  let current = item;
  if (!operations.isCurrent()) return false;
  if (current.node && !current.restoredNodeId) {
    const node = await operations.createNode(nodeRestoreBody(current.node, current.mapId));
    if (!operations.isCurrent()) return false;
    const oldId = current.node.id;
    current = { ...remapDeletedNode(current, oldId, node.id), restoredNodeId: node.id };
    operations.onNode(oldId, node);
    operations.checkpoint(current);
  }
  while (current.pendingEdges.length) {
    if (!operations.isCurrent()) return false;
    const edge = await operations.createEdge(edgeRestoreBody(current.pendingEdges[0], current.mapId));
    if (!operations.isCurrent()) return false;
    operations.onEdge(edge);
    current = { ...current, pendingEdges: current.pendingEdges.slice(1) };
    operations.checkpoint(current);
  }
  return true;
}
