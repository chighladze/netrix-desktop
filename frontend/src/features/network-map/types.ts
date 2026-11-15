export interface MapSheet {
  id: string;
  name: string;
  description: string | null;
  node_count: number;
  edge_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface MapNode {
  id: string;
  host_id: number | null;
  label: string | null;
  icon: string;
  x: number;
  y: number;
  color: string;
  width: number;
  height: number;
  host_name?: string | null;
  host_hostname?: string | null;
  host_connection_type?: string | null;
  host_group?: string | null;
  host_port?: number | null;
  host_username?: string | null;
}

export interface MapEdge {
  id: string;
  source_node_id: string;
  target_node_id: string;
  label: string | null;
  color: string;
  stroke_width: number;
  style: string;
  waypoints: string | null;
  ports_count: number;
  connection_type: string;
  connection_properties: string | null;
}

export interface WaypointXY {
  x: number;
  y: number;
}

export interface MapViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ConnectionTypeProperty {
  key: string;
  label: string;
  type: "select" | "number" | "text";
  options?: string[];
  default?: string | number;
  unit?: string;
}

export interface ConnectionTypeDefinition {
  label: string;
  color: string;
  dashArray?: string;
  icon: string;
  properties: ConnectionTypeProperty[];
}

export type AddNodeMode = "host" | "custom";
export type Tool = "select" | "pan" | "connect" | "add";
