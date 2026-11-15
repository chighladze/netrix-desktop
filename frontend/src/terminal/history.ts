import type { IMarker, Terminal } from "xterm";
import { createHistorySections, type HistorySection } from "./historySections";

export interface TerminalHistoryPosition {
  top: number;
  maxTop: number;
  rows: number;
  newLines: number;
  sections: HistorySection[];
  revision: number;
}

export function observeTerminalHistory(terminal: Terminal, publish: (position: TerminalHistoryPosition | null) => void) {
  const index = createHistorySections(terminal);
  let anchor: IMarker | undefined;
  let countAtAnchor = 0;
  let newLines = 0;
  let scrollback = terminal.options.scrollback;
  let lastPosition: TerminalHistoryPosition | null = null;
  let frame: number | undefined;

  const reset = () => {
    anchor?.dispose();
    anchor = undefined;
    newLines = 0;
  };

  // Keep the anchor outside the live screen that programs can redraw.
  const anchorTail = (cursorY: number) => {
    anchor?.dispose();
    anchor = terminal.registerMarker(-cursorY - 1);
    countAtAnchor = newLines;
  };

  const publishFrame = () => {
    frame = undefined;
    const { type, viewportY, baseY } = terminal.buffer.active;
    if (type !== "normal" || baseY === 0) {
      if (lastPosition) publish(null);
      lastPosition = null;
      return;
    }
    const { sections, revision } = index.read();
    if (lastPosition?.top === viewportY && lastPosition.maxTop === baseY
      && lastPosition.rows === terminal.rows && lastPosition.newLines === newLines && lastPosition.revision === revision) return;
    lastPosition = { top: viewportY, maxTop: baseY, rows: terminal.rows, newLines, sections, revision };
    publish(lastPosition);
  };

  const sync = (reflowed = false) => {
    const { type, viewportY, baseY, cursorY } = terminal.buffer.active;
    const limitChanged = scrollback !== terminal.options.scrollback;
    scrollback = terminal.options.scrollback;
    if (limitChanged) index.invalidate(true);

    if (type !== "normal" || viewportY >= baseY) {
      reset();
    } else if (!anchor || reflowed || limitChanged) {
      anchorTail(cursorY);
    } else if (anchor.isDisposed) {
      // With just one history row, the next append evicts the anchor itself.
      if (scrollback === 1 && baseY === 1) newLines += 1;
      anchorTail(cursorY);
    } else {
      // Trimming moves the anchor even when baseY has stopped growing.
      newLines = countAtAnchor + Math.max(0, baseY - 1 - anchor.line);
      // Count this append before the anchor can be evicted on the next one.
      if (anchor.line === 0 && baseY > 1) anchorTail(cursorY);
    }

    if (frame === undefined) frame = requestAnimationFrame(publishFrame);
  };

  const onScroll = () => sync();
  const subscriptions = [
    terminal.onScroll(onScroll),
    terminal.onResize(() => { index.invalidate(true); sync(true); }),
    terminal.onWriteParsed(() => { index.invalidate(); sync(); }),
    terminal.onRender(onScroll),
    terminal.buffer.onBufferChange(() => { index.invalidate(true); reset(); sync(); }),
  ];
  // xterm's DOM wheel path updates viewportY without emitting its public onScroll.
  const viewport = terminal.element?.querySelector(".xterm-viewport");
  viewport?.addEventListener("scroll", onScroll);
  sync();

  return () => {
    viewport?.removeEventListener("scroll", onScroll);
    for (const subscription of subscriptions) subscription.dispose();
    if (frame !== undefined) cancelAnimationFrame(frame);
    index.dispose();
    reset();
  };
}
