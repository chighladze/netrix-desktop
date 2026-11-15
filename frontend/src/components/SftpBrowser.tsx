import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LocalFilePanel from "./LocalFilePanel";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import FileList from "../features/sftp/FileList";
import FilePathBar from "../features/sftp/FilePathBar";
import { editablePermissions, fileNameError, formatBytes, formatDate, parentPath, permissionError } from "../features/sftp/filePresentation";
import { copyTextWithAutoClear } from "../utils/clipboard";
import TransferPanel from "../features/sftp/TransferPanel";
import { useTransfers } from "../features/sftp/useTransfers";
import { useFileDialog } from "../features/sftp/useFileDialog";
import { disconnectSftp, mutateFile, sftpTargetKey, validateFileName, visitDirectory, type DirectoryHistory } from "../features/sftp/api";
import {
    LuChevronRight,
    LuCircleAlert,
    LuCircleCheck,
    LuCloudUpload,
    LuCopy,
    LuDownload,
    LuEye,
    LuFileText,
    LuFolderOpen,
    LuInfo,
    LuKeyRound,
    LuFolderPlus,
    LuPanelLeft,
    LuPencil,
    LuNetwork,
    LuRefreshCw,
    LuRows3,
    LuSearch,
    LuServer,
    LuShieldCheck,
    LuTerminal,
    LuTrash2,
    LuX,
} from "react-icons/lu";
import { useShallow } from "zustand/react/shallow";
import { authenticatedFetch, fetchJsonOrThrow, getApiBase, getApiErrorMessage } from "../api";
import { HostCapability, HostCapabilityStatus, SavedHostDto, SftpBrowserState, SftpDirectoryEntry, SftpDirectoryStatus, SftpListResponse, useAppStore } from "../state/store";

type SftpEntry = SftpDirectoryEntry;
type DirectoryStatus = SftpDirectoryStatus;
type FileAction = "preview" | "download" | "upload" | "operation" | null;

type PreviewState = {
  entry: SftpEntry;
  status: "loading" | "ready" | "error";
  content?: string;
  error?: string;
  truncated?: boolean;
};

const TEXT_PREVIEW_LIMIT = 1024 * 1024;

const statusCopy: Record<HostCapabilityStatus, { label: string; tone: string; text: string }> = {
  unknown: {
    label: "Not checked",
    tone: "border-gray-700/70 bg-white/[0.03] text-gray-300",
    text: "Waiting for the first SFTP request.",
  },
  checking: {
    label: "Connecting",
    tone: "border-sky-500/30 bg-sky-500/[0.08] text-sky-300",
    text: "Opening SFTP over a separate SSH channel.",
  },
  supported: {
    label: "Connected",
    tone: "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300",
    text: "SFTP is ready for browsing.",
  },
  unsupported: {
    label: "Unavailable",
    tone: "border-amber-500/30 bg-amber-500/[0.08] text-amber-300",
    text: "This SSH server rejected the SFTP subsystem.",
  },
  auth_failed: {
    label: "Auth issue",
    tone: "border-red-500/30 bg-red-500/[0.08] text-red-300",
    text: "Credentials or vault unlock state need attention.",
  },
  error: {
    label: "Error",
    tone: "border-red-500/30 bg-red-500/[0.08] text-red-300",
    text: "SFTP could not open this path.",
  },
};

const looksBinary = (bytes: Uint8Array): boolean => {
  const sampleLength = Math.min(bytes.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) return true;
  }
  return false;
};

const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

const StatusPill: React.FC<{ capability?: HostCapability; busy?: boolean }> = ({ capability, busy }) => {
  const status = busy ? "checking" : capability?.status || "unknown";
  const copy = statusCopy[status];
  const dotTone = status === "supported"
    ? "bg-emerald-300"
    : status === "checking"
      ? "bg-sky-300 animate-pulse"
      : status === "unsupported"
        ? "bg-amber-300"
        : status === "auth_failed" || status === "error"
          ? "bg-red-300"
          : "bg-gray-500";
  return (
    <span className={`inline-flex h-7 items-center gap-2 rounded-full border px-3 text-[11px] font-semibold ${copy.tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dotTone}`} />
      {copy.label}
    </span>
  );
};

const SftpSessionTabs: React.FC<{
  hosts: SavedHostDto[];
  activeHostId: number | null;
  onActivate: (hostId: number) => void;
  onClose: (hostId: number) => void;
  onOpenPicker?: () => void;
}> = ({ hosts, activeHostId, onActivate, onClose, onOpenPicker }) => {
  if (hosts.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-white/[0.06] bg-black/10 px-4 py-2">
      {hosts.map((host) => {
        const active = host.id === activeHostId;
        return (
          <div
            key={host.id}
            className={`group inline-flex h-9 min-w-[150px] max-w-[220px] shrink-0 items-center gap-2 rounded-lg border pr-2 text-left text-[12px] transition-colors ${active ? "border-sky-400/35 bg-sky-400/[0.1] text-white" : "border-white/[0.07] bg-white/[0.025] text-gray-400 hover:bg-white/[0.06] hover:text-white"}`}
          >
            <button onClick={() => onActivate(host.id)} aria-pressed={active} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-3">
              <LuFolderOpen size={14} className={active ? "text-sky-300" : "text-gray-500"} />
              <span className="min-w-0 flex-1 truncate font-semibold">{host.name}</span>
            </button>
            <button
              onClick={() => onClose(host.id)}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-red-400/[0.12] hover:text-red-300"
              aria-label={`Close ${host.name} Files session`}
            >
              <LuX size={13} />
            </button>
          </div>
        );
      })}
      {onOpenPicker && (
        <button
          onClick={onOpenPicker}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 text-[12px] font-semibold text-gray-400 hover:bg-white/[0.06] hover:text-white"
        >
          <LuServer size={14} /> Open another
        </button>
      )}
    </div>
  );
};

