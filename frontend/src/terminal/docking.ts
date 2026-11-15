import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

export interface DockPlacement { beforeTabId: string | null; windowLabel?: string; pane?: { groupId: string; index: number } }
export interface DockMatch { placement: DockPlacement }
export interface DockProbe { id: string; source: string; target?: string; point: { x: number; y: number }; sticky?: boolean; gestureId?: string; title?: string; sessionCount?: number }
export interface DockResult { id: string; source: string; target: string; armed: boolean; placement?: DockPlacement }
export interface DockRect { x: number; y: number; width: number; height: number }

export function dockSlot(tabs: Array<{ id: string; rect: DockRect }>, x: number, bounds: DockRect): { placement: DockPlacement; x: number } {
  const before = tabs.find((tab) => x < tab.rect.x + tab.rect.width / 2);
  const edge = before?.rect.x ?? (tabs.length ? tabs[tabs.length - 1].rect.x + tabs[tabs.length - 1].rect.width : bounds.x + 12);
  return { placement: { beforeTabId: before?.id ?? null }, x: Math.max(bounds.x + 2, Math.min(bounds.x + bounds.width - 2, edge)) };
}

export function placeTerminalTab<T extends { id: string }>(tabs: T[], id: string, placement: DockPlacement, groups: Array<{ tabIds: string[] }> = []): T[] {
  const moving = tabs.find((tab) => tab.id === id);
  if (!moving || placement.beforeTabId === id) return tabs;
  const rest = tabs.filter((tab) => tab.id !== id);
  const targetGroup = groups.find((group) => group.tabIds.includes(placement.beforeTabId ?? ""));
  const before = rest.findIndex((tab) => targetGroup ? targetGroup.tabIds.includes(tab.id) : tab.id === placement.beforeTabId);
  rest.splice(before < 0 ? rest.length : before, 0, moving);
  return rest;
}

export function isOutsideTabStrip(point: { x: number; y: number }, rect: DockRect, armed: boolean): boolean {
  const padding = armed ? 18 : 36;
  return point.y < rect.y - padding || point.y > rect.y + rect.height + padding
    || point.x < rect.x - padding * 2 || point.x > rect.x + rect.width + padding * 2;
}

export function containsPhysicalPoint(rect: DockRect, origin: { x: number; y: number }, scale: number, point: { x: number; y: number }): boolean {
  const x = origin.x + rect.x * scale;
  const y = origin.y + rect.y * scale;
  return point.x >= x && point.x <= x + rect.width * scale
    && point.y >= y && point.y <= y + rect.height * scale;
}

export const terminalDockWindow = (point: { x: number; y: number }, excludeSource = true) =>
  invoke<string | null>("terminal_dock_target", { x: Math.round(point.x), y: Math.round(point.y), excludeSource });

export async function queryTerminalDock(point: { x: number; y: number }, options: Pick<DockProbe, "sticky" | "gestureId" | "title" | "sessionCount"> & { excludeSource?: boolean; signal?: AbortSignal } = {}): Promise<DockMatch | null> {
  if (options.signal?.aborted) return null;
  const id = crypto.randomUUID();
  const source = getCurrentWindow().label;
  const target = await terminalDockWindow(point, options.excludeSource ?? true);
  if (!target || options.signal?.aborted) return null;
  let stop = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let abort = () => {};
  try {
    return await new Promise<DockMatch | null>((resolve, reject) => {
      timer = setTimeout(() => resolve(null), 500);
      abort = () => resolve(null);
      options.signal?.addEventListener("abort", abort, { once: true });
      void listen<DockResult>("terminal-dock-result", ({ payload }) => {
        if (payload.id === id && payload.source === source && payload.target === target) resolve(payload.armed ? { placement: { ...payload.placement ?? { beforeTabId: null }, windowLabel: target } } : null);
      }).then((unlisten) => {
        if (finished || options.signal?.aborted) { unlisten(); resolve(null); return; }
        stop = unlisten;
        const { excludeSource: _excludeSource, signal: _signal, ...probeOptions } = options;
        void emit("terminal-dock-probe", { id, source, target, point, ...probeOptions } satisfies DockProbe).catch(reject);
      }, reject);
    });
  } finally { finished = true; options.signal?.removeEventListener("abort", abort); if (timer) clearTimeout(timer); stop(); }
}
