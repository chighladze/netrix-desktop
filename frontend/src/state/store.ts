import { createDefaultSettings, loadAppSettings, sanitizeSettingsPatch, saveAppSettings } from "../features/settings/settings";
import { createHostsActions, type HostsActions } from "../features/hosts/actions";
import { createFolderActions } from "../features/hosts/folderActions";
import { parseHostsPreferences, type HostsPreferences } from "../features/hosts/presentation";
import { normalizeGroupPath, isValidGroupPath } from "../utils/groupUtils";
import { sendTerminalInput } from "../terminal/wire";
import type { TerminalConnectionInfo } from "../terminal/connectionInfo";
import { closeBackendSession } from "../terminal/closeSession";
import { canUseVaultKeychain, readVaultPassword, saveVaultPassword, removeVaultPassword } from "../features/vault/keychain";
import { Terminal } from "xterm";
import { create } from "zustand";
import { canFillTerminalPane, findTerminalGroup, paneLimit, terminalGroupSlots, type TerminalGroup } from "../features/workspace/groups";
import {
  ApiError,
  fetchJsonOrThrow,
  getApiBase,
} from "../api";
import type { Host, HostConnectionUpdate, SavedHostDto, TerminalHost } from "../types/host";
import { redactHostSecrets } from "../types/host";
import {
  disposeTerminalSessionController,
  ensureTerminalSessionController,
  getTerminalSessionController,
} from "../terminal/TerminalSessionController";

export type {
  ConnectionType,
  Host,
  HostConnectionUpdate,
  HostMutation,
  QuickConnectHost,
  QuickConnectRequest,
  SavedHostDto,
  TerminalHost,
} from "../types/host";

let fallbackClientIdCounter = 0;

const createClientId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  fallbackClientIdCounter += 1;
  return `client-${Date.now().toString(36)}-${fallbackClientIdCounter.toString(36)}`;
};

