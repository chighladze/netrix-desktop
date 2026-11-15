import { invoke } from "@tauri-apps/api/core";
import { Dialog, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import { applyVaultStartupPolicy } from "./features/vault/startup";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    IoAdd,
    IoArrowForward,
    IoCloseCircleOutline,
    IoKeyOutline,
    IoLockClosedOutline,
    IoReloadOutline,
    IoWarningOutline,
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import {
  ApiError,
  type BackendStatus,
  fetchJsonOrThrow,
  getApiBase,
  waitForBackendReady,
} from "./api";
import BroadcastPanel from "./components/BroadcastPanel";
import ConfirmModal from "./components/ConfirmModal";
import HelpCenterModal, {
  HELP_INTRO_COMPLETED_KEY,
  type HelpCenterMode,
} from "./components/HelpCenterModal";

import HostDashboard from "./components/HostDashboard";
import NavRail from "./components/NavRail";
import QuickActionBar from "./components/QuickActionBar";
import SnippetList from "./components/SnippetList";
import TerminalCanvas from "./components/TerminalCanvas";
import TerminalWorkspace from "./components/TerminalWorkspace";
import DetachedTerminalWorkspace from "./components/DetachedTerminalWorkspace";
import TerminalTabsBar from "./components/TerminalTabsBar";
import TitleBar from "./components/TitleBar";
import type { DockPlacement } from "./terminal/docking";
import DetachedTerminalFrame from "./components/DetachedTerminalFrame";
import ToastContainer from "./components/ToastContainer";
import VaultUnlockModal from "./components/VaultUnlockModal";
import { HighlightRule, Host, QuickAction, TabStatus, useAppStore } from "./state/store";
import { cancelClipboardAutoClear, scheduleClipboardAutoClear } from "./utils/clipboard";
import { requestApplicationClose } from "./terminal/appClose";
import { transferTerminalWindow, TerminalMoveCancelledError, type HandoffAddress } from "./terminal/windowHandoff";
import { useWindowHandoffs, openMainTerminalHandoff } from "./terminal/useWindowHandoffs";
import { getTerminalSessionController } from "./terminal/TerminalSessionController";
import TerminalTransferOverlay from "./components/TerminalTransferOverlay";
import TerminalDockTarget from "./components/TerminalDockTarget";
import TerminalWindowPreview from "./components/TerminalWindowPreview";

const MAIN_WINDOW_POSITION_KEY = "netrix_main_window_position_v1";
const INITIAL_FETCH_RETRY_POLICY = { retries: 3, delayMs: 250 } as const;
const MIN_VISIBLE_WINDOW_EDGE_PX = 96;
const OFFSCREEN_POSITION_MARGIN_PX = 64;

interface HighlightRuleDto {
  id: string;
  keyword: string;
  color: string;
  highlight_type?: string;
  is_active: boolean;
}

const mapHighlightRule = (rule: HighlightRuleDto): HighlightRule => ({
  id: rule.id,
  keyword: rule.keyword,
  color: rule.color,
  highlightType: rule.highlight_type === "foreground" ? "foreground" : "background",
  isActive: rule.is_active,
});

type SavedMainWindowPosition = {
  x: number;
  y: number;
};

const parseSavedMainWindowPosition = (rawPosition: string): SavedMainWindowPosition | null => {
  try {
    const position: unknown = JSON.parse(rawPosition);
    if (
      position
      && typeof position === "object"
      && Number.isFinite((position as { x?: unknown }).x)
      && Number.isFinite((position as { y?: unknown }).y)
    ) {
      const { x, y } = position as { x: number; y: number };
      return { x, y };
    }
  } catch {
    return null;
  }

  return null;
};

const getStartupScreenBounds = () => {
  if (typeof window === "undefined" || !window.screen) return null;

  const screenInfo = window.screen as Screen & {
    availLeft?: number;
    availTop?: number;
  };
  const scale = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
  const width = screenInfo.availWidth * scale;
  const height = screenInfo.availHeight * scale;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const left = (Number.isFinite(screenInfo.availLeft) ? screenInfo.availLeft ?? 0 : 0) * scale;
  const top = (Number.isFinite(screenInfo.availTop) ? screenInfo.availTop ?? 0 : 0) * scale;

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
};

const isRestorableMainWindowPosition = ({ x, y }: SavedMainWindowPosition) => {
  const bounds = getStartupScreenBounds();
  if (!bounds) return true;

  return (
    x >= bounds.left - OFFSCREEN_POSITION_MARGIN_PX
    && y >= bounds.top - OFFSCREEN_POSITION_MARGIN_PX
    && x <= bounds.right - MIN_VISIBLE_WINDOW_EDGE_PX
    && y <= bounds.bottom - MIN_VISIBLE_WINDOW_EDGE_PX
  );
};

const NetworkMap = React.lazy(() => import("./components/NetworkMap"));
const Settings = React.lazy(() => import("./components/Settings"));
const SftpBrowser = React.lazy(() => import("./components/SftpBrowser"));
const Connections = React.lazy(() => import("./components/Connections"));
const UtilitiesHub = React.lazy(() => import("./components/UtilitiesHub"));

const LazyViewFallback: React.FC = () => (
  <div
    role="status"
    aria-live="polite"
    className="flex h-full min-h-0 items-center justify-center text-sm text-gray-500"
  >
    Loading view…
  </div>
);

const BackendStartupScreen: React.FC<{
  status: BackendStatus;
  title?: string;
}> = ({ status, title }) => {
  const failed = status.status === "failed";
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background-midnight">
      <TitleBar title={title || "Netrix"} />
      <main className="flex min-h-0 flex-1 items-center justify-center bg-[#080b11] px-5 py-8">
        <div
          role={failed ? "alert" : "status"}
          aria-live="polite"
          className="w-full max-w-md rounded-xl border border-white/[0.09] bg-[#101722]/95 p-6 text-center shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
        >
          <div className={`mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border ${failed ? "border-red-400/25 bg-red-500/10 text-red-300" : "border-primary/25 bg-primary/10 text-primary"}`}>
            {failed
              ? <IoWarningOutline size={24} />
              : <IoReloadOutline size={24} className="animate-spin" />}
          </div>
          <h1 className="text-base font-semibold text-gray-100">
            {failed ? "Backend failed to start" : "Starting Netrix backend"}
          </h1>
          <p className="mt-2 text-sm leading-6 text-gray-400">
            {failed
              ? status.message || "The local backend could not be started."
              : "Preparing the local services required by this window…"}
          </p>
        </div>
      </main>
    </div>
  );
};

