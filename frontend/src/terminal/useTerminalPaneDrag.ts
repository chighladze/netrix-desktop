import { emit } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { findTerminalGroup } from "../features/workspace/groups";
import { useAppStore } from "../state/store";
import { queryTerminalDock, terminalDockWindow } from "./docking";
import { moveTerminalPane } from "./moveTerminalPane";
import { TerminalMoveCancelledError } from "./windowHandoff";
import { captureTerminalPointer, isNativeMouseGesture, watchTerminalPointer, type DragPoint } from "./pointerDrag";

interface PaneGesture {
  id: string;
  tabId: string;
  groupId: string;
  title: string;
  started: boolean;
  finishing: boolean;
  probing: boolean;
  ended: boolean;
  committing: boolean;
  abort: AbortController;
  cleanup: (() => void)[];
}
export interface PaneDragPreview { tabId: string; title: string; x: number; y: number }

export function useTerminalPaneDrag() {
  const gesture = useRef<PaneGesture | null>(null);
  const mounted = useRef(true);
  const [preview, setPreview] = useState<PaneDragPreview | null>(null);
  const endHint = useCallback((current: PaneGesture) => {
    if (current.started && !current.ended) {
      current.ended = true;
      void emit("terminal-dock-end", { source: getCurrentWindow().label, gestureId: current.id }).catch(() => {});
    }
  }, []);
  const stop = useCallback((current: PaneGesture) => { current.cleanup.splice(0).forEach((cleanup) => cleanup()); }, []);
  const cancel = useCallback((current: PaneGesture) => {
    stop(current); endHint(current);
    if (gesture.current === current) {
      gesture.current = null;
      if (mounted.current) setPreview(null);
    }
  }, [stop, endHint]);
  const report = (error: unknown) => {
    if (!(error instanceof TerminalMoveCancelledError)) useAppStore.getState().addToast(error instanceof Error ? error.message : "Could not move this session", "error");
  };
  const detach = (tabId: string) => { void moveTerminalPane(tabId).catch(report); };

  const start = useCallback((event: ReactPointerEvent<HTMLButtonElement>, tabId: string) => {
    const state = useAppStore.getState();
    const tab = state.terminalTabs.find((item) => item.id === tabId);
    const group = findTerminalGroup(state.terminalGroups, tabId);
    if (event.button !== 0 || gesture.current || !tab || !group || Object.keys(state.terminalTransfers).length) return;
    event.preventDefault();
    state.setActiveTabId(tabId);
    const origin = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    const nativeMouse = isNativeMouseGesture(event.nativeEvent);
    let nativePending = nativeMouse;
    let domDropPoint: Promise<DragPoint> | null = null;
    let previewFrame: number | null = null;
    let nextPreview: PaneDragPreview | null = null;
    const current: PaneGesture = { id: crypto.randomUUID(), tabId, groupId: group.id, title: tab.host.name, started: false, finishing: false, probing: false, ended: false, committing: false, abort: new AbortController(), cleanup: [] };
    gesture.current = current;
    current.cleanup.push(captureTerminalPointer(event.nativeEvent), () => current.abort.abort());
    current.cleanup.push(() => { if (previewFrame !== null) cancelAnimationFrame(previewFrame); });
    const probe = async () => {
      if (gesture.current !== current || current.finishing || current.probing) return;
      current.probing = true;
      try {
        const point = await cursorPosition();
        if (gesture.current === current && !current.finishing) await queryTerminalDock(point, { gestureId: current.id, title: current.title, sessionCount: 1, excludeSource: false, signal: current.abort.signal });
      } catch { /* A drop rechecks native geometry before moving anything. */ }
      finally { current.probing = false; }
    };
    const move = (moved: PointerEvent) => {
      if (moved.pointerId !== pointerId || gesture.current !== current || current.finishing) return;
      if (!current.started) {
        if (Math.hypot(moved.clientX - origin.x, moved.clientY - origin.y) < 8) return;
        current.started = true;
        current.cleanup.push(watchTerminalPointer(current.id, (result) => {
          nativePending = false;
          if (result.released) void finish(Promise.resolve(result.point)); else cancel(current);
        }, nativeMouse, () => { nativePending = false; if (domDropPoint) void finish(domDropPoint); }));
        const timer = window.setInterval(() => { void probe(); }, 100);
        current.cleanup.push(() => clearInterval(timer));
        void probe();
      }
      nextPreview = { tabId, title: current.title, x: moved.clientX, y: moved.clientY };
      if (previewFrame === null) previewFrame = requestAnimationFrame(() => {
        previewFrame = null;
        if (mounted.current && gesture.current === current && !current.finishing) setPreview(nextPreview);
      });
    };
    const finish = async (dropPoint: Promise<DragPoint>) => {
      if (gesture.current !== current || current.finishing) return;
      if (!current.started) { cancel(current); return; }
      current.finishing = true;
      try {
        const point = await dropPoint;
        const match = await queryTerminalDock(point, { gestureId: current.id, title: current.title, sessionCount: 1, excludeSource: false, signal: current.abort.signal });
        if (gesture.current !== current) return;
        const latest = useAppStore.getState();
        if (findTerminalGroup(latest.terminalGroups, tabId)?.id !== current.groupId || Object.keys(latest.terminalTransfers).length) return;
        if (mounted.current) setPreview(null);
        if (match) {
          current.committing = true;
          endHint(current);
          await moveTerminalPane(tabId, match.placement);
        } else {
          // An occupied Netrix surface cancels the drop. Only dropping outside
          // terminal windows creates a new floating terminal.
          const target = await terminalDockWindow(point, false);
          if (gesture.current === current && !target) { current.committing = true; endHint(current); await moveTerminalPane(tabId, undefined, point); }
        }
      } catch (error) { report(error); }
      finally { cancel(current); }
    };
    const release = (released: PointerEvent) => {
      if (released.pointerId !== pointerId || released.button !== 0) return;
      domDropPoint ??= cursorPosition();
      if (!current.started || !nativePending) void finish(domDropPoint);
    };
    const abort = () => { if (!current.finishing && (!current.started || !nativePending)) cancel(current); };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape" && !current.committing) { key.preventDefault(); cancel(current); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", abort);
    handle.addEventListener("lostpointercapture", abort);
    window.addEventListener("keydown", escape, true);
    current.cleanup.push(() => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("blur", abort);
      handle.removeEventListener("lostpointercapture", abort);
      window.removeEventListener("keydown", escape, true);
    });
  }, [cancel, endHint]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (gesture.current) cancel(gesture.current); };
  }, [cancel]);
  return { start, detach, preview };
}