const deleteJsonOrIgnoreNotFound = async (url: string): Promise<void> => {
  try {
    await fetchJsonOrThrow<void>(url, { method: "DELETE" });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
};


export type HostCapabilityStatus =
  | "unknown"
  | "checking"
  | "supported"
  | "unsupported"
  | "auth_failed"
  | "error";

export interface HostCapability {
  host_id: number;
  capability: string;
  status: HostCapabilityStatus;
  reason?: string | null;
  checked_at?: string | null;
  expires_at?: string | null;
  can_probe: boolean;
}

export interface SftpDirectoryEntry {
  name: string;
  path: string;
  entry_type: "directory" | "file" | "symlink" | "other" | string;
  size?: number | null;
  modified_at?: string | null;
  permissions?: string | null;
}

export interface SftpListResponse {
  host_id: number;
  path: string;
  entries: SftpDirectoryEntry[];
}

export type SftpDirectoryStatus = "idle" | "loading" | "ready" | "error";

export interface SftpBrowserState {
  connectionKey?: string;
  hostId: number;
  directory: SftpListResponse | null;
  currentPath: string;
  directoryStatus: SftpDirectoryStatus;
  directoryError: string | null;
  selectedEntry: SftpDirectoryEntry | null;
  selectedEntries?: SftpDirectoryEntry[];
  updatedAt: number;
}

export interface Snippet {
  id: number;
  title: string;
  template: string;
  variables?: Record<string, any>;
  host_id?: number | null;
}

export interface QuickAction {
  id: string;
  label: string;
  command: string; // The text to send
  color: "green" | "red" | "blue" | "yellow" | "gray" | "purple";
  category?: string;
  description?: string;
}



export interface TerminalTab {
  id: string; // Unique tab ID
  host: TerminalHost;
  isConnected: boolean;
  sessionId?: number; // Track the backend session ID for reattachment
}

export type TabStatus = "connecting" | "connected" | "disconnected" | "error";

export interface OverlayState {
  progress: number;
  stepIndex: number;
}

export interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

export interface NetworkMapFocusRequest {
  id: string;
  mapId: string;
  nodeId?: string;
  hostId?: number;
}

export interface VaultStatus {
  unlocked: boolean;
  initialized: boolean;
  secretItems: number;
  linkedHosts: number;
}

export interface VaultActionResult {
  ok: boolean;
  error?: string;
}

interface VaultStatusDto {
  unlocked?: boolean;
  initialized?: boolean;
  secret_items?: number;
  linked_hosts?: number;
}

interface VaultPasswordChangeDto {
  changed?: boolean;
  rotated_items?: number;
}

interface VaultResetDto {
  reset?: boolean;
  initialized?: boolean;
  detached_hosts?: number;
  deleted_items?: number;
}

// ============ SETTINGS INTERFACES ============

export interface HighlightRule {
  id: string;
  keyword: string;
  color: string;
  highlightType: 'background' | 'foreground';
  isActive: boolean;
}

export interface TerminalSettings {
  newHostAppearance?: import("../types/terminalAppearance").TerminalAppearancePreset | null;
  fontFamily: string;
  fontSize: number;
  type: string; // 'xterm-256color', 'vt100', etc.
  theme: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollbackLines: number;
  bellSound: boolean;
  bellVolume: number;
  highlightRules: HighlightRule[];
  searchMatchBackground: string;
  searchActiveMatchBackground: string;
  rowsMultiplier: number;
}

export interface ConnectionSettings {
  defaultSSHPort: number;
  defaultTelnetPort: number;
  connectionTimeout: number;
  keepaliveInterval: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
}

export interface KeyboardSettings {
  copyOnSelect: boolean;
  rightClickAction: "paste" | "contextMenu" | "copy";
  pasteOnMiddleClick: boolean;
  scrollOnOutput: boolean;
  scrollOnKeyPress: boolean;
}

export interface WindowSettings {
  alwaysOnTop: boolean;
  rememberWindowPosition: boolean;
  tabPosition: "top" | "bottom";
  showTabCloseButton: boolean;
  confirmCloseMultipleTabs: boolean;
}



export interface SecuritySettings {
  autoLockEnabled: boolean;
  autoLockTimeout: number; // minutes
  clearClipboardAfter: number; // seconds, 0 = disabled
  confirmBeforeDisconnect: boolean;
  vaultUnlockMode: "session" | "every_start";
  vaultAutoLockEnabled: boolean;
  vaultAutoLockTimeout: number; // minutes
  vaultRememberPassword: boolean;
}

export interface AppSettings {
  terminal: TerminalSettings;
  connection: ConnectionSettings;
  keyboard: KeyboardSettings;
  window: WindowSettings;
  security: SecuritySettings;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  onConfirm: () => void;
  confirmText?: string;
  cancelText?: string;
  type?: "danger" | "warning" | "info";
}

export interface RecentConnection {
  host: Host;
  timestamp: number;
}

interface RecentConnectionApiItem {
  host: SavedHostDto;
  connected_at: string | number;
}

const loadRecentConnections = async (): Promise<RecentConnection[]> => {
  const baseUrl = await getApiBase();
  const data = await fetchJsonOrThrow<RecentConnectionApiItem[]>(
    `${baseUrl}/recent-connections`,
  );
  return data.map((item) => ({
    host: item.host,
    timestamp: new Date(item.connected_at).getTime(),
  }));
};

interface AppState extends HostsActions {
  appSecurity: { locked: boolean | null; revision: number; error: string | null;
    databaseMode?: "setup" | "upgrade" | "encrypted" | "open"; databaseEncrypted?: boolean; databaseBusy?: boolean };
  hosts: SavedHostDto[];
  hostsLoading: boolean;
  hostsError: string | null;
  hostsEpoch: number;
  selectedHost: TerminalHost | null;
  snippets: Snippet[];

  // Terminal tabs
  terminalTabs: TerminalTab[];
  activeTabId: string | null;
  terminalLayout: "single" | "columns" | "rows" | "grid";
  terminalGroups: TerminalGroup[];
  pendingTerminalGroupId: string | null;
  pendingTerminalPaneIndex: number | null;
  setTerminalGroup: (group: TerminalGroup) => void;
  ungroupTerminalTabs: (groupId: string) => void;
  extractTerminalTab: (tabId: string) => boolean;
  replaceTerminalPane: (groupId: string, previousId: string, nextId: string) => void;
  reserveTerminalPane: (index?: number) => void;
  insertTerminalPane: (groupId: string, index: number, tabId: string) => boolean;
  setTerminalLayout: (layout: "single" | "columns" | "rows" | "grid") => void;
  maximizeTerminalPane: (tabId: string) => void;
  activeView: 'hosts' | 'terminal' | 'snippets' | 'settings' | 'utilities' | 'network-map' | 'files' | 'connections';
  connectionsTab: "credentials" | "import" | "backups" | "known" | "tunnels";

  // Persistence for terminal sessions
  terminalInstances: Record<string, Terminal>;
  terminalSockets: Record<string, WebSocket>;
  sessionIds: Record<string, number | null>;
  terminalClosures: Record<string, "closing" | "failed">;
  terminalReconnectKeys: Record<string, number>;
  tabStatuses: Record<string, TabStatus>;
  overlayStates: Record<string, OverlayState>;

  // Broadcast mode — send input to multiple terminals simultaneously
  broadcastMode: boolean;
  broadcastTargets: Set<string>; // tab IDs included in broadcast

  // Settings
  terminalTheme: string;
  terminalFontSize: number;
  hostsViewMode: "grid" | "list" | "compact";
  hostsPreferences: HostsPreferences;
  setHostsPreferences: (preferences: Partial<HostsPreferences>) => void;
  settings: AppSettings;

  // UI State
  isSidebarExpanded: boolean;
  toasts: Toast[];
  confirmDialog: ConfirmOptions | null;

  // Tabs that should NOT auto-connect on first mount (used for
  // reattached tabs coming from a failed detached window)
  initialConnectSuppressed: Record<string, boolean>;
  terminalTransfers: Record<string, { direction: "outgoing" | "incoming"; phase: "preparing" | "connecting" | "finishing"; cancel: () => void }>;
  setTerminalTransfer: (tabId: string, transfer: AppState["terminalTransfers"][string] | null) => void;
  // Groups State
  collapsedGroups: Set<string>;

  // Recent Connections
  recentConnections: RecentConnection[];

  // SFTP / Files
  activeSftpHostId: number | null;
  openSftpHostIds: number[];
  sftpCapabilities: Record<number, HostCapability>;
  sftpBusyHosts: Record<number, boolean>;
  sftpBrowserStates: Record<number, SftpBrowserState>;

  // Network Map tab persistence (survives view switches)
  networkMapOpenIds: string[];
  networkMapActiveId: string | null;
  networkMapDetachedIds: string[];  // maps currently open in separate windows
  networkMapInitialized: boolean;   // true after first fetchMaps completes
  networkMapViewStates: Record<string, { x: number; y: number; w: number; h: number; zoom: number }>;
  networkMapFocusRequest: NetworkMapFocusRequest | null;

  setHosts: (hosts: SavedHostDto[]) => void;
  setSelectedHost: (host: Host | null) => void;
  setSnippets: (snippets: Snippet[]) => void;
  setHostsViewMode: (mode: "grid" | "list" | "compact") => void;

  // Quick Actions
  quickActions: QuickAction[];
  setQuickActions: (actions: QuickAction[]) => void;
  addQuickAction: (action: Omit<QuickAction, "id">) => Promise<boolean>;
  updateQuickAction: (id: string, action: Partial<QuickAction>) => Promise<boolean>;
  removeQuickAction: (id: string) => Promise<boolean>;

  // Confirmation actions
  showConfirm: (options: ConfirmOptions) => void;
  hideConfirm: () => void;

  // Notification actions
  addToast: (message: string, type?: "success" | "error" | "info") => void;
  removeToast: (id: string) => void;

  // UI actions
  setSidebarExpanded: (expanded: boolean) => void;
  reorderTerminalTabs: (tabs: TerminalTab[]) => void;


  // Control over initial auto-connect behavior per tab
  markInitialConnectSuppressed: (tabId: string) => void;
  consumeInitialConnectSuppressed: (tabId: string) => boolean;

  // Manual reconnection trigger
  triggerReconnect: (tabId: string) => void;

  // Tab actions
  addTerminalTab: (host: Host, sessionId?: number) => string;
  removeTerminalTab: (tabId: string, options?: { preserveSession?: boolean }) => Promise<boolean>;
  setActiveTabId: (tabId: string | null) => void;
  setActiveView: (view: AppState["activeView"], connectionsTab?: AppState["connectionsTab"]) => void;
  updateTabConnection: (tabId: string, isConnected: boolean) => void;
  // reorderTerminalTabs moved to UI actions section above

  // Session persistence actions
  setTerminalInstance: (tabId: string, terminal: Terminal | null) => void;
  setTerminalSocket: (tabId: string, socket: WebSocket | null) => void;
  setSessionId: (tabId: string, sessionId: number | null) => void;
  setTabStatus: (tabId: string, status: TabStatus) => void;
  setOverlayState: (tabId: string, overlay: OverlayState) => void;
  updateTabHost: (hostId: number, updates: HostConnectionUpdate) => void;
  updateTerminalConnection: (tabId: string, connection: TerminalConnectionInfo) => void;

  // Broadcast actions
  setBroadcastMode: (enabled: boolean) => void;
  toggleBroadcastTarget: (tabId: string) => void;
  setBroadcastTargets: (tabIds: string[]) => void;
  broadcastSend: (data: string) => void;

  // Layout persistence
  saveLayout: () => void;
  restoreLayout: () => void;

  // Settings actions
  setTerminalTheme: (theme: string) => void;
  setTerminalFontSize: (size: number) => void;
  updateSettings: <K extends keyof AppSettings>(
    category: K,
    updates: Partial<AppSettings[K]>,
  ) => boolean;
  resetSettings: (category?: keyof AppSettings) => boolean;
  getSettings: () => AppSettings;

  // Highlight Rules
  setHighlightRules: (rules: HighlightRule[]) => void;
  addHighlightRule: (rule: Omit<HighlightRule, "id">) => Promise<void>;
  updateHighlightRule: (id: string, updates: Partial<HighlightRule>) => Promise<void>;
  removeHighlightRule: (id: string) => Promise<void>;

  // Group Management
  hostGroupsBusy: boolean;
  moveHostFolder: (source: string, destination: string) => Promise<void>;
  toggleGroup: (groupPath: string) => void;
  expandAllGroups: () => void;
  collapseAllGroups: () => void;
  moveHostToGroup: (hostId: number, targetGroupPath: string | null) => Promise<void>;
  deleteGroupWithHosts: (groupPath: string, recursive: boolean) => Promise<void>;

  // Recent Connections
  addRecentConnection: (host: Host) => Promise<void>;
  clearRecentConnections: () => Promise<void>;
  fetchRecentConnections: () => Promise<void>;

  // SFTP / Files actions
  openSftpForHost: (host: Host) => Promise<void>;
  setActiveSftpHostId: (hostId: number | null) => void;
  clearActiveSftpHost: () => void;
  disconnectSftpHost: (hostId?: number) => void;
  setSftpBrowserState: (hostId: number, updates: Partial<Omit<SftpBrowserState, "hostId" | "updatedAt">>) => void;
  fetchSftpCapability: (hostId: number) => Promise<HostCapability | null>;
  probeSftpCapability: (hostId: number) => Promise<HostCapability | null>;

  // Explicitly created (possibly empty) groups
  definedGroups: Set<string>;
  addDefinedGroup: (path: string) => void;
  removeDefinedGroup: (path: string) => void;

  // Vault state
  isVaultUnlocked: boolean;
  vaultInitialized: boolean;
  vaultStatusLoaded: boolean;
  vaultSecretItems: number;
  vaultLinkedHosts: number;
  hasStoredVaultPassword: boolean;
  refreshVaultStatus: () => Promise<VaultStatus | null>;
  refreshStoredVaultPasswordState: () => Promise<void>;
  unlockVault: (masterPassword: string) => Promise<VaultActionResult>;
  lockVault: () => Promise<VaultActionResult>;
  changeVaultPassword: (currentPassword: string, newPassword: string) => Promise<{ ok: boolean; rotatedItems: number; error?: string }>;
  resetVault: (confirmation: string) => Promise<{ ok: boolean; detachedHosts: number; deletedItems: number; error?: string }>;
  getStoredVaultPassword: () => Promise<string | null>;
  clearStoredVaultPassword: () => Promise<void>;

  // Network Map actions
  setNetworkMapOpenIds: (ids: string[]) => void;
  setNetworkMapActiveId: (id: string | null) => void;
  addNetworkMapDetached: (id: string) => void;
  removeNetworkMapDetached: (id: string) => void;
  setNetworkMapInitialized: (v: boolean) => void;
  setNetworkMapViewState: (mapId: string, state: { x: number; y: number; w: number; h: number; zoom: number }) => void;
  requestNetworkMapFocus: (request: Omit<NetworkMapFocusRequest, "id">) => void;
  clearNetworkMapFocusRequest: (id: string) => void;
}

let tabCounter = 0;

// Load initial settings from localStorage
const loadSetting = <T>(key: string, defaultValue: T): T => {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : defaultValue;
  } catch {
    return defaultValue;
  }
};

