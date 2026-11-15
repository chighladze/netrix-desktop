import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
    LuCheck,
    LuCloud,
    LuCopy,
    LuDatabase,
    LuExternalLink,
    LuFolderOpen,
    LuGlobe,
    LuGrid3X3,
    LuHardDrive,
    LuLaptop,
    LuLayoutGrid,
    LuLink,
    LuMap,
    LuMaximize2,
    LuMonitor,
    LuMousePointer,
    LuNetwork,
    LuPencil,
    LuPlus,
    LuPrinter,
    LuRefreshCw,
    LuSearch,
    LuServer,
    LuShield,
    LuSmartphone,
    LuTerminal,
    LuTrash2,
    LuUndo2,
    LuUnlink,
    LuWifi,
    LuX,
    LuZoomIn,
    LuZoomOut,
} from "react-icons/lu";
import { useShallow } from "zustand/react/shallow";
import { fetchJsonOrThrow, getApiBase } from "../api";
import { useAppStore } from "../state/store";
import type { Host } from "../types/host";
import {
  edgePath,
  nodeBounds,
  nodeCenter,
  parseWaypoints,
  snapCoordinate,
} from "../features/network-map/geometry";
import {
  colorForHost,
  hostSearchText,
  iconForHost,
} from "../features/network-map/hostPresentation";
import {
  CONNECTION_TYPES,
} from "../features/network-map/connectionTypes";
import type {
  AddNodeMode,
  MapEdge,
  MapNode,
  MapSheet,
  Tool,
  WaypointXY,
} from "../features/network-map/types";

import MapExplorer from "../features/network-map/MapExplorer";
import MapToolbar from "../features/network-map/MapToolbar";
import NodeInspector from "../features/network-map/NodeInspector";
import EdgeInspector, { edgeDraft, edgePatch, type EdgeDraft } from "../features/network-map/EdgeInspector";
import NodeAppearanceDialog from "../features/network-map/NodeAppearanceDialog";
import { findMapNodes, nodeLabel, type ReachabilityFilter } from "../features/network-map/presentation";
import { fitBounds, pointInViewport, resizeViewport, topologyBounds, viewportScale, zoomViewport, type CanvasSize } from "../features/network-map/viewport";
import { remapDeletedNode, restoreDeletedItem, type DeletedMapItem } from "../features/network-map/deletionHistory";
import "../features/network-map/map.css";

export type { MapEdge, MapNode, MapSheet } from "../features/network-map/types";
// ─── Icon Registry ──────────────────────────────────────────────────

const ICON_MAP: Record<string, { icon: React.ReactNode; label: string }> = {
  server:   { icon: <LuServer size={22} />,     label: "Server" },
  router:   { icon: <LuNetwork size={22} />,    label: "Router" },
  switch:   { icon: <LuHardDrive size={22} />,  label: "Switch" },
  firewall: { icon: <LuShield size={22} />,     label: "Firewall" },
  cloud:    { icon: <LuCloud size={22} />,      label: "Cloud" },
  desktop:  { icon: <LuMonitor size={22} />,    label: "Desktop" },
  laptop:   { icon: <LuLaptop size={22} />,     label: "Laptop" },
  phone:    { icon: <LuSmartphone size={22} />, label: "Phone" },
  printer:  { icon: <LuPrinter size={22} />,    label: "Printer" },
  database: { icon: <LuDatabase size={22} />,   label: "Database" },
  wireless: { icon: <LuWifi size={22} />,       label: "Wireless AP" },
  internet: { icon: <LuGlobe size={22} />,      label: "Internet" },
  generic:  { icon: <LuHardDrive size={22} />,  label: "Generic" },
};

const ICON_KEYS = Object.keys(ICON_MAP);

const NODE_COLORS = [
  "#3b82f6", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
  "#f97316", "#6366f1",
];

function mutationErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// ─── Component ──────────────────────────────────────────────────────

interface NetworkMapProps {
  /** When set, the component runs in detached (single-map) mode — no tabs, no switcher */
  detachedMapId?: string;
  /** Initial view state to restore (used when detaching/reattaching) */
  initialViewState?: { x: number; y: number; w: number; h: number; zoom: number };
}

