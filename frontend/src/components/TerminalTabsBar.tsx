import {
    closestCenter,
    DndContext,
    DragEndEvent,
    DragMoveEvent,
    DragOverlay,
    DragStartEvent,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import {
    arrayMove,
    horizontalListSortingStrategy,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cursorPosition, getCurrentWindow, monitorFromPoint, PhysicalPosition, type Monitor } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IoAdd, IoChevronBack, IoChevronForward, IoClose, IoRadio, IoUnlinkOutline } from "react-icons/io5";
import { VscLinkExternal } from "react-icons/vsc";
import { useShallow } from "zustand/react/shallow";
import type { Host, TabStatus, TerminalTab } from "../state/store";
import { useAppStore } from "../state/store";
import { isOutsideTabStrip, queryTerminalDock, terminalDockWindow, type DockPlacement } from "../terminal/docking";
import { captureTerminalPointer, isNativeMouseGesture, watchTerminalPointer, type DragPoint } from "../terminal/pointerDrag";
import { floatingTerminalPlacement } from "../terminal/windowPlacement";
import { transferTerminalWindow, TerminalMoveCancelledError } from "../terminal/windowHandoff";
import { openMainTerminalHandoff, waitForTerminalRenderer } from "../terminal/useWindowHandoffs";
import { findTerminalGroup, terminalStripEntries, type TerminalGroup } from "../features/workspace/groups";
import { TerminalLayoutGlyph } from "./TerminalLayoutControl";

const TAB_WINDOW_PREVIEW_WIDTH = 360;
const TAB_WINDOW_PREVIEW_HEIGHT = 190;

interface TerminalTabsBarProps {
  onAddTab?: () => void;
  onDetachTab?: (tabId: string, destination?: DockPlacement, releasePoint?: DragPoint) => Promise<void>;
  disabled?: boolean;
}

interface SortableTabProps {
  id: string;
  tab: TerminalTab;
  activeTabId: string | null;
  setActiveTabId: (id: string | null) => void;
  handleCloseTab: (id: string, isConnected: boolean) => void;
  getProtocolBadgeColor: (type: string) => string;
  showCloseButton: boolean;
  tabPosition: "top" | "bottom";
  tabStop: boolean;
  handleDetachTab: (tab: TerminalTab) => void;
  status: TabStatus;
  tearOutArmed: boolean;
  detaching: boolean;
  terminalGroup?: TerminalGroup;
}