const loadGroupPaths = (key: string): Set<string> => {
  const values = loadSetting<unknown>(key, []);
  return new Set(Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
        .map(normalizeGroupPath).filter(isValidGroupPath)
    : []);
};

// Preferences have one validated canonical snapshot; old theme/font keys are migration input.
const saveAllSettings = (settings: AppSettings): boolean => {
  try {
    saveAppSettings(settings);
    return true;
  } catch {
    return false;
  }
};

const createSftpBrowserState = (hostId: number): SftpBrowserState => ({
  hostId,
  directory: null,
  currentPath: ".",
  directoryStatus: "idle",
  directoryError: null,
  selectedEntry: null,
  selectedEntries: [],
  updatedAt: Date.now(),
});
const initialSettings = loadAppSettings();

const syncTerminalSessionSettings = (tabs: AppState["terminalTabs"], settings: AppSettings) => {
  for (const tab of tabs) {
    getTerminalSessionController(tab.id)?.configure({
      host: tab.host,
      settings: {
        connectionTimeout: settings.connection.connectionTimeout,
        keepaliveInterval: settings.connection.keepaliveInterval,
        autoReconnect: settings.connection.autoReconnect,
        maxReconnectAttempts: settings.connection.maxReconnectAttempts,
        terminalType: settings.terminal.type,
        rowsMultiplier: settings.terminal.rowsMultiplier,
      },
    });
  }
};

