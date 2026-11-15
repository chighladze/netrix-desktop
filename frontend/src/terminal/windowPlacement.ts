import type { Monitor } from "@tauri-apps/api/window";

/** Sizes are logical; monitor work areas and returned positions are physical. */
export function floatingTerminalPlacement(point: { x: number; y: number }, monitor: Pick<Monitor, "scaleFactor" | "workArea"> | null, fallbackScale: number) {
  const scale = monitor?.scaleFactor || fallbackScale;
  const area = monitor?.workArea;
  const width = Math.min(1000, area ? Math.max(1, Math.floor(area.size.width / scale - 24)) : 1000);
  const height = Math.min(700, area ? Math.max(1, Math.floor(area.size.height / scale - 24)) : 700);
  const x = point.x - width * .25 * scale;
  const y = point.y - 18 * scale;
  return {
    width, height,
    x: area ? Math.max(area.position.x, Math.min(Math.floor(area.position.x + area.size.width - width * scale), Math.round(x))) : Math.round(x),
    y: area ? Math.max(area.position.y, Math.min(Math.floor(area.position.y + area.size.height - height * scale), Math.round(y))) : Math.round(y),
  };
}
