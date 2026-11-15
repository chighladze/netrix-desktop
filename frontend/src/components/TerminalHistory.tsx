import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { IoArrowDown, IoTerminalOutline } from "react-icons/io5";
import { createPortal } from "react-dom";
import type { Terminal } from "xterm";
import { observeTerminalHistory, type TerminalHistoryPosition } from "../terminal/history";
import { groupHistorySections, historyLineToOffset, historyOffsetToLine, historySectionAtLine, readHistoryPreview } from "../terminal/historySections";
import "../terminal/history.css";

const format = new Intl.NumberFormat("en-US");
const lineCount = (count: number) => `${format.format(count)} ${count === 1 ? "line" : "lines"}`;

function HistoryRail({ terminal, position, viewportId }: {
  terminal: Terminal;
  position: TerminalHistoryPosition;
  viewportId: string;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; offset: number; moved: boolean } | null>(null);
  const wheelRemainder = useRef(0);
  const hoverFrame = useRef<number>();
  const pendingHover = useRef<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ capacity: 40, previewWidth: 300 });
  const { top, maxTop, rows } = position;
  const page = Math.max(1, rows - 1);
  const range = rows === 1 ? `Line ${format.format(top + 1)}` : `Lines ${format.format(top + 1)}–${format.format(top + rows)}`;
  const below = `${lineCount(maxTop - top)} below`;
  const sections = useMemo(() => groupHistorySections(position.sections, size.capacity), [position.sections, size.capacity]);
  const active = historySectionAtLine(sections, top, maxTop);
  const selected = hover === null ? active : Math.min(sections.length - 1, Math.max(0, Math.round(hover)));
  const showPreview = !dismissed && (hover !== null || focused || dragging);
  const section = sections[selected];
  const preview = useMemo(() => showPreview ? readHistoryPreview(terminal, section) : null,
    [terminal, section, showPreview, position.revision]);
  const geometry = {
    "--history-height": `${sections.length * 10 + 24}px`,
    "--history-preview-y": `${(selected + .5) / sections.length * 100}%`,
    "--history-preview-width": `${size.previewWidth}px`,
  } as CSSProperties;

  useLayoutEffect(() => {
    const pane = rail.current?.parentElement;
    if (!pane) return;
    const measure = () => {
      if (!pane.clientHeight || !pane.clientWidth) return;
      const capacity = Math.max(2, Math.floor((pane.clientHeight - 120) / 10));
      const previewWidth = Math.max(100, Math.min(300, pane.clientWidth - 68));
      setSize((previous) => previous.capacity === capacity && previous.previewWidth === previewWidth ? previous : { capacity, previewWidth });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => {
      observer.disconnect();
      if (hoverFrame.current !== undefined) cancelAnimationFrame(hoverFrame.current);
    };
  }, []);

  const pointerOffset = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return (event.clientY - bounds.top - 12) / Math.max(1, bounds.height - 24) * sections.length;
  };

  const updateHover = (value: number | null) => {
    pendingHover.current = value;
    if (hoverFrame.current !== undefined) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = undefined;
      setHover(pendingHover.current);
    });
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    setFocused(false);
    const offset = pointerOffset(event);
    const index = Math.min(sections.length - 1, Math.max(0, Math.floor(offset)));
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startY: event.clientY, moved: false,
      offset: index === active ? offset - historyLineToOffset(sections, top, maxTop) : 0 };
    updateHover(offset - .5);
    setDismissed(false);
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const offset = pointerOffset(event);
    updateHover(offset - .5);
    setDismissed(false);
    const gesture = drag.current;
    if (gesture?.pointerId !== event.pointerId) return;
    if (!gesture.moved && Math.abs(event.clientY - gesture.startY) < 3) return;
    gesture.moved = true;
    setDragging(true);
    const limit = terminal.buffer.active.baseY;
    let line = historyOffsetToLine(sections, offset - gesture.offset, limit);
    if (sections.length > 1 && offset <= .5) line = 0;
    if (sections.length > 1 && offset >= sections.length - .5) line = limit;
    terminal.scrollToLine(line);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const gesture = drag.current;
    if (gesture?.pointerId !== event.pointerId) return;
    if (!cancelled && !gesture.moved) {
      const index = Math.min(sections.length - 1, Math.max(0, Math.floor(pointerOffset(event))));
      terminal.scrollToLine(Math.min(terminal.buffer.active.baseY, sections[index].start));
    }
    drag.current = null;
    setDragging(false);
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) updateHover(null);
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowUp": terminal.scrollLines(-1); break;
      case "ArrowDown": terminal.scrollLines(1); break;
      case "PageUp": terminal.scrollLines(-page); break;
      case "PageDown": terminal.scrollLines(page); break;
      case "Home": terminal.scrollToTop(); break;
      case "End": terminal.scrollToBottom(); break;
      case "Escape": setDismissed(true); break;
      default: return;
    }
    if (event.key !== "Escape") { setDismissed(false); updateHover(null); }
    setFocused(true);
    event.preventDefault();
    event.stopPropagation();
  };

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || !event.currentTarget.clientHeight) return;
    const { deltaMode, deltaY } = event;
    const viewportHeight = terminal.element?.clientHeight || event.currentTarget.clientHeight;
    const rowsPerUnit = deltaMode === 1 ? 1 : deltaMode === 2 ? rows : rows / viewportHeight;
    wheelRemainder.current += deltaY * rowsPerUnit;
    const lines = Math.trunc(wheelRemainder.current);
    wheelRemainder.current -= lines;
    if (lines) terminal.scrollLines(lines);
  };

  return (
    <div
      ref={rail}
      className="terminal-history-rail"
      data-terminal-history-control
      data-dragging={dragging}
      data-preview={showPreview}
      data-keyboard-focus={focused}
      style={geometry}
      role="scrollbar"
      tabIndex={0}
      aria-label="Terminal output history"
      aria-controls={viewportId}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={maxTop}
      aria-valuenow={top}
      aria-valuetext={`${range}, ${below}`}
      aria-describedby={showPreview ? `${viewportId}-history-preview` : undefined}
      onPointerEnter={pointerMove}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerLeave={() => { if (!drag.current) updateHover(null); }}
      onPointerUp={(event) => endDrag(event)}
      onPointerCancel={(event) => endDrag(event, true)}
      onLostPointerCapture={(event) => endDrag(event, true)}
      onFocus={(event) => { setFocused(event.currentTarget.matches(":focus-visible")); setDismissed(false); }}
      onBlur={() => setFocused(false)}
      onKeyDown={keyDown}
      onWheel={wheel}
    >
      <div className="terminal-history-scale" aria-hidden="true">
        {sections.map((item, index) => {
          const distance = hover === null ? 4 : Math.abs(index - hover);
          const wave = distance < 4 ? (1 + Math.cos(distance / 4 * Math.PI)) / 2 : 0;
          const current = index === active;
          return <span className="terminal-history-tick" key={index} data-current={current} data-selected={showPreview && selected === index}
            data-history-line={item.start}
            style={{
              top: `${(index + .5) / sections.length * 100}%`,
              "--history-tick-scale": Math.max(current ? .47 : .18, .18 + .82 * wave),
              "--history-tick-opacity": Math.max(current ? .95 : .3, .3 + .7 * wave),
            } as CSSProperties} />;
        })}
      </div>
      {preview && <div id={`${viewportId}-history-preview`} className="terminal-history-preview" role="tooltip">
        <div className="terminal-history-preview-kind">
          <span>{section.commands > 1 ? `${format.format(section.commands)} commands` : section.commands === 1 ? "Command" : "Output"}</span>
          <span>{format.format(selected + 1)} / {format.format(sections.length)}</span>
        </div>
        <div className="terminal-history-preview-heading"><span>{preview.title}</span><IoTerminalOutline size={14} aria-hidden="true" /></div>
        {preview.body && <pre className="terminal-history-preview-body">{preview.body}</pre>}
        <div className="terminal-history-preview-footer">
          <span>Lines {format.format(section.start + 1)}–{format.format(section.end + 1)}</span>
          <span>{lineCount(Math.max(0, maxTop + rows - 1 - section.end))} below</span>
        </div>
      </div>}
    </div>
  );
}