export const useAppStore = create<AppState>((set, get) => ({
  hosts: [],
  hostsLoading: false, hostsError: null, hostsEpoch: 0,
  selectedHost: null,
  snippets: [],
  terminalTabs: [],
  activeTabId: null,
  terminalLayout: "single",
  terminalGroups: [],
  pendingTerminalGroupId: null,
  pendingTerminalPaneIndex: null,
  setTerminalGroup: (group) => set((state) => {
    const tabIds = [...new Set(group.tabIds)].filter((id) => state.terminalTabs.some((tab) => tab.id === id)).slice(0, 4);
    if (!tabIds.length) return {};
    const terminalGroups = state.terminalGroups.filter((item) => item.id !== group.id)
      .map((item) => ({ ...item, tabIds: item.tabIds.filter((id) => !tabIds.includes(id)) }))
      .filter((item) => item.tabIds.length > 0);
    terminalGroups.push({ ...group, tabIds, paneSlots: terminalGroupSlots({ ...group, tabIds }) });
    return { terminalGroups, terminalLayout: findTerminalGroup(terminalGroups, state.activeTabId)?.layout ?? "single" };
  }),
  ungroupTerminalTabs: (groupId) => set((state) => {
    if (state.terminalGroups.find((group) => group.id === groupId)?.tabIds.some((id) => state.terminalTransfers[id])) return {};
    const terminalGroups = state.terminalGroups.filter((group) => group.id !== groupId);
    return { terminalGroups, terminalLayout: findTerminalGroup(terminalGroups, state.activeTabId)?.layout ?? "single",
      ...(state.pendingTerminalGroupId === groupId ? { pendingTerminalGroupId: null, pendingTerminalPaneIndex: null } : {}) };
  }),
  extractTerminalTab: (tabId) => {
    const state = get();
    if (!state.terminalTabs.some((tab) => tab.id === tabId) || Object.keys(state.terminalTransfers).length) return false;
    const terminalGroups = state.terminalGroups.map((group) => ({ ...group,
      tabIds: group.tabIds.filter((id) => id !== tabId),
      paneSlots: terminalGroupSlots(group).map((id) => id === tabId ? null : id),
    })).filter((group) => group.tabIds.length > 0);
    set({ terminalGroups, terminalLayout: "single" });
    state.setActiveTabId(tabId);
    state.saveLayout();
    return true;
  },
  replaceTerminalPane: (groupId, previousId, nextId) => {
    const state = get();
    const group = state.terminalGroups.find((item) => item.id === groupId);
    if (!group || !group.tabIds.includes(previousId) || group.tabIds.includes(nextId)
      || findTerminalGroup(state.terminalGroups, nextId) || Object.keys(state.terminalTransfers).length) return;
    state.setTerminalGroup({ ...group, tabIds: group.tabIds.map((id) => id === previousId ? nextId : id), paneSlots: terminalGroupSlots(group).map((id) => id === previousId ? nextId : id) });
    state.setActiveTabId(nextId);
  },
  reserveTerminalPane: (index) => set((state) => {
    const group = findTerminalGroup(state.terminalGroups, state.activeTabId);
    const position = index ?? (group ? terminalGroupSlots(group).slice(0, paneLimit(group.layout)).indexOf(null) : -1);
    return { pendingTerminalGroupId: canFillTerminalPane(group, position) ? group.id : null, pendingTerminalPaneIndex: position >= 0 ? position : null };
  }),
  insertTerminalPane: (groupId, index, tabId) => {
    const state = get();
    const group = state.terminalGroups.find((item) => item.id === groupId);
    if (!canFillTerminalPane(group, index) || !state.terminalTabs.some((tab) => tab.id === tabId)
      || Object.entries(state.terminalTransfers).some(([id, transfer]) => transfer.direction === "incoming" || transfer.phase === "preparing" || group.tabIds.includes(id) || id === tabId)) return false;
    const paneSlots = terminalGroupSlots(group).map((id) => id === tabId ? null : id);
    paneSlots[index] = tabId;
    state.setTerminalGroup({ ...group, paneSlots, tabIds: paneSlots.filter((id): id is string => id !== null) });
    state.setActiveTabId(tabId);
    return true;
  },
  setTerminalLayout: (layout) => {
    const state = get();
    if (Object.keys(state.terminalTransfers).length) return;
    localStorage.setItem("terminalLayout", JSON.stringify(layout));
    const group = findTerminalGroup(state.terminalGroups, state.activeTabId);
    if (group && layout === "single") {
      state.ungroupTerminalTabs(group.id);
    } else if (group) {
      state.setTerminalGroup({ ...group, layout });
    } else if (layout !== "single" && state.terminalTabs.some((tab) => tab.id === state.activeTabId)) {
      state.setTerminalGroup({ id: createClientId(), layout, tabIds: [state.activeTabId!] });
    } else set({ terminalLayout: "single" });
  },
  maximizeTerminalPane: (tabId) => {
    const state = get();
    const group = findTerminalGroup(state.terminalGroups, tabId);
    if (!group || Object.keys(state.terminalTransfers).length) return;
    state.setActiveTabId(tabId);
    state.setTerminalGroup({ ...group, activeTabId: tabId, layout: "single" });
  },
  activeView: "hosts",
  connectionsTab: "credentials",
  terminalInstances: {},
  terminalSockets: {},
  sessionIds: {},
  terminalClosures: {},
  terminalReconnectKeys: {},
  tabStatuses: {},
  overlayStates: {},
  broadcastMode: false,
  broadcastTargets: new Set<string>(),
  terminalTheme: initialSettings.terminal.theme,
  terminalFontSize: initialSettings.terminal.fontSize,
  hostsViewMode: loadSetting("hostsViewMode", "list"),
  hostsPreferences: parseHostsPreferences(loadSetting("hostsPreferences", null)),
  setHostsPreferences: (patch) => {
    const hostsPreferences = parseHostsPreferences({ ...get().hostsPreferences, ...patch });
    try { localStorage.setItem("hostsPreferences", JSON.stringify(hostsPreferences)); } catch { /* Keep preferences for this session. */ }
    set({ hostsPreferences });
  },
  settings: initialSettings,
  isSidebarExpanded: loadSetting("isSidebarExpanded", true),
  toasts: [],
  confirmDialog: null,

  initialConnectSuppressed: {},
  terminalTransfers: {},
  setTerminalTransfer: (tabId, transfer) => set((state) => {
    const terminalTransfers = { ...state.terminalTransfers };
    if (transfer) terminalTransfers[tabId] = transfer;
    else delete terminalTransfers[tabId];
    return { terminalTransfers };
  }),
  collapsedGroups: loadGroupPaths("collapsedGroups"),
  // load explicitly defined groups (persisted)
  definedGroups: loadGroupPaths("definedGroups"),
  quickActions: [],
  recentConnections: [], // Loaded from API on startup
  activeSftpHostId: null,
  openSftpHostIds: [],
  sftpCapabilities: {},
  sftpBusyHosts: {},
  sftpBrowserStates: {},
  appSecurity: { locked: null, revision: -1, error: null },
  isVaultUnlocked: false,
  vaultInitialized: false,
  vaultStatusLoaded: false,
  vaultSecretItems: 0,
  vaultLinkedHosts: 0,
  hasStoredVaultPassword: false,
  refreshVaultStatus: async () => {
    try {
      const baseUrl = await getApiBase();
      const data = await fetchJsonOrThrow<VaultStatusDto>(`${baseUrl}/vault/status`);
      const status = {
        unlocked: data.unlocked === true,
        initialized: data.initialized === true,
        secretItems: Number(data.secret_items || 0),
        linkedHosts: Number(data.linked_hosts || 0),
      };
      set({
        isVaultUnlocked: status.unlocked,
        vaultInitialized: status.initialized,
        vaultStatusLoaded: true,
        vaultSecretItems: status.secretItems,
        vaultLinkedHosts: status.linkedHosts,
      });
      return status;
    } catch (e) {
      console.warn("Failed to refresh vault status", e);
    }
    return null;
  },
  refreshStoredVaultPasswordState: async () => {
    try {
      const stored = await readVaultPassword();
      set({ hasStoredVaultPassword: Boolean(stored) });
    } catch {
      set({ hasStoredVaultPassword: false });
      get().addToast("Could not check remembered Vault password storage. Unlock manually.", "error");
    }
  },
  getStoredVaultPassword: async () => {
    const security = get().settings.security;
    if (!security.vaultRememberPassword || security.vaultUnlockMode === "every_start") return null;
    try { return await readVaultPassword(); }
    catch {
      get().addToast("Could not read the remembered Vault password. Unlock manually.", "error");
      return null;
    }
  },
  clearStoredVaultPassword: async () => {
    try {
      await removeVaultPassword();
      set({ hasStoredVaultPassword: false });
    } catch {
      get().addToast("Could not remove the remembered Vault password. It may still be in Windows Credential Manager.", "error");
    }
  },

  // Network Map tab state
  networkMapOpenIds: [],
  networkMapActiveId: null,
  networkMapDetachedIds: [],
  networkMapInitialized: false,
  networkMapViewStates: {},
  networkMapFocusRequest: null,

  ...createHostsActions(set, get),
  hostGroupsBusy: false,
  ...createFolderActions(set, get),
  setQuickActions: (actions) => set({ quickActions: actions }),
  setSelectedHost: (host) => set({ selectedHost: host ? redactHostSecrets(host) : null }),
  setSnippets: (snippets) => set({ snippets }),
  setHostsViewMode: (mode) => {
    localStorage.setItem("hostsViewMode", JSON.stringify(mode));
    set({ hostsViewMode: mode });
  },

  openSftpForHost: async (host) => {
    if (host.connection_type !== "ssh") {
      get().addToast("Files are available only for SSH hosts", "info");
      return;
    }
    set((state) => ({
      activeSftpHostId: host.id,
      openSftpHostIds: state.openSftpHostIds.includes(host.id)
        ? state.openSftpHostIds
        : [...state.openSftpHostIds, host.id],
      sftpBrowserStates: state.sftpBrowserStates[host.id]
        ? state.sftpBrowserStates
        : { ...state.sftpBrowserStates, [host.id]: createSftpBrowserState(host.id) },
    }));
    if (!get().sftpCapabilities[host.id]) {
      await get().fetchSftpCapability(host.id);
    }
  },

  setActiveSftpHostId: (hostId) => set({ activeSftpHostId: hostId }),

  clearActiveSftpHost: () => set({ activeSftpHostId: null }),

  disconnectSftpHost: (hostId) => {
    set((state) => {
      const targetHostId = hostId ?? state.activeSftpHostId;
      if (targetHostId === null) return { activeSftpHostId: null };
      const nextOpenHostIds = state.openSftpHostIds.filter((id) => id !== targetHostId);
      const nextStates = { ...state.sftpBrowserStates };
      delete nextStates[targetHostId];
      const nextBusyHosts = { ...state.sftpBusyHosts };
      delete nextBusyHosts[targetHostId];
      const nextActiveHostId = state.activeSftpHostId === targetHostId
        ? nextOpenHostIds[nextOpenHostIds.length - 1] ?? null
        : state.activeSftpHostId;
      return {
        activeSftpHostId: nextActiveHostId,
        openSftpHostIds: nextOpenHostIds,
        sftpBrowserStates: nextStates,
        sftpBusyHosts: nextBusyHosts,
      };
    });
  },

  setSftpBrowserState: (hostId, updates) => {
    set((state) => {
      const current = state.sftpBrowserStates[hostId] ?? createSftpBrowserState(hostId);
      return {
        sftpBrowserStates: {
          ...state.sftpBrowserStates,
          [hostId]: {
            ...current,
            ...updates,
            ...(updates.selectedEntries === undefined && updates.selectedEntry !== undefined
              ? { selectedEntries: updates.selectedEntry ? [updates.selectedEntry] : [] }
              : {}),
            hostId,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  fetchSftpCapability: async (hostId) => {
    try {
      const baseUrl = await getApiBase();
      const capability = await fetchJsonOrThrow<HostCapability>(
        `${baseUrl}/sftp/hosts/${hostId}/capability`,
      );
      set((state) => ({
        sftpCapabilities: { ...state.sftpCapabilities, [hostId]: capability },
      }));
      return capability;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load SFTP capability";
      const capability: HostCapability = {
        host_id: hostId,
        capability: "sftp",
        status: "error",
        reason: message,
        can_probe: true,
      };
      set((state) => ({
        sftpCapabilities: { ...state.sftpCapabilities, [hostId]: capability },
      }));
      return null;
    }
  },

  probeSftpCapability: async (hostId) => {
    const previous = get().sftpCapabilities[hostId];
    set((state) => ({
      sftpBusyHosts: { ...state.sftpBusyHosts, [hostId]: true },
      sftpCapabilities: {
        ...state.sftpCapabilities,
        [hostId]: {
          host_id: hostId,
          capability: "sftp",
          status: "checking",
          reason: previous?.reason ?? null,
          checked_at: previous?.checked_at ?? null,
          expires_at: previous?.expires_at ?? null,
          can_probe: true,
        },
      },
    }));

    try {
      const baseUrl = await getApiBase();
      const capability = await fetchJsonOrThrow<HostCapability>(`${baseUrl}/sftp/hosts/${hostId}/probe`, {
        method: "POST",
      });
      set((state) => ({
        sftpBusyHosts: { ...state.sftpBusyHosts, [hostId]: false },
        sftpCapabilities: { ...state.sftpCapabilities, [hostId]: capability },
      }));
      return capability;
    } catch (error) {
      const message = error instanceof Error ? error.message : "SFTP probe failed";
      const capability: HostCapability = {
        host_id: hostId,
        capability: "sftp",
        status: "error",
        reason: message,
        can_probe: true,
      };
      set((state) => ({
        sftpBusyHosts: { ...state.sftpBusyHosts, [hostId]: false },
        sftpCapabilities: { ...state.sftpCapabilities, [hostId]: capability },
      }));
      return null;
    }
  },

  addQuickAction: async (action) => {
    const id = createClientId();
    const newAction = { ...action, id };

    try {
      const baseUrl = await getApiBase();
      await fetchJsonOrThrow<QuickAction>(`${baseUrl}/quick-actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAction),
      });
      set((state) => ({ quickActions: [...state.quickActions, newAction] }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save quick action";
      console.error("Failed to save quick action", error);
      get().addToast(message, "error");
      return false;
    }
  },

  updateQuickAction: async (id, updates) => {
    try {
      const baseUrl = await getApiBase();
      await fetchJsonOrThrow<QuickAction>(`${baseUrl}/quick-actions/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      set((state) => ({ quickActions: state.quickActions.map((action) => action.id === id ? { ...action, ...updates } : action) }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update quick action";
      console.error("Failed to update quick action", error);
      get().addToast(message, "error");
      return false;
    }
  },

  removeQuickAction: async (id) => {
    try {
      const baseUrl = await getApiBase();
      await deleteJsonOrIgnoreNotFound(`${baseUrl}/quick-actions/${id}`);
      set((state) => ({ quickActions: state.quickActions.filter((action) => action.id !== id) }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete quick action";
      console.error("Failed to delete quick action", error);
      get().addToast(message, "error");
      return false;
    }
  },

  addDefinedGroup: (path: string) => {
    path = normalizeGroupPath(path);
    if (!isValidGroupPath(path)) return;
    set((state) => {
      const next = new Set(state.definedGroups);
      next.add(path);
      localStorage.setItem("definedGroups", JSON.stringify(Array.from(next)));
      return { definedGroups: next };
    });
  },

  removeDefinedGroup: (path: string) => {
    set((state) => {
      const next = new Set(state.definedGroups);
      next.delete(path);
      localStorage.setItem("definedGroups", JSON.stringify(Array.from(next)));
      return { definedGroups: next };
    });
  },

  setHighlightRules: (rules) => set((state) => ({
    settings: {
      ...state.settings,
      terminal: { ...state.settings.terminal, highlightRules: rules }
    }
  })),

  addHighlightRule: async (rule) => {
    const id = createClientId();
    const newRule = { ...rule, id };

    set((state) => ({
      settings: {
        ...state.settings,
        terminal: { 
          ...state.settings.terminal, 
          highlightRules: [...(state.settings.terminal.highlightRules || []), newRule] 
        }
      }
    }));

    try {
      const baseUrl = await getApiBase();
      await fetchJsonOrThrow<unknown>(`${baseUrl}/highlight-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
           id: newRule.id,
           keyword: newRule.keyword,
           color: newRule.color,
           highlight_type: newRule.highlightType,
           is_active: newRule.isActive
        }),
      });
    } catch (error) {
      set((state) => ({
        settings: {
          ...state.settings,
          terminal: {
            ...state.settings.terminal,
            highlightRules: state.settings.terminal.highlightRules.filter((item) => item.id !== id),
          },
        },
      }));
      const message = error instanceof Error ? error.message : "Failed to save highlight rule";
      console.error("Failed to save highlight rule", error);
      get().addToast(message, "error");
    }
  },

  updateHighlightRule: async (id, updates) => {
    const previous = get().settings.terminal.highlightRules.find((rule) => rule.id === id);
    set((state) => ({
      settings: {
        ...state.settings,
        terminal: {
          ...state.settings.terminal,
          highlightRules: state.settings.terminal.highlightRules.map((r) =>
            r.id === id ? { ...r, ...updates } : r
          ),
        }
      }
    }));

    try {
      const baseUrl = await getApiBase();
      const payload: Partial<{
        keyword: string;
        color: string;
        highlight_type: HighlightRule["highlightType"];
        is_active: boolean;
      }> = {};
      if (updates.keyword !== undefined) payload.keyword = updates.keyword;
      if (updates.color !== undefined) payload.color = updates.color;
      if (updates.highlightType !== undefined) payload.highlight_type = updates.highlightType;
      if (updates.isActive !== undefined) payload.is_active = updates.isActive;

      await fetchJsonOrThrow<unknown>(`${baseUrl}/highlight-rules/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (previous) {
        set((state) => ({
          settings: {
            ...state.settings,
            terminal: {
              ...state.settings.terminal,
              highlightRules: state.settings.terminal.highlightRules.map((item) =>
                item.id === id ? previous : item
              ),
            },
          },
        }));
      }
      const message = error instanceof Error ? error.message : "Failed to update highlight rule";
      console.error("Failed to update highlight rule", error);
      get().addToast(message, "error");
    }
  },

  removeHighlightRule: async (id) => {
    const previousRules = get().settings.terminal.highlightRules;
    set((state) => ({
      settings: {
        ...state.settings,
        terminal: {
          ...state.settings.terminal,
          highlightRules: state.settings.terminal.highlightRules.filter((r) => r.id !== id),
        }
      }
    }));

    try {
      const baseUrl = await getApiBase();
      await deleteJsonOrIgnoreNotFound(`${baseUrl}/highlight-rules/${id}`);
    } catch (error) {
      set((state) => ({
        settings: {
          ...state.settings,
          terminal: {
            ...state.settings.terminal,
            highlightRules: previousRules,
          },
        },
      }));
      const message = error instanceof Error ? error.message : "Failed to delete highlight rule";
      console.error("Failed to delete highlight rule", error);
      get().addToast(message, "error");
    }
  },

  showConfirm: (options) => set({ confirmDialog: options }),
  hideConfirm: () => set({ confirmDialog: null }),

  addToast: (message, type = "success") => {
    const id = createClientId();
    set((state) => ({
      toasts: [...state.toasts, { id, message, type }],
    }));
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, 4000);
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },

  setSidebarExpanded: (expanded) => {
    localStorage.setItem("isSidebarExpanded", JSON.stringify(expanded));
    set({ isSidebarExpanded: expanded });
  },




  markInitialConnectSuppressed: (tabId) => {
    set((state) => ({
      initialConnectSuppressed: {
        ...state.initialConnectSuppressed,
        [tabId]: true,
      },
    }));
  },

  consumeInitialConnectSuppressed: (tabId) => {
    const state = get();
    const wasSuppressed = !!state.initialConnectSuppressed[tabId];
    if (!wasSuppressed) return false;

    const next = { ...state.initialConnectSuppressed };
    delete next[tabId];
    set({ initialConnectSuppressed: next });
    return true;
  },



  addTerminalTab: (host, sessionId) => {
    tabCounter++;
    const tabId = `tab-${tabCounter}-${Date.now()}`;
    const safeHost = redactHostSecrets(host);
    ensureTerminalSessionController(tabId, {
      host,
      initialSessionId: sessionId,
      settings: {
        connectionTimeout: get().settings.connection.connectionTimeout,
        keepaliveInterval: get().settings.connection.keepaliveInterval,
        autoReconnect: get().settings.connection.autoReconnect,
        maxReconnectAttempts: get().settings.connection.maxReconnectAttempts,
        terminalType: get().settings.terminal.type,
        rowsMultiplier: get().settings.terminal.rowsMultiplier,
      },
      callbacks: {
        onConnectionInfo: (connection) => get().updateTerminalConnection(tabId, connection),
        onSocketChange: (socket) => {
          set((state) => {
            const terminalSockets = { ...state.terminalSockets };
            if (socket) terminalSockets[tabId] = socket;
            else delete terminalSockets[tabId];
            return { terminalSockets };
          });
        },
        onStatusChange: (status) => {
          set((state) => ({
            tabStatuses: { ...state.tabStatuses, [tabId]: status },
          }));
        },
        onSessionIdChange: (nextSessionId) => {
          set((state) => ({
            sessionIds: { ...state.sessionIds, [tabId]: nextSessionId },
            terminalTabs: state.terminalTabs.map((tab) =>
              tab.id === tabId
                ? { ...tab, sessionId: nextSessionId ?? undefined }
                : tab,
            ),
          }));
        },
        onConnectedChange: (connected) => {
          set((state) => ({
            terminalTabs: state.terminalTabs.map((tab) =>
              tab.id === tabId ? { ...tab, isConnected: connected } : tab,
            ),
          }));
        },
      },
    });
    const newTab: TerminalTab = {
      id: tabId,
      host: safeHost,
      isConnected: false,
      sessionId,
    };
    const pendingGroupId = get().pendingTerminalGroupId;
    const pendingPane = get().pendingTerminalPaneIndex;
    set((state) => ({
      terminalTabs: [...state.terminalTabs, newTab],
      activeTabId: tabId,
      terminalLayout: "single",
      pendingTerminalGroupId: null,
      pendingTerminalPaneIndex: null,
      tabStatuses: { ...state.tabStatuses, [tabId]: "connecting" },
    }));
    if (pendingGroupId && pendingPane !== null) get().insertTerminalPane(pendingGroupId, pendingPane, tabId);
    get().saveLayout();
    return tabId;
  },

  removeTerminalTab: async (tabId, options) => {
    const before = get();
    if (!before.terminalTabs.some((tab) => tab.id === tabId)) return true;
    if (before.terminalClosures[tabId] === "closing") return false;
    if (before.terminalTransfers[tabId] && !options?.preserveSession) return false;
    const socketBefore = before.terminalSockets[tabId];
    const isDetaching = options?.preserveSession === true;
    if (!isDetaching) {
      const controller = getTerminalSessionController(tabId);
      const sessionId = controller?.getSnapshot().sessionId ?? before.sessionIds[tabId]
        ?? before.terminalTabs.find((tab) => tab.id === tabId)?.sessionId;
      set((state) => ({ terminalClosures: { ...state.terminalClosures, [tabId]: "closing" } }));
      controller?.beginClose();
      if (!controller && socketBefore) {
        try {
          if (socketBefore.readyState === WebSocket.OPEN) socketBefore.send(JSON.stringify({ type: "terminate" }));
        } catch { /* The independent HTTP request still closes the session. */ }
        try { socketBefore.close(); } catch { /* already closed */ }
      }
      try {
        if (typeof sessionId === "number") await closeBackendSession(sessionId);
      } catch {
        set((state) => ({ terminalClosures: { ...state.terminalClosures, [tabId]: "failed" } }));
        get().addToast("Could not confirm session closure. The tab was kept open; retry closing it when the backend is reachable.", "error");
        return false;
      }
    }
    if (getTerminalSessionController(tabId)) {
      disposeTerminalSessionController(tabId, { preserveSession: isDetaching });
    } else if (socketBefore) {
      try {
        if (!isDetaching && socketBefore.readyState === WebSocket.OPEN) {
          socketBefore.send(JSON.stringify({ type: "terminate" }));
        }
        socketBefore.close();
      } catch {
        try { socketBefore.close(); } catch { /* already closed */ }
      }
    }

    set((state) => {
      const terminalClosures = { ...state.terminalClosures };
      delete terminalClosures[tabId];
      const terminalTransfers = { ...state.terminalTransfers };
      delete terminalTransfers[tabId];
      const tabToRemove = state.terminalTabs.find((t) => t.id === tabId);
      const newTabs = state.terminalTabs.filter((t) => t.id !== tabId);
      const terminalGroups = state.terminalGroups.map((group) => ({ ...group, tabIds: group.tabIds.filter((id) => id !== tabId), paneSlots: terminalGroupSlots(group).map((id) => id === tabId ? null : id) }))
        .filter((group) => group.tabIds.length > 0);
      let newActiveId = state.activeTabId;

      if (state.activeTabId === tabId) {
        const siblings = findTerminalGroup(state.terminalGroups, tabId)?.tabIds.filter((id) => id !== tabId);
        newActiveId = siblings?.[0] ?? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null);
      }

      // Logic to clear selectedHost if we closed the last tab for it
      let newSelectedHost = state.selectedHost;
      if (
        newSelectedHost &&
        tabToRemove &&
        tabToRemove.host.id === newSelectedHost.id
      ) {
        const hasOtherTabsForHost = newTabs.some(
          (t) => t.host.id === newSelectedHost?.id,
        );
        if (!hasOtherTabsForHost) {
          newSelectedHost = null;
        }
      }

      const newInstances = { ...state.terminalInstances };
      delete newInstances[tabId];
      const newSockets = { ...state.terminalSockets };
      delete newSockets[tabId];
      const newSessionIds = { ...state.sessionIds };
      delete newSessionIds[tabId];
      const newReconnectKeys = { ...state.terminalReconnectKeys };
      delete newReconnectKeys[tabId];
      const newStatuses = { ...state.tabStatuses };
      delete newStatuses[tabId];
      const newOverlay = { ...state.overlayStates };
      delete newOverlay[tabId];

      return {
        terminalClosures,
        terminalTransfers,
        terminalTabs: newTabs,
        terminalGroups,
        terminalLayout: findTerminalGroup(terminalGroups, newActiveId)?.layout ?? "single",
        activeTabId: newActiveId,
        terminalInstances: newInstances,
        terminalSockets: newSockets,
        sessionIds: newSessionIds,
        terminalReconnectKeys: newReconnectKeys,
        tabStatuses: newStatuses,
        overlayStates: newOverlay,
        selectedHost: newSelectedHost,
      };
    });
    get().saveLayout();
    return true;
  },

  triggerReconnect: (tabId) => {
    getTerminalSessionController(tabId)?.reconnect();
    set((state) => ({
      terminalReconnectKeys: {
        ...state.terminalReconnectKeys,
        [tabId]: (state.terminalReconnectKeys[tabId] || 0) + 1,
      },
    }));
  },

  setActiveTabId: (tabId) => {
    set((state) => {
      if (tabId !== state.activeTabId && Object.values(state.terminalTransfers).some((transfer) => transfer.direction === "incoming")) return {};
      const tab = state.terminalTabs.find((t) => t.id === tabId);
      return {
        activeTabId: tabId,
        pendingTerminalGroupId: null,
        pendingTerminalPaneIndex: null,
        terminalLayout: findTerminalGroup(state.terminalGroups, tabId)?.layout ?? "single",
        terminalGroups: state.terminalGroups.map((group) => group.tabIds.includes(tabId ?? "") ? { ...group, activeTabId: tabId ?? undefined } : group),
        selectedHost: tab ? tab.host : state.selectedHost,
      };
    });
  },
  
  setActiveView: (view, connectionsTab) => set((state) => {
    if (view !== "terminal" && Object.values(state.terminalTransfers).some((transfer) => transfer.direction === "incoming")) return {};
    return {
      activeView: view,
      connectionsTab: connectionsTab ?? (view === state.activeView ? state.connectionsTab : "credentials"),
      pendingTerminalGroupId: view === "hosts" ? state.pendingTerminalGroupId : null,
      pendingTerminalPaneIndex: view === "hosts" ? state.pendingTerminalPaneIndex : null,
    };
  }),

  // Network Map tab persistence
  setNetworkMapOpenIds: (ids) => set({ networkMapOpenIds: ids }),
  setNetworkMapActiveId: (id) => set({ networkMapActiveId: id }),
  addNetworkMapDetached: (id) => set((s) => ({ networkMapDetachedIds: [...s.networkMapDetachedIds.filter((d) => d !== id), id] })),
  removeNetworkMapDetached: (id) => set((s) => ({ networkMapDetachedIds: s.networkMapDetachedIds.filter((d) => d !== id) })),
  setNetworkMapInitialized: (v) => set({ networkMapInitialized: v }),
  setNetworkMapViewState: (mapId, state) => set((s) => ({ networkMapViewStates: { ...s.networkMapViewStates, [mapId]: state } })),
  requestNetworkMapFocus: (request) => set({ networkMapFocusRequest: { ...request, id: createClientId() } }),
  clearNetworkMapFocusRequest: (id) => set((s) => (
    s.networkMapFocusRequest?.id === id ? { networkMapFocusRequest: null } : {}
  )),

  updateTabConnection: (tabId, isConnected) => {
    set((state) => ({
      terminalTabs: state.terminalTabs.map((t) =>
        t.id === tabId ? { ...t, isConnected } : t,
      ),
    }));
  },



  reorderTerminalTabs: (tabs) => {
    set({ terminalTabs: tabs });
    get().saveLayout();
  },

  setTerminalInstance: (tabId, terminal) => {
    set((state) => {
      const terminalInstances = { ...state.terminalInstances };
      if (terminal) terminalInstances[tabId] = terminal;
      else delete terminalInstances[tabId];
      return { terminalInstances };
    });
  },

  setTerminalSocket: (tabId, socket) => {
    set((state) => {
      const terminalSockets = { ...state.terminalSockets };
      if (socket) terminalSockets[tabId] = socket;
      else delete terminalSockets[tabId];
      return { terminalSockets };
    });
  },

  setTabStatus: (tabId, status) => {
    getTerminalSessionController(tabId)?.setExternalStatus(status);
    set((state) => ({
      tabStatuses: { ...state.tabStatuses, [tabId]: status },
    }));
  },

  setOverlayState: (tabId, overlay) => {
    set((state) => ({
      overlayStates: { ...state.overlayStates, [tabId]: overlay },
    }));
  },

  setSessionId: (tabId, sessionId) => {
    getTerminalSessionController(tabId)?.setExternalSessionId(sessionId);
    set((state) => ({
      sessionIds: { ...state.sessionIds, [tabId]: sessionId },
      terminalTabs: state.terminalTabs.map((tab) =>
        tab.id === tabId ? { ...tab, sessionId: sessionId ?? undefined } : tab,
      ),
    }));
  },

  updateTerminalConnection: (tabId, connection) => {
    set((state) => ({
      terminalTabs: state.terminalTabs.map((tab) =>
        tab.id === tabId ? { ...tab, host: { ...tab.host, ...connection } } : tab,
      ),
    }));
  },

  updateTabHost: (hostId, updates) => {
    set((state) => ({
      terminalTabs: state.terminalTabs.map((tab) => {
        if (tab.host.id === hostId) {
          return { ...tab, host: { ...tab.host, ...updates } };
        }
        return tab;
      }),
    }));
  },

  // Broadcast actions
  setBroadcastMode: (enabled) => {
    set((state) => ({
      broadcastMode: enabled,
      // When turning off, clear targets
      broadcastTargets: enabled ? state.broadcastTargets : new Set<string>(),
    }));
  },
  toggleBroadcastTarget: (tabId) => {
    set((state) => {
      const next = new Set(state.broadcastTargets);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return { broadcastTargets: next };
    });
  },
  setBroadcastTargets: (tabIds) => {
    set({ broadcastTargets: new Set(tabIds) });
  },
  broadcastSend: (data) => {
    const state = get();
    if (!state.broadcastMode || state.broadcastTargets.size === 0) return;
    for (const tabId of state.broadcastTargets) {
      const ws = state.terminalSockets[tabId];
      if (ws?.readyState === WebSocket.OPEN) sendTerminalInput(ws, data);
    }
  },

  // Layout persistence
  saveLayout: () => {
    if (new URLSearchParams(window.location.search).get("detached") === "true") return;
    const state = get();
    const layout = state.terminalTabs.map((t) => ({ hostId: t.host.id }));
    try {
      localStorage.setItem("netrix_layout", JSON.stringify({
        tabs: layout,
        activeHostId: state.terminalTabs.find((t) => t.id === state.activeTabId)?.host.id ?? null,
      }));
    } catch { /* ignore quota errors */ }
  },

  restoreLayout: () => {
    try {
      const raw = localStorage.getItem("netrix_layout");
      if (!raw) return;
      const { tabs, activeHostId } = JSON.parse(raw) as {
        tabs: { hostId: number }[];
        activeHostId: number | null;
      };
      if (!Array.isArray(tabs) || tabs.length === 0) return;

      const { hosts, addTerminalTab } = get();
      let lastActiveTabId: string | null = null;

      for (const entry of tabs) {
        const host = hosts.find((h) => h.id === entry.hostId);
        if (host) {
          const tabId = addTerminalTab(host);
          if (host.id === activeHostId) lastActiveTabId = tabId;
        }
      }

      if (lastActiveTabId) {
        set({ activeTabId: lastActiveTabId, activeView: "terminal" });
      }

      // Clear saved layout to avoid stale re-opens on crash
      localStorage.removeItem("netrix_layout");
    } catch { /* ignore parse errors */ }
  },

  // Compatibility fields are mirrors of the canonical settings, not separate storage.
  setTerminalTheme: (theme) => get().updateSettings("terminal", { theme }),
  setTerminalFontSize: (fontSize) => get().updateSettings("terminal", { fontSize }),

  updateSettings: (category, updates) => {
    const patch = sanitizeSettingsPatch(category, updates);
    if (Object.keys(patch).length === 0) return true;
    const current = get().settings;
    const settings = { ...current, [category]: { ...current[category], ...patch } };
    if (!saveAllSettings(settings)) {
      get().addToast("Could not save settings. Your previous settings are still active.", "error");
      return false;
    }
    set({ settings, terminalTheme: settings.terminal.theme, terminalFontSize: settings.terminal.fontSize });
    if (category === "terminal" || category === "connection") syncTerminalSessionSettings(get().terminalTabs, settings);
    if (category === "security" && "vaultRememberPassword" in patch && patch.vaultRememberPassword === false) {
      void get().clearStoredVaultPassword();
    }
    return true;
  },

  resetSettings: (category) => {
    const defaults = createDefaultSettings();
    if (category && !Object.prototype.hasOwnProperty.call(defaults, category)) return false;
    const current = get().settings;
    const settings = category ? { ...current, [category]: defaults[category] } : defaults;
    // Rules belong to the highlighting API/SQLite, not an appearance reset.
    settings.terminal = { ...settings.terminal, highlightRules: current.terminal.highlightRules };
    if (!saveAllSettings(settings)) {
      get().addToast("Could not save settings. Your previous settings are still active.", "error");
      return false;
    }
    set({ settings, terminalTheme: settings.terminal.theme, terminalFontSize: settings.terminal.fontSize });
    if (!category || category === "terminal" || category === "connection") syncTerminalSessionSettings(get().terminalTabs, settings);
    return true;
  },

  getSettings: () => get().settings,

  // Recent Connections
  addRecentConnection: async (host: Host) => {
    // Quick-connect sessions are transient and have no saved backend host id.
    if (host.id === -1) return;

    const previousConnections = get().recentConnections;
    // Optimistic update
    set((state) => {
      const filtered = state.recentConnections.filter(
        (rc) => rc.host.id !== host.id
      );
      const updated: RecentConnection[] = [
        { host, timestamp: Date.now() },
        ...filtered,
      ].slice(0, 10);
      return { recentConnections: updated };
    });

    // Persist to backend
    try {
      const baseUrl = await getApiBase();
      await fetchJsonOrThrow<unknown>(`${baseUrl}/recent-connections/${host.id}`, {
        method: "POST",
      });
    } catch (error) {
      try {
        set({ recentConnections: await loadRecentConnections() });
      } catch (reconcileError) {
        console.error("Failed to reconcile recent connections", reconcileError);
        set({ recentConnections: previousConnections });
      }
      console.error("Failed to save recent connection", error);
      get().addToast(
        error instanceof Error ? error.message : "Failed to save recent connection",
        "error",
      );
    }
  },

  clearRecentConnections: async () => {
    const previousConnections = get().recentConnections;
    set({ recentConnections: [] });

    try {
      const baseUrl = await getApiBase();
      await fetchJsonOrThrow<unknown>(`${baseUrl}/recent-connections`, {
        method: "DELETE",
      });
    } catch (error) {
      try {
        set({ recentConnections: await loadRecentConnections() });
      } catch (reconcileError) {
        console.error("Failed to reconcile recent connections", reconcileError);
        set({ recentConnections: previousConnections });
      }
      console.error("Failed to clear recent connections", error);
      get().addToast(
        error instanceof Error ? error.message : "Failed to clear recent connections",
        "error",
      );
    }
  },

  fetchRecentConnections: async () => {
    try {
      set({ recentConnections: await loadRecentConnections() });
    } catch (error) {
      console.error("Failed to fetch recent connections", error);
    }
  },

  // Group Management
  toggleGroup: (groupPath) => {
    set((state) => {
      const next = new Set(state.collapsedGroups);
      if (next.has(groupPath)) {
        next.delete(groupPath);
      } else {
        next.add(groupPath);
      }
      localStorage.setItem("collapsedGroups", JSON.stringify(Array.from(next)));
      return { collapsedGroups: next };
    });
  },

  expandAllGroups: () => {
    localStorage.setItem("collapsedGroups", JSON.stringify([]));
    set({ collapsedGroups: new Set<string>() });
  },

  collapseAllGroups: () => {
    set((state) => {
      const allPaths = new Set<string>();
      state.hosts.forEach((host) => {
        if (host.group) {
          const segments = normalizeGroupPath(host.group).split("/").filter(Boolean);
          for (let i = 1; i <= segments.length; i++) {
            allPaths.add(segments.slice(0, i).join("/"));
          }
        }
      });
      // Also include empty defined groups
      state.definedGroups.forEach(p => {
        const segments = normalizeGroupPath(p).split("/").filter(Boolean);
        for (let i = 1; i <= segments.length; i++) {
          allPaths.add(segments.slice(0, i).join("/"));
        }
      });
      localStorage.setItem("collapsedGroups", JSON.stringify(Array.from(allPaths)));
      return { collapsedGroups: allPaths };
    });
  },

  moveHostToGroup: async (hostId, targetGroupPath) => {
    await get().patchHost(hostId, { group: normalizeGroupPath(targetGroupPath) || null });
  },

  deleteGroupWithHosts: async (groupPath, recursive) => {
    const matches = (path: string) => path === groupPath || (recursive && path.startsWith(groupPath + "/"));
    const pending = get().hosts.filter(h => matches(normalizeGroupPath(h.group)));
    // Delete jump-chain dependants first; preserve all rejected records and groups.
    let failure: unknown;
    while (pending.length) {
      const index = pending.findIndex(h => !pending.some(other => other.jump_host_id === h.id && other.id !== h.id));
      const [host] = pending.splice(index < 0 ? 0 : index, 1);
      try { await get().deleteHost(host.id); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
    if (recursive) {
      const definedGroups = new Set([...get().definedGroups].filter(p => !matches(p)));
      const collapsedGroups = new Set([...get().collapsedGroups].filter(p => !matches(p)));
      localStorage.setItem("definedGroups", JSON.stringify([...definedGroups]));
      localStorage.setItem("collapsedGroups", JSON.stringify([...collapsedGroups]));
      set({ definedGroups, collapsedGroups });
    }
  },

  unlockVault: async (masterPassword: string): Promise<VaultActionResult> => {
    try {
      const baseUrl = await getApiBase();
      const data = await fetchJsonOrThrow<VaultStatusDto>(`${baseUrl}/vault/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ master_password: masterPassword }),
      });
      set({
        isVaultUnlocked: data.unlocked === true,
        vaultInitialized: data.initialized === true,
        vaultStatusLoaded: true,
      });
      if (data.unlocked === true && get().settings.security.vaultRememberPassword && canUseVaultKeychain()) {
        try {
          await saveVaultPassword(masterPassword);
          set({ hasStoredVaultPassword: true });
          if (!get().settings.security.vaultRememberPassword || !get().vaultInitialized) await get().clearStoredVaultPassword();
        } catch {
          get().addToast("Vault unlocked, but the password could not be remembered. Unlock manually next time.", "error");
        }
      }
      await get().refreshVaultStatus();
      return data.unlocked === true
        ? { ok: true }
        : { ok: false, error: "Vault remained locked" };
    } catch (e) {
      console.error("Failed to unlock vault:", e);
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Failed to unlock vault",
      };
    }
  },

  lockVault: async (): Promise<VaultActionResult> => {
    try {
      const baseUrl = await getApiBase();
      const data = await fetchJsonOrThrow<VaultStatusDto>(`${baseUrl}/vault/lock`, {
        method: "POST",
      });
      if (data.unlocked !== false) {
        return {
          ok: false,
          error: "Vault returned an unexpected lock response",
        };
      }

      set({ isVaultUnlocked: false });
      return { ok: true };
    } catch (e) {
      console.error("Failed to lock vault:", e);
      return {
        ok: false,
        error: e instanceof Error ? e.message : "Failed to lock vault",
      };
    }
  },

  changeVaultPassword: async (currentPassword: string, newPassword: string) => {
    try {
      const baseUrl = await getApiBase();
      const data = await fetchJsonOrThrow<VaultPasswordChangeDto>(`${baseUrl}/vault/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      if (data.changed !== true) {
        return {
          ok: false,
          rotatedItems: 0,
          error: "Failed to change master password",
        };
      }

      if (get().settings.security.vaultRememberPassword) {
        try {
          await saveVaultPassword(newPassword);
          set({ hasStoredVaultPassword: true });
          if (!get().settings.security.vaultRememberPassword || !get().vaultInitialized) await get().clearStoredVaultPassword();
        } catch {
          get().addToast("Vault password changed, but the remembered password could not be updated. Unlock manually next time.", "error");
        }
      }

      await get().refreshVaultStatus();

      return {
        ok: true,
        rotatedItems: Number(data.rotated_items || 0),
      };
    } catch (e) {
      console.error("Failed to change vault password:", e);
      return {
        ok: false,
        rotatedItems: 0,
        error: e instanceof Error ? e.message : "Failed to change master password",
      };
    }
  },

  resetVault: async (confirmation: string) => {
    try {
      const baseUrl = await getApiBase();
      const data = await fetchJsonOrThrow<VaultResetDto>(`${baseUrl}/vault/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });

      if (data.reset !== true) {
        return {
          ok: false,
          detachedHosts: 0,
          deletedItems: 0,
          error: "Failed to reset vault",
        };
      }

      set({
        isVaultUnlocked: false,
        vaultInitialized: data.initialized === true,
        vaultStatusLoaded: true,
        vaultSecretItems: 0,
        vaultLinkedHosts: 0,
      });
      await get().clearStoredVaultPassword();

      return {
        ok: true,
        detachedHosts: Number(data.detached_hosts || 0),
        deletedItems: Number(data.deleted_items || 0),
      };
    } catch (e) {
      console.error("Failed to reset vault:", e);
      return {
        ok: false,
        detachedHosts: 0,
        deletedItems: 0,
        error: e instanceof Error ? e.message : "Failed to reset vault",
      };
    }
  },
}));
