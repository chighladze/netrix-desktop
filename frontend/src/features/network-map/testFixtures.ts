import type { MapEdge, MapNode, MapSheet } from "./types";

export const sampleMap: MapSheet = { id: "core-map", name: "Production network", description: null, node_count: 6, edge_count: 5, created_at: "2026-01-01", updated_at: null };
export const mapNode = (id: string, overrides: Partial<MapNode> = {}): MapNode => ({ id, host_id: null, label: id, icon: "server", x: 0, y: 0, width: 180, height: 64, color: "#34d399", ...overrides });
export const mapEdge = (id: string, source: string, target: string, overrides: Partial<MapEdge> = {}): MapEdge => ({ id, source_node_id: source, target_node_id: target, label: null, color: "#3b82f6", stroke_width: 2, style: "solid", waypoints: null, ports_count: 1, connection_type: "ethernet", connection_properties: null, ...overrides });
export const sampleNodes = [
  mapNode("internet", { label: "Internet", icon: "cloud", x: 430, y: 60, color: "#a78bfa" }),
  mapNode("gateway", { label: "Edge Gateway", host_id: 1, host_name: "Edge Gateway", host_hostname: "192.0.2.1", host_connection_type: "ssh", host_port: 22, host_username: "netadmin", host_group: "Production", icon: "router", x: 430, y: 230, color: "#38bdf8" }),
  mapNode("core", { label: "Core Switch", host_id: 2, host_name: "Core Switch", host_hostname: "192.0.2.10", host_connection_type: "ssh", host_port: 22, host_username: "netadmin", host_group: "Production", icon: "switch", x: 430, y: 420, color: "#fbbf24" }),
  mapNode("db", { label: "Database Primary", host_id: 3, host_hostname: "192.0.2.20", host_connection_type: "ssh", host_group: "Production/Servers", icon: "database", x: 150, y: 640 }),
  mapNode("web", { label: "Application Server", host_id: 4, host_hostname: "192.0.2.30", host_connection_type: "ssh", host_group: "Production/Servers", x: 430, y: 640 }),
  mapNode("wifi", { label: "Office Wi-Fi", host_id: 5, host_hostname: "192.0.2.40", host_connection_type: "ssh", host_group: "Office", icon: "wireless", x: 710, y: 640, color: "#c084fc" }),
];
export const sampleEdges = [
  mapEdge("wan", "internet", "gateway", { label: "WAN", connection_type: "fiber", color: "#f59e0b", connection_properties: '{"mode":"Single-mode (OS2)","speed":"10 Gbps"}' }),
  mapEdge("uplink", "gateway", "core", { label: "Core uplink", connection_type: "trunk", color: "#10b981", ports_count: 2, connection_properties: '{"vlans":"10,20,30","speed":"10 Gbps"}' }),
  mapEdge("db-link", "core", "db", { waypoints: '[{"x":240,"y":452}]' }),
  mapEdge("web-link", "core", "web"),
  mapEdge("wifi-link", "core", "wifi", { waypoints: '[{"x":800,"y":452}]' }),
];
