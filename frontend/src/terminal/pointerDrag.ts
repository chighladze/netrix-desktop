import { invoke } from "@tauri-apps/api/core";

export interface DragPoint { x: number; y: number }
export interface DragRelease { released: boolean; point: DragPoint }

/** Mouse capture keeps DOM events arriving outside the source webview. */
export function captureTerminalPointer(event: Event): () => void {
  const pointer = event as PointerEvent;
  const target = event.target;
  if (!(target instanceof Element) || !Number.isFinite(pointer.pointerId)) return () => {};
  try { target.setPointerCapture(pointer.pointerId); } catch { /* Synthetic events and older webviews use the document path. */ }
  return () => { try { if (target.hasPointerCapture(pointer.pointerId)) target.releasePointerCapture(pointer.pointerId); } catch { /* The source may have unmounted. */ } };
}

/** Native release is a fallback for real mouse gestures whose DOM events are
 * consumed by another window or the OS move loop. Touch/keyboard use DOM events. */
export function watchTerminalPointer(gestureId: string, onRelease: (result: DragRelease) => void, enabled = true, onUnavailable?: () => void): () => void {
  if (!enabled) return () => {};
  let disposed = false;
  let settled = false;
  void invoke<DragRelease | null>("wait_terminal_drag_release", { gestureId }).then((result) => {
    settled = true;
    if (!disposed) { if (result) onRelease(result); else onUnavailable?.(); }
  }).catch(() => { settled = true; if (!disposed) onUnavailable?.(); });
  return () => {
    if (disposed) return;
    disposed = true;
    if (!settled) void invoke("cancel_terminal_drag", { gestureId }).catch(() => {});
  };
}

export function isNativeMouseGesture(event: Event): boolean {
  return event.isTrusted && (!("pointerType" in event) || (event as PointerEvent).pointerType === "mouse");
}