type HostPickerScope = "all" | "credentialed" | "open";

const formatHostEndpoint = (host: SavedHostDto) => `${host.username ? `${host.username}@` : ""}${host.hostname}:${host.port}`;

const hostHasSavedCredential = (host: SavedHostDto) => Boolean(host.credential_id || host.has_password || host.has_private_key);

const describeHostCredential = (host: SavedHostDto) => {
  if (host.has_private_key && host.has_password) return "Key + password";
  if (host.has_private_key) return "Private key";
  if (host.has_password) return "Password";
  if (host.credential_id) return "Vault item";
  return "No saved credential";
};

const HostPicker: React.FC<{
  hosts: SavedHostDto[];
  openHosts: SavedHostDto[];
  capabilities: Record<number, HostCapability>;
  busyHosts: Record<number, boolean>;
  onPick: (host: SavedHostDto) => void | Promise<void>;
  onActivate: (hostId: number) => void;
  onClose: (hostId: number) => void;
}> = ({ hosts, openHosts, capabilities, busyHosts, onPick, onActivate, onClose }) => {
  const [query, setQuery] = React.useState("");
  const [scope, setScope] = React.useState<HostPickerScope>("all");
  const openHostIds = useMemo(() => new Set(openHosts.map((host) => host.id)), [openHosts]);
  const credentialedCount = useMemo(() => hosts.filter(hostHasSavedCredential).length, [hosts]);
  const supportedCount = useMemo(
    () => hosts.filter((host) => capabilities[host.id]?.status === "supported").length,
    [capabilities, hosts],
  );
  const scopeOptions: Array<{ id: HostPickerScope; label: string; count: number; icon: React.ReactNode }> = [
    { id: "all", label: "All", count: hosts.length, icon: <LuRows3 size={14} /> },
    { id: "credentialed", label: "Vault", count: credentialedCount, icon: <LuKeyRound size={14} /> },
    { id: "open", label: "Open", count: openHosts.length, icon: <LuFolderOpen size={14} /> },
  ];
  const filteredHosts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return hosts
      .filter((host) => {
        if (scope === "credentialed") return hostHasSavedCredential(host);
        if (scope === "open") return openHostIds.has(host.id);
        return true;
      })
      .filter((host) => {
        if (!normalized) return true;
        return [host.name, host.hostname, host.username, host.group, formatHostEndpoint(host)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((left, right) => {
        const openWeight = Number(openHostIds.has(right.id)) - Number(openHostIds.has(left.id));
        if (openWeight !== 0) return openWeight;
        const groupCompare = (left.group || "").localeCompare(right.group || "");
        if (groupCompare !== 0) return groupCompare;
        return left.name.localeCompare(right.name);
      });
  }, [hosts, openHostIds, query, scope]);
  const hasFilters = query.trim().length > 0 || scope !== "all";

  return (
    <div className="files-workspace flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#070b12] text-white">
      <SftpSessionTabs hosts={openHosts} activeHostId={null} onActivate={onActivate} onClose={onClose} />

      <div className="shrink-0 border-b border-white/[0.06] bg-[#081018] px-5 py-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-600">
              <LuFolderOpen size={13} />
              <span>Remote files</span>
            </div>
            <h1 className="text-2xl font-bold text-white">Files</h1>
            <p className="mt-1 text-[13px] text-gray-500">SFTP workspace for saved SSH hosts.</p>
          </div>

          <div className="grid grid-cols-3 gap-2 sm:w-[420px]">
            <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-600">
                <LuServer size={13} /> Hosts
              </div>
              <div className="mt-1 text-lg font-bold text-white">{hosts.length}</div>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-600">
                <LuFolderOpen size={13} /> Open
              </div>
              <div className="mt-1 text-lg font-bold text-white">{openHosts.length}</div>
            </div>
            <div className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-600">
                <LuCircleCheck size={13} /> Ready
              </div>
              <div className="mt-1 text-lg font-bold text-white">{supportedCount}</div>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-md">
            <LuSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" size={15} />
            <input
              value={query}
              aria-label="Search SSH hosts"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search host, group, endpoint"
              className="h-10 w-full rounded-lg border border-white/[0.08] bg-white/[0.035] pl-9 pr-3 text-[13px] text-white placeholder-gray-600 outline-none transition-colors focus:border-sky-400/45"
            />
          </div>

          <div className="flex overflow-x-auto rounded-lg border border-white/[0.08] bg-white/[0.025] p-1">
            {scopeOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => setScope(option.id)}
                className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-[12px] font-semibold transition-colors ${scope === option.id ? "bg-sky-400/[0.12] text-sky-200" : "text-gray-500 hover:bg-white/[0.04] hover:text-gray-200"}`}
              >
                {option.icon}
                <span>{option.label}</span>
                <span className="text-[11px] text-gray-600">{option.count}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-5 py-4">
        {hosts.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] p-8 text-center">
            <div>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-gray-500">
                <LuServer size={22} />
              </div>
              <h2 className="text-sm font-semibold text-white">No SSH hosts</h2>
              <p className="mt-1 text-[12px] text-gray-500">Create an SSH host before opening Files.</p>
            </div>
          </div>
        ) : filteredHosts.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] p-8 text-center">
            <div>
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-gray-500">
                <LuSearch size={22} />
              </div>
              <h2 className="text-sm font-semibold text-white">No matching hosts</h2>
              <p className="mt-1 text-[12px] text-gray-500">{hosts.length} SSH hosts available</p>
              {hasFilters && (
                <button
                  onClick={() => {
                    setQuery("");
                    setScope("all");
                  }}
                  className="mt-4 inline-flex h-9 items-center rounded-lg border border-white/[0.08] bg-white/[0.04] px-3 text-[12px] font-semibold text-gray-300 hover:bg-white/[0.07] hover:text-white"
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/[0.07] bg-white/[0.018]">
            <div className="hidden shrink-0 grid-cols-[minmax(240px,1.6fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)_minmax(132px,0.7fr)_96px] gap-3 border-b border-white/[0.06] bg-white/[0.025] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-600 md:grid">
              <span>Host</span>
              <span>Group</span>
              <span>Credential</span>
              <span>SFTP</span>
              <span className="text-right">Action</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filteredHosts.map((host) => {
                const isOpen = openHostIds.has(host.id);
                const savedCredential = hostHasSavedCredential(host);
                const groupLabel = host.group?.trim() || "Ungrouped";
                return (
                  <button
                    key={host.id}
                    onClick={() => void onPick(host)}
                    className={`group grid w-full gap-3 border-b border-white/[0.055] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-sky-400/[0.045] md:grid-cols-[minmax(240px,1.6fr)_minmax(130px,0.7fr)_minmax(150px,0.8fr)_minmax(132px,0.7fr)_96px] md:items-center ${isOpen ? "bg-sky-400/[0.035]" : "bg-transparent"}`}
                    aria-label={`Open Files for ${host.name}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${isOpen ? "border-sky-400/30 bg-sky-400/[0.1] text-sky-300" : "border-white/[0.08] bg-white/[0.035] text-gray-400"}`}>
                        <LuServer size={18} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate text-[14px] font-semibold text-white">{host.name}</span>
                          {isOpen && (
                            <span className="rounded border border-sky-400/20 bg-sky-400/[0.1] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-sky-300">
                              Open
                            </span>
                          )}
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[11px] text-gray-500">
                          <LuNetwork size={12} className="shrink-0 text-gray-700" />
                          <span className="truncate">{formatHostEndpoint(host)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="min-w-0">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-700 md:hidden">Group</div>
                      <span className="block truncate text-[12px] font-medium text-gray-300">{groupLabel}</span>
                    </div>

                    <div className="min-w-0">
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-700 md:hidden">Credential</div>
                      <span className={`inline-flex h-7 max-w-full items-center gap-2 rounded-full border px-3 text-[11px] font-semibold ${savedCredential ? "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-300" : "border-white/[0.08] bg-white/[0.03] text-gray-500"}`}>
                        <LuKeyRound size={13} className="shrink-0" />
                        <span className="truncate">{describeHostCredential(host)}</span>
                      </span>
                    </div>

                    <div>
                      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-700 md:hidden">SFTP</div>
                      <StatusPill capability={capabilities[host.id]} busy={busyHosts[host.id] === true} />
                    </div>

                    <div className="flex items-center justify-start md:justify-end">
                      <span className="inline-flex h-8 items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.035] px-3 text-[12px] font-semibold text-gray-300 transition-colors group-hover:border-sky-400/30 group-hover:bg-sky-400/[0.08] group-hover:text-sky-200">
                        Open <LuChevronRight size={14} />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SftpBrowser: React.FC = () => {
  const {
    hosts,
    activeSftpHostId,
    openSftpHostIds,
    sftpCapabilities,
    sftpBusyHosts,
    sftpBrowserStates,
    openSftpForHost,
    setActiveSftpHostId,
    clearActiveSftpHost,
    disconnectSftpHost,
    setSftpBrowserState,
    fetchSftpCapability,
    probeSftpCapability,
    addTerminalTab,
    setActiveView,
    addToast,
  } = useAppStore(
    useShallow((state) => ({
      hosts: state.hosts,
      activeSftpHostId: state.activeSftpHostId,
      openSftpHostIds: state.openSftpHostIds,
      sftpCapabilities: state.sftpCapabilities,
      sftpBusyHosts: state.sftpBusyHosts,
      sftpBrowserStates: state.sftpBrowserStates,
      openSftpForHost: state.openSftpForHost,
      setActiveSftpHostId: state.setActiveSftpHostId,
      clearActiveSftpHost: state.clearActiveSftpHost,
      disconnectSftpHost: state.disconnectSftpHost,
      setSftpBrowserState: state.setSftpBrowserState,
      fetchSftpCapability: state.fetchSftpCapability,
      probeSftpCapability: state.probeSftpCapability,
      addTerminalTab: state.addTerminalTab,
      setActiveView: state.setActiveView,
      addToast: state.addToast,
    })),
  );

  const [fileAction, setFileAction] = useState<FileAction>(null);
  const [showLocal, setShowLocal] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const { ask, dialog, close: closeDialog } = useFileDialog();
  const [histories, setHistories] = useState<Record<number, DirectoryHistory>>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const attemptedPathsRef = useRef(new Map<number, string>());
  const abortControllersRef = useRef<Map<number, Set<AbortController>>>(new Map());
  const latestDirectoryRequestRef = useRef<Map<number, { id: number; controller: AbortController }>>(new Map());
  const directoryRequestIdRef = useRef(0);
  const previewRequestRef = useRef<AbortController | null>(null);
  const viewHost = hosts.find((host) => host.id === activeSftpHostId);
  const targetKey = viewHost ? sftpTargetKey(viewHost) : "";
  const viewRef = useRef({ hostId: activeSftpHostId, targetKey });
  if (viewRef.current.hostId !== activeSftpHostId || viewRef.current.targetKey !== targetKey)
    viewRef.current = { hostId: activeSftpHostId, targetKey };
  const view = viewRef.current;
  const isCurrentView = useCallback(() => {
    const state = useAppStore.getState();
    const current = state.hosts.find((host) => host.id === view.hostId);
    return viewRef.current === view && state.activeSftpHostId === view.hostId
      && !!current && sftpTargetKey(current) === view.targetKey;
  }, [view]);
  const setCurrentFileAction = useCallback((action: FileAction) => {
    if (isCurrentView()) setFileAction(action);
  }, [isCurrentView]);
  const closePreview = useCallback(() => {
    const pending = previewRequestRef.current;
    previewRequestRef.current = null;
    pending?.abort();
    setPreview(null);
    if (pending) setFileAction(null);
  }, []);

  const trackAbortController = useCallback((hostId: number) => {
    const controller = new AbortController();
    const controllers = abortControllersRef.current.get(hostId) ?? new Set<AbortController>();
    controllers.add(controller);
    abortControllersRef.current.set(hostId, controllers);
    return controller;
  }, []);

  const releaseAbortController = useCallback((hostId: number, controller: AbortController) => {
    const controllers = abortControllersRef.current.get(hostId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) abortControllersRef.current.delete(hostId);
  }, []);

  const isSftpHostOpen = useCallback((hostId: number) => (
    useAppStore.getState().openSftpHostIds.includes(hostId)
  ), []);

  const abortSftpOperations = useCallback((hostId?: number) => {
    const abortControllers = (targetHostId: number) => {
      const controllers = abortControllersRef.current.get(targetHostId);
      controllers?.forEach((controller) => controller.abort());
      abortControllersRef.current.delete(targetHostId);
      if (latestDirectoryRequestRef.current.has(targetHostId)) {
        const state = useAppStore.getState();
        if (state.openSftpHostIds.includes(targetHostId)) {
          state.setSftpBrowserState(targetHostId, { directoryStatus: "idle" });
        }
      }
      latestDirectoryRequestRef.current.delete(targetHostId);
    };
    if (hostId !== undefined) {
      abortControllers(hostId);
      return;
    }

    Array.from(abortControllersRef.current.keys()).forEach(abortControllers);
  }, []);

  useEffect(() => () => abortSftpOperations(), [abortSftpOperations]);
  useEffect(() => {
    closeDialog(null);
    closePreview();
    setShowDetails(false);
    setFileAction(null);
    setIsDragOver(false);
    return () => { if (activeSftpHostId !== null) abortSftpOperations(activeSftpHostId); };
  }, [activeSftpHostId, targetKey, abortSftpOperations, closeDialog, closePreview]);

  const sshHosts = useMemo(() => hosts.filter((host) => host.connection_type === "ssh" && host.id >= 0), [hosts]);
  const openSftpHosts = useMemo(
    () => openSftpHostIds
      .map((hostId) => sshHosts.find((host) => host.id === hostId))
      .filter((host): host is SavedHostDto => Boolean(host)),
    [openSftpHostIds, sshHosts],
  );
  const activeHost = useMemo(
    () => sshHosts.find((host) => host.id === activeSftpHostId) || null,
    [activeSftpHostId, sshHosts],
  );
  const sftpState = activeSftpHostId !== null ? sftpBrowserStates[activeSftpHostId] : undefined;
  const sameTarget = sftpState?.connectionKey === targetKey;
  const directory = sameTarget ? sftpState?.directory ?? null : null;
  const currentPath = sameTarget ? sftpState?.currentPath ?? "." : ".";
  const directoryStatus: DirectoryStatus = sameTarget ? sftpState?.directoryStatus ?? "idle" : "idle";
  const directoryError = sameTarget ? sftpState?.directoryError ?? null : null;
  const selectedEntry = sameTarget ? sftpState?.selectedEntry ?? null : null;
  const selectedEntries = useMemo(() => sameTarget
    ? sftpState?.selectedEntries ?? (selectedEntry ? [selectedEntry] : [])
    : [], [sameTarget, sftpState?.selectedEntries, selectedEntry]);
  const capability = activeHost ? sftpCapabilities[activeHost.id] : undefined;
  const busy = activeHost ? sftpBusyHosts[activeHost.id] === true || directoryStatus === "loading" : false;
  const status = busy ? "checking" : capability?.status || "unknown";
  const copy = statusCopy[status];
  const entries = directory?.entries || [];
  const activePath = directory?.path || currentPath;
  const history = activeSftpHostId !== null ? histories[activeSftpHostId] : undefined;
  const selectedFile = selectedEntry && selectedEntry.entry_type !== "directory" ? selectedEntry : null;
  const selectedDirectory = selectedEntry && selectedEntry.entry_type === "directory" ? selectedEntry : null;
  const selectedKind = selectedEntry
    ? selectedEntry.entry_type === "directory"
      ? "Folder"
      : selectedEntry.entry_type === "symlink"
        ? "Symlink"
        : "File"
    : null;
  const updateSftpState = useCallback((updates: Partial<Omit<SftpBrowserState, "hostId" | "updatedAt">>) => {
    if (!activeHost) return;
    setSftpBrowserState(activeHost.id, updates);
  }, [activeHost, setSftpBrowserState]);

  const loadDirectory = useCallback(async (path: string, historyIndex?: number) => {
    if (!activeHost || !isSftpHostOpen(activeHost.id)) return;
    const hostId = activeHost.id;
    attemptedPathsRef.current.set(hostId, path);
    const cached = useAppStore.getState().sftpBrowserStates[hostId];
    const previousPath = cached?.connectionKey === sftpTargetKey(activeHost) ? cached.directory?.path : undefined;
    latestDirectoryRequestRef.current.get(hostId)?.controller.abort();
    const controller = trackAbortController(hostId);
    const requestId = ++directoryRequestIdRef.current;
    latestDirectoryRequestRef.current.set(hostId, { id: requestId, controller });
    setSftpBrowserState(hostId, { connectionKey: sftpTargetKey(activeHost), directoryStatus: "loading", directoryError: null });

    try {
      const baseUrl = await getApiBase();
      const params = new URLSearchParams({ path });
      const data = await fetchJsonOrThrow<SftpListResponse>(`${baseUrl}/sftp/hosts/${hostId}/list?${params.toString()}`, {
        signal: controller.signal,
      });
      if (
        controller.signal.aborted || !isSftpHostOpen(hostId)
        || latestDirectoryRequestRef.current.get(hostId)?.id !== requestId
      ) return;
      setSftpBrowserState(hostId, {
        directory: data,
        currentPath: data.path || path,
        selectedEntry: null,
        directoryStatus: "ready",
        directoryError: null,
      });
      setHistories((previous) => ({
        ...previous,
        [hostId]: visitDirectory(previous[hostId] || (previousPath ? visitDirectory(undefined, previousPath) : undefined), data.path || path, historyIndex),
      }));
      void fetchSftpCapability(hostId);
    } catch (error) {
      if (
        isAbortError(error)
        || !isSftpHostOpen(hostId)
        || latestDirectoryRequestRef.current.get(hostId)?.id !== requestId
      ) return;
      const message = `${path}: ${error instanceof Error ? error.message : "Failed to list SFTP directory"}`;
      setSftpBrowserState(hostId, { directoryError: message, directoryStatus: "error" });
      void fetchSftpCapability(hostId);
    } finally {
      releaseAbortController(hostId, controller);
      if (latestDirectoryRequestRef.current.get(hostId)?.id === requestId) {
        latestDirectoryRequestRef.current.delete(hostId);
      }
    }
  }, [activeHost, fetchSftpCapability, isSftpHostOpen, releaseAbortController, setSftpBrowserState, trackAbortController]);

  useEffect(() => {
    if (!activeHost) return;
    const current = useAppStore.getState().sftpBrowserStates[activeHost.id];
    if (current && current.connectionKey !== targetKey) {
      setSftpBrowserState(activeHost.id, {
        connectionKey: targetKey, directory: null, selectedEntry: null,
        currentPath: ".", directoryStatus: "idle", directoryError: null,
      });
      setHistories((previous) => { const next = { ...previous }; delete next[activeHost.id]; return next; });
      void loadDirectory(".");
      return;
    }
    if (!useAppStore.getState().sftpCapabilities[activeHost.id]) {
      void fetchSftpCapability(activeHost.id);
    }
    if (!current || current.directoryStatus === "idle") {
      void loadDirectory(current?.currentPath || ".");
    }
  }, [activeHost, directoryStatus, targetKey, fetchSftpCapability, loadDirectory, setSftpBrowserState]);

  const fetchFileResponse = useCallback(async (entry: SftpEntry, options?: { preview?: boolean; signal?: AbortSignal }) => {
    if (!activeHost) throw new Error("No active SFTP host");
    const baseUrl = await getApiBase();
    const params = new URLSearchParams({ path: entry.path });
    if (options?.preview) {
      params.set("max_bytes", String(TEXT_PREVIEW_LIMIT));
      params.set("truncate", "true");
    }
    const response = await authenticatedFetch(`${baseUrl}/sftp/hosts/${activeHost.id}/download?${params.toString()}`, {
      signal: options?.signal,
    });
    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response, "Failed to read SFTP file"));
    }
    return response;
  }, [activeHost]);

  const fetchFileBlob = useCallback(async (entry: SftpEntry, options?: { preview?: boolean; signal?: AbortSignal }) => {
    const response = await fetchFileResponse(entry, options);
    return {
      blob: await response.blob(),
      truncated: response.headers.get("x-netrix-truncated") === "true",
    };
  }, [fetchFileResponse]);

  const { uploadFiles: handleUploadFiles, download: downloadFile, downloadMany } = useTransfers({
    hostId: activeHost?.id, remotePath: directory?.path || currentPath, entries, ask,
    track: trackAbortController, release: releaseAbortController,
    busy: setCurrentFileAction, toast: addToast, reload: loadDirectory,
  });
  const handleDownload = (entry?: SftpEntry | null) => entry ? downloadFile(entry) : downloadMany(selectedEntries);

  const handlePreview = useCallback(async (entry: SftpEntry | null = selectedFile) => {
    if (!entry || entry.entry_type === "directory") return;
    const hostId = activeHost?.id;
    if (hostId === undefined) return;
    previewRequestRef.current?.abort();
    setFileAction("preview");
    setPreview({ entry, status: "loading" });
    const controller = trackAbortController(hostId);
    previewRequestRef.current = controller;
    try {
      const { blob, truncated } = await fetchFileBlob(entry, { preview: true, signal: controller.signal });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (controller.signal.aborted || previewRequestRef.current !== controller || !isCurrentView() || !isSftpHostOpen(hostId)) return;
      if (looksBinary(bytes)) {
        setPreview({
          entry,
          status: "error",
          error: "Binary preview is not available yet. Download the file to open it locally.",
        });
        return;
      }
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      setPreview({ entry, status: "ready", content, truncated });
    } catch (error) {
      if (controller.signal.aborted || previewRequestRef.current !== controller || !isCurrentView()) return;
      if (isAbortError(error)) {
        setPreview(null);
        return;
      }
      const message = error instanceof Error ? error.message : "SFTP preview failed";
      setPreview({ entry, status: "error", error: message });
    } finally {
      releaseAbortController(hostId, controller);
      if (previewRequestRef.current === controller && isCurrentView()) {
        previewRequestRef.current = null;
        setFileAction(null);
      }
    }
  }, [activeHost?.id, fetchFileBlob, isSftpHostOpen, isCurrentView, releaseAbortController, selectedFile, trackAbortController]);

  const handleOperation = async (action: "mkdir" | "rename" | "delete" | "chmod") => {
    if (!activeHost || fileAction || busy || directoryStatus !== "ready") return;
    const entry = selectedEntry;
    if (action !== "mkdir" && !entry) return;
    const path = entry?.path || activePath;
    const hostId = activeHost.id;
    const controller = trackAbortController(hostId);
    setFileAction("operation");
    try {
      if (action === "mkdir") {
        const name = await ask({ title: "New folder", description: activePath, inputLabel: "Folder name", confirmLabel: "Create folder", validate: fileNameError });
        if (name === null || controller.signal.aborted || !isCurrentView()) return;
        await mutateFile(activeHost.id, { action, path: (activePath === "/" ? "" : activePath.replace(/\/+$/, "")) + "/" + validateFileName(name) });
      } else if (action === "rename" && entry) {
        const name = await ask({ title: "Rename", description: path, inputLabel: "New name", initialValue: entry.name, confirmLabel: "Rename", validate: fileNameError });
        if (name === null || controller.signal.aborted || !isCurrentView()) return;
        if (name === entry.name) return;
        const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
        await mutateFile(activeHost.id, { action, path, destination: (parent || (path.startsWith("/") ? "" : ".")) + "/" + validateFileName(name) });
      } else if (action === "delete") {
        const answer = await ask({ title: "Delete remote item?", description: path + ". Folders must be empty. This cannot be undone.", confirmLabel: "Delete", destructive: true });
        if (answer === null || controller.signal.aborted || !isCurrentView()) return;
        await mutateFile(activeHost.id, { action, path, confirmation: path });
      } else if (action === "chmod") {
        const mode = await ask({ title: "Change permissions", description: `${path}. Applies to this item only.`, inputLabel: "Permissions (000-777)", initialValue: entry ? editablePermissions(entry) : "644", validate: permissionError });
        if (mode === null || controller.signal.aborted || !isCurrentView()) return;
        await mutateFile(activeHost.id, { action, path, permissions: mode });
      }
      if (isCurrentView() && !controller.signal.aborted) {
        addToast({ mkdir: "Folder created", rename: "Item renamed", delete: "Item deleted", chmod: "Permissions updated" }[action], "success");
        setPreview(null);
        await loadDirectory(activePath);
      } else if (isSftpHostOpen(hostId)) {
        setSftpBrowserState(hostId, { directoryStatus: "idle" });
      }
    } catch (error) {
      addToast(`${activeHost.name}: ${error instanceof Error ? error.message : "File operation failed"}`, "error");
    } finally {
      releaseAbortController(hostId, controller);
      setCurrentFileAction(null);
    }
  };

  const handleTerminal = () => {
    if (!activeHost) return;
    addTerminalTab(activeHost);
    setActiveView("terminal");
  };

  const handleRecheck = async () => {
    if (!activeHost) return;
    const result = await probeSftpCapability(activeHost.id);
    if (!result || result.status === "supported") {
      void loadDirectory(currentPath);
    }
  };

  const handleDisconnect = () => {
    if (!activeHost) return;
    abortSftpOperations(activeHost.id);
    void disconnectSftp(activeHost.id)
      .then(() => addToast(`Disconnected Files from ${activeHost.name}`, "info"))
      .catch((error: unknown) => addToast(`${activeHost.name}: ${error instanceof Error ? error.message : "SFTP disconnect failed"}`, "error"));
    setPreview(null);
    setFileAction(null);
    disconnectSftpHost(activeHost.id);
  };

  const handleCloseSftpTab = (hostId: number) => {
    abortSftpOperations(hostId);
    void disconnectSftp(hostId).catch((error: unknown) => addToast(
      error instanceof Error ? error.message : "SFTP disconnect failed", "error"));
    if (hostId === activeSftpHostId) {
      setPreview(null);
      setFileAction(null);
    }
    disconnectSftpHost(hostId);
  };

  if (!activeHost) {
    return (
      <HostPicker
        hosts={sshHosts}
        openHosts={openSftpHosts}
        capabilities={sftpCapabilities}
        busyHosts={sftpBusyHosts}
        onPick={openSftpForHost}
        onActivate={setActiveSftpHostId}
        onClose={handleCloseSftpTab}
      />
    );
  }

  const actionsDisabled = busy || fileAction !== null || directoryStatus !== "ready";
  const copyPath = async () => {
    try {
      await copyTextWithAutoClear(selectedEntry?.path || activePath);
      addToast("Path copied", "success");
    } catch { addToast("Could not copy path", "error"); }
  };

  return (
    <div className="files-workspace flex h-full min-h-0 flex-col overflow-hidden bg-[#080e16] text-white">
      {dialog}
      <input ref={uploadInputRef} type="file" multiple className="hidden" aria-label="Upload files"
        onChange={(event) => {
          if (event.currentTarget.files && !actionsDisabled) void handleUploadFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }} />
      <SftpSessionTabs hosts={openSftpHosts} activeHostId={activeSftpHostId}
        onActivate={setActiveSftpHostId} onClose={handleCloseSftpTab} onOpenPicker={clearActiveSftpHost} />
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] bg-[#0b131e] px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <button onClick={clearActiveSftpHost} className="text-sm font-medium text-gray-400 hover:text-white">Files</button>
            <LuChevronRight size={14} className="text-gray-600" />
            <h1 className="max-w-64 truncate text-base font-semibold">{activeHost.name}</h1>
            <StatusPill capability={capability} busy={busy && !directory} />
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-gray-500">{formatHostEndpoint(activeHost)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowLocal(!showLocal)} aria-pressed={showLocal} className={`files-button ${showLocal ? "border-sky-400/30 bg-sky-400/10 text-sky-200" : ""}`}><LuPanelLeft size={15} />Local panel</button>
          <button onClick={handleTerminal} className="files-button"><LuTerminal size={15} />Terminal</button>
          {directoryStatus === "error" && <button onClick={() => void handleRecheck()} disabled={busy || fileAction !== null} className="files-button"><LuRefreshCw size={14} />Reconnect</button>}
          <button onClick={handleDisconnect} title="Disconnect Files session" className="files-button"><LuX size={14} />Disconnect</button>
        </div>
      </header>

      <div className={`grid min-h-0 flex-1 overflow-hidden ${showLocal ? "grid-rows-2 md:grid-cols-2 md:grid-rows-1" : "grid-cols-1"}`}>
        {showLocal && <LocalFilePanel key={activeHost.id} disabled={actionsDisabled} remotePath={activePath} onUpload={(file) => handleUploadFiles([file])} />}
        <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden p-4" aria-label="Remote file workspace"
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
              event.preventDefault(); event.stopPropagation(); pathInputRef.current?.focus(); pathInputRef.current?.select();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (event.dataTransfer.types.includes("Files")) {
              event.dataTransfer.dropEffect = actionsDisabled ? "none" : "copy";
              if (!actionsDisabled) setIsDragOver(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragOver(false);
          }}
          onDrop={(event) => {
            event.preventDefault(); setIsDragOver(false);
            if (!actionsDisabled && event.dataTransfer.files.length) void handleUploadFiles(event.dataTransfer.files);
          }}>
          {isDragOver && <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-sky-400/60 bg-[#0b1726]/95 p-5 text-center">
            <div><LuCloudUpload size={32} className="mx-auto mb-3 text-sky-300" /><p className="text-sm font-semibold">Drop files to upload</p><p className="mt-2 break-all font-mono text-xs text-gray-400">{activePath}</p></div>
          </div>}
          <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-gray-300"><LuServer size={15} className="text-sky-300" />Remote files<span className="truncate font-normal text-gray-500">{activeHost.name}</span></div>
            <span className="text-[10px] font-medium uppercase tracking-wider text-gray-500">SFTP</span>
          </div>
          <FilePathBar key={`${activeHost.id}:${targetKey}`} label="Remote" path={directoryStatus === "ready" ? activePath : attemptedPathsRef.current.get(activeHost.id) || activePath} home="." parent={parentPath(activePath)}
            history={history} busy={busy} disabled={fileAction !== null} inputRef={pathInputRef}
            onNavigate={(path, index) => void loadDirectory(path, index)} />
          <div role="group" aria-label="Remote file actions" className="mb-3 flex shrink-0 flex-wrap items-center gap-1.5">
            <button onClick={() => uploadInputRef.current?.click()} disabled={actionsDisabled}
              className="files-button border-sky-400/30 bg-sky-400/10 text-sky-200"><LuCloudUpload size={15} />{fileAction === "upload" ? "Uploading…" : "Upload"}</button>
            <button onClick={() => void handleOperation("mkdir")} disabled={actionsDisabled} className="files-button"><LuFolderPlus size={15} />New folder</button>
            <span className="mx-0.5 h-5 border-l border-white/10" />
            <button onClick={() => selectedDirectory ? void loadDirectory(selectedDirectory.path) : void handlePreview()} disabled={actionsDisabled || !selectedEntry} className="files-button">
              {selectedDirectory ? <LuFolderOpen size={15} /> : <LuEye size={15} />}{selectedDirectory ? "Open folder" : "View"}</button>
            <button onClick={() => void handleDownload()} disabled={actionsDisabled || !selectedEntries.length || selectedEntries.some((entry) => entry.entry_type === "directory")}
              title={selectedEntries.length > 1 ? "Download selected files; choose a folder when supported" : "Download file"}
              className="files-button"><LuDownload size={15} />{fileAction === "download" ? "Downloading…" : selectedEntries.length > 1 ? `Download ${selectedEntries.length} files` : "Download"}</button>
            <button onClick={() => void handleOperation("rename")} disabled={actionsDisabled || !selectedEntry} title="Rename · F2" className="files-button"><LuPencil size={14} />Rename</button>
            <button onClick={() => void handleOperation("delete")} disabled={actionsDisabled || !selectedEntry} title="Delete selected item" className="files-button text-red-300"><LuTrash2 size={14} />Delete</button>
            <button onClick={() => void handleOperation("chmod")} disabled={actionsDisabled || !selectedEntry} className="files-button"><LuKeyRound size={14} />Permissions</button>
            <button onClick={() => void copyPath()} title={selectedEntry ? "Copy selected path" : "Copy folder path"} className="files-icon-button text-gray-400" aria-label="Copy path"><LuCopy size={14} /></button>
            <button onClick={() => setShowDetails(true)} disabled={!selectedEntry} className="files-icon-button text-gray-400" aria-label="File details" title="File details"><LuInfo size={15} /></button>
          </div>
          <FileList label="Remote files" locationKey={`${activeHost.id}:${targetKey}:${activePath}`} entries={entries}
            status={directoryStatus} error={directoryError || capability?.reason || copy.text} selected={selectedEntry} disabled={busy || fileAction !== null}
            selection={selectedEntries} onSelectionChange={(selection) => updateSftpState({ selectedEntries: selection, selectedEntry: selection.length === 1 ? selection[0] : null })}
            onSelect={(entry) => updateSftpState({ selectedEntry: entry })}
            onOpen={(entry) => { if (!actionsDisabled) { if (entry.entry_type === "directory") void loadDirectory(entry.path); else void handlePreview(entry); } }}
            onRetry={() => void loadDirectory(attemptedPathsRef.current.get(activeHost.id) || currentPath)}
            onRename={() => void handleOperation("rename")} onDelete={() => void handleOperation("delete")}
            emptyAction={<button className="files-button mt-3" disabled={actionsDisabled} onClick={() => uploadInputRef.current?.click()}><LuCloudUpload size={14} />Upload files</button>} />
        </main>
      </div>
      <TransferPanel key={activeHost.id} hostId={activeHost.id} />

      <Dialog open={showDetails && Boolean(selectedEntry)} onClose={() => setShowDetails(false)} className="relative z-50">
        <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
        <div className="fixed inset-0 flex justify-end">
          <DialogPanel className="files-workspace flex h-full w-full max-w-sm flex-col overflow-y-auto border-l border-white/10 bg-[#101923] p-5 shadow-2xl">
            <div className="mb-6 flex items-center justify-between"><DialogTitle className="text-sm font-semibold text-white">File details</DialogTitle><button autoFocus onClick={() => setShowDetails(false)} aria-label="Close file details" className="files-icon-button text-gray-400"><LuX size={17} /></button></div>
            {selectedEntry && <>
              <LuFileText size={28} className="mb-4 text-sky-300" /><p className="break-all text-lg font-semibold text-white">{selectedEntry.name}</p>
              <p className="mt-1 text-xs text-gray-400">{selectedKind}</p>
              <p className="my-5 break-all rounded-lg border border-white/10 bg-black/20 p-3 font-mono text-xs leading-5 text-gray-300">{selectedEntry.path}</p>
              <button className="files-button mb-5" onClick={() => void copyPath()}><LuCopy size={14} />Copy path</button>
              <dl className="space-y-4 text-xs text-gray-300">
                <div className="flex justify-between gap-3"><dt className="text-gray-500">Size</dt><dd>{selectedDirectory ? "—" : formatBytes(selectedEntry.size)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-gray-500">Modified</dt><dd>{formatDate(selectedEntry.modified_at)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-gray-500">Permissions</dt><dd className="font-mono">{selectedEntry.permissions || "—"}</dd></div>
              </dl>
            </>}
          </DialogPanel>
        </div>
      </Dialog>
      <Dialog open={Boolean(preview)} onClose={closePreview} className="relative z-50">
        <div className="fixed inset-0 bg-black/65 backdrop-blur-sm" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel className="ui-dialog files-workspace flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-dialog">
            {preview && <>
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
                <div className="min-w-0"><DialogTitle className="truncate text-sm font-semibold text-white">{preview.entry.name}</DialogTitle><p className="truncate font-mono text-[11px] text-gray-500">{preview.entry.path}</p></div>
                <div className="flex shrink-0 items-center gap-2">
                  <button onClick={() => void handleDownload(preview.entry)} disabled={fileAction !== null} className="files-button"><LuDownload size={14} />Download</button>
                  <button autoFocus onClick={closePreview} className="files-icon-button text-gray-400" aria-label="Close preview"><LuX size={17} /></button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {preview.status === "loading" && <div role="status" className="flex min-h-64 flex-col items-center justify-center gap-4 text-sm text-gray-200"><LuRefreshCw className="animate-spin text-sky-300" size={28} />Opening preview</div>}
                {preview.status === "error" && <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"><LuCircleAlert size={28} className="text-amber-300" /><p className="text-sm font-semibold text-white">Preview unavailable</p><p className="max-w-lg text-xs leading-5 text-gray-400">{preview.error}</p></div>}
                {preview.status === "ready" && <pre className="min-h-64 whitespace-pre-wrap break-words p-5 font-mono text-xs leading-6 text-gray-200">{preview.content}</pre>}
              </div>
              <div className="flex shrink-0 items-center justify-between border-t border-white/10 px-4 py-2 text-[11px] text-gray-400"><span>{preview.truncated ? "Showing the first 1 MiB · Download to read the full file" : "Read-only text preview"}</span><span>Esc to close</span></div>
            </>}
          </DialogPanel>
        </div>
      </Dialog>
    </div>
  );
};

export default SftpBrowser;
