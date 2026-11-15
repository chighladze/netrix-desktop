import { broadcastUserInput, sendQuickAction } from "../terminal/userInput";
import { terminalRuntimeOptions, terminalBellGain, applyTerminalPreferences } from "../features/settings/terminalOptions";
import { createTerminalPasteHandler } from "../terminal/paste";
import type { TerminalConnectionInfo } from "../terminal/connectionInfo";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IoArrowDown, IoArrowUp, IoClose, IoDocuments, IoDuplicate, IoSearchOutline, IoTerminal, IoTrash } from "react-icons/io5";
import { Terminal } from "xterm";
import "xterm/css/xterm.css";
import { useShallow } from "zustand/react/shallow";
import { fetchJsonOrThrow, getApiBase } from "../api";
import { Host, HostConnectionUpdate, useAppStore } from "../state/store";
import {
  ensureTerminalSessionController,
  type TerminalSessionController,
} from "../terminal/TerminalSessionController";
import { getTerminalSurface, getThemeColors } from "../themes";
import { copyTextWithAutoClear } from "../utils/clipboard";
import TerminalHints from "./TerminalHints";
import TerminalHistory from "./TerminalHistory";
import "../terminal/sessionChrome.css";
import TerminalTransferOverlay from "./TerminalTransferOverlay";
import ConnectionStatusPanel from "./ConnectionStatusPanel";

interface TerminalCanvasProps {
  tabId: string;
  host: Host;
  initialSessionId?: number;
  onBack?: () => void;
  onConnectionInfo?: (connection: TerminalConnectionInfo) => void;
}

type LauncherItem = {
  id: string;
  label: string;
  command: string;
  source: "quick" | "recent";
  meta?: string;
  usageCount?: number;
  lastUsed?: number;
};

type RecentCommandEntry = {
  command: string;
  count: number;
  lastUsed: number;
};

const RECENT_COMMANDS_KEY = "netrix_terminal_recent_commands_v2";
const LEGACY_RECENT_COMMANDS_KEY = "netrix_terminal_recent_commands_v1";
let recentCommandCache: RecentCommandEntry[] = [];

const cleanupPersistedRecentCommands = () => {
  try {
    localStorage.removeItem(RECENT_COMMANDS_KEY);
    localStorage.removeItem(LEGACY_RECENT_COMMANDS_KEY);
  } catch {
    // Best-effort cleanup only.
  }
};

// Search decorations are now dynamic (derived from settings)