const SortableTab = ({
  id,
  tab,
  activeTabId,
  setActiveTabId,
  handleCloseTab,
  getProtocolBadgeColor,
  showCloseButton,
  tabPosition,
  tabStop,
  handleDetachTab,
  status,
  tearOutArmed,
  detaching,
  terminalGroup,
}: SortableTabProps) => {
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
    isSorting,
  } = useSortable({ id, disabled: detaching });

  const [tooltipPos, setTooltipPos] = useState<{ left: number; edge: number } | null>(null);
  const tooltipId = React.useId();
  const tabRef = React.useRef<HTMLDivElement | null>(null);

  // Combine sortable ref with our own ref
  const combinedRef = React.useCallback((node: HTMLDivElement | null) => {
    tabRef.current = node;
    setSortableRef(node);
  }, [setSortableRef]);

  const handleMouseEnter = React.useCallback(() => {
    if (tabRef.current) {
      const rect = tabRef.current.getBoundingClientRect();
      setTooltipPos({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
        edge: tabPosition === "top" ? rect.bottom + 8 : window.innerHeight - rect.top + 8,
      });
    }
  }, [tabPosition]);

  useEffect(() => {
    if (!tooltipPos) return;
    const hide = () => setTooltipPos(null);
    window.addEventListener("resize", hide);
    document.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("resize", hide);
      document.removeEventListener("scroll", hide, true);
    };
  }, [tooltipPos]);

  const flatTransform = transform
    ? {
        ...transform,
        y: 0,
        scaleX: 1,
        scaleY: 1,
      }
    : null;

  const style = {
    transform: !tearOutArmed && flatTransform ? CSS.Transform.toString(flatTransform) : undefined,
    transition: isSorting ? transition : [transition, "var(--terminal-tab-transition)"].filter(Boolean).join(", "),
    opacity: isDragging ? 0.28 : detaching ? 0.7 : 1,
    zIndex: isDragging ? 1 : "auto",
  };

  const badgeStyle = getProtocolBadgeColor(tab.host.connection_type || "ssh");
  const portDisplay = tab.host.port && tab.host.port !== 22 ? `:${tab.host.port}` : '';
  const isConnected = status === "connected";
  const isConnecting = status === "connecting";
  const isActive = activeTabId === tab.id;
  const statusLabel = isConnected ? "Connected" : isConnecting ? "Connecting" : status === "error" ? "Connection failed" : "Disconnected";

  return (
    <div
      data-terminal-tab-id={id}
      data-close-button={showCloseButton}
      aria-busy={detaching}
      ref={combinedRef}
      style={style}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={isActive}
      aria-label={terminalGroup ? `Session group: ${tab.host.name}, ${terminalGroup.tabIds.length} sessions` : `${tab.host.name}, ${tab.host.connection_type || "ssh"}, ${statusLabel}`}
      aria-describedby={[attributes["aria-describedby"], tooltipPos && !isDragging && !detaching ? tooltipId : null].filter(Boolean).join(" ") || undefined}
      aria-keyshortcuts="Enter Space ArrowLeft ArrowRight Home End"
      tabIndex={tabStop ? 0 : -1}
      data-dragging={isDragging}
      data-tear-out={tearOutArmed}
      onClick={() => setActiveTabId(tab.id)}
      onMouseDown={(e) => {
        // Middle click is button 1
        if (e.button === 1) {
          e.preventDefault();
          handleCloseTab(tab.id, isConnected);
        }
      }}
      onFocus={(event) => { if (event.target === event.currentTarget && !detaching) handleMouseEnter(); }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setTooltipPos(null); }}
      onMouseEnter={detaching ? undefined : handleMouseEnter}
      onMouseLeave={() => setTooltipPos(null)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        setTooltipPos(null);
        if (event.key === "Enter" && !isDragging) {
          event.preventDefault();
          setActiveTabId(tab.id);
          return;
        }
        listeners?.onKeyDown?.(event);
      }}
      data-terminal-group-id={terminalGroup?.id}
      className="terminal-session-tab group relative flex shrink-0 touch-none cursor-pointer select-none items-center gap-2 border outline-none motion-reduce:!transition-none"
    >
      {tooltipPos && !isDragging && !detaching && createPortal(
        <div
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed z-[9999] w-[280px] max-w-[calc(100vw-16px)] rounded-xl border border-white/10 bg-[#101b2b]/95 px-3 py-2.5 shadow-2xl backdrop-blur-xl"
          style={{ left: tooltipPos.left, [tabPosition === "top" ? "top" : "bottom"]: tooltipPos.edge }}
        >
          <p className="break-words text-xs font-semibold text-slate-100">{tab.host.name}</p>
          {!terminalGroup && <p className="mt-1 break-all font-mono text-[10px] leading-4 text-slate-400">
            {tab.host.username && `${tab.host.username}@`}{tab.host.hostname}{portDisplay}
          </p>}
          <div className="mt-2 flex items-center justify-between border-t border-white/[0.06] pt-2 text-[10px]">
            <span className={isConnected ? "text-emerald-400" : isConnecting ? "text-amber-300" : status === "error" ? "text-rose-400" : "text-slate-400"}>
              {terminalGroup ? `${terminalGroup.tabIds.length} grouped sessions` : `${statusLabel}${isConnecting ? "…" : ""}`}
            </span>
            <span className="text-slate-500">Drag to reorder · Space to move</span>
          </div>
        </div>, document.body,
      )}

      {terminalGroup ? <GroupTabIdentity tab={tab} group={terminalGroup} /> : <TabIdentity tab={tab} status={status} badgeStyle={badgeStyle} />}
      <div className="terminal-tab-actions flex shrink-0 items-center gap-0.5">
        {terminalGroup && <button type="button" disabled={detaching} tabIndex={isActive ? 0 : -1} aria-label="Ungroup sessions" title="Show sessions as separate tabs"
          onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); useAppStore.getState().ungroupTerminalTabs(terminalGroup.id); }} className="terminal-tab-action"><IoUnlinkOutline size={14} /></button>}
        <button
          type="button"
          disabled={detaching}
          tabIndex={isActive ? 0 : -1}
          aria-label={`Detach ${tab.host.name}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            handleDetachTab(tab);
          }}
          className="terminal-tab-action"
          title={detaching ? "Moving terminal…" : "Move to a separate window"}
        >
          <VscLinkExternal size={13} />
        </button>
        {showCloseButton && (
          <button
            type="button"
            disabled={detaching}
            tabIndex={isActive ? 0 : -1}
            aria-label={`Close ${tab.host.name}`}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()} // Prevent drag start from button
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              handleCloseTab(tab.id, isConnected);
            }}
            className="terminal-tab-action terminal-tab-close"
            title="Close session"
          >
            <IoClose size={15} />
          </button>
        )}
      </div>
    </div>
  );
};

const TabIdentity = ({ tab, status, badgeStyle }: { tab: TerminalTab; status: TabStatus; badgeStyle: string }) => (
  <>
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${
      status === "connected" ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.35)]"
        : status === "connecting" ? "bg-amber-300 motion-safe:animate-pulse"
          : status === "error" ? "bg-rose-400" : "bg-slate-500"
    }`} />
    <span aria-hidden="true" className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-3 tracking-wide ${badgeStyle}`}>
      {tab.host.connection_type || "SSH"}
    </span>
    <span className="terminal-tab-title min-w-0 flex-1 truncate font-medium tracking-[0.01em]">{tab.host.name}</span>
  </>
);

const GroupTabIdentity = ({ tab, group }: { tab: TerminalTab; group: TerminalGroup }) => <>
  <span className="flex shrink-0 items-center gap-1 rounded-md border border-blue-400/20 bg-blue-400/10 px-1.5 py-0.5 text-[10px] text-blue-300"><TerminalLayoutGlyph layout={group.layout} />{group.tabIds.length}</span>
  <span className="terminal-tab-title min-w-0 flex-1 truncate font-medium" title={tab.host.name}>{tab.host.name}</span>
</>;

const TabDragPreview = ({ tab, status, tearOutArmed, getProtocolBadgeColor, terminalGroup, isActive }: {
  tab: TerminalTab;
  status: TabStatus;
  tearOutArmed: boolean;
  getProtocolBadgeColor: (type: string) => string;
  terminalGroup?: TerminalGroup;
  isActive: boolean;
}) => {
  const badgeStyle = getProtocolBadgeColor(tab.host.connection_type || "ssh");

  return (
    <div
      aria-hidden="true"
      data-active={isActive}
      style={{ width: "100%", height: "100%" }}
      className={`terminal-session-tab terminal-session-tab-preview relative flex select-none items-center gap-2 border ${tearOutArmed ? "ring-2 ring-primary/70" : ""}`}
    >
      {terminalGroup ? <GroupTabIdentity tab={tab} group={terminalGroup} /> : <TabIdentity tab={tab} status={status} badgeStyle={badgeStyle} />}
      {tearOutArmed && <VscLinkExternal size={14} className="text-primary shrink-0" />}
    </div>
  );
};

const TerminalTabsBar: React.FC<TerminalTabsBarProps> = ({
  onAddTab,
  onDetachTab,
  disabled = false,
}) => {
  const {
    terminalTabs,
    activeTabId,
    setActiveTabId,
    removeTerminalTab,
    reorderTerminalTabs,
    settings,
    showConfirm,
    terminalSockets,
    updateTabConnection,
    tabStatuses,
    broadcastMode,
    setBroadcastMode,
    addToast,
    terminalGroups,
    terminalTransfers,

  } = useAppStore(
    useShallow((state) => ({
      terminalTabs: state.terminalTabs,
      activeTabId: state.activeTabId,
      setActiveTabId: state.setActiveTabId,
      removeTerminalTab: state.removeTerminalTab,
      reorderTerminalTabs: state.reorderTerminalTabs,
      settings: state.settings,
      showConfirm: state.showConfirm,
      terminalSockets: state.terminalSockets,
      updateTabConnection: state.updateTabConnection,
      tabStatuses: state.tabStatuses,
      broadcastMode: state.broadcastMode,
      setBroadcastMode: state.setBroadcastMode,
      addToast: state.addToast,
      terminalGroups: state.terminalGroups,
      terminalTransfers: state.terminalTransfers,
    })),
  );
  const [tearOutTabId, setTearOutTabId] = useState<string | null>(null);
  const entries = terminalStripEntries(terminalTabs, terminalGroups);
  const displayTab = (tab: TerminalTab): TerminalTab => {
    const group = findTerminalGroup(terminalGroups, tab.id);
    return group ? { ...tab, host: { ...tab.host, name: group.tabIds.map((id) => terminalTabs.find((item) => item.id === id)?.host.name).join(" + ") } } : tab;
  };
  const activateTab = (id: string | null) => {
    if (disabled || Object.keys(useAppStore.getState().terminalTransfers).length) return;
    const group = findTerminalGroup(terminalGroups, id);
    setActiveTabId(group && group.tabIds.includes(group.activeTabId ?? "") ? group.activeTabId! : id);
  };
  const [activeDragTabId, setActiveDragTabId] = useState<string | null>(null);
  const [detachingTabId, setDetachingTabId] = useState<string | null>(null);
  const [resolvingDrop, setResolvingDrop] = useState(false);
  const detachingTabsRef = React.useRef<Set<string>>(new Set());
  const tabBarRef = React.useRef<HTMLDivElement>(null);
  const tabsViewportRef = React.useRef<HTMLDivElement>(null);
  const [scrollEdges, setScrollEdges] = useState({ left: false, right: false });
  const hasOverflow = scrollEdges.left || scrollEdges.right;
  const tabOrder = terminalTabs.map((tab) => tab.id).join("\0");
  const pointerOriginRef = React.useRef<{ x: number; y: number } | null>(null);
  const dragGestureRef = React.useRef<string | null>(null);
  const dragAbortRef = React.useRef<AbortController | null>(null);
  const dragCleanupRef = React.useRef<Array<() => void>>([]);
  const dropPointRef = React.useRef<Promise<DragPoint> | null>(null);
  const dockProbePendingRef = React.useRef<string | null>(null);
  const tearArmedRef = React.useRef(false);
  const tearPreviewWindowRef = React.useRef<WebviewWindow | null>(null);
  const tearPreviewTabIdRef = React.useRef<string | null>(null);
  const tearPreviewMovePendingRef = React.useRef<WebviewWindow | null>(null);
  const tearPreviewMonitorRef = React.useRef<Monitor | null>(null);
  const tearPreviewFollowTimerRef = React.useRef<number | null>(null);

  // Periodic WebSocket health check — verify real connection state every 3s
  const checkConnections = useCallback(() => {
    terminalTabs.forEach((tab) => {
      const ws = terminalSockets[tab.id];
      const isAlive = tabStatuses[tab.id] === "connected" && ws != null && ws.readyState === WebSocket.OPEN;
      if (tab.isConnected !== isAlive) {
        updateTabConnection(tab.id, isAlive);
      }
    });
  }, [terminalTabs, terminalSockets, tabStatuses, updateTabConnection]);

  useEffect(() => {
    const interval = setInterval(checkConnections, 3000);
    return () => clearInterval(interval);
  }, [checkConnections]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      onActivation: ({ event }) => {
        dragCleanupRef.current.splice(0).forEach((cleanup) => cleanup());
        dragCleanupRef.current.push(captureTerminalPointer(event));
      },
      activationConstraint: {
        distance: 8, // Require 8px movement before drag starts, to allow clicks
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  useEffect(() => {
    const viewport = tabsViewportRef.current;
    if (!viewport) return;
    const update = () => {
      const left = viewport.scrollLeft > 1;
      const right = viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 1;
      setScrollEdges((current) => current.left === left && current.right === right ? current : { left, right });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    viewport.querySelectorAll("[data-terminal-tab-id]").forEach((tab) => observer.observe(tab));
    viewport.addEventListener("scroll", update, { passive: true });
    return () => { observer.disconnect(); viewport.removeEventListener("scroll", update); };
  }, [terminalTabs.length, entries.length]);

  useEffect(() => {
    if (activeDragTabId) return;
    const viewport = tabsViewportRef.current;
    const active = viewport && [...viewport.querySelectorAll<HTMLElement>("[data-terminal-tab-id]")]
      .find((tab) => tab.dataset.terminalTabId === (findTerminalGroup(terminalGroups, activeTabId)?.tabIds[0] ?? activeTabId));
    if (!viewport || !active) return;
    const reveal = () => {
      const bounds = viewport.getBoundingClientRect();
      const tab = active.getBoundingClientRect();
      const delta = tab.left < bounds.left ? tab.left - bounds.left - 4
        : tab.right > bounds.right ? tab.right - bounds.right + 4 : 0;
      if (delta) viewport.scrollBy({ left: delta, behavior: "auto" });
    };
    reveal();
    // Follow the expanding tab so its right edge stays visible during selection.
    const observer = new ResizeObserver(reveal);
    observer.observe(active);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [activeTabId, tabOrder, activeDragTabId, hasOverflow, terminalGroups]);

  const handleTabNavigation = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (activeDragTabId || event.defaultPrevented || !(event.target instanceof HTMLElement)
      || event.target.getAttribute("role") !== "tab") return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")];
    const index = tabs.indexOf(event.target);
    let next: number;
    switch (event.key) {
      case "ArrowRight": next = (index + 1) % tabs.length; break;
      case "ArrowLeft": next = (index - 1 + tabs.length) % tabs.length; break;
      case "Home": next = 0; break;
      case "End": next = tabs.length - 1; break;
      default: return;
    }
    const target = tabs[next];
    if (!target?.dataset.terminalTabId) return;
    event.preventDefault();
    activateTab(target.dataset.terminalTabId);
    target.focus({ preventScroll: true });
  };

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabsViewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({
      left: direction * Math.max(224, viewport.clientWidth * 0.75),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  const isTearOutGesture = (delta: { x: number; y: number }) => {
    const origin = pointerOriginRef.current;
    const bounds = tabBarRef.current?.getBoundingClientRect();
    return Boolean(origin && bounds && isOutsideTabStrip({ x: origin.x + delta.x, y: origin.y + delta.y }, bounds, tearArmedRef.current));
  };

  const closeTearPreviewWindow = useCallback(() => {
    if (tearPreviewFollowTimerRef.current !== null) {
      window.clearInterval(tearPreviewFollowTimerRef.current);
      tearPreviewFollowTimerRef.current = null;
    }
    const preview = tearPreviewWindowRef.current;
    tearPreviewWindowRef.current = null;
    tearPreviewTabIdRef.current = null;
    tearPreviewMovePendingRef.current = null;
    tearPreviewMonitorRef.current = null;
    if (preview) {
      preview.close().catch(() => {});
    }
  }, []);

  useEffect(() => () => {
    dragCleanupRef.current.splice(0).forEach((cleanup) => cleanup());
    dragAbortRef.current?.abort();
    closeTearPreviewWindow();
    const gestureId = dragGestureRef.current;
    dragGestureRef.current = null;
    if (gestureId) void emit("terminal-dock-end", { source: getCurrentWindow().label, gestureId }).catch(() => {});
  }, [closeTearPreviewWindow]);

  const placeTearPreview = useCallback(async (preview: WebviewWindow) => {
    const point = await cursorPosition();
    let monitor = tearPreviewMonitorRef.current;
    if (!monitor || point.x < monitor.position.x || point.x >= monitor.position.x + monitor.size.width
      || point.y < monitor.position.y || point.y >= monitor.position.y + monitor.size.height) {
      monitor = await monitorFromPoint(point.x, point.y).catch(() => null);
      tearPreviewMonitorRef.current = monitor;
    }
    if (tearPreviewWindowRef.current !== preview) return;
    const scale = monitor?.scaleFactor || window.devicePixelRatio;
    await preview.setPosition(new PhysicalPosition(point.x - TAB_WINDOW_PREVIEW_WIDTH * scale / 2, point.y + 18 * scale));
  }, []);

  const moveTearPreviewWindow = useCallback(() => {
    const preview = tearPreviewWindowRef.current;
    if (!preview || tearPreviewMovePendingRef.current === preview) return;
    tearPreviewMovePendingRef.current = preview;
    requestAnimationFrame(async () => {
      try {
        if (tearPreviewWindowRef.current === preview) await placeTearPreview(preview);
      } catch {
        if (tearPreviewWindowRef.current === preview) closeTearPreviewWindow();
      } finally {
        if (tearPreviewMovePendingRef.current === preview) tearPreviewMovePendingRef.current = null;
      }
    });
  }, [closeTearPreviewWindow, placeTearPreview]);

  const ensureTearPreviewWindow = useCallback((tab: TerminalTab, status: TabStatus) => {
    // Floating workspaces use the in-webview overlay; generic preview-window
    // creation belongs to the main capability only.
    if (getCurrentWindow().label !== "main") return;
    if (tearPreviewWindowRef.current && tearPreviewTabIdRef.current === tab.id) {
      moveTearPreviewWindow();
      return;
    }

    closeTearPreviewWindow();
    tearPreviewTabIdRef.current = tab.id;

    const params = new URLSearchParams({
      tabPreview: "true",
      name: tab.host.name || "Terminal",
      protocol: tab.host.connection_type || "ssh",
      status,
    });
    const preview = new WebviewWindow(`tab-preview-${tab.id}-${Date.now()}`, {
      url: `/?${params.toString()}`,
      title: `Moving ${tab.host.name || "Terminal"}`,
      width: TAB_WINDOW_PREVIEW_WIDTH,
      height: TAB_WINDOW_PREVIEW_HEIGHT,
      decorations: false,
      resizable: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focus: false,
      focusable: false,
      visible: false,
      shadow: false,
    });

    tearPreviewWindowRef.current = preview;
    preview.once("tauri://created", async () => {
      try {
        await placeTearPreview(preview);
      } catch (err) {
        console.warn("[TabPreview] Failed to place preview window:", err);
      }
      if (tearPreviewWindowRef.current !== preview) { void preview.close().catch(() => {}); return; }
      if (tearPreviewFollowTimerRef.current === null) {
        tearPreviewFollowTimerRef.current = window.setInterval(moveTearPreviewWindow, 32);
      }
      preview.show().catch(() => {});
    });
    preview.once("tauri://error", (event) => {
      console.warn("[TabPreview] Failed to create preview window:", event.payload);
      if (tearPreviewWindowRef.current === preview) {
        tearPreviewWindowRef.current = null;
        tearPreviewTabIdRef.current = null;
      }
    });
  }, [closeTearPreviewWindow, moveTearPreviewWindow, placeTearPreview]);

  const handleDragStart = (event: DragStartEvent) => {
    const activator = event.activatorEvent;
    pointerOriginRef.current = "clientX" in activator && "clientY" in activator ? { x: Number(activator.clientX), y: Number(activator.clientY) } : null;
    dragGestureRef.current = pointerOriginRef.current ? crypto.randomUUID() : null;
    dropPointRef.current = null;
    dragAbortRef.current?.abort();
    const abort = new AbortController();
    dragAbortRef.current = abort;
    tearArmedRef.current = false;
    setActiveDragTabId(String(event.active.id));
    setTearOutTabId(null);
    closeTearPreviewWindow();
    const gestureId = dragGestureRef.current;
    if (gestureId) {
      const probe = () => {
        if (dragGestureRef.current !== gestureId || abort.signal.aborted || dockProbePendingRef.current === gestureId || dropPointRef.current) return;
        dockProbePendingRef.current = gestureId;
        const state = useAppStore.getState();
        const tab = state.terminalTabs.find((item) => item.id === String(event.active.id));
        void cursorPosition().then((point) => {
          if (dragGestureRef.current !== gestureId || dropPointRef.current) return;
          return queryTerminalDock(point, { gestureId, excludeSource: false, title: tab?.host.name ?? "Terminal", sessionCount: findTerminalGroup(state.terminalGroups, tab?.id ?? null)?.tabIds.length ?? 1, signal: abort.signal });
        }).catch(() => {}).finally(() => { if (dockProbePendingRef.current === gestureId) dockProbePendingRef.current = null; });
      };
      const heartbeat = window.setInterval(probe, 100);
      const freezePoint = () => { dropPointRef.current ??= cursorPosition(); };
      window.addEventListener("pointerup", freezePoint, true);
      dragCleanupRef.current.push(() => clearInterval(heartbeat), () => window.removeEventListener("pointerup", freezePoint, true));
      dragCleanupRef.current.push(watchTerminalPointer(gestureId, (result) => {
        if (dragGestureRef.current !== gestureId || abort.signal.aborted) return;
        if (result.released) {
          dropPointRef.current = Promise.resolve(result.point);
          document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: (activator as PointerEvent).pointerId }));
        } else {
          document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape", code: "Escape" }));
          handleDragCancel();
        }
      }, isNativeMouseGesture(activator)));
      probe();
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const activeId = String(event.active.id);
    if (dropPointRef.current || dragAbortRef.current?.signal.aborted) return;
    const nextTearOutTabId = isTearOutGesture(event.delta) ? activeId : null;
    tearArmedRef.current = Boolean(nextTearOutTabId);
    setTearOutTabId((current) => current === nextTearOutTabId ? current : nextTearOutTabId);
    if (nextTearOutTabId) {
      const tab = terminalTabs.find((t) => t.id === activeId);
      if (tab) ensureTearPreviewWindow(displayTab(tab), getTabStatus(tab));
    } else {
      closeTearPreviewWindow();
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over, delta } = event;
    const activeId = String(active.id);
    const overId = over ? String(over.id) : null;
    let shouldTearOut = isTearOutGesture(delta);
    const wasArmed = tearArmedRef.current;
    const gestureId = dragGestureRef.current;
    const pointerDrag = !!pointerOriginRef.current;
    const abort = dragAbortRef.current;
    const point = pointerDrag ? (dropPointRef.current ?? cursorPosition()) : null;
    dropPointRef.current = point;
    dragCleanupRef.current.splice(0).forEach((cleanup) => cleanup());
    setResolvingDrop(pointerDrag);
    const escape = (key: KeyboardEvent) => { if (key.key === "Escape") handleDragCancel(); };
    window.addEventListener("keydown", escape, true);
    const cancelled = () => {
      const state = useAppStore.getState();
      return dragGestureRef.current !== gestureId || abort?.signal.aborted
        || Object.keys(state.terminalTransfers).length > 0 || !state.terminalTabs.some((tab) => tab.id === activeId);
    };
    try {
      tearArmedRef.current = false;
      pointerOriginRef.current = null;
      setTearOutTabId(null);
      setActiveDragTabId(null);
      const releasePoint = point ? await point.catch(() => null) : null;
      if (pointerDrag && !releasePoint) return;

      const tab = useAppStore.getState().terminalTabs.find((item) => item.id === activeId);
      const match = releasePoint ? await queryTerminalDock(releasePoint, { gestureId: gestureId ?? undefined, excludeSource: false, title: tab ? displayTab(tab).host.name : "Terminal", sessionCount: findTerminalGroup(terminalGroups, activeId)?.tabIds.length ?? 1, signal: abort?.signal }).catch(() => null) : null;
      if (cancelled()) return;
      if (match?.placement.pane && match.placement.windowLabel === getCurrentWindow().label && tab) {
        if (!useAppStore.getState().insertTerminalPane(match.placement.pane.groupId, match.placement.pane.index, tab.id)) addToast("This pane is no longer empty.", "error");
        return;
      }
      if (match && match.placement.windowLabel !== getCurrentWindow().label && tab) {
        closeTearPreviewWindow();
        void handleDetachTab(tab, match.placement);
        return;
      }

      if (releasePoint) {
        try {
          const origin = await getCurrentWindow().innerPosition();
          const bounds = tabBarRef.current?.getBoundingClientRect();
          if (bounds) shouldTearOut = isOutsideTabStrip({ x: (releasePoint.x - origin.x) / window.devicePixelRatio, y: (releasePoint.y - origin.y) / window.devicePixelRatio }, bounds, wasArmed);
        } catch { /* Keep the last DOM coordinates if native geometry is unavailable. */ }
      }
      if (cancelled()) return;
      if (shouldTearOut) {
        // A refused dock must not accidentally open a replacement window.
        if (releasePoint && await terminalDockWindow(releasePoint, false).catch(() => "unavailable")) return;
        if (cancelled()) return;
        if (tab) void handleDetachTab(tab, undefined, releasePoint ?? undefined);
        return;
      }

      if (overId && activeId !== overId) {
        const state = useAppStore.getState();
        const currentEntries = terminalStripEntries(state.terminalTabs, state.terminalGroups);
        const oldIndex = currentEntries.findIndex((entry) => entry.tab.id === activeId);
        const newIndex = currentEntries.findIndex((entry) => entry.tab.id === overId);

        if (oldIndex >= 0 && newIndex >= 0) reorderTerminalTabs(arrayMove(currentEntries, oldIndex, newIndex).flatMap((entry) =>
          entry.group ? entry.group.tabIds.flatMap((id) => state.terminalTabs.filter((tab) => tab.id === id)) : [entry.tab]));
      }
    } finally {
      window.removeEventListener("keydown", escape, true);
      if (dragAbortRef.current === abort) { abort?.abort(); dragAbortRef.current = null; setResolvingDrop(false); }
      if (dragGestureRef.current === gestureId) {
        dragGestureRef.current = null;
        if (gestureId) void emit("terminal-dock-end", { source: getCurrentWindow().label, gestureId }).catch(() => {});
      }
      closeTearPreviewWindow();
    }
  };

  const handleDragCancel = () => {
    dragAbortRef.current?.abort();
    dragCleanupRef.current.splice(0).forEach((cleanup) => cleanup());
    const gestureId = dragGestureRef.current;
    dragGestureRef.current = null;
    if (gestureId) void emit("terminal-dock-end", { source: getCurrentWindow().label, gestureId }).catch(() => {});
    tearArmedRef.current = false;
    pointerOriginRef.current = null;
    setTearOutTabId(null);
    setActiveDragTabId(null);
    closeTearPreviewWindow();
  };

  const handleCloseTab = (tabId: string, isConnected: boolean) => {
    const group = findTerminalGroup(terminalGroups, tabId);
    const ids = group?.tabIds ?? [tabId];
    if (ids.some((id) => useAppStore.getState().terminalTransfers[id])) return;
    const close = () => ids.forEach((id) => removeTerminalTab(id));
    isConnected = isConnected || !!group && ids.some((id) => tabStatuses[id] === "connected" || tabStatuses[id] === "connecting");
    if (isConnected && settings.security.confirmBeforeDisconnect) {
      showConfirm({
        title: "Active Connection",
        message:
          group ? `Close all ${ids.length} sessions in this group? All unsaved work will be lost.` : "This tab has an active connection. Are you sure you want to close it? All unsaved work will be lost.",
        confirmText: "Close Connection",
        cancelText: "Stay Connected",
        type: "danger",
        onConfirm: close,
      });
      return;
    }
    close();
  };



  const handleDetachTab = async (tab: { id: string; host: Host }, destination?: DockPlacement, releasePoint?: DragPoint) => {
    const state = useAppStore.getState();
    if (detachingTabsRef.current.has(tab.id) || Object.keys(state.terminalTransfers).length || !state.terminalTabs.some((item) => item.id === tab.id)) return;
    detachingTabsRef.current.add(tab.id);
    setDetachingTabId(tab.id);
    let webview: WebviewWindow | undefined;
    const group = findTerminalGroup(state.terminalGroups, tab.id);
    const members = group ? group.tabIds.flatMap((id) => state.terminalTabs.filter((item) => item.id === id)) : [tab];
    const focused = members.find((item) => item.id === group?.activeTabId) ?? tab;
    try {
      if (onDetachTab) { await onDetachTab(tab.id, destination, releasePoint); return; }
      setActiveTabId(focused.id);
      if (!group) await waitForTerminalRenderer(tab.id);
      const windowId = `detached-${tab.id}-${Date.now()}`;
      await transferTerminalWindow({
        tabId: focused.id,
        host: focused.host,
        placement: destination,
        workspace: group ? { group, tabs: members } : undefined,
        prepare: group ? () => Promise.all(members.map((item) => waitForTerminalRenderer(item.id))).then(() => {}) : undefined,
        target: destination?.windowLabel ?? windowId,
        open: async (address) => {
          if (destination) { closeTearPreviewWindow(); await openMainTerminalHandoff(address); return; }
          const cursor = releasePoint ?? await cursorPosition();
          const monitor = await monitorFromPoint(cursor.x, cursor.y).catch(() => null);
          const placement = floatingTerminalPlacement(cursor, monitor, window.devicePixelRatio);
          const params = new URLSearchParams({ detached: "true", workspace: "true", handoff: address.id, source: address.source, originTabId: tab.id });
          webview = new WebviewWindow(windowId, {
            url: `/?${params}`,
            title: `Terminal - ${tab.host.name}`,
            width: placement.width,
            height: placement.height,
            minWidth: Math.min(640, placement.width),
            minHeight: Math.min(400, placement.height),
            decorations: false,
            transparent: true,
            shadow: false,
            visible: false,
          });
          await new Promise<void>((resolve, reject) => {
            void webview!.once("tauri://created", () => resolve()).catch(reject);
            void webview!.once("tauri://error", () => reject(new Error("Could not open the terminal window. Your session is still here."))).catch(reject);
          });
          closeTearPreviewWindow();
          await webview.setPosition(new PhysicalPosition(placement.x, placement.y));
        },
        release: () => members.forEach((item) => removeTerminalTab(item.id, { preserveSession: true })),
        discard: async () => { await webview?.close(); },
      });
    } catch (error) {
      if (!(error instanceof TerminalMoveCancelledError)) addToast(error instanceof Error ? error.message : "Could not move terminal window", "error");
    } finally {
      closeTearPreviewWindow();
      detachingTabsRef.current.delete(tab.id);
      setDetachingTabId((current) => current === tab.id ? null : current);
    }
  };

  const getProtocolBadgeColor = (type: string) => {
    switch (type) {
      case "ssh":
        return "bg-green-500/10 text-green-400 border-green-500/20";
      case "telnet":
        return "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
      case "serial":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20";
      case "local":
        return "bg-violet-500/10 text-violet-300 border-violet-400/20";
      default:
        return "bg-gray-500/10 text-gray-400 border-gray-500/20";
    }
  };

  const activeDragTab = activeDragTabId
    ? terminalTabs.find((tab) => tab.id === activeDragTabId)
    : null;

  const getTabStatus = (tab: TerminalTab): TabStatus => {
    const status = tabStatuses[tab.id];
    if (status) return status;
    const ws = terminalSockets[tab.id];
    const alive = tab.isConnected && ws != null && ws.readyState === WebSocket.OPEN;
    return alive ? "connected" : "disconnected";
  };

  return (
    <div ref={tabBarRef} data-terminal-tabbar className={`relative flex h-[42px] min-w-0 shrink-0 items-center gap-2 overflow-hidden bg-[var(--terminal-chrome-bg)] px-3 ${settings.window.tabPosition === "bottom" ? "border-t" : "border-b"} border-[var(--terminal-chrome-border)]`}>
      <DndContext
        accessibility={{ screenReaderInstructions: { draggable: "To move a terminal tab, press Space. Use the arrow keys to reorder, then Space or Enter to drop, or Escape to cancel." } }}
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div
          ref={tabsViewportRef}
          data-terminal-tabs-dropzone
          role="tablist"
          aria-label="Terminal sessions"
          aria-orientation="horizontal"
          onKeyDown={handleTabNavigation}
          className="scrollbar-hide flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1"
        >
          <SortableContext
            items={entries.map((entry) => entry.tab.id)}
            strategy={tearOutTabId ? () => null : horizontalListSortingStrategy}
          >
            {entries.map(({ tab, group }, index) => (
              <SortableTab
                key={tab.id}
                id={tab.id}
                tab={displayTab(tab)}
                activeTabId={group?.tabIds.includes(activeTabId ?? "") ? tab.id : activeTabId}
                setActiveTabId={activateTab}
                terminalGroup={group}
                handleCloseTab={handleCloseTab}
                getProtocolBadgeColor={getProtocolBadgeColor}
                showCloseButton={settings.window.showTabCloseButton}
                tabPosition={settings.window.tabPosition}
                tabStop={activeTabId === tab.id || !!group?.tabIds.includes(activeTabId ?? "") || (!activeTabId && index === 0)}
                handleDetachTab={() => handleDetachTab(tab)}
                tearOutArmed={tearOutTabId === tab.id}
                detaching={disabled || resolvingDrop || detachingTabId === tab.id || Object.keys(terminalTransfers).length > 0}
                status={getTabStatus(tab)}
              />
            ))}
          </SortableContext>
        </div>
        <DragOverlay dropAnimation={null}>
          {activeDragTab && (!tearOutTabId || !!onDetachTab) ? (
            <TabDragPreview
              tab={displayTab(activeDragTab)}
              terminalGroup={findTerminalGroup(terminalGroups, activeDragTab.id)}
              isActive={activeDragTab.id === activeTabId || !!findTerminalGroup(terminalGroups, activeDragTab.id)?.tabIds.includes(activeTabId ?? "")}
              status={getTabStatus(activeDragTab)}
              tearOutArmed={tearOutTabId === activeDragTab.id}
              getProtocolBadgeColor={getProtocolBadgeColor}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] transition-opacity duration-150 ${
          tearOutTabId ? "opacity-100 bg-primary shadow-[0_0_12px_rgba(34,211,238,0.65)]" : "opacity-0"
        }`}
      />

      <div className="flex shrink-0 items-center gap-1 border-l border-white/[0.08] pl-2">
        {hasOverflow && (
          <div className="mr-1 flex items-center gap-0.5">
            <button type="button" aria-label="Scroll sessions left" title="Scroll sessions left" disabled={!scrollEdges.left} onClick={() => scrollTabs(-1)} className="terminal-tabs-control h-7 w-6">
              <IoChevronBack size={14} />
            </button>
            <button type="button" aria-label="Scroll sessions right" title="Scroll sessions right" disabled={!scrollEdges.right} onClick={() => scrollTabs(1)} className="terminal-tabs-control h-7 w-6">
              <IoChevronForward size={14} />
            </button>
          </div>
        )}
        <button
          type="button"
          aria-label="Broadcast mode"
          aria-pressed={broadcastMode}
          onClick={() => setBroadcastMode(!broadcastMode)}
          className="terminal-tabs-control h-7 w-7"
          title="Broadcast Mode"
        >
          <IoRadio size={16} />
        </button>

        {onAddTab && <button
          type="button"
          aria-label="New connection"
          onClick={onAddTab}
          className="terminal-tabs-control terminal-tabs-add h-7 w-7"
          title="New Connection"
        >
          <IoAdd size={18} />
        </button>}
      </div>
    </div>
  );
};

export default TerminalTabsBar;