export default function TerminalHistory({ terminal, viewportId, enabled, children, actionsTarget }: {
  terminal: Terminal | null | undefined;
  viewportId: string;
  enabled: boolean;
  children?: ReactNode;
  actionsTarget?: HTMLElement | null;
}) {
  const [position, setPosition] = useState<TerminalHistoryPosition | null>(null);
  useLayoutEffect(() => {
    setPosition(null);
    if (terminal) return observeTerminalHistory(terminal, setPosition);
  }, [terminal]);

  const history = enabled ? position : null;
  const newOutput = history?.newLines
    ? `${format.format(history.newLines)} new ${history.newLines === 1 ? "line" : "lines"}`
    : null;
  const actions = (
      <div className={`terminal-history-actions${actionsTarget !== undefined ? " terminal-history-actions-docked" : ""}`}>
        {terminal && history && history.top < history.maxTop && (
          <button
            type="button"
            className="terminal-history-latest"
            data-terminal-history-control
            aria-label={newOutput ? `To latest, ${newOutput}` : "To latest"}
            onClick={() => {
              terminal.scrollToBottom();
              terminal.focus();
            }}
          >
            <IoArrowDown size={13} aria-hidden="true" />
            <span className="terminal-history-latest-label">To latest</span>
            {newOutput && <span className="terminal-history-count"><span>{format.format(history.newLines)}</span><span className="terminal-history-count-label"> new {history.newLines === 1 ? "line" : "lines"}</span></span>}
          </button>
        )}
        {children}
      </div>
  );
  return (
    <>
      {terminal && history && <HistoryRail terminal={terminal} position={history} viewportId={viewportId} />}
      {actionsTarget === undefined ? actions : actionsTarget && createPortal(actions, actionsTarget)}
    </>
  );
}
