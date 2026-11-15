import type { MapNode, MapViewBox, WaypointXY } from "./types";

export const GRID_SIZE = 20;
const CORNER_RADIUS = 14;

export interface DeviceShape {
  d: string;
  clipD?: string;
}

export function snapCoordinate(
  value: number,
  enabled: boolean,
  gridSize = GRID_SIZE,
): number {
  if (!enabled) return value;
  return Math.round(value / gridSize) * gridSize;
}

/** Return the SVG path used to render a device silhouette. */
export function getDeviceShape(icon: string, w: number, h: number): DeviceShape {
  const r = 8;
  switch (icon) {
    case "router":
      return { d: `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z` };
    case "switch":
      return { d: `M ${w * 0.12} 0 L ${w * 0.88} 0 L ${w} ${h} L 0 ${h} Z` };
    case "firewall": {
      const cx = w / 2;
      return { d: `M ${cx} 0 L ${w} ${h * 0.2} L ${w} ${h * 0.55} Q ${w} ${h * 0.85} ${cx} ${h} Q 0 ${h * 0.85} 0 ${h * 0.55} L 0 ${h * 0.2} Z` };
    }
    case "cloud":
    case "internet": {
      const cx = w / 2;
      return { d: `M ${w * 0.2} ${h * 0.6} 
        C ${-w * 0.05} ${h * 0.6}, ${-w * 0.05} ${h * 0.2}, ${w * 0.2} ${h * 0.2}
        C ${w * 0.2} ${-h * 0.05}, ${w * 0.45} ${-h * 0.05}, ${cx} ${h * 0.15}
        C ${w * 0.55} ${-h * 0.05}, ${w * 0.8} ${-h * 0.05}, ${w * 0.8} ${h * 0.2}
        C ${w * 1.05} ${h * 0.2}, ${w * 1.05} ${h * 0.6}, ${w * 0.8} ${h * 0.6} Z` };
    }
    case "database": {
      const ry = h * 0.15;
      return { d: `M 0 ${ry} 
        A ${w / 2} ${ry} 0 0 1 ${w} ${ry} 
        L ${w} ${h - ry} 
        A ${w / 2} ${ry} 0 0 1 0 ${h - ry} Z` };
    }
    case "desktop": {
      const screenH = h * 0.72;
      const standW = w * 0.3;
      return { d: `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${screenH - r} Q ${w} ${screenH} ${w - r} ${screenH} L ${r} ${screenH} Q 0 ${screenH} 0 ${r} L 0 ${r} Q 0 0 ${r} 0 Z
        M ${w / 2 - standW / 2} ${screenH} L ${w / 2 + standW / 2} ${screenH} L ${w / 2 + standW / 2 + 4} ${h} L ${w / 2 - standW / 2 - 4} ${h} Z` };
    }
    case "laptop": {
      const screenH = h * 0.7;
      return { d: `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${screenH} L 0 ${screenH} L 0 ${r} Q 0 0 ${r} 0 Z
        M ${-4} ${screenH} L ${w + 4} ${screenH} L ${w + 4} ${h - r} Q ${w + 4} ${h} ${w + 4 - r} ${h} L ${-4 + r} ${h} Q ${-4} ${h} ${-4} ${h - r} Z` };
    }
    case "phone": {
      const rr = 10;
      return { d: `M ${rr} 0 L ${w - rr} 0 Q ${w} 0 ${w} ${rr} L ${w} ${h - rr} Q ${w} ${h} ${w - rr} ${h} L ${rr} ${h} Q 0 ${h} 0 ${h - rr} L 0 ${rr} Q 0 0 ${rr} 0 Z` };
    }
    case "wireless": {
      const inset = w * 0.15;
      return { d: `M ${inset} 0 L ${w - inset} 0 L ${w} ${h / 2} L ${w - inset} ${h} L ${inset} ${h} L 0 ${h / 2} Z` };
    }
    case "printer": {
      const slot = h * 0.2;
      return { d: `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z
        M ${w * 0.15} ${slot} L ${w * 0.85} ${slot}` };
    }
    case "server":
    default:
      return { d: `M ${r} 0 L ${w - r} 0 Q ${w} 0 ${w} ${r} L ${w} ${h - r} Q ${w} ${h} ${w - r} ${h} L ${r} ${h} Q 0 ${h} 0 ${h - r} L 0 ${r} Q 0 0 ${r} 0 Z` };
  }
}

/** Build a straight polyline with rounded intermediate corners. */
export function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  waypoints?: WaypointXY[],
): string {
  const points: WaypointXY[] = [
    { x: x1, y: y1 },
    ...(waypoints ?? []),
    { x: x2, y: y2 },
  ];

  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const next = points[index + 1];
    const dx1 = previous.x - current.x;
    const dy1 = previous.y - current.y;
    const dx2 = next.x - current.x;
    const dy2 = next.y - current.y;
    const distance1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const distance2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const radius = Math.min(CORNER_RADIUS, distance1 / 2, distance2 / 2);

    if (radius < 1 || distance1 < 1 || distance2 < 1) {
      path += ` L ${current.x} ${current.y}`;
      continue;
    }

    const startX = current.x + (dx1 / distance1) * radius;
    const startY = current.y + (dy1 / distance1) * radius;
    const endX = current.x + (dx2 / distance2) * radius;
    const endY = current.y + (dy2 / distance2) * radius;
    path += ` L ${startX} ${startY} Q ${current.x} ${current.y} ${endX} ${endY}`;
  }

  path += ` L ${points[points.length - 1].x} ${points[points.length - 1].y}`;
  return path;
}

export function parseWaypoints(value: string | null | undefined): WaypointXY[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (point): point is WaypointXY =>
        point !== null && typeof point === "object"
        && Number.isFinite((point as { x?: unknown }).x)
        && Number.isFinite((point as { y?: unknown }).y),
    );
  } catch {
    return [];
  }
}

export function nodeCenter(node: MapNode): WaypointXY {
  const width = Math.max(node.width || 0, 180);
  const height = Math.max(node.height || 0, 64);
  return {
    x: node.x + width / 2,
    y: node.y + height / 2,
  };
}

export function nodeBounds(
  nodes: MapNode[],
  padding: number,
  emptyBounds: MapViewBox = { x: 0, y: 0, w: 800, h: 600 },
): MapViewBox {
  if (nodes.length === 0) return emptyBounds;
  const minX = Math.min(...nodes.map((node) => node.x)) - padding;
  const minY = Math.min(...nodes.map((node) => node.y)) - padding;
  const maxX = Math.max(...nodes.map((node) => node.x + Math.max(node.width || 0, 180))) + padding;
  const maxY = Math.max(...nodes.map((node) => node.y + Math.max(node.height || 0, 64))) + padding;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