const DetachedTerminalCloseDialog: React.FC<{
  hostName: string;
  status: TabStatus;
  onReturn: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onCancel: () => void;
}> = ({ hostName, status, onReturn, onDisconnect, onCancel }) => {
  const isLive = status === "connected" || status === "connecting";

  return (
    <Dialog open onClose={onCancel} className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md">
      <DialogPanel className="terminal-transfer-card w-full max-w-[430px] overflow-hidden rounded-xl border border-white/[0.1] bg-[#0d121c]/95 shadow-[0_28px_90px_rgba(0,0,0,0.55)]">
        <div className="border-b border-white/[0.08] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className={`h-2.5 w-2.5 rounded-full ${isLive ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]" : "bg-red-500"}`} />
            <div className="min-w-0">
              <DialogTitle className="truncate text-sm font-semibold text-white">{hostName}</DialogTitle>
              <div className="mt-0.5 text-[11px] uppercase tracking-[0.16em] text-gray-500">
                Detached Terminal
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-5">
          <Description className="text-sm leading-6 text-gray-300">
            Keep working in the main window, or disconnect this session and close its window.
          </Description>

          <div className="mt-5 grid gap-2">
            <button
              onClick={() => { void onReturn(); }}
              className="flex h-11 items-center justify-center gap-2 rounded-md border border-cyan-300/25 bg-cyan-300/10 px-4 text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-300/20"
            >
              <IoArrowForward size={16} className="rotate-180" />
              Return to main window
            </button>
            <button
              onClick={onDisconnect}
              className="flex h-11 items-center justify-center gap-2 rounded-md border border-red-400/25 bg-red-500/10 px-4 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/20"
            >
              <IoWarningOutline size={16} />
              Disconnect
            </button>
            <button
              onClick={onCancel}
              data-autofocus
              className="flex h-10 items-center justify-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.04] px-4 text-sm font-semibold text-gray-300 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              <IoCloseCircleOutline size={16} />
              Cancel
            </button>
          </div>
        </div>
      </DialogPanel>
    </Dialog>
  );
};

type NetworkMapSheetSummary = {
  id: string;
  name: string;
};

type NetworkMapNodeSummary = {
  id: string;
  host_id?: number | null;
  x?: number;
  y?: number;
};

const mapIconForHost = (host: Host) => {
  if (host.connection_type === "telnet") return "router";
  if (host.connection_type === "serial") return "switch";
  if (host.connection_type === "local") return "server";
  return "server";
};

const nextMapNodePosition = (nodes: NetworkMapNodeSummary[]) => {
  const col = nodes.length % 5;
  const row = Math.floor(nodes.length / 5);
  return {
    x: 120 + col * 220,
    y: 120 + row * 150,
  };
};

const App: React.FC = () => {
  const previewParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  if (previewParams.get("tabPreview") === "true") {
    return (
      <TerminalWindowPreview
        name={previewParams.get("name") || "Terminal"}
        protocol={previewParams.get("protocol") || "ssh"}
        status={previewParams.get("status") === "connected" ? "connected" : "disconnected"}
      />
    );
  }

  const {
    terminalTabs,
    activeTabId,
    addTerminalTab,
    setActiveTabId,
    settings,
    showConfirm,
    terminalSockets,
    fetchHosts,
    setQuickActions,
    activeView,
    setActiveView,
    recentConnections,
    addRecentConnection,
    tabStatuses,
    lockVault,
    refreshVaultStatus,
    unlockVault,
    addToast,
    getStoredVaultPassword,
    clearStoredVaultPassword,
    isVaultUnlocked,
    vaultInitialized,
    vaultStatusLoaded,
    vaultLinkedHosts,
    hasStoredVaultPassword,
    refreshStoredVaultPasswordState,
    isSidebarExpanded,
    networkMapActiveId,
    networkMapOpenIds,
    setNetworkMapOpenIds,
    setNetworkMapActiveId,
    requestNetworkMapFocus,
    openSftpForHost,
    activeSftpHostId,
    openSftpHostIds,
  } = useAppStore(
    useShallow((state) => ({
      terminalTabs: state.terminalTabs,
      activeTabId: state.activeTabId,
      addTerminalTab: state.addTerminalTab,
      setActiveTabId: state.setActiveTabId,
      settings: state.settings,
      showConfirm: state.showConfirm,
      terminalSockets: state.terminalSockets,
      fetchHosts: state.fetchHosts,
      setQuickActions: state.setQuickActions,
      activeView: state.activeView,
      setActiveView: state.setActiveView,
      recentConnections: state.recentConnections,
      addRecentConnection: state.addRecentConnection,
      tabStatuses: state.tabStatuses,
      lockVault: state.lockVault,
      refreshVaultStatus: state.refreshVaultStatus,
      unlockVault: state.unlockVault,
      addToast: state.addToast,
      getStoredVaultPassword: state.getStoredVaultPassword,
      clearStoredVaultPassword: state.clearStoredVaultPassword,
      isVaultUnlocked: state.isVaultUnlocked,
      vaultInitialized: state.vaultInitialized,
      vaultStatusLoaded: state.vaultStatusLoaded,
      vaultLinkedHosts: state.vaultLinkedHosts,
      hasStoredVaultPassword: state.hasStoredVaultPassword,
      refreshStoredVaultPasswordState: state.refreshStoredVaultPasswordState,
      isSidebarExpanded: state.isSidebarExpanded,
      networkMapActiveId: state.networkMapActiveId,
      networkMapOpenIds: state.networkMapOpenIds,
      setNetworkMapOpenIds: state.setNetworkMapOpenIds,
      setNetworkMapActiveId: state.setNetworkMapActiveId,
      requestNetworkMapFocus: state.requestNetworkMapFocus,
      openSftpForHost: state.openSftpForHost,
      activeSftpHostId: state.activeSftpHostId,
      openSftpHostIds: state.openSftpHostIds,
    })),
  );

  // Detached mode state — parse URL params synchronously so detached
  // windows render correctly on first paint (no flashing of other views)
  const _params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const _isDetached = _params.get("detached") === "true";
  const isDetachedWorkspace = _isDetached && _params.get("workspace") === "true";
  const _detachedHost = (() => {
    const hostData = _params.get("host");
    if (!hostData) return null;
    try {
      // URLSearchParams.get() already percent-decodes the value once.
      return JSON.parse(hostData) as Host;
    } catch (e) {
      console.error("Failed to parse detached host", e);
      return null;
    }
  })();
  const _detachedSid = (() => {
    const sid = _params.get("sid");
    return sid ? parseInt(sid) : null;
  })();

  const _detachedOriginTabId = _params.get("originTabId") || null;

  const _suppress = _params.get("suppress") === "true";

  // Detached map window params
  const _isDetachedMap = _params.get("detachedMap") === "true";
  const _detachedMapId = _params.get("mapId") || null;
  const _detachedMapName = _params.get("mapName") || null;
  const _detachedMapViewState = (() => {
    try {
      const raw = _params.get("viewState");
      if (raw) return JSON.parse(raw) as { x: number; y: number; w: number; h: number; zoom: number };
    } catch { /* ignore */ }
    return undefined;
  })();

  const [isDetached] = useState<boolean>(_isDetached);
  const [detachedHost, setDetachedHost] = useState<Host | null>(_detachedHost);
  const [detachedSid] = useState<number | null>(_detachedSid);
  const [detachedOriginTabId] = useState<string | null>(_detachedOriginTabId);
  const [detachedCloseDialogOpen, setDetachedCloseDialogOpen] = useState(false);
  const [isDetachedMap] = useState<boolean>(_isDetachedMap);
  const [detachedMapId] = useState<string | null>(_detachedMapId);
  const [detachedMapName] = useState<string | null>(_detachedMapName);
  const [detachedMapViewState] = useState(_detachedMapViewState);
  const isMainWindow = !isDetached && !isDetachedMap;
  const allowDetachedCloseRef = useRef(false);
  const detachedHandoffAddress: HandoffAddress | null = isDetached && _params.get("handoff") && _params.get("source")
    ? { id: _params.get("handoff")!, source: _params.get("source")!, target: getCurrentWindow().label }
    : null;
  useWindowHandoffs({ isMainWindow, isWorkspaceWindow: isDetachedWorkspace, detachedAddress: detachedHandoffAddress, setDetachedHost, allowDetachedClose: allowDetachedCloseRef });

  const [backendStatus, setBackendStatus] = useState<BackendStatus>({ status: "starting" });
  const [mainBootstrapComplete, setMainBootstrapComplete] = useState(false);
  const [terminalViewOpened, setTerminalViewOpened] = useState(false);
  const [vaultUnlockDialogOpen, setVaultUnlockDialogOpen] = useState(false);
  const [helpCenterOpen, setHelpCenterOpen] = useState(false);
  const [helpCenterMode, setHelpCenterMode] = useState<HelpCenterMode>("guide");
  const mainBootstrapStartedRef = useRef(false);
  const startupWindowShownRef = useRef(false);
  const closeVaultUnlockDialog = useCallback(() => {
    setVaultUnlockDialogOpen(false);
  }, []);

  const closeHelpCenter = useCallback(() => {
    if (helpCenterMode === "welcome") {
      localStorage.setItem(HELP_INTRO_COMPLETED_KEY, "true");
    }
    setHelpCenterOpen(false);
  }, [helpCenterMode]);

  const openHelpCenter = useCallback(() => {
    setHelpCenterMode("guide");
    setHelpCenterOpen(true);
  }, []);

  const quitApplication = useCallback(async () => {
    try {
      await invoke("quit_app");
    } catch (error) {
      console.error("Failed to quit application through Tauri:", error);
      addToast("Could not quit Netrix. Your sessions are still open.", "error");
    }
  }, [addToast]);

  // Keep an opened workspace alive across navigation, but leave restored tabs
  // dormant until the user first opens Terminal after bootstrap.
  useEffect(() => {
    if (mainBootstrapComplete && activeView === "terminal") setTerminalViewOpened(true);
  }, [mainBootstrapComplete, activeView]);

  useEffect(() => {
    if (isVaultUnlocked) {
      setVaultUnlockDialogOpen(false);
    }
  }, [isVaultUnlocked]);

  useEffect(() => {
    if (!isMainWindow || !mainBootstrapComplete || !vaultStatusLoaded) return;
    if (localStorage.getItem(HELP_INTRO_COMPLETED_KEY) === "true") return;

    setHelpCenterMode("welcome");
    setHelpCenterOpen(true);
  }, [isMainWindow, mainBootstrapComplete, vaultStatusLoaded]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void waitForBackendReady({
      signal: controller.signal,
      onStatus: (status) => {
        if (active) {
          setBackendStatus((current) =>
            current.status === status.status && current.message === status.message
              ? current
              : status,
          );
        }
      },
    }).catch((error: unknown) => {
      if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
      console.error("Failed to read backend readiness status:", error);
      setBackendStatus({
        status: "failed",
        message: "Unable to determine whether the local backend started.",
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);



  // Save layout on window close
  useEffect(() => {
    if (!isMainWindow) return;
    const handleBeforeUnload = () => useAppStore.getState().saveLayout();
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isMainWindow]);

  // Disable default browser context menu ONLY in production and trap global Ctrl+F
  useEffect(() => {
    // @ts-ignore - import.meta.env is provided by Vite
    const handleContextMenu = (e: MouseEvent) => { if (import.meta.env.PROD) e.preventDefault(); };
    const handleGlobalKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') e.preventDefault();
    };
    window.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("keydown", handleGlobalKeydown);
    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", handleGlobalKeydown);
    };
  }, []);

  useEffect(() => {
    if (isDetached && !isDetachedWorkspace) {
      setActiveTabId("detached");
    }
  }, [isDetached, isDetachedWorkspace, setActiveTabId]);

  // Pre-register session ID in store for detached window reattachment
  useEffect(() => {
    if (isDetached && detachedSid) {
      useAppStore.getState().setSessionId("detached", detachedSid);
      console.log(`[DetachedWindow] Registered session ID ${detachedSid} for reattachment`);
    }
  }, [isDetached, detachedSid]);

  // Mark initial connect as suppressed for detached windows
  // This preserves error/disconnected state from main window
  useEffect(() => {
    if (isDetached && _suppress) {
      useAppStore.getState().markInitialConnectSuppressed("detached");
      console.log("[DetachedWindow] Initial connect suppressed (preserving error state)");
    }
  }, [isDetached]);

  // Listen for reattach-map events (detached map window returning to main)
  useEffect(() => {
    if (!isMainWindow) return;
    let unlisten: (() => void) | null = null;
    const init = async () => {
      unlisten = await listen<{ mapId: string; mapName: string; viewState?: { x: number; y: number; w: number; h: number; zoom: number } | null }>("reattach-map", (event) => {
        const { mapId, mapName, viewState } = event.payload;
        console.log(`[ReattachMap] Map "${mapName}" (${mapId}) returned to main window`);
        // Save the detached window's view state so NetworkMap can restore it
        if (viewState) {
          useAppStore.getState().setNetworkMapViewState(mapId, viewState);
        }
        // The NetworkMap component will handle reattaching the map tab
        // by emitting a custom DOM event that NetworkMap listens for
        window.dispatchEvent(new CustomEvent("netrix-reattach-map", { detail: { mapId, mapName } }));
        // Switch to network map view
        setActiveView("network-map");
        // Focus main window
        getCurrentWindow().unminimize().then(() => getCurrentWindow().setFocus()).catch(() => {});
      });
    };
    init();
    return () => { if (unlisten) unlisten(); };
  }, [isMainWindow, setActiveView]);


  const isLocked = useAppStore((state) => state.appSecurity.locked === true);

  // Apply window settings (always on top)
  useEffect(() => {
    const applyWindowSettings = async () => {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setAlwaysOnTop(settings.window.alwaysOnTop);
      } catch (err) {
        console.error("Failed to apply window settings:", err);
      }
    };
    applyWindowSettings();
  }, [settings.window.alwaysOnTop]);

  useEffect(() => {
    if (!isMainWindow) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;

    if (!settings.window.rememberWindowPosition) {
      localStorage.removeItem(MAIN_WINDOW_POSITION_KEY);
      return;
    }

    void appWindow.onMoved(({ payload }) => {
      if (disposed) return;
      localStorage.setItem(
        MAIN_WINDOW_POSITION_KEY,
        JSON.stringify({ x: payload.x, y: payload.y }),
      );
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isMainWindow, settings.window.rememberWindowPosition]);

  useEffect(() => {
    if (!isMainWindow) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void appWindow.onCloseRequested((event) => {
      event.preventDefault();

      void requestApplicationClose(quitApplication);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isMainWindow, quitApplication]);

  // Restore the main-window position before making the initially hidden window visible.
  useEffect(() => {
    if (startupWindowShownRef.current) return;
    startupWindowShownRef.current = true;

    const showWindow = async () => {
      try {
        const appWindow = getCurrentWindow();
        if (isMainWindow && settings.window.rememberWindowPosition) {
          const rawPosition = localStorage.getItem(MAIN_WINDOW_POSITION_KEY);
          if (rawPosition) {
            const position = parseSavedMainWindowPosition(rawPosition);
            if (position && isRestorableMainWindowPosition(position)) {
              try {
                await appWindow.setPosition(new PhysicalPosition(position.x, position.y));
              } catch (error) {
                console.warn("Ignoring saved main-window position:", error);
                localStorage.removeItem(MAIN_WINDOW_POSITION_KEY);
              }
            } else {
              localStorage.removeItem(MAIN_WINDOW_POSITION_KEY);
            }
          }
        }
        await appWindow.show();
        await appWindow.unminimize().catch(() => {});
        await appWindow.setFocus().catch(() => {});
      } catch (err) {
        console.error("Failed to show window:", err);
      }
    };
    void showWindow();
  }, [isMainWindow, settings.window.rememberWindowPosition]);

  // Main-window bootstrap. Child windows have a separate minimal loader below.
  useEffect(() => {
    if (
      !isMainWindow
      || backendStatus.status !== "ready"
      || mainBootstrapStartedRef.current
    ) return;
    mainBootstrapStartedRef.current = true;

    const fetchData = async () => {
      try {
        const baseUrl = await getApiBase();
        console.log(`[App] Fetching initial data from: ${baseUrl}`);

        const vaultStatus = await refreshVaultStatus();
        await refreshStoredVaultPasswordState();
        const startupResult = useAppStore.getState().appSecurity.databaseEncrypted ? { ok: true } : await applyVaultStartupPolicy(settings.security, vaultStatus?.initialized, {
          getStoredVaultPassword, unlockVault, lockVault,
          clearStoredVaultPassword, refreshStoredVaultPasswordState,
        });
        if (!startupResult.ok) {
          addToast(startupResult.error || "Failed to apply vault startup settings", "error");
        }

        try {
          console.log(`[App] GET ${baseUrl}/hosts`);
          const data = await fetchHosts();
          console.log(`[App] Loaded ${data.length} hosts`);
          // restoreLayout also restores the previously active terminal view.
          // Preserve the view the user currently has so restored tabs remain
          // dormant until terminal workspace is explicitly opened.
          const state = useAppStore.getState();
          const viewBeforeRestore = state.activeView;
          state.restoreLayout();
          state.setActiveView(viewBeforeRestore);
        } catch (err) {
            console.error(`[App] Failed to load hosts after retries:`, err);
        } finally {
          // Terminal mounting is gated only until layout restoration has had
          // its chance to run; unrelated quick-action/rule fetches may finish later.
          setMainBootstrapComplete(true);
        }

        try {
          console.log(`[App] GET ${baseUrl}/quick-actions`);
          const data = await fetchJsonOrThrow<QuickAction[]>(
            `${baseUrl}/quick-actions`,
            {},
            INITIAL_FETCH_RETRY_POLICY,
          );
          console.log(`[App] Loaded ${data.length} quick actions`);
          setQuickActions(data);
        } catch (err) {
             console.error(`[App] Failed to load quick actions after retries:`, err);
        }

        try {
          console.log(`[App] GET ${baseUrl}/highlight-rules`);
          const data = await fetchJsonOrThrow<HighlightRuleDto[]>(
            `${baseUrl}/highlight-rules`,
            {},
            INITIAL_FETCH_RETRY_POLICY,
          );
          const mappedRules = data.map(mapHighlightRule);
          console.log(`[App] Loaded ${mappedRules.length} highlight rules`);
          useAppStore.getState().setHighlightRules(mappedRules);
        } catch (err) {
          console.error(`[App] Failed to load highlight rules after retries:`, err);
        }

        // Fetch recent connections
        try {
          console.log(`[App] Fetching recent connections...`);
          await useAppStore.getState().fetchRecentConnections();
          console.log(`[App] Recent connections loaded`);
        } catch (err) {
          console.error(`[App] Failed to load recent connections:`, err);
        }
      } catch (err) {
        console.error("Failed to initialize API base:", err);
      } finally {
        setMainBootstrapComplete(true);
      }
    };

    void fetchData();
  }, [backendStatus.status, isMainWindow, fetchHosts, setQuickActions, refreshVaultStatus, refreshStoredVaultPasswordState, settings.security.vaultUnlockMode, settings.security.vaultRememberPassword, lockVault, unlockVault, getStoredVaultPassword, clearStoredVaultPassword, addToast, setActiveView]);

  // Child windows load only the data their visible surface consumes. They must
  // never run main-window layout restoration or vault/keychain startup policy.
  useEffect(() => {
    if (
      (!isDetached && !isDetachedMap)
      || backendStatus.status !== "ready"
    ) return;

    let active = true;
    const loadWindowData = async () => {
      try {
        const baseUrl = await getApiBase();
        if (isDetachedMap) {
          await fetchHosts();
          return;
        }

        const quickActions = await fetchJsonOrThrow<QuickAction[]>(`${baseUrl}/quick-actions`);
        if (active) setQuickActions(quickActions);
      } catch (error) {
        console.error("Failed to load child-window data:", error);
      }
    };

    void loadWindowData();
    return () => {
      active = false;
    };
  }, [backendStatus.status, isDetached, isDetachedMap, fetchHosts, setQuickActions]);

  // Clear clipboard after timeout
  useEffect(() => {
    const handleCopy = () => {
      const active = document.activeElement;
      const selectedText = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
        ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
        : window.getSelection()?.toString() ?? "";
      scheduleClipboardAutoClear(selectedText);
    };

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, []);

  useEffect(() => {
    // A changed/disabled timeout must not leave a timer created under the old policy.
    cancelClipboardAutoClear();
  }, [settings.security.clearClipboardAfter]);

  const handleConnect = (host: Host) => {
    addRecentConnection(host);
    addTerminalTab(host);
    setActiveView("terminal");
  };

  const handleOpenFiles = useCallback(async (host: Host) => {
    await openSftpForHost(host);
    if (host.connection_type === "ssh") {
      setActiveView("files");
    }
  }, [openSftpForHost, setActiveView]);

  const handleAddHostToMap = useCallback(async (host: Host) => {
    try {
      const base = await getApiBase();
      let maps = await fetchJsonOrThrow<NetworkMapSheetSummary[]>(
        `${base}/network-map/maps`,
      );
      if (maps.length === 0) {
        const createdMap = await fetchJsonOrThrow<NetworkMapSheetSummary>(`${base}/network-map/maps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Default Map" }),
        });
        maps = [createdMap];
      }

      const targetMap = maps.find((map) => map.id === networkMapActiveId) || maps[0];
      const mapData = await fetchJsonOrThrow<{ nodes?: NetworkMapNodeSummary[] }>(
        `${base}/network-map/maps/${targetMap.id}`,
      );
      const nodes = mapData.nodes || [];
      const existingNode = nodes.find((node) => node.host_id === host.id);

      setNetworkMapOpenIds(
        networkMapOpenIds.includes(targetMap.id)
          ? networkMapOpenIds
          : [...networkMapOpenIds, targetMap.id],
      );
      setNetworkMapActiveId(targetMap.id);
      setActiveView("network-map");

      if (existingNode) {
        requestNetworkMapFocus({ mapId: targetMap.id, nodeId: existingNode.id, hostId: host.id });
        addToast(`${host.name} is already on ${targetMap.name}`, "info");
        return;
      }

      const position = nextMapNodePosition(nodes);
      const node = await fetchJsonOrThrow<NetworkMapNodeSummary>(`${base}/network-map/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          map_id: targetMap.id,
          host_id: host.id,
          label: host.name,
          icon: mapIconForHost(host),
          color: host.connection_type === "telnet" ? "#10b981" : host.connection_type === "serial" ? "#8b5cf6" : host.connection_type === "local" ? "#a855f7" : "#3b82f6",
          x: position.x,
          y: position.y,
          width: 180,
          height: 64,
        }),
      });
      requestNetworkMapFocus({ mapId: targetMap.id, nodeId: node.id, hostId: host.id });
      addToast(`${host.name} added to ${targetMap.name}`, "success");
    } catch (error) {
      console.error("Failed to add host to map:", error);
      addToast(error instanceof Error ? error.message : "Failed to add host to map", "error");
    }
  }, [addToast, networkMapActiveId, networkMapOpenIds, requestNetworkMapFocus, setActiveView, setNetworkMapActiveId, setNetworkMapOpenIds]);

  const handleAddTab = () => {
    setActiveView("hosts");
  };

  const handleBackFromTerminal = () => {
    if (terminalTabs.length <= 1) {
      setActiveView("hosts");
    }
  };

  const handleAppClose = () => requestApplicationClose(quitApplication);

  const returnDetachedTerminal = useCallback(async (placement?: DockPlacement) => {
    if (!detachedHost || useAppStore.getState().terminalTransfers["detached"]) return;
    setDetachedCloseDialogOpen(false);
    try {
      await transferTerminalWindow({
        tabId: "detached",
        host: detachedHost,
        originTabId: detachedOriginTabId ?? undefined,
        placement,
        target: placement?.windowLabel ?? "main",
        open: openMainTerminalHandoff,
        release: async () => {
          allowDetachedCloseRef.current = true;
          await invoke("close_terminal_window");
        },
      });
    } catch (error) {
      allowDetachedCloseRef.current = false;
      if (!(error instanceof TerminalMoveCancelledError)) addToast(error instanceof Error ? error.message : "Could not return terminal to main window", "error");
    }
  }, [addToast, detachedHost, detachedOriginTabId]);

  const terminateDetachedTerminal = useCallback(async () => {
    if (useAppStore.getState().terminalTransfers["detached"]) return;
    setDetachedCloseDialogOpen(false);
    const sid = useAppStore.getState().sessionIds["detached"];
    try {
      if (typeof sid === "number") {
        const baseUrl = await getApiBase();
        await fetchJsonOrThrow<void>(`${baseUrl}/sessions/${sid}`, { method: "DELETE" });
      }
      getTerminalSessionController("detached")?.dispose({ preserveSession: true });
      allowDetachedCloseRef.current = true;
      await invoke("close_terminal_window");
    } catch (error) {
      allowDetachedCloseRef.current = false;
      addToast(error instanceof Error ? error.message : "Could not disconnect terminal session", "error");
    }
  }, [addToast]);

  useEffect(() => {
    if (!isDetached || isDetachedWorkspace || !detachedHost) return;
    let disposed = false;
    let stop = () => {};
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (allowDetachedCloseRef.current) { void invoke("close_terminal_window"); return; }
      if (!useAppStore.getState().terminalTransfers["detached"]) setDetachedCloseDialogOpen(true);
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop(); };
  }, [isDetached, isDetachedWorkspace, detachedHost]);

  useEffect(() => {
    if (isDetached || isDetachedMap || activeView !== "terminal") return;
    if (terminalTabs.length === 0) {
      if (activeTabId !== null) setActiveTabId(null);
      return;
    }
    if (!terminalTabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(terminalTabs[terminalTabs.length - 1].id);
    }
  }, [activeTabId, activeView, isDetached, isDetachedMap, setActiveTabId, terminalTabs]);

  const activeTab = terminalTabs.find((t) => t.id === activeTabId);

  if (backendStatus.status !== "ready") {
    const startupTitle = isDetachedMap
      ? `Map: ${detachedMapName || "Network Map"}`
      : isDetached
        ? detachedHost?.name || "Terminal"
        : "Netrix";
    return <BackendStartupScreen status={backendStatus} title={startupTitle} />;
  }

  // Detached map view
  if (isDetachedMap && detachedMapId) {
    return (
      <div className="relative flex flex-col h-screen overflow-hidden bg-background-midnight">
        <TitleBar
          title={`Map: ${detachedMapName || "Network Map"}`}
          onReturn={async () => {
            try {
              const vs = (window as any).__netrixMapViewState || null;
              await emit("reattach-map", { mapId: detachedMapId, mapName: detachedMapName, viewState: vs });
              getCurrentWindow().close();
            } catch (err) {
              console.error("[DetachedMap] Failed to return:", err);
              getCurrentWindow().close();
            }
          }}
        />
        <div className="flex-1 relative overflow-hidden">
          <React.Suspense fallback={<LazyViewFallback />}>
            <NetworkMap detachedMapId={detachedMapId} initialViewState={detachedMapViewState} />
          </React.Suspense>
        </div>
        <ToastContainer />
      </div>
    );
  }

  if (isDetachedWorkspace) return <DetachedTerminalWorkspace allowClose={allowDetachedCloseRef} />;

  if (isDetached && !detachedHost) {
    return <div className="relative flex h-screen items-center justify-center bg-[#0d121c] text-sm text-gray-400" role="status">Preparing terminal window...</div>;
  }

  // Detached view
  if (isDetached && detachedHost) {
    const detachedWs = terminalSockets["detached"];
    const isDetachedConnected = tabStatuses["detached"] === "connected" && detachedWs?.readyState === WebSocket.OPEN;

    return (
      <div className="terminal-window-root relative flex flex-col h-screen overflow-hidden bg-transparent">
        <TerminalTransferOverlay tabId="detached" />
        <DetachedTerminalFrame
          title={detachedHost.name}
          isConnected={isDetachedConnected}
          onReturn={returnDetachedTerminal}
          onClose={() => setDetachedCloseDialogOpen(true)}
        >
          <div className="flex-1 relative overflow-hidden">
            <TerminalCanvas
              tabId="detached"
              host={detachedHost}
              onConnectionInfo={(connection) => setDetachedHost((current) => current ? { ...current, ...connection } : current)}
              initialSessionId={detachedSid || undefined}
              onBack={() => {}} // No back in detached mode
            />
          </div>
          <QuickActionBar rounded={false} />
        </DetachedTerminalFrame>
        <ConfirmModal />
        <ToastContainer />
        {detachedCloseDialogOpen && (
          <DetachedTerminalCloseDialog
            hostName={detachedHost.name}
            status={tabStatuses["detached"] || (isDetachedConnected ? "connected" : "disconnected")}
            onReturn={returnDetachedTerminal}
            onDisconnect={terminateDetachedTerminal}
            onCancel={() => setDetachedCloseDialogOpen(false)}
          />
        )}
      </div>
    );
  }


  return (
    <div className="relative flex flex-col h-screen overflow-hidden bg-background-midnight">
      <TitleBar
        onSettings={() => setActiveView("settings")}
        onClose={handleAppClose}
      />
      <div className="flex min-h-0 flex-1 bg-background-dark">
        <NavRail
          activeView={activeView}
          onChange={setActiveView}
          onOpenHelp={openHelpCenter}
          onUnlockVault={() => setVaultUnlockDialogOpen(true)}
        />
        <main data-terminal-dock-surface data-workspace-ready={mainBootstrapComplete} className="flex-1 bg-background-midnight text-foreground-dark overflow-hidden flex flex-col min-h-0 rounded-[var(--workspace-radius)] shadow-[-20px_0_60px_-15px_rgba(0,0,0,0.9),0_-10px_30px_-15px_rgba(0,0,0,0.5)] border border-white/5 relative z-10 mr-2 mb-2">
          {mainBootstrapComplete
            && vaultStatusLoaded
            && vaultInitialized
            && !isVaultUnlocked
            && activeView !== "settings" && (
              <div
                role="status"
                className="mx-3 mb-2 mt-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-400/20 bg-amber-400/[0.075] px-3 py-2.5 text-amber-100 shadow-[0_10px_28px_rgba(0,0,0,0.18)] sm:mx-4 sm:px-4"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-300/20 bg-amber-300/10 text-amber-300">
                  <IoLockClosedOutline size={16} />
                </div>
                <div className="min-w-[220px] flex-1">
                  <div className="text-xs font-semibold text-amber-100">Credential Vault is locked</div>
                  <p className="mt-0.5 text-[11px] leading-4 text-amber-100/70">
                    {vaultLinkedHosts > 0
                      ? vaultLinkedHosts === 1
                        ? "1 saved host uses encrypted credentials. Unlock the Vault before connecting with its saved password or key."
                        : `${vaultLinkedHosts} saved hosts use encrypted credentials. Unlock the Vault before connecting with saved passwords or keys.`
                      : "Unlock the Vault before saving or using stored passwords and private keys."}
                  </p>
                </div>
                <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto sm:gap-2">
                  <button
                    type="button"
                    onClick={openHelpCenter}
                    className="h-8 whitespace-nowrap rounded-lg px-2.5 text-[11px] font-semibold text-amber-100/65 transition-colors hover:bg-amber-300/10 hover:text-amber-100"
                  >
                    Why is this needed?
                  </button>
                  <button
                    type="button"
                    onClick={() => setVaultUnlockDialogOpen(true)}
                    className="inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-300/20"
                  >
                    <IoKeyOutline size={14} />
                    Unlock Vault
                  </button>
                </div>
              </div>
            )}
          <div className="min-h-0 flex-1 overflow-hidden">
            <React.Suspense fallback={<LazyViewFallback />}>
          {activeView === "hosts" && (
            <div className="h-full w-full animate-fade-in">
              <HostDashboard onConnect={handleConnect} onOpenFiles={handleOpenFiles} onAddToMap={handleAddHostToMap} />
            </div>
          )}

          {activeView === "network-map" && (
            <div className="h-full w-full animate-fade-in">
              <NetworkMap />
            </div>
          )}
          {activeView === "connections" && <Connections />}
            </React.Suspense>

          {/* Lazy modules must not suspend the persistent xterm layout effects. */}
          {mainBootstrapComplete && (activeView === "terminal" || terminalViewOpened) && (
            <div data-terminal-view hidden={activeView !== "terminal"}
              className={activeView === "terminal" ? "flex h-full min-h-0 flex-col" : "hidden"}>
              {activeView === "terminal" && settings.window.tabPosition === "top" && (
                <TerminalTabsBar
                  onAddTab={handleAddTab}
                />
              )}

              {activeTab ? (
                <TerminalWorkspace onBack={handleBackFromTerminal} onAddConnection={handleAddTab} />
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8 text-foreground-muted scrollbar-thin">
                  <div className="text-center w-full max-w-2xl">
                    <div className="w-20 h-20 mx-auto mb-6 bg-primary/10 rounded-3xl flex items-center justify-center text-primary">
                      <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                    </div>
                    <h2 className="text-2xl font-bold text-white mb-2">No Active Sessions</h2>
                    <p className="text-gray-500 mb-8">Start a new connection or select from your recent sessions</p>

                    <button
                      onClick={handleAddTab}
                      className="group inline-flex items-center gap-2.5 px-7 py-3 bg-primary/[0.12] backdrop-blur-xl border border-primary/[0.25] text-primary hover:bg-primary/[0.2] hover:border-primary/[0.4] hover:scale-[1.03] active:scale-[0.97] font-semibold rounded-xl transition-all duration-200 mb-10"
                    >
                      <IoAdd size={20} className="transition-transform duration-200 group-hover:rotate-90" />
                      New Connection
                    </button>

                    {recentConnections.length > 0 && (
                      <div className="mt-6">
                        <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-4">
                          Recent Connections
                        </h3>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {recentConnections.slice(0, 6).map((rc) => (
                            <button
                              key={rc.host.id + '-' + rc.timestamp}
                              onClick={() => handleConnect(rc.host)}
                              className="group flex items-center gap-4 p-4 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-primary/30 rounded-xl transition-all text-left"
                            >
                              <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center text-primary group-hover:scale-110 transition-transform">
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                                </svg>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-white truncate">{rc.host.name}</p>
                                <p className="text-xs text-gray-500 truncate">
                                  {rc.host.username}@{rc.host.hostname}:{rc.host.port}
                                </p>
                              </div>
                              <div className="text-[10px] text-gray-600 uppercase">
                                {rc.host.connection_type}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Quick Action Bar (Bottom of Terminal View) */}
              {activeView === "terminal" && <QuickActionBar />}
              {activeView === "terminal" && <BroadcastPanel />}

              {activeView === "terminal" && settings.window.tabPosition === "bottom" && (
                <TerminalTabsBar
                  onAddTab={handleAddTab}
                />
              )}
            </div>
          )}

            <React.Suspense fallback={<LazyViewFallback />}>
          {activeView === "snippets" && <SnippetList />}
          {activeView === "settings" && <Settings />}
          {(activeView === "files" || activeSftpHostId !== null || openSftpHostIds.length > 0) && (
            <div className={activeView === "files" ? "h-full min-h-0 overflow-hidden" : "hidden"}>
              <SftpBrowser />
            </div>
          )}
          {activeView === "utilities" && (
            <div className="h-full min-h-0">
              <UtilitiesHub />
            </div>
          )}
            </React.Suspense>
          </div>
        </main>
      </div>
      <TerminalDockTarget enabled={isMainWindow && !isLocked} tabPosition={settings.window.tabPosition} />
      <VaultUnlockModal
        isOpen={vaultUnlockDialogOpen}
        linkedHosts={vaultLinkedHosts}
        onClose={closeVaultUnlockDialog}
        onUnlock={async (masterPassword) => {
          const result = await unlockVault(masterPassword);
          if (result.ok) {
            addToast("Vault unlocked", "success");
          }
          return result;
        }}
      />
      <HelpCenterModal
        isOpen={helpCenterOpen}
        mode={helpCenterMode}
        vaultInitialized={vaultInitialized}
        vaultUnlocked={isVaultUnlocked}
        onClose={closeHelpCenter}
        onNavigate={(view) => {
          setActiveView(view);
          closeHelpCenter();
        }}
        onCreateVault={async (masterPassword) => {
          const result = await unlockVault(masterPassword);
          if (result.ok) {
            addToast("Credential Vault created and unlocked", "success");
          }
          return result;
        }}
        onUnlockVault={() => {
          closeHelpCenter();
          setVaultUnlockDialogOpen(true);
        }}
      />
      <ToastContainer />
      <ConfirmModal />
    </div>
  );
};

export default App;
