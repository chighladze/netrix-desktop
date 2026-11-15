import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { IoArrowDown, IoCheckmarkCircleOutline } from "react-icons/io5";
import { containsPhysicalPoint, dockSlot, type DockProbe, type DockRect, type DockPlacement } from "../terminal/docking";
import { useAppStore } from "../state/store";
import { canFillTerminalPane } from "../features/workspace/groups";

interface DockHint { rect: DockRect; surface: DockRect; slotX: number; armed: boolean; placement: DockPlacement; title: string; bottom: boolean }

export default function TerminalDockTarget({ enabled, tabPosition, allowTabStrip = true }: { enabled: boolean; tabPosition: "top" | "bottom"; allowTabStrip?: boolean }) {
  const [hint, setHint] = useState<DockHint | null>(null);
  useEffect(() => {
    if (!enabled) { setHint(null); return; }
    let disposed = false;
    let stopProbe = () => {};
    let stopEnd = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let cancelledGeneration = 0;
    let hintOwner: string | null = null;
    const endedGestures = new Set<string>();
    const owner = (payload: { source?: string; gestureId?: string }) => `${payload.source ?? ""}\0${payload.gestureId ?? ""}`;
    void listen<DockProbe>("terminal-dock-probe", async ({ payload }) => {
      if (!Number.isFinite(payload.point?.x) || !Number.isFinite(payload.point?.y) || endedGestures.has(owner(payload))) return;
      const win = getCurrentWindow();
      if (payload.target && payload.target !== win.label) return;
      const probeGeneration = ++generation;
      const cancelVersion = cancelledGeneration;
      const show = (next: DockHint | null) => {
        if (probeGeneration !== generation) return;
        hintOwner = owner(payload);
        setHint(next);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { hintOwner = null; setHint(null); }, 1_000);
      };
      const surface = document.querySelector("[data-terminal-dock-surface]");
      if (!surface || disposed) return;
      const tabs = allowTabStrip ? document.querySelector("[data-terminal-tabs-dropzone]") : null;
      const bounds = (tabs ?? surface).getBoundingClientRect();
      const rect = { x: bounds.x + 4, y: tabs || tabPosition === "top" ? bounds.y : bounds.bottom - 56, width: Math.max(0, bounds.width - 8), height: tabs ? bounds.height : 56 };
      try {
        const [origin, minimized] = await Promise.all([win.innerPosition(), win.isMinimized()]);
        if (disposed || cancelVersion !== cancelledGeneration || endedGestures.has(owner(payload))) return;
        const state = useAppStore.getState();
        const blocked = Object.keys(state.terminalTransfers).length > 0 || !!document.querySelector('[role="dialog"], [aria-modal="true"]');
        const pane = !blocked && !minimized && (payload.sessionCount ?? 1) === 1
          ? [...document.querySelectorAll<HTMLElement>("[data-terminal-empty-pane][data-terminal-group-id]")].find((element) => {
            const group = state.terminalGroups.find((item) => item.id === element.dataset.terminalGroupId);
            return canFillTerminalPane(group, Number(element.dataset.terminalPaneIndex))
              && containsPhysicalPoint(element.getBoundingClientRect(), origin, window.devicePixelRatio, payload.point);
          }) : undefined;
        if (pane) {
          const placement: DockPlacement = { beforeTabId: null, windowLabel: win.label, pane: { groupId: pane.dataset.terminalGroupId!, index: Number(pane.dataset.terminalPaneIndex) } };
          const paneRect = pane.getBoundingClientRect();
          show({ rect: paneRect, surface: paneRect, slotX: paneRect.x, armed: true, placement, title: payload.title?.slice(0, 120) || "Terminal", bottom: false });
          await emit("terminal-dock-result", { id: payload.id, source: payload.source, target: win.label, armed: true, placement });
          return;
        }
        const padding = payload.sticky ? 18 : 6;
        const hitRect = { x: rect.x, y: rect.y - padding, width: rect.width, height: rect.height + padding * 2 };
        const armed = allowTabStrip && !blocked && !minimized && containsPhysicalPoint(hitRect, origin, window.devicePixelRatio, payload.point);
        const clientX = (payload.point.x - origin.x) / window.devicePixelRatio;
        const tabRects = [...document.querySelectorAll<HTMLElement>("[data-terminal-tab-id]")].map((tab) => ({ id: tab.dataset.terminalTabId!, rect: tab.getBoundingClientRect() }));
        const slot = dockSlot(tabRects, clientX, rect);
        show(minimized || blocked || !allowTabStrip ? null : { rect, armed, surface: surface.getBoundingClientRect(), slotX: slot.x, placement: slot.placement, title: payload.title?.slice(0, 120) || "Terminal", bottom: tabPosition === "bottom" });
        await emit("terminal-dock-result", { id: payload.id, source: payload.source, target: win.label, armed, placement: slot.placement });
      } catch {
        if (!disposed) { show(null); await emit("terminal-dock-result", { id: payload.id, source: payload.source, target: win.label, armed: false }).catch(() => {}); }
      }
    }).then((stop) => { if (disposed) stop(); else stopProbe = stop; });
    void listen<{ source?: string; gestureId?: string }>("terminal-dock-end", ({ payload }) => {
      if (payload?.gestureId) {
        endedGestures.add(owner(payload));
        if (endedGestures.size > 64) endedGestures.delete(endedGestures.values().next().value!);
        if (hintOwner !== owner(payload)) return;
      } else cancelledGeneration++;
      generation++;
      hintOwner = null;
      if (timer) clearTimeout(timer);
      setHint(null);
    }).then((stop) => { if (disposed) stop(); else stopEnd = stop; });
    return () => { disposed = true; stopProbe(); stopEnd(); if (timer) clearTimeout(timer); };
  }, [enabled, tabPosition, allowTabStrip]);
  if (!enabled || !hint) return null;
  const isPane = !!hint.placement.pane;
  const cardX = Math.max(hint.rect.x + 4, Math.min(hint.rect.x + hint.rect.width - 232, isPane ? hint.rect.x + hint.rect.width / 2 - 116 : hint.slotX));
  return (
    <div className="terminal-dock-target pointer-events-none fixed inset-0 z-[110]" data-dock-armed={hint.armed}>
      <div className="terminal-dock-lane absolute rounded-md" style={{ left: hint.rect.x, top: hint.rect.y, width: hint.rect.width, height: hint.rect.height }} />
      {hint.armed && !isPane && <div className="terminal-dock-insertion absolute rounded-full" style={{ left: hint.slotX - 1, top: hint.rect.y + 3, height: hint.rect.height - 6 }} />}
      <div className="terminal-dock-label absolute flex items-center gap-3 rounded-xl border border-cyan-300/20 bg-[#101b2b]/95 px-4 py-3 shadow-2xl" style={{ left: cardX, top: isPane ? hint.rect.y + 12 : hint.bottom ? hint.rect.y - 70 : hint.rect.y + hint.rect.height + 8, width: Math.min(232, hint.rect.width - 8) }}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-300/10 text-cyan-200">
          {hint.armed ? <IoCheckmarkCircleOutline size={19} /> : <IoArrowDown size={18} className={hint.bottom ? "rotate-180" : ""} />}
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-gray-100">{hint.armed ? hint.title : "Dock a terminal"}</p>
          <p className="mt-0.5 text-[10px] text-cyan-200/70">{isPane ? `Release to insert in pane ${hint.placement.pane!.index + 1}` : hint.armed ? "Release to dock here" : "Drag into the tab strip"}</p>
        </div>
      </div>
      {hint.armed && <div className="terminal-dock-workspace absolute rounded-2xl" style={{ left: hint.surface.x + 5, top: hint.surface.y + 5, width: hint.surface.width - 10, height: hint.surface.height - 10 }} />}
    </div>
  );
}
