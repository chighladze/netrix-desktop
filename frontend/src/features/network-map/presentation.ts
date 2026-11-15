import type { MapNode } from "./types";

export type ReachabilityFilter = "all" | "reachable" | "unreachable" | "unknown";
export const nodeLabel = (node: MapNode | undefined): string => node?.label || node?.host_name || "Unnamed device";
export function nodeReachability(node: MapNode, status: Record<string, boolean | null>, enabled: boolean): ReachabilityFilter {
  if (!enabled || !node.host_id || status[node.id] == null) return "unknown";
  return status[node.id] ? "reachable" : "unreachable";
}
export function findMapNodes(nodes: MapNode[], query: string, filter: ReachabilityFilter, status: Record<string, boolean | null>, enabled: boolean): MapNode[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return nodes.filter((node) => {
    if (filter !== "all" && nodeReachability(node, status, enabled) !== filter) return false;
    const text = [node.label, node.host_name, node.host_hostname, node.host_group, node.host_connection_type, node.host_username, node.icon].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  }).sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b), undefined, { numeric: true, sensitivity: "base" }));
}