const TerminalCanvas: React.FC<TerminalCanvasProps> = ({
  tabId,
  host,
  initialSessionId,
  onBack,
  onConnectionInfo,
}) => {
  const {
    terminalTheme: globalTheme,
    terminalFontSize: globalFontSize,
    setTerminalTheme,
    setTerminalFontSize,
    currentTerminalInstance,
    terminalSockets,
    setTerminalInstance,
    sessionIds,
    updateTabHost,
    addTerminalTab,
    activeView,
    setActiveView,
    activeTabId,
    removeTerminalTab,
    terminalTabs,
    settings,
    addToast,
    consumeInitialConnectSuppressed,
    tabStatuses,
    quickActions,
  } = useAppStore(
    useShallow((state) => ({
      terminalTheme: state.terminalTheme,
      terminalFontSize: state.terminalFontSize,
      setTerminalTheme: state.setTerminalTheme,
      setTerminalFontSize: state.setTerminalFontSize,
      currentTerminalInstance: state.terminalInstances[tabId],
      terminalSockets: state.terminalSockets,
      setTerminalInstance: state.setTerminalInstance,
      sessionIds: state.sessionIds,
      updateTabHost: state.updateTabHost,
      addTerminalTab: state.addTerminalTab,
      activeView: state.activeView,
      setActiveView: state.setActiveView,
      activeTabId: state.activeTabId,
      removeTerminalTab: state.removeTerminalTab,
      terminalTabs: state.terminalTabs,
      settings: state.settings,
      addToast: state.addToast,
      consumeInitialConnectSuppressed: state.consumeInitialConnectSuppressed,
      tabStatuses: state.tabStatuses,
      quickActions: state.quickActions,
    })),
  );

  const hasExistingSession = useCallback(() => {
    const state = useAppStore.getState();
    return Boolean(
      initialSessionId ||
      state.sessionIds[tabId] ||
      state.terminalTabs.find((tab) => tab.id === tabId)?.sessionId,
    );
  }, [initialSessionId, tabId]);

  // Moving a terminal between windows should feel like moving the same live
  // surface, not starting a fresh connection flow.
  const isSessionHandoff = Boolean(
    initialSessionId ||
    sessionIds[tabId] ||
    terminalTabs.find((tab) => tab.id === tabId)?.sessionId,
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const pasteHandlerRef = useRef<ReturnType<typeof createTerminalPasteHandler> | null>(null);
  const connectionInfoCallbackRef = useRef(onConnectionInfo);
  connectionInfoCallbackRef.current = onConnectionInfo;
  const [historyActionsTarget, setHistoryActionsTarget] = useState<HTMLDivElement | null>(null);
  const viewportId = useId();
  const fitAddonRef = useRef<FitAddon | null>(null);
  const suppressInitialConnectRef = useRef<boolean | null>(null);
  const settingsRef = useRef(settings); // Stable ref for settings to avoid stale closures
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  const sessionControllerRef = useRef<TerminalSessionController | null>(null);
  if (!sessionControllerRef.current) {
    const currentState = useAppStore.getState();
    sessionControllerRef.current = ensureTerminalSessionController(tabId, {
      host,
      initialSessionId,
      initialStatus: currentState.tabStatuses[tabId] ?? "connecting",
      settings: {
        connectionTimeout: settings.connection.connectionTimeout,
        keepaliveInterval: settings.connection.keepaliveInterval,
        autoReconnect: settings.connection.autoReconnect,
        maxReconnectAttempts: settings.connection.maxReconnectAttempts,
        terminalType: settings.terminal.type,
        rowsMultiplier: settings.terminal.rowsMultiplier,
      },
      callbacks: {
        onConnectionInfo: (connection) => {
          useAppStore.getState().updateTerminalConnection(tabId, connection);
          connectionInfoCallbackRef.current?.(connection);
        },
        onSocketChange: (socket) => useAppStore.getState().setTerminalSocket(tabId, socket),
        onStatusChange: (nextStatus) => useAppStore.getState().setTabStatus(tabId, nextStatus),
        onSessionIdChange: (nextSessionId) => useAppStore.getState().setSessionId(tabId, nextSessionId),
        onConnectedChange: (connected) => useAppStore.getState().updateTabConnection(tabId, connected),
      },
    });
  }
  const sessionController = sessionControllerRef.current;
  const initialControllerSnapshot = sessionController.getSnapshot();
  const [handoffPending, setHandoffPending] = useState(initialControllerSnapshot.handoffPending);
  const getInitialStatus = () => initialControllerSnapshot.status;

  const [status, setStatus] = useState<
    "connecting" | "connected" | "disconnected" | "error"
  >(getInitialStatus);

  const [progressStep, setProgressStep] = useState(initialControllerSnapshot.progressStep);
  const isVaultUnlocked = useAppStore((state) => state.isVaultUnlocked);
  const isClosing = useAppStore((state) => state.terminalClosures[tabId] === "closing");
  const [showOverlay, setShowOverlay] = useState(() => {
    const s = getInitialStatus();
    // On session handoff, skip the heavy connection overlay
    // even though we still briefly go through the "connecting" state.
    if (isSessionHandoff && s === "connecting") return false;
    // For fresh connections, show overlay while connecting.
    return s === "connecting";
  });
  const [overlayExiting, setOverlayExiting] = useState(false);
  useEffect(() => {
    containerRef.current?.toggleAttribute("inert", showOverlay);
  }, [showOverlay]);
  const overlayExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(initialControllerSnapshot.errorMessage);
  const [isVaultError, setIsVaultError] = useState(initialControllerSnapshot.isVaultError);
  const [sessionUnavailable, setSessionUnavailable] = useState(initialControllerSnapshot.sessionUnavailable);
  const [apiBase, setApiBase] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const [showZoomIndicator, setShowZoomIndicator] = useState(false);
  const zoomTimerRef = useRef<any>(null);

  // --- Search State Management ---
  const searchStatesRef = useRef<Record<string, { 
    isOpen: boolean; 
    searchText: string;
    resultCount: number;
    resultIndex: number;
  }>>({});
  
  // Local state for the CURRENT rendering tab
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [resultCount, setResultCount] = useState(0);
  const [resultIndex, setResultIndex] = useState(-1);
  const [latency, setLatency] = useState<number | null>(initialControllerSnapshot.latency);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [launcherQuery, setLauncherQuery] = useState("");
  const [launcherIndex, setLauncherIndex] = useState(0);
  const launcherInputRef = useRef<HTMLInputElement>(null);
  const launcherOpenRef = useRef(false);
  const launcherIndexRef = useRef(0);
  const launcherItemsRef = useRef<LauncherItem[]>([]);
  const launcherListRef = useRef<HTMLDivElement>(null);
  const launcherItemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const quickActionsRef = useRef(quickActions);

  const normalizeCommand = (raw: string) => raw.replace(/\s+/g, " ").trim();

  const loadRecentCommands = (): RecentCommandEntry[] => {
    cleanupPersistedRecentCommands();
    return recentCommandCache;
  };

  const [recentCommands, setRecentCommands] = useState<RecentCommandEntry[]>(loadRecentCommands);
  
  const searchInputRef = useRef<HTMLInputElement>(null);
  const keywordDecorationsRef = useRef<any[]>([]);
  const lastHighlightedLineRef = useRef<number>(-1);
  const applyHighlightsRef = useRef<any>(null);
  
  // Track last copied text for intelligent right-click behavior
  const lastCopiedTextRef = useRef<string>("");
  useEffect(() => {
    recentCommandCache = recentCommands.slice(0, 40);
    cleanupPersistedRecentCommands();
  }, [recentCommands]);

  const pushRecentCommand = useCallback((rawCommand: string) => {
    const norm = normalizeCommand(rawCommand);
    if (!norm) return;
    const now = Date.now();
    setRecentCommands((prev) => {
      const existingIdx = prev.findIndex((c) => c.command === norm);
      if (existingIdx >= 0) {
        const updated = [...prev];
        const existing = updated[existingIdx];
        updated.splice(existingIdx, 1);
        updated.unshift({ ...existing, count: existing.count + 1, lastUsed: now });
        return updated.slice(0, 40);
      }
      return [{ command: norm, count: 1, lastUsed: now }, ...prev].slice(0, 40);
    });
  }, []);

  const executeCommand = useCallback((command: string, record = true) => {
    if (!sendQuickAction(tabId, command)) {
      addToast("Terminal is not connected", "error");
      return false;
    }
    if (record) {
      // Only explicit saved-action execution may populate recent commands.
      // Terminal input/echo cannot reliably distinguish commands from secrets.
      pushRecentCommand(command);
    }
    return true;
  }, [tabId, addToast, pushRecentCommand]);

  const openLauncher = useCallback(() => {
    setIsLauncherOpen(true);
    setLauncherQuery("");
    setLauncherIndex(0);
    setTimeout(() => launcherInputRef.current?.focus(), 0);
  }, []);

  const closeLauncher = useCallback(() => {
    setIsLauncherOpen(false);
    setLauncherQuery("");
    setLauncherIndex(0);
    useAppStore.getState().terminalInstances[tabId]?.focus();
  }, [tabId]);

  const launcherItems = React.useMemo<LauncherItem[]>(() => {
    const q = launcherQuery.trim().toLowerCase();
    const quick = quickActions.map((a, idx) => ({
      id: `quick-${a.id}`,
      label: a.label || `Quick Action ${idx + 1}`,
      command: a.command,
      source: "quick" as const,
      meta: a.category || "Quick Action",
    }));
    const recent = [...recentCommands]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((entry, idx) => ({
        id: `recent-${idx}`,
        label: entry.command,
        command: entry.command,
        source: "recent" as const,
        meta: "Recent",
        usageCount: entry.count,
        lastUsed: entry.lastUsed,
      }));
    const merged = [...quick, ...recent];
    if (!q) return merged.slice(0, 12);
    return merged
      .filter((item) =>
        item.label.toLowerCase().includes(q) ||
        item.command.toLowerCase().includes(q) ||
        (item.meta || "").toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [quickActions, recentCommands, launcherQuery]);

  useEffect(() => {
    if (launcherIndex > launcherItems.length - 1) setLauncherIndex(0);
  }, [launcherItems, launcherIndex]);

  useEffect(() => {
    launcherOpenRef.current = isLauncherOpen;
  }, [isLauncherOpen]);

  useEffect(() => {
    launcherIndexRef.current = launcherIndex;
  }, [launcherIndex]);

  useEffect(() => {
    launcherItemsRef.current = launcherItems;
  }, [launcherItems]);

  useEffect(() => {
    const item = launcherItems[launcherIndex];
    if (!item) return;
    const el = launcherItemRefs.current[item.id];
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [launcherIndex, launcherItems]);

  const exportRecentCommandsCsv = useCallback(async () => {
    if (!recentCommands.length) {
      addToast("No recent commands to export", "info");
      return;
    }

    const header = "command,count,lastUsed\n";
    const rows = [...recentCommands]
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .map((entry) => {
        const escaped = entry.command.replace(/"/g, '""');
        return `"${escaped}",${entry.count},${new Date(entry.lastUsed).toISOString()}`;
      })
      .join("\n");
    const csv = header + rows;

    const fileName = `netrix_recent_commands_${new Date().toISOString().slice(0, 10)}.csv`;

    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

      // Modern browsers: prompt with Save File Picker (lets user choose location; defaults to Downloads).
      const savePicker = (window as any).showSaveFilePicker;
      if (typeof savePicker === "function") {
        const handle = await savePicker({
          suggestedName: fileName,
          types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        addToast("CSV exported", "success");
        return;
      }

      // Tauri: use native save dialog + write file
      const tauri = (window as any).__TAURI__;
      if (tauri?.dialog?.save && tauri?.fs?.writeTextFile) {
        const targetPath = await tauri.dialog.save({
          defaultPath: fileName,
          filters: [{ name: "CSV", extensions: ["csv"] }],
        });
        if (targetPath) {
          await tauri.fs.writeTextFile(targetPath, csv);
          addToast("CSV exported", "success");
          return;
        }
      }

      // Fallback: force a download via anchor (lands in default Downloads folder)
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      addToast("CSV exported", "success");
    } catch (err) {
      // Final fallback: copy to clipboard so the user can save manually.
      try {
        await copyTextWithAutoClear(csv);
        addToast("CSV copied to clipboard", "success");
      } catch (clipErr) {
        console.error("CSV export failed", err || clipErr);
        addToast("Failed to export CSV", "error");
      }
    }
  }, [recentCommands, addToast]);

  useEffect(() => {
    quickActionsRef.current = quickActions;
  }, [quickActions]);

  // Check if this terminal is currently visible
  const isVisible = tabId === "detached" || (activeView === "terminal" && activeTabId === tabId);

  // Restore search state for this tab
  useEffect(() => {
    const state = searchStatesRef.current[tabId] || { 
      isOpen: false, 
      searchText: "", 
      resultCount: 0,
      resultIndex: -1
    };
    setIsSearchOpen(state.isOpen);
    setSearchText(state.searchText);
    setResultCount(state.resultCount);
    setResultIndex(state.resultIndex);
  }, [tabId]);

  const updateSearchState = useCallback((
    updates: Partial<{ 
      isOpen: boolean; 
      searchText: string; 
      resultCount: number;
      resultIndex: number;
    }>
  ) => {
    const currentState = searchStatesRef.current[tabId] || { 
      isOpen: false, 
      searchText: "", 
      resultCount: 0,
      resultIndex: -1
    };
    
    const newState = { ...currentState, ...updates };
    searchStatesRef.current[tabId] = newState;
    
    // Update local state if we are the active tab
    if (updates.isOpen !== undefined) setIsSearchOpen(updates.isOpen);
    if (updates.isOpen) setIsLauncherOpen(false);
    if (updates.searchText !== undefined) setSearchText(updates.searchText);
    if (updates.resultCount !== undefined) setResultCount(updates.resultCount);
    if (updates.resultIndex !== undefined) setResultIndex(updates.resultIndex);
  }, [tabId]);

  const getSearchDecorations = useCallback(() => {
    const matchBg = settings.terminal.searchMatchBackground || '#ffffff20';
    const activeMatchBg = settings.terminal.searchActiveMatchBackground || '#eab30899';
    
    // xterm-addon-search overview ruler properties strictly require #RRGGBB according to some implementations
    const to6Digit = (hex: string) => hex.length > 7 ? hex.slice(0, 7) : hex;

    return {
      matchBackground: matchBg,
      activeMatchBackground: activeMatchBg,
      activeMatchColorOverviewRuler: to6Digit(activeMatchBg),
      matchOverviewRuler: to6Digit(matchBg)
    };
  }, [settings.terminal.searchMatchBackground, settings.terminal.searchActiveMatchBackground]);

  const getSearchAddon = (term: Terminal): SearchAddon => {
    if (!(term as any)._searchAddon) {
      const addon = new SearchAddon();
      term.loadAddon(addon);
      (term as any)._searchAddon = addon;
    }
    return (term as any)._searchAddon;
  };
  
  useEffect(() => sessionController.subscribe((snapshot) => {
    setStatus(snapshot.status);
    setErrorMessage(snapshot.errorMessage);
    setIsVaultError(snapshot.isVaultError);
    setSessionUnavailable(snapshot.sessionUnavailable);
    setLatency(snapshot.latency);
    setHandoffPending(snapshot.handoffPending);
    setProgressStep(snapshot.progressStep);
  }), [sessionController]);

  useEffect(() => {
    sessionController.configure({
      host,
      initialSessionId,
      settings: {
        connectionTimeout: settings.connection.connectionTimeout,
        keepaliveInterval: settings.connection.keepaliveInterval,
        autoReconnect: settings.connection.autoReconnect,
        maxReconnectAttempts: settings.connection.maxReconnectAttempts,
        terminalType: settings.terminal.type,
        rowsMultiplier: settings.terminal.rowsMultiplier,
      },
    });
  }, [host, initialSessionId, sessionController, settings.connection, settings.terminal.rowsMultiplier, settings.terminal.type]);

  const scheduleOverlayExit = useCallback(() => {
    if (sessionController.getSnapshot().status !== "connected" || overlayExitTimerRef.current) return;
    setOverlayExiting(true);
    overlayExitTimerRef.current = setTimeout(() => {
      setShowOverlay(false);
      setOverlayExiting(false);
      overlayExitTimerRef.current = null;
    }, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  }, [sessionController]);

  const handleReconnect = useCallback(() => {
    setStatus("connecting");
    setIsVaultError(false);
    setErrorMessage(null);
    setProgressStep(null);
    if (overlayExitTimerRef.current) {
      clearTimeout(overlayExitTimerRef.current);
      overlayExitTimerRef.current = null;
    }
    setOverlayExiting(false);
    setShowOverlay(!hasExistingSession());
    sessionController.reconnect();
  }, [hasExistingSession, sessionController]);

  useEffect(() => {
    if (status === "connected") return;

    if (overlayExitTimerRef.current) {
      clearTimeout(overlayExitTimerRef.current);
      overlayExitTimerRef.current = null;
    }
    setOverlayExiting(false);
    if (status === "connecting" && hasExistingSession()) {
      setShowOverlay(false);
      return;
    }

    // For connecting, disconnected, and error states show the overlay so the
    // user always sees the state badge after returning from another module.
    setShowOverlay(true);
  }, [status, hasExistingSession]);

  useEffect(() => {
    return () => {
      if (overlayExitTimerRef.current) {
        clearTimeout(overlayExitTimerRef.current);
      }
    };
  }, []);

  // Connect Result Tracker
  useEffect(() => {
    const term = currentTerminalInstance;
    if (!term) return;

    const addon = getSearchAddon(term);
    
    const disposable = addon.onDidChangeResults((e: { resultCount: number; resultIndex: number }) => {
        updateSearchState({ resultCount: e.resultCount, resultIndex: e.resultIndex });
    });

    return () => {
        disposable.dispose();
    };
  }, [tabId, currentTerminalInstance, updateSearchState]);


  // Clean up decorations when search closes
  useEffect(() => {
    if (!isSearchOpen) {
        const term = currentTerminalInstance;
        if (term) {
            const addon = getSearchAddon(term);
            addon.clearDecorations(); 
            term.clearSelection(); // Clear the search highlight selection
        }
    }
  }, [isSearchOpen, tabId, currentTerminalInstance]);

  const handleFindNext = () => {
    const term = currentTerminalInstance;
    if (term) {
      const addon = getSearchAddon(term);
      addon.findNext(searchText, { 
        decorations: getSearchDecorations()
      });
    }
  };

  const handleFindPrevious = () => {
    const term = currentTerminalInstance;
    if (term) {
      const addon = getSearchAddon(term);
      addon.findPrevious(searchText, { 
        decorations: getSearchDecorations()
      });
    }
  };

  const closeSearch = () => {
    updateSearchState({ isOpen: false }); 
    currentTerminalInstance?.focus();
  };

  // Auto-search when text or options change
  useEffect(() => {
    if (isSearchOpen) {
      const term = currentTerminalInstance;
      if (term) {
        const addon = getSearchAddon(term);
        if (searchText) {
            addon.findNext(searchText, { 
                incremental: true,
                decorations: getSearchDecorations()
            });
        }
      }
    }
  }, [searchText, isSearchOpen, tabId, currentTerminalInstance, getSearchDecorations]);

  // Special effect to force refresh decorations when COLORS change
  useEffect(() => {
    if (isSearchOpen) {
      const term = currentTerminalInstance;
      if (term && searchText) {
        const addon = getSearchAddon(term);
        // Force a re-search with new decorations
        addon.findNext(searchText, { 
            incremental: true,
            decorations: getSearchDecorations()
        });
      }
    }
  }, [settings.terminal.searchMatchBackground, settings.terminal.searchActiveMatchBackground, isSearchOpen, searchText, tabId, currentTerminalInstance]);

  // Focus input when opened
  useEffect(() => {
    if (isSearchOpen) {
      setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
      }, 100);
    }
  }, [isSearchOpen]);

  // Global window trap for Ctrl+F and global active Esc
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (!isVisible) return;

      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }
      
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        if (launcherOpenRef.current) closeLauncher();
        else openLauncher();
        return;
      }
      if (e.key === "Escape" && launcherOpenRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closeLauncher();
        return;
      }

      // Ctrl+F Trap
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        
        const current = searchStatesRef.current[tabId];
        updateSearchState({ isOpen: true, searchText: current?.searchText || "" });
        
        // Force focus and select if already open
        setTimeout(() => {
             searchInputRef.current?.focus();
             searchInputRef.current?.select();
        }, 10);
      }

      // Escape Trap (Robustness)
      if (e.key === 'Escape') {
         const current = searchStatesRef.current[tabId];
         if (current?.isOpen) {
             e.preventDefault();
             e.stopPropagation();
             updateSearchState({ isOpen: false });
             currentTerminalInstance?.focus();
         }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true); // Capture phase to beat others
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [isVisible, tabId, updateSearchState, currentTerminalInstance, openLauncher, closeLauncher]);

  // --- Keyword Highlighting Implementation ---
  const applyHighlights = useCallback((start: number, end: number) => {
    const term = currentTerminalInstance;
    const rules = settings.terminal.highlightRules?.filter(r => r.keyword && r.isActive) || [];
    if (!term || rules.length === 0) return;

    for (let i = start; i <= end; i++) {
      const line = term.buffer.active.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      
      // Clear existing keyword decorations for THIS specific line to avoid overlaps
      keywordDecorationsRef.current.forEach(d => {
        if (d.marker.line === i) d.dispose();
      });

      rules.forEach(rule => {
        let pos = text.indexOf(rule.keyword);
        while (pos !== -1) {
          const cursorLine = term.buffer.active.baseY + term.buffer.active.cursorY;
          const marker = term.registerMarker(i - cursorLine);
          if (marker) {
            const decoration = term.registerDecoration({
              marker,
              x: pos,
              width: rule.keyword.length,
              ...(rule.highlightType === 'foreground' 
                ? { foregroundColor: rule.color } 
                : { backgroundColor: rule.color + '44' }) // 25% opacity for background
            });
            if (decoration) {
              keywordDecorationsRef.current.push(decoration);
              decoration.onDispose(() => {
                keywordDecorationsRef.current = keywordDecorationsRef.current.filter(d => d !== decoration);
              });
            }
          }
          pos = text.indexOf(rule.keyword, pos + 1);
        }
      });
    }
  }, [tabId, currentTerminalInstance, settings.terminal.highlightRules]);

  // Update ref whenever applyHighlights changes
  useEffect(() => {
    applyHighlightsRef.current = applyHighlights;
  }, [applyHighlights]);

  // Re-scan buffer when rules change
  useEffect(() => {
    const term = currentTerminalInstance;
    if (!term) return;

    // Clear existing decorations
    keywordDecorationsRef.current.forEach(d => d.dispose());
    keywordDecorationsRef.current = [];

    const rules = settings.terminal.highlightRules?.filter(r => r.keyword && r.isActive) || [];
    if (rules.length === 0) return;

    // Scan the entire current scrollback
    const totalLines = term.buffer.active.length;
    applyHighlights(0, totalLines - 1);
    lastHighlightedLineRef.current = term.buffer.active.baseY + term.buffer.active.cursorY;
  }, [tabId, settings.terminal.highlightRules, currentTerminalInstance]);

  // Sync highlights on new data (handled in ws.onmessage)

  // Active settings with fallback to global
  const activeTheme = host.terminal_theme || globalTheme;
  const activeColors = useMemo(() => getThemeColors(activeTheme, {
    terminal_background: host.terminal_background,
    terminal_foreground: host.terminal_foreground,
    terminal_appearance: host.terminal_appearance,
  }), [activeTheme, host.terminal_background, host.terminal_foreground, host.terminal_appearance]);
  const activeSurface = getTerminalSurface(activeTheme, host.terminal_background);
  const rendererColors = useMemo(() => activeSurface.backgroundImage === "none" ? activeColors : {
    ...activeColors,
    // Let the shared surface show through default cells; explicit ANSI
    // backgrounds stay opaque. Keep RGB for inverse text and cursor contrast.
    background: `${activeColors.background}00`,
    cursorAccent: activeColors.background,
  }, [activeColors, activeSurface.backgroundImage]);
  const [liveFontSize, setLiveFontSize] = useState(host.terminal_font_size || globalFontSize);

  useEffect(() => {
    setLiveFontSize(host.terminal_font_size || globalFontSize);
  }, [host.terminal_font_size, globalFontSize]);

  const activeFontSize = liveFontSize;

  useEffect(() => {
    const initData = async () => {
      try {
        setApiBase(await getApiBase());
      } catch (err) {
        console.error("[Netrix] Failed to initialize terminal bases:", err);
      }
    };
    void initData();
  }, []);

  const settingsSaveGeneration = useRef(0);
  const saveHostSettings = async (updates: HostConnectionUpdate) => {
    if (host.id === -1) { updateTabHost(host.id, updates); return; }
    const generation = ++settingsSaveGeneration.current;
    try {
      await useAppStore.getState().patchHost(host.id, updates);
    } catch (error) {
      if (generation === settingsSaveGeneration.current) {
        const saved = useAppStore.getState().hosts.find(h => h.id === host.id);
        setLiveFontSize(saved?.terminal_font_size || globalFontSize);
      }
      addToast(error instanceof Error ? error.message : "Failed to save settings", "error");
    }
  };

  const performFit = () => {
    if (sessionController.getSnapshot().handoffPending) return;
    if (!fitAddonRef.current) return;
    requestAnimationFrame(() => {
      try {
        if (containerRef.current && containerRef.current.clientWidth > 0) {
          fitAddonRef.current?.fit();
        }
      } catch (e) {}
    });
  };

  useEffect(() => {
    if (!isVisible || activeView !== "terminal" || showOverlay) return;
    performFit();
    const focusTimer = window.setTimeout(() => {
      if (document.activeElement instanceof HTMLElement
        && document.activeElement.closest("[data-terminal-workspace-controls], [data-terminal-history-control], [data-terminal-session-control]")) return;
      if (isLauncherOpen) launcherInputRef.current?.focus();
      else if (isSearchOpen) searchInputRef.current?.focus();
      else currentTerminalInstance?.focus();
    }, 50);
    return () => window.clearTimeout(focusTimer);
  }, [isVisible, activeView, tabId, currentTerminalInstance, handoffPending, isLauncherOpen, isSearchOpen, showOverlay]);

  useEffect(() => {
    const term = currentTerminalInstance;
    if (term) {
      const baseTheme = rendererColors;
      // If search is open, override selection background to match active search highlight
      // This is because search addon selects the active match, and the terminal's 
      // theme-defined selection color would otherwise override the decoration.
      if (isSearchOpen && settings.terminal.searchActiveMatchBackground) {
        term.options.theme = {
          ...baseTheme,
          selectionBackground: settings.terminal.searchActiveMatchBackground
        };
      } else {
        term.options.theme = baseTheme;
      }
    }
  }, [rendererColors, tabId, isSearchOpen, settings.terminal.searchActiveMatchBackground, currentTerminalInstance]);

  useEffect(() => {
    const term = currentTerminalInstance;
    if (term) {
      term.options.fontSize = activeFontSize;
      setTimeout(performFit, 50);
    }
  }, [activeFontSize, tabId]);

  useEffect(() => {
    const term = currentTerminalInstance;
    if (term) {
      applyTerminalPreferences(term, settings, host.terminal_appearance);
      const timer = window.setTimeout(performFit, 50);
      return () => window.clearTimeout(timer);
    }
  }, [settings.terminal.fontFamily, settings.terminal.cursorStyle, settings.terminal.cursorBlink,
    settings.terminal.scrollbackLines, settings.keyboard.scrollOnKeyPress, host.terminal_appearance, tabId, currentTerminalInstance]);

  const copySession = async () => {
    const term = currentTerminalInstance;
    if (!term) return;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString(true));
    }
    try {
      await copyTextWithAutoClear(lines.join("\n").trimEnd());
      addToast("Session copied", "success");
    } catch (err) {
      addToast("Failed to copy", "error");
    }
    setContextMenu(null);
  };

  const copySelection = async () => {
    const term = currentTerminalInstance;
    if (!term) return;
    const selection = term.getSelection();
    if (selection) {
      try {
        await copyTextWithAutoClear(selection);
        addToast("Copied", "success");
      } catch (err) {
        addToast("Failed to copy", "error");
      }
    }
    setContextMenu(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      const newFontSize = Math.min(Math.max(activeFontSize + delta, 8), 40);
      if (newFontSize !== activeFontSize) {
        setLiveFontSize(newFontSize);
        saveHostSettings({ terminal_font_size: newFontSize });
        setShowZoomIndicator(true);
        if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
        zoomTimerRef.current = setTimeout(() => setShowZoomIndicator(false), 1200);
      }
    }
  };

  const isInteractiveTarget = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(
      target.closest(
        'input, textarea, select, button, a, [role="button"], [data-terminal-history-control], [data-terminal-session-control], [contenteditable="true"]',
      ),
    );
  };

  const handleTerminalPaneClick = (e: React.MouseEvent) => {
    if (isInteractiveTarget(e.target)) return;
    currentTerminalInstance?.focus();
  };

  // Handle middle-click paste
  const handleMouseDown = async (e: React.MouseEvent) => {
    if (isInteractiveTarget(e.target)) return;

    if (e.button === 1 && settings.keyboard.pasteOnMiddleClick) {
      e.preventDefault();
      const ws = terminalSockets[tabId];
      const term = currentTerminalInstance;
      if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
      
      try {
        await pasteHandlerRef.current?.readClipboard();
      } catch (err) {
        console.error("Failed to paste on middle click:", err);
      }
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    if (isInteractiveTarget(e.target)) return;

    e.preventDefault();
    const term = currentTerminalInstance;
    if (!term) return;

    if (settings.keyboard.rightClickAction === "paste") {
      try {
        await pasteHandlerRef.current?.readClipboard();
      } catch (err) {}
      return;
    }

    if (settings.keyboard.rightClickAction === "contextMenu") {
      setContextMenu({ x: e.clientX, y: e.clientY });
      return;
    }

    // Simple Copy-then-Paste behavior for "copy" mode
    const selection = term.getSelection();
    
    if (selection && selection.length > 0) {
      // There's a selection - always copy it
      try {
        await copyTextWithAutoClear(selection);
        lastCopiedTextRef.current = selection; // Track this copy

        // Clear selection so next right-click will paste
        setTimeout(() => term.clearSelection(), 10);
      } catch (err) {
        addToast("Failed to copy", "error");
      }
    } else {
      // No selection - paste from clipboard
      try {
        if (await pasteHandlerRef.current?.readClipboard() === false) {
          // Clipboard is empty - show context menu as fallback
          setContextMenu({ x: e.clientX, y: e.clientY });
        }
      } catch (err) {
        // Error reading clipboard - show context menu
        setContextMenu({ x: e.clientX, y: e.clientY });
      }
    }
  };

  useEffect(() => {
    const handleClick = () => {
        setContextMenu(null);
    };
    if (contextMenu) {
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }
  }, [contextMenu]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      ...terminalRuntimeOptions(settingsRef.current, host.terminal_appearance),
      fontSize: activeFontSize,
      convertEol: true,
      theme: rendererColors,
      // Must be enabled before open, including when switching to Default Dark later.
      allowTransparency: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
    });
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank");
    }, {
      urlRegex: /https?:\/\/[^\s'"<>\]\)]+|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/[^\s'"<>\]\)]*)?/,
    }));
    try {
      term.loadAddon(new ImageAddon());
    } catch {
      // Image support is optional on xterm versions without the proposal.
    }

    const searchAddon = getSearchAddon(term);
    (term as Terminal & { _searchAddon?: SearchAddon })._searchAddon = searchAddon;
    const bellDisposable = term.onBell(() => {
      const volume = terminalBellGain(settingsRef.current);
      if (volume === 0) return;
      try {
        const AudioContextConstructor =
          window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextConstructor) return;
        const context = new AudioContextConstructor();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.frequency.value = 800;
        gain.gain.value = volume;
        oscillator.start();
        window.setTimeout(() => {
          oscillator.stop();
          void context.close();
        }, 100);
      } catch {
        // Bell playback is best-effort.
      }
    });

    container.innerHTML = "";
    term.open(container);
    fitAddonRef.current = fitAddon;
    setTerminalInstance(tabId, term);

    let rendererDisposed = false;
    const flush = () => new Promise<void>((resolve) => term.write("", resolve));
    const detachRenderer = sessionController.attachRenderer((data, _replay, reset) => {
      if (rendererDisposed) return;
      if (reset) {
        // Queue the reset behind pending output, ahead of the incoming replay.
        term.write("\x1bc", () => { lastHighlightedLineRef.current = -1; });
        return;
      }
      const isAtBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      term.write(data, () => {
        if (rendererDisposed) return;
        const currentLine = term.buffer.active.baseY + term.buffer.active.cursorY;
        if (currentLine !== lastHighlightedLineRef.current) {
          const start = Math.max(0, lastHighlightedLineRef.current);
          applyHighlightsRef.current?.(start, currentLine);
          lastHighlightedLineRef.current = currentLine;
        } else if (data.length > 0) {
          applyHighlightsRef.current?.(currentLine, currentLine);
        }
      });
      if (settingsRef.current.keyboard.scrollOnOutput && isAtBottom) {
        term.scrollToBottom();
      }
    }, {
      flush,
      capture: () => new Promise((resolve, reject) => {
        term.write("", () => {
          if (rendererDisposed) { reject(new Error("The terminal view was closed.")); return; }
          const selection = term.getSelectionPosition();
          resolve({
            serialized: serializeAddon.serialize(),
            cols: term.cols,
            rows: term.rows,
            viewportY: term.buffer.active.viewportY,
            selection: selection ? {
              column: selection.start.x,
              row: selection.start.y,
              length: (selection.end.y - selection.start.y) * term.cols + selection.end.x - selection.start.x,
            } : undefined,
          });
        });
      }),
      restore: (view) => new Promise((resolve) => {
        term.resize(view.cols, view.rows);
        term.write(view.serialized + (view.parserTail ?? ""), () => {
          if (!rendererDisposed) {
            term.scrollToLine(view.viewportY);
            if (view.selection) term.select(view.selection.column, view.selection.row, view.selection.length);
          }
          resolve();
        });
      }),
    });

    const dataDisposable = term.onData((data: string) => {
      // Forward input without collecting it: password prompts, pasted secrets
      // and interactive programs use the same stream as ordinary shell input.
      sessionController.send(data);

    });
    const keyDisposable = term.onKey(({ key }) => {
      if (!term.options.disableStdin) broadcastUserInput(tabId, key);
    });

    const pasteHandler = createTerminalPasteHandler(tabId, term, sessionController);
    pasteHandlerRef.current = pasteHandler;
    const handleNativePaste = (event: ClipboardEvent) => {
      // Capture before xterm's textarea listener can forward unreviewed bytes.
      event.preventDefault();
      event.stopImmediatePropagation();
      pasteHandler.paste(event.clipboardData?.getData("text/plain") ?? "");
    };
    container.addEventListener("paste", handleNativePaste, true);

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      sessionController.updateSize(cols, rows);
    });

    const selectionDisposable = term.onSelectionChange(() => {
      if (!settingsRef.current.keyboard.copyOnSelect) return;
      const selection = term.getSelection();
      if (!selection) return;
      copyTextWithAutoClear(selection).then(() => {
        lastCopiedTextRef.current = selection;
      }).catch(() => {});
    });

    term.attachCustomKeyEventHandler((event) => {
      const current = searchStatesRef.current[tabId];
      if (
        (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && event.key.toLowerCase() === "p"
        && event.type === "keydown"
      ) {
        event.preventDefault();
        if (launcherOpenRef.current) closeLauncher();
        else openLauncher();
        return false;
      }

      if (
        event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && event.type === "keydown"
        && /^[1-9]$/.test(event.key)
      ) {
        const quickIndex = Number(event.key) - 1;
        const action = quickActionsRef.current[quickIndex];
        if (action?.command) {
          event.preventDefault();
          if (executeCommand(action.command, true)) addToast("Sent: " + action.label, "info");
          return false;
        }
      }

      if (launcherOpenRef.current) {
        if (event.key === "Escape" && event.type === "keydown") {
          event.preventDefault();
          closeLauncher();
          return false;
        }
        if (event.key === "ArrowDown" && event.type === "keydown") {
          event.preventDefault();
          setLauncherIndex((previous) => (previous + 1) % Math.max(1, launcherItemsRef.current.length));
          return false;
        }
        if (event.key === "ArrowUp" && event.type === "keydown") {
          event.preventDefault();
          setLauncherIndex((previous) =>
            (previous - 1 + Math.max(1, launcherItemsRef.current.length))
            % Math.max(1, launcherItemsRef.current.length));
          return false;
        }
        if (
          (event.key === "Enter" || event.key === "Tab")
          && event.type === "keydown"
        ) {
          event.preventDefault();
          const selected = launcherItemsRef.current[launcherIndexRef.current];
          if (selected) {
            executeCommand(selected.command, false);
            closeLauncher();
          }
          return false;
        }
      }

      if (current?.isOpen && event.key === "Escape" && event.type === "keydown") {
        updateSearchState({ isOpen: false });
        return false;
      }

      if (
        (event.ctrlKey || event.metaKey)
        && event.key.toLowerCase() === "f"
        && event.type === "keydown"
      ) {
        event.preventDefault();
        updateSearchState({ isOpen: true, searchText: current?.searchText || "" });
        window.setTimeout(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }, 10);
        return false;
      }

      if (
        (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && event.key.toLowerCase() === "c"
        && event.type === "keydown"
      ) {
        event.preventDefault();
        const selection = term.getSelection();
        if (selection) {
          copyTextWithAutoClear(selection)
            .then(() => { lastCopiedTextRef.current = selection; })
            .catch(() => addToast("Failed to copy", "error"));
        }
        return false;
      }

      if (
        (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && event.key.toLowerCase() === "v"
        && event.type === "keydown"
      ) {
        event.preventDefault();
        void pasteHandler.readClipboard().catch(() => {});
        return false;
      }

      if (
        (event.ctrlKey || event.metaKey)
        && !event.altKey
        && (event.code === "KeyA" || event.key.toLowerCase() === "a")
        && event.type === "keydown"
      ) {
        event.preventDefault();
        term.selectAll();
        return false;
      }

      if (event.key === "Escape" && event.type === "keydown" && !current?.isOpen && term.hasSelection()) {
        event.preventDefault();
        term.clearSelection();
        return false;
      }

      return true;
    });

    try {
      if (!sessionController.getSnapshot().handoffPending) fitAddon.fit();
    } catch {
      // The next resize observer tick will retry once layout is stable.
    }
    sessionController.updateSize(term.cols, term.rows);

    if (suppressInitialConnectRef.current === null) {
      suppressInitialConnectRef.current = consumeInitialConnectSuppressed(tabId);
    }
    const suppressInitialConnect = suppressInitialConnectRef.current;
    const controllerSnapshot = sessionController.getSnapshot();
    const socket = sessionController.getSocket();
    const needsConnection =
      !socket
      || socket.readyState === WebSocket.CLOSED
      || socket.readyState === WebSocket.CLOSING;
    const shouldAutoConnect =
      !suppressInitialConnect
      && controllerSnapshot.status !== "disconnected"
      && controllerSnapshot.status !== "error";

    if (shouldAutoConnect && needsConnection) {
      void sessionController.connect();
    } else if (suppressInitialConnect && controllerSnapshot.status === "connecting") {
      sessionController.setExternalStatus("disconnected");
    }

    if (isVisible) term.focus();

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (rendererDisposed || !containerRef.current?.clientWidth || sessionController.getSnapshot().handoffPending) return;
        try {
          fitAddon.fit();
          sessionController.updateSize(term.cols, term.rows);
        } catch {
          // Ignore transient zero-size layout while views are changing.
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      rendererDisposed = true;
      container.removeEventListener("paste", handleNativePaste, true);
      pasteHandler.dispose();
      if (pasteHandlerRef.current === pasteHandler) pasteHandlerRef.current = null;
      resizeObserver.disconnect();
      detachRenderer();
      dataDisposable.dispose();
      keyDisposable.dispose();
      resizeDisposable.dispose();
      selectionDisposable.dispose();
      bellDisposable.dispose();
      keywordDecorationsRef.current.forEach((decoration) => decoration.dispose());
      keywordDecorationsRef.current = [];
      if (useAppStore.getState().terminalInstances[tabId] === term) {
        useAppStore.getState().setTerminalInstance(tabId, null);
      }
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
      term.dispose();
    };
  }, [sessionController, tabId]);

  return (
    <div
      className="terminal-session relative flex flex-col h-full w-full min-h-0 min-w-0"
      data-active={isVisible}
      style={activeSurface}
    >
      {tabId !== "detached" && <TerminalTransferOverlay tabId={tabId} />}


      <div
        className="terminal-session-output"
        onContextMenu={handleContextMenu}
        onMouseDown={handleMouseDown}
        onWheel={handleWheel}
        onClick={handleTerminalPaneClick}
      >
        <div
          id={viewportId}
          className={`terminal-history-viewport w-full h-full transition-opacity duration-150 motion-reduce:transition-none ${
            showOverlay && !overlayExiting
              ? "opacity-0"
              : "opacity-100"
          }`}
          ref={containerRef}
          aria-hidden={showOverlay}
        />

        {/* Terminal Hints overlay (Ctrl+Shift+H) */}
        <TerminalHints tabId={tabId} />

        <TerminalHistory terminal={currentTerminalInstance} viewportId={viewportId}
          enabled={!showOverlay && !handoffPending} actionsTarget={historyActionsTarget} />

        {showOverlay && <ConnectionStatusPanel
          host={host} status={status} progressStep={progressStep} errorMessage={errorMessage}
          sessionUnavailable={sessionUnavailable} vaultLocked={isVaultError && !isVaultUnlocked}
          exiting={overlayExiting} closing={isClosing} onReconnect={handleReconnect}
          onReady={scheduleOverlayExit}
          onClose={() => removeTerminalTab(tabId)}
          onUnlock={(password) => useAppStore.getState().unlockVault(password)}
        />}
      </div>

        {/* Docked search keeps terminal rows unobscured. */}
        {isSearchOpen && !isLauncherOpen && !showOverlay && (
          <div 
            id={`${viewportId}-search`} role="search" aria-label="Find in terminal"
            className="terminal-session-search" data-terminal-session-control
            onClick={(e) => e.stopPropagation()}
          >
             <div className="terminal-session-search-field">
               <IoSearchOutline className="text-gray-400 mr-2" size={14} />
               <input
                 ref={searchInputRef}
                 type="text"
                 value={searchText}
                 onChange={(e) => updateSearchState({ searchText: e.target.value })}
                 onKeyDown={(e) => {
                   if (e.key === 'Enter') {
                     e.preventDefault();
                     if (e.shiftKey) handleFindPrevious();
                     else handleFindNext();
                   }
                   if (e.key === 'Escape') {
                     e.preventDefault();
                     e.stopPropagation();
                     closeSearch();
                   }
                   if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') e.preventDefault();
                 }}
                 placeholder="Find..."
                 aria-label="Find in terminal output"
                 className="min-w-0 flex-1 bg-transparent border-none outline-none text-white text-xs placeholder-gray-500 font-mono"
                 autoFocus
               />
               
               {/* Search Result Count */}
               {searchText && resultCount > 0 && (
                 <span className="shrink-0 text-[10px] text-gray-400 font-mono mr-2 min-w-[30px] text-right">
                    {resultIndex >= 0 ? resultIndex + 1 : 0}/{resultCount}
                 </span>
               )}
               
             </div>
             
             <div className="flex items-center gap-0.5 ml-1">
               <button 
                  onClick={handleFindPrevious}
                  className="p-1 px-1.5 hover:bg-white/10 text-gray-400 hover:text-white rounded transition-colors"
                  title="Find Previous (Shift+Enter)"
                >
                  <IoArrowUp size={14} />
                </button>
                <button 
                  onClick={handleFindNext}
                  className="p-1 px-1.5 hover:bg-white/10 text-gray-400 hover:text-white rounded transition-colors"
                  title="Find Next (Enter)"
                >
                  <IoArrowDown size={14} />
                </button>

                <div className="w-px h-3 bg-white/10 mx-0.5" />

                <button 
                  onClick={closeSearch}
                  className="p-1 px-1.5 hover:bg-white/10 text-gray-400 hover:text-red-400 rounded transition-colors"
                  title="Close Search (Esc)"
                >
                  <IoClose size={16} />
                </button>
             </div>
          </div>
        )}

        {/* The launcher occupies its own rows instead of covering terminal output. */}
        {isLauncherOpen && !showOverlay && (
          <div
            id={`${viewportId}-launcher`} role="region" aria-label="Terminal launcher"
            className="terminal-session-launcher custom-scrollbar" data-terminal-session-control
            ref={launcherListRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="terminal-session-launcher-header">
              <IoTerminal size={16} className="text-cyan-300" />
              <input
                ref={launcherInputRef}
                type="text"
                value={launcherQuery}
                onChange={(e) => {
                  setLauncherQuery(e.target.value);
                  setLauncherIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeLauncher();
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setLauncherIndex((prev) => (prev + 1) % Math.max(1, launcherItems.length));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setLauncherIndex((prev) => (prev - 1 + Math.max(1, launcherItems.length)) % Math.max(1, launcherItems.length));
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const selected = launcherItems[launcherIndex];
                    if (selected) {
                      executeCommand(selected.command, false);
                      closeLauncher();
                    }
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const selected = launcherItems[launcherIndex];
                    if (selected) {
                      executeCommand(selected.command, false);
                      closeLauncher();
                    }
                  }
                }}
                placeholder="Find a saved command..."
                aria-label="Find a saved command"
                className="terminal-session-launcher-input bg-transparent border-none outline-none text-xs text-white placeholder-gray-500 font-mono"
                autoFocus
              />
              <button
                onClick={(e) => {
                  e.preventDefault();
                  setLauncherQuery("");
                  setLauncherIndex(0);
                  launcherListRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  launcherInputRef.current?.focus();
                }}
                className="px-2 py-1 text-[11px] font-mono rounded-md border border-gray-600 text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
                title="Reset search and selection"
              >
                Reset
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault();
                  exportRecentCommandsCsv();
                }}
                className="px-2 py-1 text-[11px] font-mono rounded-md border border-cyan-400/30 text-cyan-200 hover:bg-cyan-500/10 hover:border-cyan-300/50 transition-colors"
                title="Export recent commands to CSV"
              >
                Export CSV
              </button>
              <button
                onClick={closeLauncher}
                className="terminal-session-launcher-close p-1.5 rounded-md hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                aria-label="Close launcher"
                title="Close"
              >
                <IoClose size={15} />
              </button>
            </div>

            <div className="terminal-session-launcher-list p-2">
              {launcherItems.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-gray-500 font-mono">
                  No commands found. Add saved Quick Actions to use the launcher.
                </div>
              ) : (
                launcherItems.map((item, idx) => (
                  <button
                    ref={(el) => { launcherItemRefs.current[item.id] = el; }}
                    key={item.id}
                    onMouseEnter={() => setLauncherIndex(idx)}
                    onClick={() => {
                      executeCommand(item.command, false);
                      closeLauncher();
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-all mb-1 ${
                      idx === launcherIndex
                        ? "bg-cyan-500/15 border-cyan-400/40 shadow-[0_0_18px_rgba(34,211,238,0.2)]"
                        : "bg-white/[0.02] border-transparent hover:border-white/10 hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-xs text-white font-semibold truncate">{item.label}</div>
                        <div className="text-[11px] text-gray-400 font-mono truncate">{item.command}</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {item.source === "recent" && (
                          <span className="text-[10px] text-gray-500 font-mono">×{item.usageCount || 1}</span>
                        )}
                        <span className={`text-[10px] font-bold uppercase tracking-wider ${
                          item.source === "quick" ? "text-cyan-300" : "text-amber-300"
                        }`}>
                          {item.source === "quick" ? "Quick" : "Recent"}
                        </span>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>

            <p className="px-4 pb-2 text-[10px] text-gray-500">
              History includes Quick Actions run with Alt+1–9. Typed and pasted terminal input is never recorded.
            </p>
            <div className="px-3 py-2 border-t border-white/10 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono text-gray-400">
              <span>Enter/Click/Tab: send saved text</span>
              <span>No Enter is added</span>
              <span>Esc: close</span>
              <span className="ml-auto">Alt+1..9: run top quick actions</span>
            </div>
          </div>
        )}

        {contextMenu && (
          <div
            className="fixed z-50 bg-[#1a1a1f] border border-gray-700 rounded-lg shadow-2xl py-1 min-w-[220px] animate-fade-in"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
             <button
               onClick={() => {
                 setContextMenu(null);
                 updateSearchState({ isOpen: true, searchText: searchText || "" });
               }}
               className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-primary/20 hover:text-white transition-colors text-left"
            >
               <div className="flex items-center gap-3">
                 <IoSearchOutline size={16} />
                 Find...
               </div>
               <span className="text-[10px] text-gray-600 font-mono">Ctrl+F</span>
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                openLauncher();
              }}
              className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-cyan-500/20 hover:text-white transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <IoTerminal size={16} />
                Launcher
              </div>
              <span className="text-[10px] text-gray-600 font-mono">Ctrl+Shift+P</span>
            </button>
            <button
               onClick={() => {
                 addTerminalTab(host);
                 setContextMenu(null);
               }}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-primary/20 hover:text-white transition-colors text-left"
             >
                <div className="flex items-center gap-3">
                  <IoDuplicate size={16} />
                  Duplicate Session
                </div>
             </button>
             <div className="border-t border-gray-700 my-1" />
             <button
               onClick={copySelection}
               className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-primary/20 hover:text-white transition-colors text-left"
            >
               <div className="flex items-center gap-3">
                 <IoDocuments size={16} />
                 Copy
               </div>
               <span className="text-[10px] text-gray-600 font-mono">Ctrl+Shift+C</span>
            </button>
             <button
              onClick={async () => {
                try {
                  await pasteHandlerRef.current?.readClipboard();
                } catch (e) {}
                setContextMenu(null);
              }}
              className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-primary/20 hover:text-white transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <IoDocuments size={16} />
                Paste
              </div>
              <span className="text-[10px] text-gray-600 font-mono">Ctrl+Shift+V</span>
            </button>
            <div className="border-t border-gray-700 my-1" />
            <button
              onClick={() => {
                const term = currentTerminalInstance;
                if (term) {
                  term.selectAll();
                  addToast("All text selected", "info");
                }
                setContextMenu(null);
              }}
              className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-primary/20 hover:text-white transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <IoDocuments size={16} />
                Select All
              </div>
              <span className="text-[10px] text-gray-600 font-mono">Ctrl+A</span>
            </button>
            <button
                onClick={() => {
                  const term = currentTerminalInstance;
                  if (term) term.clear();
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-red-500/20 hover:text-red-400 transition-colors text-left"
            >
               <IoTrash size={16} /> Clear Terminal
            </button>
          </div>
        )}

      <div className="terminal-session-toolbar" role="group" aria-label="Session controls" data-terminal-session-control>
        <button type="button" className="terminal-session-tool" aria-label="Open launcher"
          aria-expanded={isLauncherOpen && !showOverlay} aria-controls={`${viewportId}-launcher`}
          aria-keyshortcuts="Control+Shift+P Meta+Shift+P" title="Terminal launcher · Ctrl+Shift+P"
          disabled={showOverlay || handoffPending} onClick={() => isLauncherOpen ? closeLauncher() : openLauncher()}>
          <IoTerminal size={14} aria-hidden="true" /><span>Launcher</span>
        </button>
        <button type="button" className="terminal-session-tool" aria-label="Find in terminal"
          aria-expanded={isSearchOpen && !isLauncherOpen && !showOverlay} aria-controls={`${viewportId}-search`}
          aria-keyshortcuts="Control+F Meta+F" title="Find in terminal · Ctrl+F"
          disabled={showOverlay || handoffPending}
          onClick={() => isSearchOpen && !isLauncherOpen ? closeSearch() : updateSearchState({ isOpen: true })}>
          <IoSearchOutline size={14} aria-hidden="true" /><span>Find</span>
        </button>
        {showZoomIndicator && <span className="terminal-session-zoom" role="status" aria-label={`Terminal font size ${activeFontSize} pixels`}>{activeFontSize}px</span>}
        <div ref={setHistoryActionsTarget} className="terminal-session-history" />
        <span className="terminal-session-status"
          data-status={status === "connected" && latency === -1 ? "error" : status}
          title={status === "connected" ? latency === -1 ? "Connection health check failed" : latency !== null ? `Connected · ${latency}ms round-trip latency` : "Connected" : status}
          aria-label={status === "connected" ? latency === -1 ? "Connection unreachable" : latency !== null ? `Connected, ${latency} milliseconds` : "Connected" : status}>
          <span className="terminal-session-status-dot" aria-hidden="true" />
          <span className="terminal-session-status-text">{status === "connected" ? latency === -1 ? "Unreachable" : latency !== null ? `${latency}ms` : "Connected" : status === "connecting" ? "Connecting" : status === "error" ? "Error" : "Disconnected"}</span>
        </span>
      </div>
    </div>
  );
};

export default TerminalCanvas;