const NetworkMap: React.FC<NetworkMapProps> = ({ detachedMapId, initialViewState }) => {
  const isDetachedMode = !!detachedMapId;
  const {
    hosts, addToast, addTerminalTab, setActiveView, openSftpForHost,
    networkMapOpenIds, networkMapActiveId, networkMapDetachedIds, networkMapInitialized,
    setNetworkMapOpenIds, setNetworkMapActiveId, addNetworkMapDetached, removeNetworkMapDetached, setNetworkMapInitialized,
    setNetworkMapViewState,
    networkMapFocusRequest, clearNetworkMapFocusRequest,
  } = useAppStore(
    useShallow((state) => ({
      hosts: state.hosts,
      addToast: state.addToast,
      addTerminalTab: state.addTerminalTab,
      setActiveView: state.setActiveView,
      openSftpForHost: state.openSftpForHost,
      networkMapOpenIds: state.networkMapOpenIds,
      networkMapActiveId: state.networkMapActiveId,
      networkMapDetachedIds: state.networkMapDetachedIds,
      networkMapInitialized: state.networkMapInitialized,
      setNetworkMapOpenIds: state.setNetworkMapOpenIds,
      setNetworkMapActiveId: state.setNetworkMapActiveId,
      addNetworkMapDetached: state.addNetworkMapDetached,
      removeNetworkMapDetached: state.removeNetworkMapDetached,
      setNetworkMapInitialized: state.setNetworkMapInitialized,
      setNetworkMapViewState: state.setNetworkMapViewState,
      networkMapFocusRequest: state.networkMapFocusRequest,
      clearNetworkMapFocusRequest: state.clearNetworkMapFocusRequest,
    })),
  );

  // ─── Map sheets (tabs) state ───────────────────────────────────
  const [allMaps, setAllMaps] = useState<MapSheet[]>([]);

  // In detached mode use local state, otherwise use Zustand-persisted state
  const [localOpenMapIds, setLocalOpenMapIds] = useState<string[]>([]);
  const [localActiveMapId, setLocalActiveMapId] = useState<string | null>(null);
  const [localMapsLoaded, setLocalMapsLoaded] = useState(false);

  // Unified accessors
  const openMapIds = isDetachedMode ? localOpenMapIds : networkMapOpenIds;
  const activeMapId = isDetachedMode ? localActiveMapId : networkMapActiveId;
  const mapsLoaded = isDetachedMode ? localMapsLoaded : networkMapInitialized;

  const setOpenMapIds = useCallback((updater: string[] | ((prev: string[]) => string[])) => {
    if (isDetachedMode) {
      setLocalOpenMapIds(updater);
    } else {
      const next = typeof updater === "function" ? updater(useAppStore.getState().networkMapOpenIds) : updater;
      setNetworkMapOpenIds(next);
    }
  }, [isDetachedMode, setNetworkMapOpenIds]);

  const setActiveMapId = useCallback((id: string | null) => {
    if (isDetachedMode) {
      setLocalActiveMapId(id);
    } else {
      setNetworkMapActiveId(id);
    }
  }, [isDetachedMode, setNetworkMapActiveId]);

  const setMapsLoaded = useCallback((v: boolean) => {
    if (isDetachedMode) {
      setLocalMapsLoaded(v);
    } else {
      setNetworkMapInitialized(v);
    }
  }, [isDetachedMode, setNetworkMapInitialized]);

  // Ping status: nodeId → reachable (true/false/null=unknown)
  const [pingStatus, setPingStatus] = useState<Record<string, boolean | null>>({});
  const [pingEnabled, setPingEnabled] = useState(true);
  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pingErrorToastShownRef = useRef(false);

  // Map management modals
  const [renameMapId, setRenameMapId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteMapId, setDeleteMapId] = useState<string | null>(null);
  const [showMapSwitcher, setShowMapSwitcher] = useState(false);
  const [newMapName, setNewMapName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Map data
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [edges, setEdges] = useState<MapEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [mapLoadError, setMapLoadError] = useState<string | null>(null);
  const mapLoadGenerationRef = useRef(0);
  const mapLoadAbortRef = useRef<AbortController | null>(null);
  const activeMapIdRef = useRef(activeMapId);
  activeMapIdRef.current = activeMapId;

  // Canvas state
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 1000, height: 700 });
  const [spacePan, setSpacePan] = useState(false);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  // Initialize viewBox/zoom from store (for returning after navigation) or from props (detached window)
  const storedView = !isDetachedMode && networkMapActiveId
    ? useAppStore.getState().networkMapViewStates[networkMapActiveId]
    : null;
  const [viewBox, setViewBox] = useState(
    initialViewState
      ? { x: initialViewState.x, y: initialViewState.y, w: initialViewState.w, h: initialViewState.h }
      : storedView
        ? { x: storedView.x, y: storedView.y, w: storedView.w, h: storedView.h }
        : { x: 0, y: 0, w: 1600, h: 900 }
  );
  const zoom = viewportScale(viewBox, canvasSize);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const prevActiveMapIdRef = useRef<string | null>(null);
  // Keep refs updated for unmount/save usage
  const viewBoxRef = useRef(viewBox);
  const zoomRef = useRef(zoom);
  useEffect(() => { viewBoxRef.current = viewBox; }, [viewBox]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  // Expose current view state on window for detached window reattach
  useEffect(() => {
    (window as any).__netrixMapViewState = { x: viewBox.x, y: viewBox.y, w: viewBox.w, h: viewBox.h, zoom };
  }, [viewBox, zoom]);

  // Tool state
  const [activeTool, setActiveTool] = useState<Tool>("select");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [connectSourceId, setConnectSourceId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  // Drag state
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId?: string;
    edgeId?: string;
  } | null>(null);

  // Add node panel
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addNodeMode, setAddNodeMode] = useState<AddNodeMode>("host");
  const [hostPickerQuery, setHostPickerQuery] = useState("");
  const [addPanelPosition, setAddPanelPosition] = useState<{ x: number; y: number } | null>(null);
  const hostPickerInputRef = useRef<HTMLInputElement>(null);
  const [addNodeForm, setAddNodeForm] = useState({
    host_id: null as number | null,
    label: "",
    icon: "server",
    color: "#3b82f6",
  });

  // Edit node (icon picker)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);

  // Connect from context menu
  const [connectFromNodeId, setConnectFromNodeId] = useState<string | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  // --- Professional UX state ---
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(true);
  const [reachabilityFilter, setReachabilityFilter] = useState<ReachabilityFilter>("all");
  const [edgeDrafts, setEdgeDrafts] = useState<Record<string, Partial<EdgeDraft>>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Inline rename
  const [inlineEditId, setInlineEditId] = useState<string | null>(null);
  const [inlineEditLabel, setInlineEditLabel] = useState("");
  const inlineInputRef = useRef<HTMLInputElement>(null);

  // Session-local deletion history is scoped to the active map.
  const [undoStack, setUndoStack] = useState<DeletedMapItem[]>([]);
  const undoBusyRef = useRef(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const pendingDeletesRef = useRef(new Set<string>());

  // ─── Edge / Waypoint editing state ─────────────────────────────
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [dragWaypoint, setDragWaypoint] = useState<{
    edgeId: string;
    wpIndex: number;
  } | null>(null);
  const inspectorVisible = Boolean((selectedNodeId && !editingNodeId && !inlineEditId) || selectedEdgeId);

  // ─── API Functions ─────────────────────────────────────────────

  // --- Map sheets CRUD ---

  const fetchMaps = useCallback(async () => {
    try {
      const base = await getApiBase();
      const maps = await fetchJsonOrThrow<MapSheet[]>(
        `${base}/network-map/maps`,
        {},
        { retries: 1 },
      );
      setAllMaps(maps);
      if (!mapsLoaded) {
        setMapsLoaded(true);
      }
      return maps;
    } catch (e) {
      console.error("Failed to fetch maps:", e);
      addToast(mutationErrorMessage(e, "Failed to load maps"), "error");
    }
    return [];
  }, [addToast, mapsLoaded, setMapsLoaded]);

  const apiCreateMap = useCallback(async (name: string) => {
    try {
      const base = await getApiBase();
      const sheet = await fetchJsonOrThrow<MapSheet>(`${base}/network-map/maps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setAllMaps((prev) => [...prev, sheet]);
      setOpenMapIds((prev) => [...prev, sheet.id]);
      setActiveMapId(sheet.id);
      setNodes([]);
      setEdges([]);
      addToast(`Map "${name}" created`, "success");
      return sheet;
    } catch (e) {
      console.error("Failed to create map:", e);
      addToast(mutationErrorMessage(e, "Failed to create map"), "error");
      return undefined;
    }
  }, [addToast]);

  const apiRenameMap = useCallback(async (mapId: string, name: string) => {
    try {
      const base = await getApiBase();
      const updated = await fetchJsonOrThrow<MapSheet>(`${base}/network-map/maps/${mapId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setAllMaps((prev) => prev.map((m) => (m.id === mapId ? updated : m)));
      addToast(`Map renamed to "${name}"`, "success");
      return updated;
    } catch (e) {
      console.error("Failed to rename map:", e);
      addToast(mutationErrorMessage(e, "Failed to rename map"), "error");
      return undefined;
    }
  }, [addToast]);

  const apiDeleteMap = useCallback(async (mapId: string) => {
    try {
      const base = await getApiBase();
      await fetchJsonOrThrow<void>(`${base}/network-map/maps/${mapId}`, {
        method: "DELETE",
      });

      setAllMaps((prev) => prev.filter((m) => m.id !== mapId));
      setOpenMapIds((prev) => {
        const next = prev.filter((id) => id !== mapId);
        if (activeMapIdRef.current === mapId) {
          const newActive = next.length > 0 ? next[next.length - 1] : null;
          setActiveMapId(newActive);
          if (!newActive) {
            setNodes([]);
            setEdges([]);
          }
        }
        return next;
      });
      addToast("Map deleted", "success");
      return true;
    } catch (e) {
      console.error("Failed to delete map:", e);
      addToast(mutationErrorMessage(e, "Failed to delete map"), "error");
      return false;
    }
  }, [addToast]);

  const apiDuplicateMap = useCallback(async (mapId: string) => {
    try {
      const base = await getApiBase();
      const sheet = await fetchJsonOrThrow<MapSheet>(`${base}/network-map/maps/${mapId}/duplicate`, {
        method: "POST",
      });
      setAllMaps((prev) => [...prev, sheet]);
      setOpenMapIds((prev) => [...prev, sheet.id]);
      setActiveMapId(sheet.id);
      addToast(`Map duplicated as "${sheet.name}"`, "success");
      return sheet;
    } catch (e) {
      console.error("Failed to duplicate map:", e);
      addToast(mutationErrorMessage(e, "Failed to duplicate map"), "error");
      return undefined;
    }
  }, [addToast]);

  // --- Open map in new window ---

  const openMapInNewWindow = useCallback(async (mapId: string, mapName: string) => {
    try {
      const windowId = `map-${mapId.substring(0, 8)}-${Date.now()}`;

      // Capture current view state to pass to the new window
      const vb = viewBoxRef.current;
      const z = zoomRef.current;
      const viewParam = encodeURIComponent(JSON.stringify({ x: vb.x, y: vb.y, w: vb.w, h: vb.h, zoom: z }));
      const url = `/?detachedMap=true&mapId=${encodeURIComponent(mapId)}&mapName=${encodeURIComponent(mapName)}&viewState=${viewParam}`;

      const webview = new WebviewWindow(windowId, {
        url,
        title: `Map: ${mapName}`,
        width: 1200,
        height: 800,
        decorations: false,
        transparent: false,
        visible: false,
      });

      webview.once("tauri://created", () => {
        webview.show();
        webview.setFocus();
      });

      // Track this map as detached + save its view state
      addNetworkMapDetached(mapId);
      setNetworkMapViewState(mapId, { x: vb.x, y: vb.y, w: vb.w, h: vb.h, zoom: z });

      // Close the tab in the main window
      setOpenMapIds((prev) => {
        const next = prev.filter((id) => id !== mapId);
        if (activeMapId === mapId) {
          setActiveMapId(next.length > 0 ? next[next.length - 1] : null);
          if (next.length === 0) { setNodes([]); setEdges([]); }
        }
        return next;
      });

      addToast(`Map "${mapName}" opened in new window`, "success");
    } catch (err) {
      console.error("Failed to open map in new window:", err);
      addToast("Failed to open in new window", "error");
    }
  }, [activeMapId, addToast, addNetworkMapDetached, setOpenMapIds, setActiveMapId, setNetworkMapViewState]);

  // --- Ping status ---

  const fetchPingStatus = useCallback(async (mapId?: string) => {
    const id = mapId || activeMapId;
    if (!id) return;
    try {
      const base = await getApiBase();
      const data = await fetchJsonOrThrow<Record<string, { reachable: boolean; hostname: string }>>(`${base}/network-map/maps/${id}/ping`, {
        method: "POST",
      });
      if (activeMapIdRef.current !== id) return;
      const statusMap: Record<string, boolean | null> = {};
      for (const [nodeId, info] of Object.entries(data)) {
        statusMap[nodeId] = info.reachable;
      }
      pingErrorToastShownRef.current = false;
      setPingStatus(statusMap);
    } catch (e) {
      if (activeMapIdRef.current !== id) return;
      console.error("Failed to fetch ping status:", e);
      if (!pingErrorToastShownRef.current) {
        addToast(mutationErrorMessage(e, "Failed to refresh ping status"), "error");
        pingErrorToastShownRef.current = true;
      }
    }
  }, [activeMapId, addToast]);

  // --- Map data loading (scoped to activeMapId) ---

  const fetchMap = useCallback(async (mapId: string) => {
    const generation = ++mapLoadGenerationRef.current;
    mapLoadAbortRef.current?.abort();

    const controller = new AbortController();
    mapLoadAbortRef.current = controller;

    setLoading(true);
    setMapLoadError(null);
    setNodes([]);
    setEdges([]);

    try {
      const base = await getApiBase();
      const data = await fetchJsonOrThrow<{ nodes?: MapNode[]; edges?: MapEdge[] }>(`${base}/network-map/maps/${mapId}`, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        generation !== mapLoadGenerationRef.current ||
        activeMapIdRef.current !== mapId
      ) return;

      setNodes(data.nodes ?? []);
      setEdges(data.edges ?? []);
    } catch (e) {
      if (
        isAbortError(e) ||
        controller.signal.aborted ||
        generation !== mapLoadGenerationRef.current ||
        activeMapIdRef.current !== mapId
      ) return;

      const message = mutationErrorMessage(e, "Failed to load network map");
      console.error("Failed to fetch network map:", e);
      setNodes([]);
      setEdges([]);
      setMapLoadError(message);
      addToast(message, "error");
    } finally {
      if (
        generation === mapLoadGenerationRef.current &&
        activeMapIdRef.current === mapId
      ) {
        if (mapLoadAbortRef.current === controller) {
          mapLoadAbortRef.current = null;
        }
        setLoading(false);
      }
    }
  }, [addToast]);

  const autoPopulate = useCallback(async () => {
    if (!activeMapId) return;
    try {
      const base = await getApiBase();
      const data = await fetchJsonOrThrow<{ nodes?: MapNode[]; edges?: MapEdge[] }>(`${base}/network-map/maps/${activeMapId}/auto-populate`, {
        method: "POST",
      });
      if (activeMapIdRef.current !== activeMapId) return;
      setNodes(data.nodes ?? []);
      setEdges(data.edges ?? []);
      addToast("Map populated with hosts", "success");
    } catch (e) {
      console.error("Failed to auto-populate:", e);
      addToast(mutationErrorMessage(e, "Failed to populate map"), "error");
      if (activeMapIdRef.current === activeMapId) {
        await fetchMap(activeMapId);
      }
    }
  }, [activeMapId, addToast, fetchMap]);

  const createNode = useCallback(
    async (data: {
      host_id?: number | null;
      label?: string;
      icon?: string;
      color?: string;
      x?: number;
      y?: number;
    }) => {
      const mapId = activeMapIdRef.current;
      try {
        const base = await getApiBase();
        const node = await fetchJsonOrThrow<MapNode>(`${base}/network-map/nodes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            map_id: mapId,
            host_id: data.host_id || null,
            label: data.label || "New Node",
            icon: data.icon || "server",
            color: data.color || "#3b82f6",
            x: data.x ?? 400,
            y: data.y ?? 300,
            width: 180,
            height: 64,
          }),
        });
        if (activeMapIdRef.current !== mapId) return undefined;
        setNodes((prev) => [...prev, node]);
        return node;
      } catch (e) {
        console.error("Failed to create node:", e);
        addToast(mutationErrorMessage(e, "Failed to add node"), "error");
        return undefined;
      }
    },
    [addToast],
  );

  const updateNode = useCallback(async (nodeId: string, data: Partial<MapNode>, reconcileOnFailure = true) => {
    const mapId = activeMapIdRef.current;
    try {
      const base = await getApiBase();
      await fetchJsonOrThrow<MapNode>(`${base}/network-map/nodes/${nodeId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (activeMapIdRef.current !== mapId) return false;
      setNodes((previous) => previous.map((node) => node.id === nodeId ? { ...node, ...data } : node));
      return true;
    } catch (error) {
      addToast(mutationErrorMessage(error, "Failed to update device"), "error");
      if (reconcileOnFailure && mapId && activeMapIdRef.current === mapId) await fetchMap(mapId);
      return false;
    }
  }, [addToast, fetchMap]);

  const updateNodePosition = useCallback(
    async (nodeId: string, x: number, y: number) => {
      const mapId = activeMapIdRef.current;
      try {
        const base = await getApiBase();
        await fetchJsonOrThrow<unknown>(`${base}/network-map/nodes/${nodeId}/position`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ x, y }),
        });
        return true;
      } catch (e) {
        console.error("Failed to update position:", e);
        addToast(mutationErrorMessage(e, "Failed to update node position"), "error");
        if (mapId && activeMapIdRef.current === mapId) {
          await fetchMap(mapId);
        }
        return false;
      }
    },
    [addToast, fetchMap],
  );

  const deleteNode = useCallback(async (nodeId: string) => {
    const mapId = activeMapIdRef.current;
    if (!mapId || undoBusyRef.current || pendingDeletesRef.current.size) return false;
    const node = nodesRef.current.find((item) => item.id === nodeId);
    const connected = edgesRef.current.filter((edge) => edge.source_node_id === nodeId || edge.target_node_id === nodeId);
    pendingDeletesRef.current.add(nodeId);
    try {
      const base = await getApiBase();
      await fetchJsonOrThrow<void>(`${base}/network-map/nodes/${nodeId}`, { method: "DELETE" });
      if (activeMapIdRef.current !== mapId) return true;
      if (node) setUndoStack((previous) => [...previous.slice(-9), { id: `node-${nodeId}`, mapId, node, pendingEdges: connected }]);
      setNodes((previous) => previous.filter((item) => item.id !== nodeId));
      setEdges((previous) => previous.filter((edge) => edge.source_node_id !== nodeId && edge.target_node_id !== nodeId));
      setEdgeDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => !connected.some((edge) => edge.id === id))));
      setSelectedNodeId((current) => current === nodeId ? null : current);
      addToast("Device removed — Ctrl+Z restores it and its links", "info");
      return true;
    } catch (error) { addToast(mutationErrorMessage(error, "Failed to remove device"), "error"); return false; }
    finally { pendingDeletesRef.current.delete(nodeId); }
  }, [addToast]);

  const createEdge = useCallback(
    async (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      const exists = edges.some(
        (e) =>
          (e.source_node_id === sourceId && e.target_node_id === targetId) ||
          (e.source_node_id === targetId && e.target_node_id === sourceId),
      );
      if (exists) {
        addToast("Connection already exists", "info");
        return;
      }
      const mapId = activeMapIdRef.current;
      try {
        const base = await getApiBase();
        const edge = await fetchJsonOrThrow<MapEdge>(`${base}/network-map/edges`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_node_id: sourceId,
            target_node_id: targetId,
          }),
        });
        if (activeMapIdRef.current !== mapId) return undefined;
        setEdges((prev) => [...prev, edge]);
        addToast("Connection created", "success");
        return edge;
      } catch (e) {
        console.error("Failed to create edge:", e);
        addToast(mutationErrorMessage(e, "Failed to create connection"), "error");
        return undefined;
      }
    },
    [edges, addToast],
  );

  const deleteEdge = useCallback(async (edgeId: string) => {
    const mapId = activeMapIdRef.current;
    if (!mapId || undoBusyRef.current || pendingDeletesRef.current.size) return false;
    const edge = edgesRef.current.find((item) => item.id === edgeId);
    pendingDeletesRef.current.add(edgeId);
    try {
      const base = await getApiBase();
      await fetchJsonOrThrow<void>(`${base}/network-map/edges/${edgeId}`, { method: "DELETE" });
      if (activeMapIdRef.current !== mapId) return true;
      if (edge) setUndoStack((previous) => [...previous.slice(-9), { id: `edge-${edgeId}`, mapId, pendingEdges: [edge] }]);
      setEdges((previous) => previous.filter((item) => item.id !== edgeId));
      setEdgeDrafts((previous) => { const next = { ...previous }; delete next[edgeId]; return next; });
      setSelectedEdgeId((current) => current === edgeId ? null : current);
      addToast("Connection removed — Ctrl+Z to undo", "info");
      return true;
    } catch (error) { addToast(mutationErrorMessage(error, "Failed to remove connection"), "error"); return false; }
    finally { pendingDeletesRef.current.delete(edgeId); }
  }, [addToast]);

  // Save edge waypoints to backend
  const updateEdgeWaypoints = useCallback(
    async (edgeId: string, waypoints: WaypointXY[]) => {
      const mapId = activeMapIdRef.current;
      // The update API treats null as omitted; an empty array clears the route.
      const wpStr = JSON.stringify(waypoints);
      setEdges((prev) =>
        prev.map((e) => (e.id === edgeId ? { ...e, waypoints: wpStr } : e)),
      );
      try {
        const base = await getApiBase();
        await fetchJsonOrThrow<unknown>(`${base}/network-map/edges/${edgeId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ waypoints: wpStr }),
        });
        return true;
      } catch (err) {
        console.error("Failed to update edge waypoints:", err);
        addToast(mutationErrorMessage(err, "Failed to update connection path"), "error");
        if (mapId && activeMapIdRef.current === mapId) {
          await fetchMap(mapId);
        }
        return false;
      }
    },
    [addToast, fetchMap],
  );

  // Update edge properties (ports_count, label, etc.) on the backend
  const updateEdgeProps = useCallback(async (edgeId: string, props: Partial<MapEdge>) => {
    const mapId = activeMapIdRef.current;
    try {
      const base = await getApiBase();
      await fetchJsonOrThrow<MapEdge>(`${base}/network-map/edges/${edgeId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(props) });
      if (activeMapIdRef.current !== mapId) return false;
      setEdges((previous) => previous.map((edge) => edge.id === edgeId ? { ...edge, ...props } : edge));
      return true;
    } catch (error) { addToast(mutationErrorMessage(error, "Failed to save connection"), "error"); return false; }
  }, [addToast]);

  const undoLast = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last || last.mapId !== activeMapIdRef.current || undoBusyRef.current || pendingDeletesRef.current.size) return;
    undoBusyRef.current = true; setUndoBusy(true);
    const isCurrent = () => activeMapIdRef.current === last.mapId;
    try {
      const base = await getApiBase();
      const restored = await restoreDeletedItem(last, {
        isCurrent,
        createNode: (body) => fetchJsonOrThrow<MapNode>(`${base}/network-map/nodes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        createEdge: (body) => fetchJsonOrThrow<MapEdge>(`${base}/network-map/edges`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        onNode: (oldId, node) => { setNodes((previous) => [...previous, node]); setUndoStack((previous) => previous.map((item) => remapDeletedNode(item, oldId, node.id))); setSelectedNodeId(node.id); },
        onEdge: (edge) => setEdges((previous) => [...previous, edge]),
        checkpoint: (item) => setUndoStack((previous) => previous.map((entry) => entry.id === item.id ? item : entry)),
      });
      if (restored && isCurrent()) { setUndoStack((previous) => previous.filter((item) => item.id !== last.id)); addToast("Deletion undone, including connection properties", "success"); }
    } catch (error) { if (isCurrent()) addToast(mutationErrorMessage(error, "Restore incomplete. Use Undo again to retry remaining items."), "error"); }
    finally { undoBusyRef.current = false; setUndoBusy(false); }
  }, [undoStack, addToast]);

  // ─── Load on Mount ─────────────────────────────────────────────

  // 1. Fetch map list on mount (skip in detached mode)
  useEffect(() => {
    if (isDetachedMode) {
      // In detached mode, directly set the map as active
      setActiveMapId(detachedMapId!);
      setOpenMapIds([detachedMapId!]);
      setMapsLoaded(true);
      return;
    }
    fetchMaps();
  }, [fetchMaps, isDetachedMode, detachedMapId]);

  // 2. When activeMapId changes, save previous map's view state and restore new map's state
  useEffect(() => {
    // Save view state of the map we're leaving
    const prevId = prevActiveMapIdRef.current;
    if (prevId) {
      const vb = viewBoxRef.current;
      setNetworkMapViewState(prevId, { x: vb.x, y: vb.y, w: vb.w, h: vb.h, zoom: zoomRef.current });
    }
    prevActiveMapIdRef.current = activeMapId;
    setUndoStack([]);
    setEdgeDrafts({});
    setDragNodeId(null);
    setDragWaypoint(null);
    setIsPanning(false);
    setSpacePan(false);
    setEditingNodeId(null);
    setInlineEditId(null);
    setShowAddPanel(false);
    setContextMenu(null);
    setSearchQuery("");
    setReachabilityFilter("all");

    if (activeMapId) {
      void fetchMap(activeMapId);
      // Restore saved view state for this map (if any)
      const saved = useAppStore.getState().networkMapViewStates[activeMapId];
      if (saved) {
        setViewBox({ x: saved.x, y: saved.y, w: saved.w, h: saved.h });
      } else if (prevId) {
        // Only reset to defaults when switching from another map that had no saved state
        setViewBox({ x: 0, y: 0, w: 1600, h: 900 });
      }
      // Clear selection state on tab switch
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setConnectSourceId(null);
      setConnectFromNodeId(null);
      // Reset ping status for new map
      setPingStatus({});
      pingErrorToastShownRef.current = false;
    } else {
      mapLoadGenerationRef.current += 1;
      mapLoadAbortRef.current?.abort();
      mapLoadAbortRef.current = null;
      setLoading(false);
      setMapLoadError(null);
      setNodes([]);
      setEdges([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMapId, fetchMap, setNetworkMapViewState]);

  useEffect(() => {
    const element = canvasContainerRef.current;
    if (!element) return;
    let previous: DOMRect | undefined;
    const measure = () => {
      const next = element.getBoundingClientRect();
      if (next.width <= 0 || next.height <= 0) return;
      if (previous && next.width === previous.width && next.height === previous.height && next.left === previous.left && next.top === previous.top) return;
      const before = previous;
      previous = next;
      if (before) setViewBox((view) => resizeViewport(view, before, next, { x: next.left - before.left, y: next.top - before.top }));
      setCanvasSize({ width: next.width, height: next.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeMapId]);

  // 2b. Save view state on unmount (navigating away from map view)
  useEffect(() => {
    return () => {
      mapLoadGenerationRef.current += 1;
      mapLoadAbortRef.current?.abort();
      mapLoadAbortRef.current = null;
      const mapId = prevActiveMapIdRef.current;
      if (mapId) {
        const vb = viewBoxRef.current;
        useAppStore.getState().setNetworkMapViewState(mapId, { x: vb.x, y: vb.y, w: vb.w, h: vb.h, zoom: zoomRef.current });
      }
    };
  }, []);

  // 3. Ping polling: run immediately when map loads, then every 30s
  useEffect(() => {
    if (!activeMapId || !pingEnabled) {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
      return;
    }
    // Initial ping
    fetchPingStatus(activeMapId);
    // Poll every 30 seconds
    pingIntervalRef.current = setInterval(() => {
      fetchPingStatus(activeMapId);
    }, 30000);
    return () => {
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }
    };
  }, [activeMapId, pingEnabled, fetchPingStatus]);

  // 4. Listen for reattach-map events (detached map window returned to main)
  useEffect(() => {
    if (isDetachedMode) return;
    const handler = (e: Event) => {
      const { mapId, mapName } = (e as CustomEvent).detail;
      // Remove from detached tracking
      removeNetworkMapDetached(mapId);
      // Re-open the map tab
      setOpenMapIds((prev) => prev.includes(mapId) ? prev : [...prev, mapId]);
      setActiveMapId(mapId);
      // Refresh maps list
      fetchMaps();
    };
    window.addEventListener("netrix-reattach-map", handler);
    return () => window.removeEventListener("netrix-reattach-map", handler);
  }, [isDetachedMode, fetchMaps, removeNetworkMapDetached, setOpenMapIds, setActiveMapId]);

  // ─── SVG Coordinate Helpers ────────────────────────────────────

  const svgPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!svgRef.current) return { x: 0, y: 0 };
      const svg = svgRef.current;
      const pt = svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const svgPt = pt.matrixTransform(ctm.inverse());
      return { x: svgPt.x, y: svgPt.y };
    },
    [],
  );

  const snap = useCallback(
    (val: number): number => snapCoordinate(val, snapToGrid),
    [snapToGrid],
  );

  const openAddNodePanel = useCallback((position?: { x: number; y: number }, mode: AddNodeMode = "host") => {
    setAddPanelPosition(position || null);
    setAddNodeMode(mode);
    setHostPickerQuery("");
    setAddNodeForm({
      host_id: null,
      label: "",
      icon: "server",
      color: "#3b82f6",
    });
    setShowAddPanel(true);
    if (mode === "host") {
      setTimeout(() => hostPickerInputRef.current?.focus(), 50);
    }
  }, []);

  const closeAddNodePanel = useCallback(() => {
    setShowAddPanel(false);
    setAddPanelPosition(null);
    setHostPickerQuery("");
  }, []);

  // ─── Mouse Handlers ───────────────────────────────────────────

  const handleSvgMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && (e.altKey || spacePan || activeTool === "pan" || (e.ctrlKey && activeTool === "select")))) {
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
        e.preventDefault();
        return;
      }
      if (e.button === 0 && activeTool === "select") {
        if (
          (e.target as SVGElement).tagName === "svg" ||
          (e.target as SVGElement).classList.contains("map-bg")
        ) {
          setSelectedNodeId(null);
          setSelectedEdgeId(null);
          setContextMenu(null);
          if (connectFromNodeId) {
            setConnectFromNodeId(null);
            setMousePos(null);
          }
        }
      }
      if (e.button === 0 && activeTool === "add") {
        const pt = svgPoint(e.clientX, e.clientY);
        openAddNodePanel({
          x: snap(Math.round(pt.x - 90)),
          y: snap(Math.round(pt.y - 32)),
        });
        setActiveTool("select");
      }
    },
    [activeTool, spacePan, svgPoint, connectFromNodeId, snap, openAddNodePanel],
  );

  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (connectSourceId || connectFromNodeId) {
        const pt = svgPoint(e.clientX, e.clientY);
        setMousePos(pt);
      }
      if (isPanning) {
        // Use viewBox dimensions for consistent pan speed at all zoom levels
        const rect = svgRef.current?.getBoundingClientRect();
        const cw = rect?.width || 1600;
        const ch = rect?.height || 900;
        const scale = viewportScale(viewBox, { width: cw, height: ch });
        const dx = (e.clientX - panStart.x) / scale;
        const dy = (e.clientY - panStart.y) / scale;
        setViewBox((prev) => ({
          ...prev,
          x: prev.x - dx,
          y: prev.y - dy,
        }));
        setPanStart({ x: e.clientX, y: e.clientY });
        return;
      }
      if (dragNodeId) {
        const pt = svgPoint(e.clientX, e.clientY);
        setNodes((prev) =>
          prev.map((n) =>
            n.id === dragNodeId
              ? {
                  ...n,
                  x: snap(Math.round(pt.x - dragOffset.x)),
                  y: snap(Math.round(pt.y - dragOffset.y)),
                }
              : n,
          ),
        );
      }
      // Waypoint drag
      if (dragWaypoint) {
        const pt = svgPoint(e.clientX, e.clientY);
        setEdges((prev) =>
          prev.map((edge) => {
            if (edge.id !== dragWaypoint.edgeId) return edge;
            const wps = parseWaypoints(edge.waypoints);
            if (dragWaypoint.wpIndex < 0 || dragWaypoint.wpIndex >= wps.length) return edge;
            wps[dragWaypoint.wpIndex] = { x: snap(Math.round(pt.x)), y: snap(Math.round(pt.y)) };
            return { ...edge, waypoints: JSON.stringify(wps) };
          }),
        );
      }
    },
    [
      isPanning,
      panStart,
      viewBox,
      dragNodeId,
      dragOffset,
      svgPoint,
      connectSourceId,
      connectFromNodeId,
      snap,
      dragWaypoint,
    ],
  );

  const handleSvgMouseUp = useCallback(() => {
    if (isPanning) {
      setIsPanning(false);
      return;
    }
    if (dragNodeId) {
      const node = nodes.find((n) => n.id === dragNodeId);
      if (node && dragOriginRef.current && (node.x !== dragOriginRef.current.x || node.y !== dragOriginRef.current.y)) {
        void updateNodePosition(dragNodeId, node.x, node.y);
      }
      dragOriginRef.current = null;
      setDragNodeId(null);
    }
    if (dragWaypoint) {
      const edge = edges.find((e) => e.id === dragWaypoint.edgeId);
      if (edge) {
        updateEdgeWaypoints(dragWaypoint.edgeId, parseWaypoints(edge.waypoints));
      }
      setDragWaypoint(null);
    }
  }, [isPanning, dragNodeId, nodes, updateNodePosition, dragWaypoint, edges, updateEdgeWaypoints]);

  useEffect(() => {
    if (!isPanning && !dragNodeId && !dragWaypoint) return;
    window.addEventListener("mouseup", handleSvgMouseUp);
    window.addEventListener("blur", handleSvgMouseUp);
    return () => { window.removeEventListener("mouseup", handleSvgMouseUp); window.removeEventListener("blur", handleSvgMouseUp); };
  }, [isPanning, dragNodeId, dragWaypoint, handleSvgMouseUp]);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const point = svgPoint(e.clientX, e.clientY);
      setViewBox((previous) => zoomViewport(previous, canvasSize, e.deltaY > 0 ? 1 / 1.12 : 1.12, point));
    } else {
      setViewBox((previous) => {
        const scale = viewportScale(previous, canvasSize);
        return { ...previous, x: previous.x + e.deltaX / scale, y: previous.y + e.deltaY / scale };
      });
    }
  }, [canvasSize, svgPoint]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [activeMapId, handleWheel]);

  // ─── Node Interaction ─────────────────────────────────────────

  const handleNodeMouseDown = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      if (e.button === 1 || (e.button === 0 && (spacePan || activeTool === "pan" || e.altKey || e.ctrlKey))) {
        handleSvgMouseDown(e); e.stopPropagation(); return;
      }
      e.stopPropagation();
      if (e.button !== 0) return;

      if (connectFromNodeId) {
        createEdge(connectFromNodeId, nodeId);
        setConnectFromNodeId(null);
        setMousePos(null);
        return;
      }

      if (activeTool === "connect") {
        if (!connectSourceId) {
          setConnectSourceId(nodeId);
          addToast("Click another node to connect", "info");
        } else {
          createEdge(connectSourceId, nodeId);
          setConnectSourceId(null);
        }
        return;
      }

      if (e.button === 0) {
        setSelectedNodeId(nodeId);
        setSelectedEdgeId(null);
        if ((containerRef.current?.clientWidth ?? 1200) <= 1100) setShowSearch(false);
        const pt = svgPoint(e.clientX, e.clientY);
        const node = nodes.find((n) => n.id === nodeId);
        if (node) {
          dragOriginRef.current = { x: node.x, y: node.y };
          setDragOffset({ x: pt.x - node.x, y: pt.y - node.y });
          setDragNodeId(nodeId);
        }
      }
    },
    [
      activeTool,
      spacePan,
      handleSvgMouseDown,
      connectSourceId,
      connectFromNodeId,
      svgPoint,
      nodes,
      createEdge,
      addToast,
    ],
  );

  const handleNodeDoubleClick = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.stopPropagation();
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      setInlineEditId(nodeId);
      setInlineEditLabel(node.label || node.host_name || "");
      setTimeout(() => inlineInputRef.current?.focus(), 50);
    },
    [nodes],
  );

  const commitInlineEdit = useCallback(() => {
    if (inlineEditId && inlineEditLabel.trim()) {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === inlineEditId ? { ...n, label: inlineEditLabel.trim() } : n,
        ),
      );
      updateNode(inlineEditId, { label: inlineEditLabel.trim() });
    }
    setInlineEditId(null);
    setInlineEditLabel("");
  }, [inlineEditId, inlineEditLabel, updateNode]);

  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, nodeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setSelectedNodeId(nodeId);
      setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
    },
    [],
  );

  const handleEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edgeId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, edgeId });
    },
    [],
  );

  // ─── Zoom Controls ────────────────────────────────────────────

  const zoomIn = useCallback(() => setViewBox((previous) => zoomViewport(previous, canvasSize, 1.25)), [canvasSize]);
  const zoomOut = useCallback(() => setViewBox((previous) => zoomViewport(previous, canvasSize, 0.8)), [canvasSize]);
  const fitToView = useCallback(() => {
    const coveredWidth = inspectorVisible && (containerRef.current?.clientWidth ?? 1200) <= 1100 ? 316 : 0;
    if (nodes.length) setViewBox(fitBounds(topologyBounds(nodes, edges), canvasSize, canvasSize.width - coveredWidth));
  }, [nodes, edges, canvasSize, inspectorVisible]);

  // ─── Context Menu Actions ─────────────────────────────────────

  const openFilesForNode = useCallback(async (nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    const host = node?.host_id ? hosts.find((h) => h.id === node.host_id) : null;
    if (!host) {
      addToast("Host not found", "error");
      return;
    }
    if (host.connection_type !== "ssh") {
      addToast("Files are available only for SSH hosts", "info");
      return;
    }
    await openSftpForHost(host);
    setActiveView("files");
  }, [addToast, hosts, nodes, openSftpForHost, setActiveView]);

  const handleContextAction = useCallback(
    async (action: string) => {
      if (!contextMenu) return;
      if (action === "delete-node" && contextMenu.nodeId) {
        deleteNode(contextMenu.nodeId);
      } else if (action === "delete-edge" && contextMenu.edgeId) {
        deleteEdge(contextMenu.edgeId);
      } else if (action === "change-icon" && contextMenu.nodeId) {
        setEditingNodeId(contextMenu.nodeId);
        const node = nodes.find((n) => n.id === contextMenu.nodeId);
      } else if (action === "connect-from" && contextMenu.nodeId) {
        setConnectFromNodeId(contextMenu.nodeId);
        addToast("Click a node to create connection", "info");
      } else if (action === "disconnect-all" && contextMenu.nodeId) {
        const nodeEdges = edges.filter(
          (e) =>
            e.source_node_id === contextMenu.nodeId ||
            e.target_node_id === contextMenu.nodeId,
        );
        for (const edge of nodeEdges) await deleteEdge(edge.id);
      } else if (action === "rename" && contextMenu.nodeId) {
        const node = nodes.find((n) => n.id === contextMenu.nodeId);
        if (node) {
          setInlineEditId(contextMenu.nodeId);
          setInlineEditLabel(node.label || node.host_name || "");
          setTimeout(() => inlineInputRef.current?.focus(), 50);
        }
      } else if (action === "files" && contextMenu.nodeId) {
        openFilesForNode(contextMenu.nodeId);
      }
      setContextMenu(null);
    },
    [contextMenu, deleteNode, deleteEdge, nodes, edges, addToast, openFilesForNode],
  );

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      window.addEventListener("click", handleClick);
      return () => window.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  // ─── Computed Data ────────────────────────────────────────────

  const getNodeCenter = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return { x: 0, y: 0 };
      return nodeCenter(node);
    },
    [nodes],
  );

  const availableHosts = useMemo(() => {
    const mappedHostIds = new Set(
      nodes.filter((n) => n.host_id).map((n) => n.host_id),
    );
    return hosts.filter((h) => !mappedHostIds.has(h.id));
  }, [hosts, nodes]);

  const mappedHostNodeById = useMemo(() => {
    const mapped = new Map<number, MapNode>();
    nodes.forEach((node) => {
      if (node.host_id) mapped.set(node.host_id, node);
    });
    return mapped;
  }, [nodes]);

  const hostPickerResults = useMemo(() => {
    const query = hostPickerQuery.trim().toLowerCase();
    return hosts
      .filter((host) => !query || hostSearchText(host).includes(query))
      .sort((a, b) => {
        const aMapped = mappedHostNodeById.has(a.id) ? 1 : 0;
        const bMapped = mappedHostNodeById.has(b.id) ? 1 : 0;
        if (aMapped !== bMapped) return aMapped - bMapped;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 80);
  }, [hosts, hostPickerQuery, mappedHostNodeById]);

  const getAddNodePosition = useCallback(() => ({
    x: snap(Math.round(addPanelPosition?.x ?? viewBox.x + viewBox.w / 2 - 90)),
    y: snap(Math.round(addPanelPosition?.y ?? viewBox.y + viewBox.h / 2 - 32)),
  }), [addPanelPosition, snap, viewBox.h, viewBox.w, viewBox.x, viewBox.y]);

  const focusNode = useCallback((node: MapNode) => {
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    setConnectSourceId(null);
    setConnectFromNodeId(null);
    setActiveTool("select");
    const center = nodeCenter(node);
    const compact = (containerRef.current?.clientWidth ?? 1200) <= 1100;
    const coveredWidth = compact ? 316 : inspectorVisible ? 0 : 300;
    setViewBox(fitBounds({ x: center.x - 320, y: center.y - 220, w: 640, h: 440 }, canvasSize, canvasSize.width - coveredWidth));
    if (compact) setShowSearch(false);
  }, [canvasSize, inspectorVisible]);

  const addHostNodeToMap = useCallback(async (host: Host) => {
    const existingNode = mappedHostNodeById.get(host.id);
    if (existingNode) {
      setShowAddPanel(false);
      focusNode(existingNode);
      addToast(`${host.name} is already on this map`, "info");
      return;
    }

    const position = getAddNodePosition();
    const node = await createNode({
      host_id: host.id,
      label: host.name,
      icon: iconForHost(host),
      color: colorForHost(host),
      x: position.x,
      y: position.y,
    });
    if (node) {
      setShowAddPanel(false);
      setAddPanelPosition(null);
      focusNode(node);
      addToast(`${host.name} added to map`, "success");
    }
  }, [addToast, createNode, focusNode, getAddNodePosition, mappedHostNodeById]);

  const addCustomNodeToMap = useCallback(async () => {
    const position = getAddNodePosition();
    const node = await createNode({
      label: addNodeForm.label.trim() || "New Node",
      icon: addNodeForm.icon,
      color: addNodeForm.color,
      x: position.x,
      y: position.y,
    });
    if (node) {
      setShowAddPanel(false);
      setAddPanelPosition(null);
      setAddNodeForm({ host_id: null, label: "", icon: "server", color: "#3b82f6" });
      focusNode(node);
    }
  }, [addNodeForm.color, addNodeForm.icon, addNodeForm.label, createNode, focusNode, getAddNodePosition]);

  useEffect(() => {
    if (!networkMapFocusRequest || networkMapFocusRequest.mapId !== activeMapId) return;
    const node = networkMapFocusRequest.nodeId
      ? nodes.find((item) => item.id === networkMapFocusRequest.nodeId)
      : networkMapFocusRequest.hostId
        ? nodes.find((item) => item.host_id === networkMapFocusRequest.hostId)
        : null;
    if (!node) return;
    focusNode(node);
    clearNetworkMapFocusRequest(networkMapFocusRequest.id);
  }, [activeMapId, clearNetworkMapFocusRequest, focusNode, networkMapFocusRequest, nodes]);

  const explorerNodes = useMemo(() => findMapNodes(nodes, searchQuery, reachabilityFilter, pingStatus, pingEnabled), [nodes, searchQuery, reachabilityFilter, pingStatus, pingEnabled]);
  const isFiltering = Boolean(searchQuery.trim() || reachabilityFilter !== "all");
  const searchMatches = useMemo(() => new Set(isFiltering ? explorerNodes.map((node) => node.id) : []), [isFiltering, explorerNodes]);
  const minimapBounds = useMemo(() => topologyBounds(nodes, edges), [nodes, edges]);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);
  const selectEdge = useCallback((edge: MapEdge) => { setSelectedNodeId(null); setSelectedEdgeId(edge.id); if ((containerRef.current?.clientWidth ?? 1200) <= 1100) setShowSearch(false); }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!activeMapId || loading || mapLoadError || showAddPanel || editingNodeId || deleteMapId || showMapSwitcher || target?.closest("input, select, textarea, [contenteditable=true], [role=dialog], [role=menu]")) return;
      const modified = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modified && key === "f") { event.preventDefault(); if (event.shiftKey) fitToView(); else { setShowSearch(true); setTimeout(() => searchInputRef.current?.focus(), 0); } return; }
      if (modified && key === "z" && !event.shiftKey) { event.preventDefault(); if (!event.repeat) void undoLast(); return; }
      if (modified || event.altKey) return;
      if (key === " " && !target?.closest("button, a")) { event.preventDefault(); setSpacePan(true); return; }
      if (event.repeat) return;
      if (key === "v" || key === "h" || key === "c" || key === "a") { setActiveTool(({ v: "select", h: "pan", c: "connect", a: "add" } as const)[key]); setConnectSourceId(null); setConnectFromNodeId(null); }
      if (key === "g") setSnapToGrid((previous) => !previous);
      if (key === "m") setShowMinimap((previous) => !previous);
      if (key === "delete" || key === "backspace") { event.preventDefault(); if (selectedNodeId) void deleteNode(selectedNodeId); else if (selectedEdgeId) void deleteEdge(selectedEdgeId); }
      if (key === "escape") { setSelectedNodeId(null); setSelectedEdgeId(null); setConnectSourceId(null); setConnectFromNodeId(null); setMousePos(null); setActiveTool("select"); setContextMenu(null); setSearchQuery(""); setReachabilityFilter("all"); }
    };
    const releasePan = () => setSpacePan(false);
    const keyUp = (event: KeyboardEvent) => { if (event.key === " ") releasePan(); };
    window.addEventListener("keydown", handleKeyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", releasePan);
    return () => { window.removeEventListener("keydown", handleKeyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", releasePan); };
  }, [activeMapId, loading, mapLoadError, showAddPanel, editingNodeId, deleteMapId, showMapSwitcher, selectedNodeId, selectedEdgeId, fitToView, undoLast, deleteNode, deleteEdge]);

  // ─── Render ───────────────────────────────────────────────────

  if (loading && !mapsLoaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-3 text-foreground-muted">
          <LuRefreshCw className="animate-spin" size={20} />
          <span>Loading Network Map…</span>
        </div>
      </div>
    );
  }

  // Helper: current map info
  const currentMap = allMaps.find((m) => m.id === activeMapId);

  return (
    <div
      ref={containerRef}
      className="netmap-workspace h-full min-h-0 flex flex-col overflow-hidden relative"
    >
      {/* ─── Map Tabs Bar ────────────────────────────────────── */}
      {!isDetachedMode && (<>
      <div className="netmap-tabs flex items-center shrink-0 select-none z-30">
        <span className="netmap-wordmark"><LuNetwork size={18} />NetMap</span>
        <div className="flex items-center flex-1 min-w-0 overflow-x-auto scrollbar-none">
          {openMapIds.map((mapId) => {
            const sheet = allMaps.find((m) => m.id === mapId);
            if (!sheet) return null;
            const isActive = activeMapId === mapId;
            return (
              <div
                key={mapId}
                role="button"
                tabIndex={0}
                aria-label={`Open map ${sheet.name}`}
                aria-current={isActive ? "page" : undefined}
                onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setActiveMapId(mapId); } }}
                className={`group flex items-center gap-1 px-3 py-1.5 text-[11px] cursor-pointer border-r border-white/[0.04] min-w-0 max-w-[180px] transition-all ${
                  isActive
                    ? "bg-background-dark/80 text-white border-b-2 border-b-primary"
                    : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
                }`}
                onClick={() => {
                  setActiveMapId(mapId);
                }}
                onDoubleClick={() => {
                  setRenameMapId(mapId);
                  setRenameValue(sheet.name);
                  setTimeout(() => renameInputRef.current?.select(), 50);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setRenameMapId(mapId);
                  setRenameValue(sheet.name);
                  setTimeout(() => renameInputRef.current?.select(), 50);
                }}
              >
                <LuMap size={11} className={isActive ? "text-primary shrink-0" : "text-gray-600 shrink-0"} />
                {renameMapId === mapId ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => {
                      if (renameValue.trim() && renameValue.trim() !== sheet.name) {
                        apiRenameMap(mapId, renameValue.trim());
                      }
                      setRenameMapId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === "Escape") {
                        setRenameMapId(null);
                      }
                    }}
                    className="w-full bg-transparent border-none outline-none text-white text-[11px] font-medium px-0"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="truncate font-medium">{sheet.name}</span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openMapInNewWindow(mapId, sheet.name);
                  }}
                  className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded hover:bg-white/[0.1] text-gray-500 hover:text-blue-400 transition-all shrink-0"
                  title="Open in new window"
                >
                  <LuExternalLink size={10} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    // Close tab (don't delete the map)
                    setOpenMapIds((prev) => {
                      const next = prev.filter((id) => id !== mapId);
                      if (activeMapId === mapId) {
                        setActiveMapId(next.length > 0 ? next[next.length - 1] : null);
                        if (next.length === 0) { setNodes([]); setEdges([]); }
                      }
                      return next;
                    });
                  }}
                  className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded hover:bg-white/[0.1] text-gray-500 hover:text-gray-200 transition-all shrink-0"
                  title="Close tab"
                >
                  <LuX size={10} />
                </button>
              </div>
            );
          })}
        </div>

        {/* New map / map list buttons */}
        <div className="flex items-center gap-0.5 px-1.5 shrink-0">
          <button
            onClick={() => setShowMapSwitcher((v) => !v)}
            className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-white/[0.06] transition-colors"
            title="All Maps" aria-label="All maps"
          >
            <LuLayoutGrid size={16} />
          </button>
          <button
            onClick={() => {
              const name = `Map ${allMaps.length + 1}`;
              apiCreateMap(name);
            }}
            className="p-1.5 rounded-md text-gray-500 hover:text-white hover:bg-white/[0.06] transition-colors"
            title="New Map" aria-label="New map"
          >
            <LuPlus size={16} />
          </button>
        </div>
      </div>

      {/* ─── Map Switcher Dropdown ──────────────────────────── */}
      {showMapSwitcher && (
        <div className="absolute top-[34px] right-2 z-50 w-72 bg-[#111826]/98 backdrop-blur-xl border border-white/[0.1] rounded-xl shadow-2xl animate-fade-in overflow-hidden">
          <div className="px-3 pt-3 pb-2 border-b border-white/[0.06]">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-white font-semibold text-[12px]">All Maps</h3>
              <button onClick={() => setShowMapSwitcher(false)} className="p-0.5 text-gray-500 hover:text-white rounded hover:bg-white/[0.08]">
                <LuX size={12} />
              </button>
            </div>
            <div className="flex gap-1">
              <input
                value={newMapName}
                onChange={(e) => setNewMapName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && newMapName.trim()) {
                    const created = await apiCreateMap(newMapName.trim());
                    if (created) setNewMapName("");
                  }
                }}
                placeholder="New map name…"
                className="flex-1 px-2 py-1 bg-white/[0.04] border border-white/[0.08] rounded-md text-white text-[11px] focus:outline-none focus:border-primary placeholder:text-gray-700"
              />
              <button
                onClick={async () => {
                  if (newMapName.trim()) {
                    const created = await apiCreateMap(newMapName.trim());
                    if (created) setNewMapName("");
                  }
                }}
                className="px-2 py-1 bg-primary/20 text-primary text-[10px] font-semibold rounded-md hover:bg-primary/30 transition-colors"
              >
                Create
              </button>
            </div>
          </div>
          <div className="max-h-[40vh] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10">
            {allMaps.map((sheet) => {
              const isOpen = openMapIds.includes(sheet.id);
              const isActive = activeMapId === sheet.id;
              return (
                <div
                  key={sheet.id}
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer group transition-colors ${
                    isActive ? "bg-primary/10" : "hover:bg-white/[0.04]"
                  }`}
                  onClick={() => {
                    if (!isOpen) setOpenMapIds((prev) => [...prev, sheet.id]);
                    setActiveMapId(sheet.id);
                    setShowMapSwitcher(false);
                  }}
                >
                  <LuMap size={13} className={isActive ? "text-primary shrink-0" : "text-gray-600 shrink-0"} />
                  <div className="flex-1 min-w-0">
                    <div className={`text-[11px] font-medium truncate ${isActive ? "text-white" : "text-gray-300"}`}>{sheet.name}</div>
                    <div className="text-[9px] text-gray-600">{sheet.node_count} node{sheet.node_count !== 1 ? "s" : ""} · {sheet.edge_count} connection{sheet.edge_count !== 1 ? "s" : ""}</div>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); openMapInNewWindow(sheet.id, sheet.name); setShowMapSwitcher(false); }}
                      className="p-1 rounded hover:bg-white/[0.08] text-gray-500 hover:text-blue-400" title="Open in new window"
                    >
                      <LuExternalLink size={11} />
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const duplicated = await apiDuplicateMap(sheet.id);
                        if (duplicated) setShowMapSwitcher(false);
                      }}
                      className="p-1 rounded hover:bg-white/[0.08] text-gray-500 hover:text-gray-200" title="Duplicate"
                    >
                      <LuCopy size={11} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameMapId(sheet.id);
                        setRenameValue(sheet.name);
                        setShowMapSwitcher(false);
                        setTimeout(() => renameInputRef.current?.select(), 50);
                      }}
                      className="p-1 rounded hover:bg-white/[0.08] text-gray-500 hover:text-gray-200" title="Rename"
                    >
                      <LuPencil size={11} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setDeleteMapId(sheet.id); setShowMapSwitcher(false); }}
                      className="p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400" title="Delete"
                    >
                      <LuTrash2 size={11} />
                    </button>
                  </div>
                  {isOpen && <div className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" title="Open" />}
                </div>
              );
            })}
            {allMaps.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px] text-gray-600">No maps yet. Create one above.</div>
            )}
          </div>
        </div>
      )}

      {/* ─── Delete Map Confirmation Modal ───────────────────── */}
      {deleteMapId && (() => {
        const mapToDelete = allMaps.find((m) => m.id === deleteMapId);
        if (!mapToDelete) return null;
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="ui-dialog w-[380px] max-w-[calc(100vw-32px)]">
              <div className="px-5 pt-5 pb-3">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                    <LuTrash2 size={20} className="text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-white font-semibold text-[14px]">Delete Map</h3>
                    <p className="text-gray-500 text-[11px]">This action cannot be undone</p>
                  </div>
                </div>
                <div className="bg-red-500/5 border border-red-500/10 rounded-lg p-3 mb-3">
                  <p className="text-[12px] text-gray-300 mb-1">
                    Are you sure you want to delete <span className="text-white font-semibold">"{mapToDelete.name}"</span>?
                  </p>
                  <p className="text-[11px] text-gray-500">
                    This will permanently remove:
                  </p>
                  <ul className="text-[11px] text-gray-500 mt-1 space-y-0.5">
                    <li className="flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-red-400/60" />
                      <span><span className="text-red-400 font-semibold">{mapToDelete.node_count}</span> node{mapToDelete.node_count !== 1 ? "s" : ""} and their positions</span>
                    </li>
                    <li className="flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-red-400/60" />
                      <span><span className="text-red-400 font-semibold">{mapToDelete.edge_count}</span> connection{mapToDelete.edge_count !== 1 ? "s" : ""} and their configurations</span>
                    </li>
                    <li className="flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-red-400/60" />
                      <span>All waypoints, labels, and connection properties</span>
                    </li>
                  </ul>
                </div>
              </div>
              <div className="flex gap-2 px-5 pb-5">
                <button
                  onClick={() => setDeleteMapId(null)}
                  className="flex-1 px-4 py-2 text-[12px] font-medium rounded-lg bg-white/[0.06] text-gray-300 hover:bg-white/[0.1] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    const deleted = await apiDeleteMap(deleteMapId);
                    if (deleted) setDeleteMapId(null);
                  }}
                  className="flex-1 px-4 py-2 text-[12px] font-semibold rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                >
                  Delete Map
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Close the !isDetachedMode wrapper above */}
      </>)}

      {/* ─── No Active Map State ──────────────────────────── */}
      {!activeMapId && !loading && !isDetachedMode && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <LuMap size={40} className="mx-auto text-gray-700 mb-3" />
            <h3 className="text-gray-400 text-[14px] font-medium mb-1">No Map Open</h3>
            <p className="text-gray-600 text-[11px] mb-4">Open a map from the list or create a new one</p>
            <div className="flex gap-2 justify-center">
              <button
                onClick={() => setShowMapSwitcher(true)}
                className="px-3 py-1.5 text-[11px] font-medium rounded-lg bg-white/[0.06] text-gray-300 hover:bg-white/[0.1] transition-colors"
              >
                Browse Maps
              </button>
              <button
                onClick={() => apiCreateMap(`Map ${allMaps.length + 1}`)}
                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
              >
                <span className="flex items-center gap-1"><LuPlus size={12} /> New Map</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {activeMapId && (<>
      <MapToolbar tool={activeTool} explorerOpen={showSearch} snap={snapToGrid} minimap={showMinimap} disabled={loading || Boolean(mapLoadError)} canUndo={undoStack.length > 0} undoBusy={undoBusy}
        onTool={(tool) => { setActiveTool(tool); setConnectSourceId(null); setConnectFromNodeId(null); setMousePos(null); }}
        onExplorer={() => { setShowSearch((open) => !open); if (!showSearch) setTimeout(() => searchInputRef.current?.focus(), 0); }}
        onSnap={() => setSnapToGrid((value) => !value)} onMinimap={() => setShowMinimap((value) => !value)} onAdd={() => openAddNodePanel(undefined, "host")}
        onPopulate={() => void autoPopulate()} onRefresh={() => { if (activeMapId) void fetchMap(activeMapId); }} onUndo={() => void undoLast()} />

      {(activeTool === "connect" || activeTool === "add" || connectFromNodeId) && <div className="netmap-mode-hint" role="status"><LuLink size={14} /><span>{activeTool === "add" ? "Click the canvas to place a device" : connectSourceId || connectFromNodeId ? "Select the destination device to create a link" : "Select the first device, then its destination"}</span><button className="netmap-icon-button" aria-label="Cancel map tool" onClick={() => { setActiveTool("select"); setConnectSourceId(null); setConnectFromNodeId(null); setMousePos(null); }}><LuX size={14} /></button></div>}

      {/* ─── Canvas Area (absolute fill — prevents vertical stretch) ─── */}
      <div className="netmap-stage">
        {showSearch && <MapExplorer nodes={explorerNodes} total={nodes.length} query={searchQuery} filter={reachabilityFilter} selectedId={selectedNodeId} ping={pingStatus} pingEnabled={pingEnabled} inputRef={searchInputRef} onQuery={setSearchQuery} onFilter={setReachabilityFilter} onFocus={focusNode} onClose={() => setShowSearch(false)} />}
        <div className="netmap-canvas" ref={canvasContainerRef}>
        {loading && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#080c14]/70 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 text-[12px] text-gray-400">
              <LuRefreshCw className="animate-spin" size={16} />
              Loading map…
            </div>
          </div>
        )}
        {!loading && mapLoadError && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#080c14]/80">
            <div className="max-w-md rounded-xl border border-red-500/20 bg-[#111826] px-5 py-4 text-center shadow-2xl">
              <p className="mb-3 text-[12px] text-red-300">{mapLoadError}</p>
              <button
                onClick={() => {
                  if (activeMapId) void fetchMap(activeMapId);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-[11px] font-medium text-gray-300 transition-colors hover:bg-white/[0.1] hover:text-white"
              >
                <LuRefreshCw size={12} /> Retry
              </button>
            </div>
          </div>
        )}
        <svg
          ref={svgRef}
          aria-label="Network topology canvas"
          className={`absolute inset-0 w-full h-full ${
            isPanning
              ? "cursor-grabbing"
              : activeTool === "pan" || spacePan
                ? "cursor-grab"
                : connectFromNodeId
                ? "cursor-crosshair"
                : activeTool === "add"
                  ? "cursor-crosshair"
                  : activeTool === "connect"
                    ? "cursor-pointer"
                    : "cursor-default"
          }`}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          preserveAspectRatio="xMidYMid meet"
          onMouseDown={handleSvgMouseDown}
          onMouseMove={handleSvgMouseMove}
          style={{ background: "#0b1118" }}
        >
          <defs>
            <pattern
              id="grid-small"
              width="20"
              height="20"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 20 0 L 0 0 0 20"
                fill="none"
                stroke="rgba(255,255,255,0.025)"
                strokeWidth="0.5"
              />
            </pattern>
            <pattern
              id="grid-large"
              width="100"
              height="100"
              patternUnits="userSpaceOnUse"
            >
              <rect width="100" height="100" fill="url(#grid-small)" />
              <path
                d="M 100 0 L 0 0 0 100"
                fill="none"
                stroke="rgba(255,255,255,0.05)"
                strokeWidth="0.5"
              />
            </pattern>
            <filter
              id="glow-blue"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter
              id="glow-green"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter
              id="glow-search"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter
              id="glow-ping-up"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter
              id="glow-ping-down"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter
              id="node-shadow"
              x="-50%"
              y="-50%"
              width="200%"
              height="200%"
            >
              <feDropShadow
                dx="0"
                dy="6"
                stdDeviation="6"
                floodColor="#02050a"
                floodOpacity="0.65"
              />
            </filter>
          </defs>

          {/* Background grid */}
          <rect
            className="map-bg"
            x={viewBox.x - 2000}
            y={viewBox.y - 2000}
            width={viewBox.w + 4000}
            height={viewBox.h + 4000}
            fill="url(#grid-large)"
          />

          {/* ─── Edges (straight lines, rounded corners) ──────── */}
          {edges.map((edge) => {
            const src = getNodeCenter(edge.source_node_id);
            const tgt = getNodeCenter(edge.target_node_id);
            const wps = parseWaypoints(edge.waypoints);
            const d = edgePath(src.x, src.y, tgt.x, tgt.y, wps);

            // Connection type visual overrides
            const ct = CONNECTION_TYPES[edge.connection_type] ?? CONNECTION_TYPES.ethernet;
            const typeColor = ct.color;

            const dashArray = edge.style === "dashed" ? "10 5" : edge.style === "dotted" ? "3 3" : undefined;
            const isHighlighted =
              isFiltering &&
              (searchMatches.has(edge.source_node_id) ||
                searchMatches.has(edge.target_node_id));
            const isEdgeSelected = selectedEdgeId === edge.id;

            // The edge color: selected → blue, highlighted → yellow, else type color (or custom)
            const edgeDisplayColor = isEdgeSelected
              ? "#3b82f6"
              : isHighlighted
                ? "#fbbf24"
                : edge.color || typeColor;

            // Compute midpoints between consecutive segments for "add waypoint" handles
            const allPts: WaypointXY[] = [{ x: src.x, y: src.y }, ...wps, { x: tgt.x, y: tgt.y }];
            const midpoints: WaypointXY[] = [];
            for (let i = 0; i < allPts.length - 1; i++) {
              midpoints.push({
                x: (allPts[i].x + allPts[i + 1].x) / 2,
                y: (allPts[i].y + allPts[i + 1].y) / 2,
              });
            }

            return (
              <g key={edge.id}>
                {/* Hit area for clicks */}
                <path
                  d={d}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select connection ${edge.label || `${nodeLabel(nodes.find((n) => n.id === edge.source_node_id))} to ${nodeLabel(nodes.find((n) => n.id === edge.target_node_id))}`}`}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); selectEdge(edge); } }}
                  stroke="transparent"
                  strokeWidth={14}
                  fill="none"
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectEdge(edge);
                  }}
                  onContextMenu={(e) =>
                    handleEdgeContextMenu(e, edge.id)
                  }
                />
                {/* Visible edge */}
                <path
                  d={d}
                  stroke={edgeDisplayColor}
                  strokeWidth={isEdgeSelected ? edge.stroke_width + 1 : edge.stroke_width}
                  strokeDasharray={dashArray}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  opacity={
                    isFiltering
                      ? isHighlighted
                        ? 0.9
                        : 0.2
                      : isEdgeSelected
                        ? 0.9
                        : 0.7
                  }
                  style={{
                    pointerEvents: "none",
                    transition: "opacity 0.2s",
                  }}
                />
                {edge.label && (
                  <text
                    x={(src.x + tgt.x) / 2}
                    y={(src.y + tgt.y) / 2 - 18}
                    textAnchor="middle"
                    fill="#9ca3af"
                    fontSize="10"
                    fontFamily="Inter, sans-serif"
                  >
                    {edge.label}
                  </text>
                )}

                {/* Connection type + port count badge */}
                {(() => {
                  // Find the midpoint of the edge for badge placement
                  const midX = wps.length > 0
                    ? (wps.length % 2 === 1
                      ? wps[Math.floor(wps.length / 2)].x
                      : (allPts[Math.floor(allPts.length / 2) - 1].x + allPts[Math.floor(allPts.length / 2)].x) / 2)
                    : (src.x + tgt.x) / 2;
                  const midY = wps.length > 0
                    ? (wps.length % 2 === 1
                      ? wps[Math.floor(wps.length / 2)].y
                      : (allPts[Math.floor(allPts.length / 2) - 1].y + allPts[Math.floor(allPts.length / 2)].y) / 2)
                    : (src.y + tgt.y) / 2;
                  const badgeY = edge.label ? midY + 2 : midY - 6;
                  const portText = `${ct.icon} · ${edge.ports_count || 1}p`;
                  const textW = portText.length * 5.5 + 14;
                  return (
                    <g>
                      <rect
                        x={midX - textW / 2}
                        y={badgeY - 8}
                        width={textW}
                        height={16}
                        rx={8}
                        fill={isEdgeSelected ? "#1e293b" : "#0f172a"}
                        stroke={isEdgeSelected ? (typeColor + "80") : "#ffffff15"}
                        strokeWidth={0.5}
                      />
                      <text
                        x={midX}
                        y={badgeY + 4}
                        textAnchor="middle"
                        fill={isEdgeSelected ? typeColor : "#6b7280"}
                        fontSize="8"
                        fontWeight="600"
                        fontFamily="JetBrains Mono, monospace"
                        style={{ pointerEvents: "none" }}
                      >
                        {portText}
                      </text>
                    </g>
                  );
                })()}

                {/* ─── Waypoint handles (when edge is selected) ─── */}
                {isEdgeSelected && (
                  <>
                    {/* Existing waypoint drag handles */}
                    {wps.map((wp, idx) => (
                      <g key={`wp-${idx}`}>
                        {/* Outer ring */}
                        <circle
                          cx={wp.x}
                          cy={wp.y}
                          r={7}
                          fill="#0f172a"
                          stroke="#3b82f6"
                          strokeWidth={1.5}
                          style={{ cursor: "grab" }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setDragWaypoint({ edgeId: edge.id, wpIndex: idx });
                          }}
                        />
                        {/* Inner dot */}
                        <circle
                          cx={wp.x}
                          cy={wp.y}
                          r={3}
                          fill="#3b82f6"
                          style={{ pointerEvents: "none" }}
                        />
                        {/* Delete waypoint on double-click */}
                        <circle
                          cx={wp.x}
                          cy={wp.y}
                          r={7}
                          fill="transparent"
                          style={{ cursor: "grab" }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            const newWps = wps.filter((_, i) => i !== idx);
                            updateEdgeWaypoints(edge.id, newWps);
                          }}
                        />
                      </g>
                    ))}
                    {/* Add-waypoint midpoint handles (shown as smaller dim circles) */}
                    {midpoints.map((mp, idx) => (
                      <circle
                        key={`mp-${idx}`}
                        cx={mp.x}
                        cy={mp.y}
                        r={5}
                        fill="#1e293b"
                        stroke="#3b82f680"
                        strokeWidth={1}
                        opacity={0.6}
                        style={{ cursor: "crosshair" }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          // Insert a new waypoint at this midpoint position
                          const newWps = [...wps];
                          newWps.splice(idx, 0, { x: Math.round(mp.x), y: Math.round(mp.y) });
                          const wpStr = JSON.stringify(newWps);
                          setEdges((prev) =>
                            prev.map((ed) => (ed.id === edge.id ? { ...ed, waypoints: wpStr } : ed)),
                          );
                          // Immediately start dragging the new waypoint
                          setDragWaypoint({ edgeId: edge.id, wpIndex: idx });
                        }}
                      />
                    ))}
                  </>
                )}
              </g>
            );
          })}

          {/* ─── Live connect line (curved) ──────────────────── */}
          {activeTool === "connect" &&
            connectSourceId &&
            mousePos && (
              <path
                d={edgePath(
                  getNodeCenter(connectSourceId).x,
                  getNodeCenter(connectSourceId).y,
                  hoveredNodeId && hoveredNodeId !== connectSourceId
                    ? getNodeCenter(hoveredNodeId).x
                    : mousePos.x,
                  hoveredNodeId && hoveredNodeId !== connectSourceId
                    ? getNodeCenter(hoveredNodeId).y
                    : mousePos.y,
                )}
                stroke={
                  hoveredNodeId && hoveredNodeId !== connectSourceId
                    ? "#10b981"
                    : "#10b98160"
                }
                strokeWidth={2}
                strokeDasharray="8 4"
                fill="none"
                opacity={0.8}
                style={{ pointerEvents: "none" }}
              />
            )}
          {connectFromNodeId &&
            !connectSourceId &&
            mousePos && (
              <path
                d={edgePath(
                  getNodeCenter(connectFromNodeId).x,
                  getNodeCenter(connectFromNodeId).y,
                  hoveredNodeId &&
                    hoveredNodeId !== connectFromNodeId
                    ? getNodeCenter(hoveredNodeId).x
                    : mousePos.x,
                  hoveredNodeId &&
                    hoveredNodeId !== connectFromNodeId
                    ? getNodeCenter(hoveredNodeId).y
                    : mousePos.y,
                )}
                stroke={
                  hoveredNodeId &&
                  hoveredNodeId !== connectFromNodeId
                    ? "#10b981"
                    : "#10b98160"
                }
                strokeWidth={2}
                strokeDasharray="8 4"
                fill="none"
                opacity={0.8}
                style={{ pointerEvents: "none" }}
              />
            )}

          {/* ─── Nodes ───────────────────────────────────────── */}
          {nodes.map((node) => {
            const w = Math.max(node.width || 0, 180);
            const h = Math.max(node.height || 0, 64);
            const isSelected = selectedNodeId === node.id;
            const isConnectSource = connectSourceId === node.id;
            const isHovered = hoveredNodeId === node.id;
            const isSearchMatch = searchMatches.has(node.id);
            const iconData = ICON_MAP[node.icon] || ICON_MAP.generic;
            const dimmed = isFiltering && !isSearchMatch;
            // Ping status: true=up, false=down, null/undefined=unknown
            const nodePingStatus = node.host_id ? pingStatus[node.id] : undefined;

            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`Select device ${nodeLabel(node)}`}
                aria-pressed={isSelected}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); focusNode(node); } }}
                transform={`translate(${node.x}, ${node.y})`}
                onMouseDown={(e) =>
                  handleNodeMouseDown(e, node.id)
                }
                onDoubleClick={(e) =>
                  handleNodeDoubleClick(e, node.id)
                }
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId(null)}
                onContextMenu={(e) =>
                  handleNodeContextMenu(e, node.id)
                }
                style={{
                  cursor:
                    activeTool === "connect" || connectFromNodeId
                      ? "pointer"
                      : "grab",
                  opacity: dimmed ? 0.2 : 1,
                  transition: "opacity 0.2s",
                }}
              >
                {/* Search highlight glow */}
                {isSearchMatch && isFiltering && (
                  <rect
                    x={-6}
                    y={-6}
                    width={w + 12}
                    height={h + 12}
                    rx={16}
                    fill="none"
                    stroke="#fbbf24"
                    strokeWidth={2}
                    opacity={0.7}
                    filter="url(#glow-search)"
                  />
                )}

                {/* Selection / Connect glow */}
                {(isSelected || isConnectSource) &&
                  !(isFiltering && isSearchMatch) && (
                    <rect
                      x={-4}
                      y={-4}
                      width={w + 8}
                      height={h + 8}
                      rx={14}
                      fill="none"
                      stroke={
                        isConnectSource ? "#10b981" : "#3b82f6"
                      }
                      strokeWidth={1.5}
                      opacity={0.6}
                      filter={
                        isConnectSource
                          ? "url(#glow-green)"
                          : "url(#glow-blue)"
                      }
                    />
                  )}

                {/* Card Background — clean panel */}
                <rect
                  x={0}
                  y={0}
                  width={w}
                  height={h}
                  rx={10}
                  fill={isHovered ? "#172432" : "#101c28"}
                  stroke={isSelected ? "#7dd3fc" : `${node.color}65`}
                  strokeWidth={isSelected ? 1.6 : 1}
                  filter={isHovered || isSelected ? "url(#node-shadow)" : undefined}
                  style={{ transition: "fill 0.15s, stroke 0.3s" }}
                />

                {/* Icon */}
                {(() => {
                  const iconColor = node.color;
                  return (
                    <>
                      <circle
                        cx={22}
                        cy={h / 2}
                        r={14}
                        fill={iconColor + "18"}
                        stroke={iconColor + "45"}
                        strokeWidth={1}
                        style={{ transition: "fill 0.5s, stroke 0.5s" }}
                      />
                      <foreignObject
                        x={12}
                        y={h / 2 - 12}
                        width={20}
                        height={24}
                        style={{ pointerEvents: "none" }}
                      >
                        <div
                          style={{
                            width: "100%",
                            height: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: iconColor,
                            transition: "color 0.5s",
                          }}
                        >
                          {iconData.icon}
                        </div>
                      </foreignObject>
                    </>
                  );
                })()}

                {/* Label */}
                {inlineEditId === node.id ? (
                  <foreignObject
                    x={44}
                    y={10}
                    width={w - 56}
                    height={h - 20}
                  >
                    <input
                      ref={inlineInputRef}
                      value={inlineEditLabel}
                      onChange={(e) =>
                        setInlineEditLabel(e.target.value)
                      }
                      onBlur={commitInlineEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitInlineEdit();
                        if (e.key === "Escape") {
                          setInlineEditId(null);
                          setInlineEditLabel("");
                        }
                      }}
                      className="w-full bg-white/10 border border-primary/40 rounded px-2 py-1 text-white text-[12px] font-semibold focus:outline-none focus:border-primary"
                      style={{ fontFamily: "Space Grotesk, system-ui, sans-serif" }}
                    />
                  </foreignObject>
                ) : (
                  <foreignObject
                    x={44}
                    y={10}
                    width={w - 56}
                    height={h - 20}
                    style={{ pointerEvents: "none" }}
                  >
                    <div style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "2px",
                      width: "100%",
                      height: "100%",
                      fontFamily: "Space Grotesk, system-ui, sans-serif",
                    }}>
                      <div style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "#e5e7eb",
                        lineHeight: "14px",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}>
                        {node.label || node.host_name || "Node"}
                      </div>
                      <div style={{
                        fontSize: "10px",
                        color: "#94a3b8",
                        lineHeight: "12px",
                        fontFamily: "JetBrains Mono, Menlo, Monaco, Courier New, monospace",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}>
                        {node.host_hostname || iconData.label}
                      </div>
                    </div>
                  </foreignObject>
                )}

                {/* Ping status indicator dot */}
                {pingEnabled && node.host_id && nodePingStatus !== undefined && (
                  <g>
                    <circle
                      cx={w - 12}
                      cy={12}
                      r={6}
                      fill={nodePingStatus === null ? "#4b556320" : nodePingStatus ? "#10b98120" : "#ef444420"}
                      stroke={nodePingStatus === null ? "#4b556340" : nodePingStatus ? "#10b98140" : "#ef444440"}
                      strokeWidth={1}
                    />
                    <circle
                      cx={w - 12}
                      cy={12}
                      r={3}
                      fill={nodePingStatus === null ? "#6b7280" : nodePingStatus ? "#10b981" : "#ef4444"}
                      style={{ transition: "fill 0.5s" }}
                    >
                      {nodePingStatus === null && (
                        <animate
                          attributeName="opacity"
                          values="0.3;1;0.3"
                          dur="1.5s"
                          repeatCount="indefinite"
                        />
                      )}
                    </circle>
                    {nodePingStatus === true && (
                      <circle
                        cx={w - 12}
                        cy={12}
                        r={3}
                        fill="none"
                        stroke="#10b981"
                        strokeWidth={1}
                        opacity={0.6}
                      >
                        <animate
                          attributeName="r"
                          values="3;7;3"
                          dur="2s"
                          repeatCount="indefinite"
                        />
                        <animate
                          attributeName="opacity"
                          values="0.6;0;0.6"
                          dur="2s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    )}
                  </g>
                )}


                {/* Connection ports */}
                {(activeTool === "connect" || connectFromNodeId) &&
                  !isConnectSource &&
                  node.id !== connectFromNodeId && (
                    <>
                      <circle
                        cx={0}
                        cy={h / 2}
                        r={4}
                        fill="#10b981"
                        opacity={isHovered ? 0.9 : 0.25}
                        style={{ transition: "opacity 0.15s" }}
                      />
                      <circle
                        cx={w}
                        cy={h / 2}
                        r={4}
                        fill="#10b981"
                        opacity={isHovered ? 0.9 : 0.25}
                        style={{ transition: "opacity 0.15s" }}
                      />
                      <circle
                        cx={w / 2}
                        cy={0}
                        r={4}
                        fill="#10b981"
                        opacity={isHovered ? 0.9 : 0.25}
                        style={{ transition: "opacity 0.15s" }}
                      />
                      <circle
                        cx={w / 2}
                        cy={h}
                        r={4}
                        fill="#10b981"
                        opacity={isHovered ? 0.9 : 0.25}
                        style={{ transition: "opacity 0.15s" }}
                      />
                    </>
                  )}
                {(isConnectSource ||
                  node.id === connectFromNodeId) && (
                  <>
                    <circle
                      cx={w}
                      cy={h / 2}
                      r={5}
                      fill="#10b981"
                      opacity={0.8}
                    >
                      <animate
                        attributeName="r"
                        values="4;6;4"
                        dur="1.5s"
                        repeatCount="indefinite"
                      />
                    </circle>
                    <circle
                      cx={0}
                      cy={h / 2}
                      r={5}
                      fill="#10b981"
                      opacity={0.8}
                    >
                      <animate
                        attributeName="r"
                        values="4;6;4"
                        dur="1.5s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  </>
                )}

                {/* Hover tooltip — rich host info */}
                {isHovered &&
                  !isSelected &&
                  activeTool === "select" &&
                  !dragNodeId &&
                  !connectFromNodeId && (
                  <foreignObject
                    x={w + 10}
                    y={-8}
                    width={200}
                    height={180}
                    style={{ pointerEvents: "none", overflow: "visible" }}
                  >
                    <div
                      style={{
                        background: "#0c1220",
                        border: "1px solid #1e293b",
                        borderRadius: 8,
                        padding: "8px 10px",
                        fontFamily: "Space Grotesk, system-ui, sans-serif",
                        width: "fit-content",
                        minWidth: 130,
                        maxWidth: 190,
                        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                      }}
                    >
                      {/* Name */}
                      <div style={{ color: "#e2e8f0", fontSize: 11, fontWeight: 600, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {node.label || node.host_name || "Node"}
                      </div>
                      {/* Hostname + port */}
                      {node.host_hostname && (
                        <div style={{ color: "#64748b", fontSize: 9, marginBottom: 2, whiteSpace: "nowrap" }}>
                          {node.host_hostname}{node.host_port && node.host_port !== 22 ? `:${node.host_port}` : ""}
                        </div>
                      )}
                      {/* Username */}
                      {node.host_username && (
                        <div style={{ color: "#475569", fontSize: 9, marginBottom: 2 }}>
                          user: {node.host_username}
                        </div>
                      )}
                      {/* Group */}
                      {node.host_group && (
                        <div style={{ color: "#475569", fontSize: 9, marginBottom: 2 }}>
                          {node.host_group}
                        </div>
                      )}
                      {/* Connection type */}
                      {node.host_connection_type && (
                        <div style={{ marginTop: 3, marginBottom: 2 }}>
                          <span style={{
                            display: "inline-block",
                            fontSize: 8,
                            fontWeight: 600,
                            padding: "1px 5px",
                            borderRadius: 3,
                            background: node.host_connection_type === "ssh" ? "#10b98118" : node.host_connection_type === "telnet" ? "#f59e0b18" : "#6b728018",
                            color: node.host_connection_type === "ssh" ? "#10b981" : node.host_connection_type === "telnet" ? "#f59e0b" : "#6b7280",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                            fontFamily: "Space Grotesk, system-ui, sans-serif",
                          }}>
                            {node.host_connection_type}
                          </span>
                          {!node.host_hostname && (
                            <span style={{ color: "#475569", fontSize: 8, marginLeft: 4 }}>{iconData.label}</span>
                          )}
                        </div>
                      )}
                      {/* Device type if no connection info */}
                      {!node.host_connection_type && !node.host_hostname && (
                        <div style={{ color: "#475569", fontSize: 9 }}>{iconData.label}</div>
                      )}
                      {/* Ping status */}
                      {pingEnabled && node.host_id && nodePingStatus !== undefined && (
                        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4, paddingTop: 4, borderTop: "1px solid #1e293b" }}>
                          <div style={{
                            width: 6, height: 6, borderRadius: "50%",
                            background: nodePingStatus === null ? "#6b7280" : nodePingStatus ? "#10b981" : "#ef4444",
                          }} />
                          <span style={{
                            fontSize: 9, fontWeight: 600,
                            color: nodePingStatus === null ? "#6b7280" : nodePingStatus ? "#10b981" : "#ef4444",
                          }}>
                            {nodePingStatus === null ? "Not checked" : nodePingStatus ? "Responds to ping" : "No ping response"}
                          </span>
                        </div>
                      )}
                    </div>
                  </foreignObject>
                )}
              </g>
            );
          })}

        </svg>

        {!loading && !mapLoadError && nodes.length === 0 && <div className="netmap-canvas-empty"><LuNetwork size={36} /><h2>Build your network map</h2><p>Add saved hosts or custom devices, then link them to describe your topology.</p><button className="netmap-button netmap-primary" onClick={() => openAddNodePanel()}><LuPlus size={15} />Add first device</button></div>}
        <div className="netmap-zoom-controls" aria-label="Map zoom"><button className="netmap-icon-button" aria-label="Zoom out" onClick={zoomOut} disabled={zoom <= 0.10001}><LuZoomOut size={16} /></button><button className="netmap-zoom-reset" aria-label="Reset zoom to 100 percent" title="Reset zoom to 100%" onClick={() => setViewBox((previous) => zoomViewport(previous, canvasSize, 1 / viewportScale(previous, canvasSize)))}>{Math.round(zoom * 100)}%</button><button className="netmap-icon-button" aria-label="Zoom in" onClick={zoomIn} disabled={zoom >= 4.999}><LuZoomIn size={16} /></button><button className="netmap-button" onClick={fitToView} disabled={!nodes.length} title="Fit map (Ctrl+Shift+F)"><LuMaximize2 size={14} />Fit</button></div>

        {/* ─── Minimap ─────────────────────────────────────────── */}
        {showMinimap && nodes.length > 0 && (
          <div className="netmap-minimap absolute bottom-3 left-3 z-20 select-none">
            <div className="w-[160px] h-[100px] bg-[#0a0e17]/90 backdrop-blur-sm border border-white/[0.08] rounded-lg overflow-hidden shadow-lg">
              <svg
                width="160"
                height="100"
                viewBox={`${minimapBounds.x} ${minimapBounds.y} ${minimapBounds.w} ${minimapBounds.h}`}
                preserveAspectRatio="xMidYMid meet"
                className="cursor-pointer"
                onClick={(e) => {
                  const rect =
                    e.currentTarget.getBoundingClientRect();
                  const point = pointInViewport(minimapBounds, { width: rect.width, height: rect.height }, { x: e.clientX - rect.left, y: e.clientY - rect.top });
                  setViewBox((previous) => ({ ...previous, x: point.x - previous.w / 2, y: point.y - previous.h / 2 }));
                }}
              >
                {edges.map((edge) => {
                  const src = getNodeCenter(edge.source_node_id);
                  const tgt = getNodeCenter(edge.target_node_id);
                  const mct = CONNECTION_TYPES[edge.connection_type] ?? CONNECTION_TYPES.ethernet;
                  return (
                    <line
                      key={edge.id}
                      x1={src.x}
                      y1={src.y}
                      x2={tgt.x}
                      y2={tgt.y}
                      stroke={mct.color}
                      strokeWidth={Math.max(
                        (minimapBounds.w / 160) * 1.5,
                        2,
                      )}
                      opacity={0.5}
                    />
                  );
                })}
                {nodes.map((node) => (
                  <rect
                    key={node.id}
                    x={node.x}
                    y={node.y}
                    width={Math.max(node.width || 0, 180)}
                    height={Math.max(node.height || 0, 64)}
                    rx={4}
                    fill={
                      node.id === selectedNodeId
                        ? "#3b82f6"
                        : node.color
                    }
                    opacity={0.7}
                  />
                ))}
                <rect
                  x={viewBox.x}
                  y={viewBox.y}
                  width={viewBox.w}
                  height={viewBox.h}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={Math.max(
                    (minimapBounds.w / 160) * 2,
                    3,
                  )}
                  opacity={0.5}
                  rx={2}
                />
              </svg>
            </div>
          </div>
        )}
      </div>

      {selectedNode && !editingNodeId && !inlineEditId && <NodeInspector node={selectedNode} nodes={nodes} edges={edges} icon={(ICON_MAP[selectedNode.icon] || ICON_MAP.generic).icon} typeLabel={(ICON_MAP[selectedNode.icon] || ICON_MAP.generic).label} ping={pingStatus} pingEnabled={pingEnabled} canOpenFiles={hosts.some((host) => host.id === selectedNode.host_id && host.connection_type === "ssh")}
        onClose={() => setSelectedNodeId(null)} onFocus={focusNode} onEdge={selectEdge} onFiles={() => void openFilesForNode(selectedNode.id)}
        onTerminal={() => { const host = hosts.find((item) => item.id === selectedNode.host_id); if (host) { addTerminalTab(host); setActiveView("terminal"); } else addToast("Host not found", "error"); }}
        onLink={() => { setConnectFromNodeId(selectedNode.id); setConnectSourceId(null); setActiveTool("select"); }} onEdit={() => setEditingNodeId(selectedNode.id)} onDelete={() => void deleteNode(selectedNode.id)} />}
      {selectedEdge && !selectedNode && <EdgeInspector key={`${activeMapId}:${selectedEdge.id}`} edge={selectedEdge} source={nodes.find((node) => node.id === selectedEdge.source_node_id)} target={nodes.find((node) => node.id === selectedEdge.target_node_id)} draft={{ ...edgeDraft(selectedEdge), ...edgeDrafts[selectedEdge.id] }}
        onDraft={(draft) => setEdgeDrafts((previous) => { const next = { ...previous }; if (draft) { const patch = edgePatch(selectedEdge, draft); if (Object.keys(patch).length) next[selectedEdge.id] = patch; else delete next[selectedEdge.id]; } else delete next[selectedEdge.id]; return next; })}
        onSave={async (patch) => {
          const saved = await updateEdgeProps(selectedEdge.id, patch);
          if (saved) setEdgeDrafts((previous) => { const next = { ...previous }; const pending = next[selectedEdge.id]; if (pending && Object.entries(pending).every(([key, value]) => patch[key as keyof MapEdge] === value)) delete next[selectedEdge.id]; return next; });
          return saved;
        }} onClose={() => setSelectedEdgeId(null)} onFocus={focusNode} onDelete={() => void deleteEdge(selectedEdge.id)} />}
      </div>

      {/* ─── Context Menu ────────────────────────────────────── */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[180px] bg-[#131a27] border border-white/[0.08] rounded-xl shadow-2xl py-1 animate-fade-in"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.nodeId && (
            <>
              {(() => {
                const node = nodes.find((n) => n.id === contextMenu.nodeId);
                const host = node?.host_id ? hosts.find((h) => h.id === node.host_id) : null;
                if (!host || host.connection_type !== "ssh") return null;
                return (
                  <button
                    onClick={() => handleContextAction("files")}
                    className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-sky-400 hover:bg-sky-500/10 transition-colors"
                  >
                    <LuFolderOpen size={13} /> Open Files
                  </button>
                );
              })()}
              <button
                onClick={() => handleContextAction("connect-from")}
                className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              >
                <LuLink size={13} /> Connect to…
              </button>
              {edges.some(
                (e) =>
                  e.source_node_id === contextMenu.nodeId ||
                  e.target_node_id === contextMenu.nodeId,
              ) && (
                <button
                  onClick={() =>
                    handleContextAction("disconnect-all")
                  }
                  className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-amber-400 hover:bg-amber-500/10 transition-colors"
                >
                  <LuUnlink size={13} /> Disconnect All
                </button>
              )}
              <div className="h-px bg-white/[0.04] my-0.5" />
              <button
                onClick={() => handleContextAction("rename")}
                className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-gray-300 hover:bg-white/[0.06] hover:text-white transition-colors"
              >
                <LuPencil size={13} /> Rename
              </button>
              <button
                onClick={() => handleContextAction("change-icon")}
                className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-gray-300 hover:bg-white/[0.06] hover:text-white transition-colors"
              >
                <LuServer size={13} /> Change Icon
              </button>
              <div className="h-px bg-white/[0.04] my-0.5" />
              <button
                onClick={() => handleContextAction("delete-node")}
                className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LuTrash2 size={13} /> Remove Node
              </button>
            </>
          )}
          {contextMenu.edgeId && (
            <>
              {/* Port count inline editor */}
              {(() => {
                const edge = edges.find((e) => e.id === contextMenu.edgeId);
                if (!edge) return null;
                return (
                  <div className="px-3.5 py-2 flex items-center gap-2">
                    <span className="text-[11px] text-gray-400">Ports:</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          const newCount = Math.max(1, (edge.ports_count || 1) - 1);
                          updateEdgeProps(edge.id, { ports_count: newCount });
                        }}
                        className="w-5 h-5 flex items-center justify-center rounded bg-white/[0.06] text-gray-400 hover:text-white hover:bg-white/[0.12] text-[11px] font-bold transition-colors"
                      >
                        −
                      </button>
                      <span className="text-[12px] text-white font-semibold w-6 text-center tabular-nums">{edge.ports_count || 1}</span>
                      <button
                        onClick={() => {
                          const newCount = Math.min(999, (edge.ports_count || 1) + 1);
                          updateEdgeProps(edge.id, { ports_count: newCount });
                        }}
                        className="w-5 h-5 flex items-center justify-center rounded bg-white/[0.06] text-gray-400 hover:text-white hover:bg-white/[0.12] text-[11px] font-bold transition-colors"
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })()}
              <div className="h-px bg-white/[0.04] my-0.5" />
              <button
                onClick={() => {
                  setSelectedEdgeId(contextMenu.edgeId!);
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-blue-400 hover:bg-blue-500/10 transition-colors"
              >
                <LuPencil size={13} /> Edit Waypoints
              </button>
              {(() => {
                const edge = edges.find((e) => e.id === contextMenu.edgeId);
                const wps = edge ? parseWaypoints(edge.waypoints) : [];
                return wps.length > 0 ? (
                  <button
                    onClick={() => {
                      updateEdgeWaypoints(contextMenu.edgeId!, []);
                      setContextMenu(null);
                    }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-amber-400 hover:bg-amber-500/10 transition-colors"
                  >
                    <LuUndo2 size={13} /> Reset Line
                  </button>
                ) : null;
              })()}
              <div className="h-px bg-white/[0.04] my-0.5" />
              <button
                onClick={() => handleContextAction("delete-edge")}
                className="w-full flex items-center gap-2.5 px-3.5 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LuUnlink size={13} /> Remove Connection
              </button>
            </>
          )}
        </div>
      )}

      {editingNodeId && nodes.some((node) => node.id === editingNodeId) && <NodeAppearanceDialog key={editingNodeId} node={nodes.find((node) => node.id === editingNodeId)!} icons={ICON_MAP} colors={NODE_COLORS} onClose={() => setEditingNodeId(null)} onSave={(patch) => updateNode(editingNodeId, patch, false)} />}

      {/* ─── Add Node Modal ──────────────────────────────────── */}
      {showAddPanel && (
        <Dialog open onClose={closeAddNodePanel} className="netmap-add-dialog fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <DialogPanel className="ui-dialog p-5 w-[560px] max-w-full animate-fade-in max-h-[84vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div>
                <DialogTitle className="text-white font-bold text-sm">Add device</DialogTitle>
                <p className="text-[10px] text-gray-600 mt-0.5">
                  {addPanelPosition ? "Place at selected position" : "Place in current view"}
                </p>
              </div>
              <button
                onClick={closeAddNodePanel}
                aria-label="Close add device"
                className="p-1 text-gray-500 hover:text-white rounded-lg hover:bg-white/[0.08] transition-colors"
              >
                <LuX size={14} />
              </button>
            </div>

            <div className="flex bg-white/[0.04] rounded-lg p-0.5 mb-3">
              <button
                onClick={() => {
                  setAddNodeMode("host");
                  setTimeout(() => hostPickerInputRef.current?.focus(), 50);
                }}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${
                  addNodeMode === "host"
                    ? "bg-primary text-white"
                    : "text-gray-500 hover:text-gray-200 hover:bg-white/[0.06]"
                }`}
              >
                <LuServer size={13} /> Hosts
              </button>
              <button
                onClick={() => setAddNodeMode("custom")}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${
                  addNodeMode === "custom"
                    ? "bg-primary text-white"
                    : "text-gray-500 hover:text-gray-200 hover:bg-white/[0.06]"
                }`}
              >
                <LuPlus size={13} /> Custom
              </button>
            </div>

            {addNodeMode === "host" ? (
              <div className="min-h-0 flex-1 flex flex-col">
                <div className="relative mb-2">
                  <LuSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
                  <input
                    ref={hostPickerInputRef}
                    aria-label="Search saved hosts"
                    value={hostPickerQuery}
                    onChange={(e) => setHostPickerQuery(e.target.value)}
                    placeholder="Search hosts..."
                    className="w-full px-3 py-2 pl-9 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-[12px] focus:outline-none focus:border-primary placeholder:text-gray-600"
                  />
                </div>
                <div className="flex items-center justify-between mb-2 text-[10px] text-gray-600">
                  <span>{availableHosts.length} available</span>
                  <span>{hosts.length - availableHosts.length} already on map</span>
                </div>
                <div className="min-h-[220px] max-h-[46vh] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10 space-y-1">
                  {hostPickerResults.map((host) => {
                    const mappedNode = mappedHostNodeById.get(host.id);
                    const iconKey = iconForHost(host);
                    const iconData = ICON_MAP[iconKey] || ICON_MAP.generic;
                    const color = colorForHost(host);
                    return (
                      <button
                        key={host.id}
                        onClick={() => addHostNodeToMap(host)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-all ${
                          mappedNode
                            ? "bg-white/[0.025] border-white/[0.04] hover:border-amber-400/25 hover:bg-amber-400/[0.04]"
                            : "bg-white/[0.035] border-white/[0.07] hover:border-primary/35 hover:bg-primary/[0.06]"
                        }`}
                      >
                        <span
                          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border"
                          style={{ color, backgroundColor: `${color}14`, borderColor: `${color}35` }}
                        >
                          {iconData.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-semibold text-white truncate">{host.name}</span>
                          <span className="block text-[10px] text-gray-500 font-mono truncate">
                            {host.username ? `${host.username}@` : ""}{host.hostname}{host.port && host.port !== 22 ? `:${host.port}` : ""}
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {host.group && <span className="max-w-[110px] truncate text-[9px] text-gray-600">{host.group}</span>}
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${
                            host.connection_type === "ssh"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : host.connection_type === "telnet"
                                ? "bg-amber-500/10 text-amber-400"
                                : "bg-violet-500/10 text-violet-400"
                          }`}
                          >
                            {host.connection_type}
                          </span>
                          {mappedNode ? (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/10 text-amber-300">Focus</span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-primary/10 text-primary">Add</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                  {hostPickerResults.length === 0 && (
                    <div className="h-[220px] flex flex-col items-center justify-center text-center text-gray-600">
                      <LuSearch size={28} className="mb-2 text-gray-700" />
                      <p className="text-[12px] text-gray-500">No hosts found</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
                <div className="mb-3">
                  <label htmlFor="netmap-custom-name" className="text-[10px] text-gray-500 mb-1 block uppercase tracking-wider">Device name</label>
                  <input
                    id="netmap-custom-name"
                    type="text"
                    maxLength={256}
                    value={addNodeForm.label}
                    onChange={(e) => setAddNodeForm({ ...addNodeForm, label: e.target.value })}
                    placeholder="Node name"
                    className="w-full px-3 py-1.5 bg-white/[0.04] border border-white/[0.08] rounded-lg text-white text-[12px] focus:outline-none focus:border-primary placeholder:text-gray-600"
                  />
                </div>

                <div className="mb-3">
                  <label className="text-[10px] text-gray-500 mb-1 block uppercase tracking-wider">Icon</label>
                  <div className="grid grid-cols-5 gap-1">
                    {ICON_KEYS.map((key) => (
                      <button
                        key={key}
                        onClick={() => setAddNodeForm({ ...addNodeForm, icon: key })}
                        className={`flex flex-col items-center gap-0.5 p-1.5 rounded-lg border transition-all text-[10px] ${
                          addNodeForm.icon === key
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-white/[0.04] text-gray-500 hover:bg-white/[0.04] hover:text-white"
                        }`}
                      >
                        {ICON_MAP[key].icon}
                        <span className="text-[8px] truncate w-full text-center">{ICON_MAP[key].label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mb-4">
                  <label className="text-[10px] text-gray-500 mb-1 block uppercase tracking-wider">Color</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {NODE_COLORS.map((color) => (
                      <button
                        key={color}
                        aria-label={`Use color ${color}`}
                        aria-pressed={addNodeForm.color === color}
                        onClick={() => setAddNodeForm({ ...addNodeForm, color })}
                        className="w-6 h-6 rounded-full border-2 transition-all hover:scale-110"
                        style={{
                          backgroundColor: color,
                          borderColor: addNodeForm.color === color ? "#fff" : "transparent",
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  <button
                    onClick={closeAddNodePanel}
                    className="px-3 py-1.5 text-[12px] text-gray-400 hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={addCustomNodeToMap}
                    className="flex items-center gap-1 px-3 py-1.5 text-[12px] bg-primary/[0.12] backdrop-blur-md border border-primary/[0.25] text-primary hover:bg-primary/[0.2] hover:border-primary/[0.4] rounded-lg transition-all duration-200"
                  >
                    <LuPlus size={13} /> Add to Map
                  </button>
                </div>
              </div>
            )}
          </DialogPanel>
        </Dialog>
      )}

      <footer className="netmap-statusbar">
        <div><span>{nodes.length} devices</span><span>{edges.length} links</span>{snapToGrid && <span className="netmap-status-accent">Grid snap</span>}{Object.keys(edgeDrafts).length > 0 && <span className="netmap-status-accent">{Object.keys(edgeDrafts).length} unsaved connection draft{Object.keys(edgeDrafts).length === 1 ? "" : "s"}</span>}</div>
        <div>{pingEnabled && Object.keys(pingStatus).length > 0 && <><span className="netmap-status-up">{nodes.filter((node) => node.host_id && pingStatus[node.id] === true).length} reachable</span><span className="netmap-status-down">{nodes.filter((node) => node.host_id && pingStatus[node.id] === false).length} no response</span></>}
          <button className="netmap-status-toggle" aria-pressed={pingEnabled} title="Ping checks every 30 seconds" onClick={() => setPingEnabled((value) => !value)}><LuWifi size={13} />Ping {pingEnabled ? "on" : "paused"}</button>
          {pingEnabled && <button className="netmap-icon-button" aria-label="Refresh ping status" onClick={() => void fetchPingStatus()}><LuRefreshCw size={13} /></button>}
        </div>
      </footer>
      </>)}
    </div>
  );
};

export default NetworkMap;
