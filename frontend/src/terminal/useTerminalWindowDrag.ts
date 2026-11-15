import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { queryTerminalDock, type DockMatch, type DockPlacement } from "./docking";
import { useAppStore } from "../state/store";
import { captureTerminalPointer, isNativeMouseGesture, watchTerminalPointer, type DragPoint } from "./pointerDrag";

export type TerminalDragPhase = "idle" | "dragging" | "armed" | "returning";
interface Gesture {
  id: string;
  started: boolean;
  stopped: boolean;
  finishing: boolean;
  probing: boolean;
  pointerReleased: boolean;
  dropPoint: Promise<DragPoint> | null;
  nativeDropPoint: DragPoint | null;
  committing: boolean;
  abort: AbortController;
  ended: boolean;
  match: DockMatch | null;
  cleanup: Array<() => void>;
}

export function useTerminalWindowDrag(title: string, onReturn: (placement?: DockPlacement) => void | Promise<void>, sessionCount = 1) {
  const [state, setState] = useState<{ phase: TerminalDragPhase; target: DockMatch | null; anchorX: number }>({ phase: "idle", target: null, anchorX: 0 });
  const gesture = useRef<Gesture | null>(null);
  const mounted = useRef(true);
  const returning = useRef(false);
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;
  const update = useCallback((phase: TerminalDragPhase, target: DockMatch | null = null) => {
    if (mounted.current) setState((current) => ({ ...current, phase, target }));
  }, []);
  const stop = useCallback((current: Gesture) => {
    current.stopped = true;
    current.cleanup.splice(0).forEach((cleanup) => cleanup());
  }, []);
  const endHint = useCallback((current: Gesture) => {
    if (current.ended) return;
    current.ended = true;
    void emit("terminal-dock-end", { source: getCurrentWindow().label, gestureId: current.id }).catch(() => {});
  }, []);
  const cancel = useCallback((current: Gesture) => {
    stop(current); endHint(current);
    if (gesture.current === current) { gesture.current = null; update("idle"); }
  }, [stop, endHint, update]);
  const returnToMain = useCallback(async (placement?: DockPlacement, target: DockMatch | null = null) => {
    if (returning.current || Object.keys(useAppStore.getState().terminalTransfers).length) return;
    returning.current = true;
    update("returning", target);
    if (!target && mounted.current) setState((current) => ({ ...current, anchorX: window.innerWidth / 2 }));
    try { await onReturnRef.current(placement); }
    catch (error) { useAppStore.getState().addToast(error instanceof Error ? error.message : "Could not return terminal. Your session is still here.", "error"); }
    finally { returning.current = false; update("idle"); }
  }, [update]);
  const finish = useCallback(async (current: Gesture) => {
    if (current.stopped || current.finishing || gesture.current !== current) return;
    current.finishing = true;
    try {
      const point = current.nativeDropPoint ?? await (current.dropPoint ?? cursorPosition());
      let target: DockMatch | null = null;
      const attempts = current.match ? 3 : 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (!mounted.current || current.stopped || gesture.current !== current) return;
        target = await queryTerminalDock(current.nativeDropPoint ?? point, { sticky: Boolean(current.match), gestureId: current.id, title, sessionCount, signal: current.abort.signal });
        if (target || attempt === attempts - 1) break;
        // Windows may still be settling native move-loop geometry/z-order.
        // Revalidate using the captured release point, never the cached match.
        await new Promise<void>((resolve) => {
          const signal = current.abort.signal;
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = window.setTimeout(done, 50);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
      if (!mounted.current || gesture.current !== current) return;
      current.committing = true;
      stop(current); endHint(current);
      if (target) await returnToMain(target.placement, target);
      else update("idle");
    } catch { update("idle"); endHint(current); }
    finally { stop(current); endHint(current); if (gesture.current === current) gesture.current = null; }
  }, [stop, title, sessionCount, endHint, returnToMain, update]);

  const start = useCallback((event: ReactPointerEvent) => {
    if (event.button !== 0 || gesture.current || returning.current || Object.keys(useAppStore.getState().terminalTransfers).length) return;
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const nativeMouse = isNativeMouseGesture(event.nativeEvent);
    let nativeAvailable = nativeMouse;
    const current: Gesture = { id: crypto.randomUUID(), started: false, stopped: false, finishing: false, probing: false, pointerReleased: false, dropPoint: null, nativeDropPoint: null, committing: false, abort: new AbortController(), ended: false, match: null, cleanup: [] };
    gesture.current = current;
    const releaseCapture = captureTerminalPointer(event.nativeEvent);
    current.cleanup.push(releaseCapture, () => current.abort.abort());
    setState((previous) => ({ ...previous, anchorX: origin.x }));
    const probe = async () => {
      if (current.stopped || current.finishing || current.probing || !current.started) return;
      current.probing = true;
      try {
        const target = await queryTerminalDock(await cursorPosition(), { sticky: Boolean(current.match), gestureId: current.id, title, sessionCount, signal: current.abort.signal });
        if (!current.stopped && !current.finishing && gesture.current === current) { current.match = target; update(target ? "armed" : "dragging", target); }
      } catch { if (!current.stopped) { current.match = null; update("dragging"); } }
      finally { current.probing = false; }
    };
    const move = async (moved: PointerEvent) => {
      if (moved.pointerId !== pointerId || current.started || current.stopped || Math.hypot(moved.clientX - origin.x, moved.clientY - origin.y) < 6) return;
      current.started = true;
      setState((previous) => ({ ...previous, anchorX: Math.max(0, Math.min(window.innerWidth, moved.clientX)) }));
      update("dragging");
      const win = getCurrentWindow();
      void win.onMoved(() => { void probe(); }).then((unlisten) => { if (current.stopped) unlisten(); else current.cleanup.push(unlisten); }).catch(() => {});
      const heartbeat = window.setInterval(() => { void probe(); }, 100);
      current.cleanup.push(() => clearInterval(heartbeat));
      void probe();
      try {
        // Register before requesting the OS move loop: its acknowledgement is
        // not a release event and may arrive after pointerup on some webviews.
        if (nativeMouse) {
          current.cleanup.push(watchTerminalPointer(current.id, (result) => {
            if (current.stopped || gesture.current !== current) return;
            if (result.released) {
              current.nativeDropPoint = result.point;
              void finish(current);
            } else cancel(current);
          }, true, () => {
            nativeAvailable = false;
            if (current.pointerReleased) void finish(current);
          }));
          // Hand capture to the native caption move loop after the threshold.
          releaseCapture();
        }
        await win.startDragging();
        if (current.stopped) return;
        if (current.pointerReleased && !nativeAvailable) void finish(current);
      } catch {
        if (!current.stopped) {
          cancel(current);
          useAppStore.getState().addToast("Could not move this window. Use Return to dock the terminal.", "error");
        }
      }
    };
    const release = (released: PointerEvent | MouseEvent) => {
      if ("pointerId" in released && released.pointerId !== pointerId) return;
      if (released.button !== 0 || current.pointerReleased || current.stopped) return;
      current.pointerReleased = true;
      current.dropPoint ??= cursorPosition();
      if (!current.started) cancel(current);
      else if (!nativeAvailable) void finish(current);
      else {
        // Give the fixed-key observer three polling ticks to report an Escape
        // consumed by the OS, then use DOM release even if its IPC is delayed.
        const fallback = window.setTimeout(() => { void finish(current); }, 48);
        current.cleanup.push(() => clearTimeout(fallback));
      }
    };
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape" && !current.committing) cancel(current); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("mouseup", release, true);
    window.addEventListener("keydown", escape, true);
    current.cleanup.push(() => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("mouseup", release, true);
      window.removeEventListener("keydown", escape, true);
    });
  }, [title, sessionCount, update, cancel, finish]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (gesture.current) { stop(gesture.current); endHint(gesture.current); gesture.current = null; }
    };
  }, [stop, endHint]);
  return { ...state, start, returnToMain };
}
