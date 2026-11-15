import type { MapEdge, MapNode, MapViewBox, WaypointXY } from "./types";
import { nodeBounds, parseWaypoints } from "./geometry";

export interface CanvasSize { width: number; height: number }
export const MIN_MAP_ZOOM = 0.1;
export const MAX_MAP_ZOOM = 5;

export function viewportScale(view: MapViewBox, size: CanvasSize): number {
  return Math.min(size.width / view.w, size.height / view.h);
}

/** Keep the map under the pointer when a docked panel changes canvas geometry. */
export function resizeViewport(view: MapViewBox, previous: CanvasSize, next: CanvasSize, offset = { x: 0, y: 0 }): MapViewBox {
  const scale = viewportScale(view, previous);
  const origin = pointInViewport(view, previous, { x: 0, y: 0 });
  return { x: origin.x + offset.x / scale, y: origin.y + offset.y / scale, w: next.width / scale, h: next.height / scale };
}

export function zoomViewport(view: MapViewBox, size: CanvasSize, factor: number, anchor?: WaypointXY): MapViewBox {
  const scale = viewportScale(view, size);
  const nextScale = Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, scale * factor));
  const ratio = scale / nextScale;
  const point = anchor ?? { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, w: view.w * ratio, h: view.h * ratio };
}

export function fitBounds(bounds: MapViewBox, size: CanvasSize, visibleWidth = size.width): MapViewBox {
  const available = Math.max(1, Math.min(visibleWidth, size.width));
  const ratio = available / Math.max(size.height, 1);
  const fittedWidth = Math.max(bounds.w, bounds.h * ratio);
  const h = fittedWidth / ratio;
  // The SVG still occupies the full canvas; center content in its unobscured area.
  return { x: bounds.x - (fittedWidth - bounds.w) / 2, y: bounds.y - (h - bounds.h) / 2, w: fittedWidth * size.width / available, h };
}

export function topologyBounds(nodes: MapNode[], edges: MapEdge[], padding = 80): MapViewBox {
  const bounds = nodeBounds(nodes, 0);
  const points = edges.flatMap((edge) => parseWaypoints(edge.waypoints));
  const minX = Math.min(bounds.x, ...points.map((point) => point.x)) - padding;
  const minY = Math.min(bounds.y, ...points.map((point) => point.y)) - padding;
  const maxX = Math.max(bounds.x + bounds.w, ...points.map((point) => point.x)) + padding;
  const maxY = Math.max(bounds.y + bounds.h, ...points.map((point) => point.y)) + padding;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** SVG `meet` adds letterboxing; use the same transform for minimap input. */
export function pointInViewport(view: MapViewBox, size: CanvasSize, point: WaypointXY): WaypointXY {
  const scale = viewportScale(view, size);
  return { x: view.x + (point.x - (size.width - view.w * scale) / 2) / scale, y: view.y + (point.y - (size.height - view.h * scale) / 2) / scale };
}
