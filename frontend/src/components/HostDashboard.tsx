import {
    closestCenter,
    CollisionDetection,
    DndContext,
    DragEndEvent,
    DragOverlay,
    DragStartEvent,
    PointerSensor,
    pointerWithin,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { IoArrowDown, IoArrowUp, IoTimeOutline, IoChevronForward, IoFolderOpenOutline, IoFolderOutline, IoEllipsisHorizontal } from "react-icons/io5";
import { hostGroupPaths, visibleHosts, type HostSort } from "../features/hosts/presentation";
import HostCollection, { type HostCollectionActions } from "../features/hosts/HostCollection";
import MoveHostDialog from "../features/hosts/MoveHostDialog";
import FolderSidebar from "../features/hosts/FolderSidebar";
import FolderDialog, { type FolderOperation } from "../features/hosts/FolderDialog";
import { childFolders, folderAncestors, inFolder, relocateFolder, validateFolderDestination } from "../features/hosts/folders";
import "../features/hosts/hosts.css";
import {
    IoAdd,
    IoApps,
    IoClose,
    IoContractOutline,
    IoExpandOutline,
    IoKeyOutline,
    IoFilter,
    IoFolder,
    IoGrid,
    IoList,
    IoLockClosed,
    IoLockOpen,
    IoRefresh,
    IoShieldCheckmarkOutline,
    IoSearch,
    IoTerminal
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { getApiBase } from "../api";
import { validateNewVaultMasterPassword } from "../features/vault/password";
import {
  Host,
  QuickConnectHost,
  SavedHostDto,
  useAppStore,
} from "../state/store";
import { buildGroupTree, getGroupName, getParentPath, normalizeGroupPath } from "../utils/groupUtils";
import DraggableHostCard from "./DraggableHostCard";
import GroupContextMenu from "./GroupContextMenu";
import HostFormModal from "./HostFormModal";

interface HostDashboardProps {
  onConnect: (host: Host) => void;
  onOpenFiles?: (host: Host) => void;
  onAddToMap?: (host: Host) => void;
}

const HostDashboard: React.FC<HostDashboardProps> = ({ onConnect, onOpenFiles, onAddToMap }) => {
  const {
    hosts,
    loadHosts,
    isLoading,
    error,
    setSelectedHost,
    hostsViewMode,
    setHostsViewMode,
    hostsPreferences,
    setHostsPreferences,
    recentConnections,
    addToast,
    showConfirm,
    collapsedGroups,
    toggleGroup,
    expandAllGroups,
    collapseAllGroups,
    moveHostToGroup,
    definedGroups,
    addDefinedGroup,
    deleteGroupWithHosts,
    hostGroupsBusy,
    moveHostFolder,
    vaultInitialized,
    vaultStatusLoaded,
    unlockVault,
  } = useAppStore(
    useShallow((state) => ({
      hosts: state.hosts,
      loadHosts: state.fetchHosts,
      isLoading: state.hostsLoading,
      error: state.hostsError,
      setSelectedHost: state.setSelectedHost,
      hostsViewMode: state.hostsViewMode,
      setHostsViewMode: state.setHostsViewMode,
      hostsPreferences: state.hostsPreferences,
      setHostsPreferences: state.setHostsPreferences,
      recentConnections: state.recentConnections,
      addToast: state.addToast,
      showConfirm: state.showConfirm,
      collapsedGroups: state.collapsedGroups,
      toggleGroup: state.toggleGroup,
      expandAllGroups: state.expandAllGroups,
      collapseAllGroups: state.collapseAllGroups,
      moveHostToGroup: state.moveHostToGroup,
      definedGroups: state.definedGroups,
      addDefinedGroup: state.addDefinedGroup,
      deleteGroupWithHosts: state.deleteGroupWithHosts,
      hostGroupsBusy: state.hostGroupsBusy,
      moveHostFolder: state.moveHostFolder,
      vaultInitialized: state.vaultInitialized,
      vaultStatusLoaded: state.vaultStatusLoaded,
      unlockVault: state.unlockVault,
    })),
  );
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<SavedHostDto | null>(null);
  const [apiBase, setApiBase] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [protocolFilter, setProtocolFilter] = useState<string>("all");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [recentOnly, setRecentOnly] = useState(false);
  const [folderOperation, setFolderOperation] = useState<FolderOperation | null>(null);
  const [initialHostGroup, setInitialHostGroup] = useState("Default");
  const [movingHost, setMovingHost] = useState<SavedHostDto | null>(null);
  const [formIntent, setFormIntent] = useState<"save" | "quick">("save");
  const [vaultSetupPassword, setVaultSetupPassword] = useState("");
  const [vaultSetupConfirmation, setVaultSetupConfirmation] = useState("");
  const [vaultSetupBusy, setVaultSetupBusy] = useState(false);
  const [vaultSetupError, setVaultSetupError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Drag & Drop state
  const [activeHost, setActiveHost] = useState<SavedHostDto | null>(null);

  // Group Management State
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    groupPath: string;
    groupName: string;
  } | null>(null);

  // DnD Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const collisionDetection: CollisionDetection = (args) => {
    return args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);
  };

  useEffect(() => {
    getApiBase().then(setApiBase).catch(() => addToast("Could not initialize connections", "error"));
  }, [addToast]);

  // Ctrl+K to focus search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !isModalOpen && !folderOperation && !movingHost) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isModalOpen, folderOperation, movingHost]);

  useEffect(() => {
    if (apiBase) void loadHosts().catch(error => {
      addToast(error instanceof Error ? error.message : "Failed to load hosts", "error");
    });
  }, [apiBase, loadHosts, addToast]);

  const handleAddStart = (intent: "save" | "quick" = "save", folder = groupFilter ?? "Default") => {
    setEditingHost(null);
    setInitialHostGroup(folder);
    setFormIntent(intent);
    setIsModalOpen(true);
  };

  const handleEditStart = (host: SavedHostDto) => {
    setEditingHost(host);
    setFormIntent("save");
    setIsModalOpen(true);
  };

  const handleDeleteClick = (host: SavedHostDto) => {
    showConfirm({
      title: "Delete Host",
      message:
        `Delete the saved profile "${host.name}"? This cannot be undone.`,
      confirmText: "Delete",
      type: "danger",
      onConfirm: async () => {
        try {
          await useAppStore.getState().deleteHost(host.id);
          addToast("Host deleted successfully", "success");
        } catch (err: unknown) {
          console.error(err);
          const message = err instanceof Error ? err.message : "Failed to delete host";
          addToast(message, "error");
        }
      },
    });
  };

  const handleConnect = (host: SavedHostDto) => {
    setSelectedHost(host);
    onConnect(host);
  };

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    if (active.data.current?.type === "host") {
      setActiveHost(active.data.current.host as SavedHostDto);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveHost(null);

    if (!over || hostGroupsBusy) return;

    if (over.data.current?.type === "group" && active.data.current?.type === "host") {
      const host = active.data.current.host as SavedHostDto;
      const targetGroupPath = over.data.current.groupPath as string;
      if (normalizeGroupPath(host.group) === targetGroupPath) return;
      
      try {
        await moveHostToGroup(host.id, targetGroupPath);
        addToast(`Moved ${host.name} to ${targetGroupPath || "Ungrouped"}`, "success");
      } catch (error) {
        addToast(error instanceof Error ? error.message : "Failed to move host", "error");
      }
    }
    

  };

  const handleGroupContextMenu = (e: React.MouseEvent, path: string, name: string) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: e.clientX || bounds.left,
      y: e.clientY || bounds.bottom,
      groupPath: path,
      groupName: name,
    });
  };

  const handleAddGroupStart = () => setFolderOperation({ mode: "create", path: groupFilter || "" });

  const selectFolder = (path: string | null) => {
    setGroupFilter(path);
    setContextMenu(null);
    if (path) folderAncestors(path).slice(0, -1).forEach(ancestor => {
      if (useAppStore.getState().collapsedGroups.has(ancestor.path)) toggleGroup(ancestor.path);
    });
  };

  const submitFolder = async (destination: string) => {
    if (!folderOperation) return;
    const { mode, path } = folderOperation;
    if (mode === "create") {
      const invalid = validateFolderDestination(null, destination, availableGroups);
      if (invalid) throw new Error(invalid);
      addDefinedGroup(destination);
    } else {
      await moveHostFolder(path, destination);
    }
    setGroupFilter(current => current && mode !== "create" ? relocateFolder(current, path, destination) : mode === "create" ? destination : current);
    folderAncestors(destination).slice(0, -1).forEach(ancestor => {
      if (useAppStore.getState().collapsedGroups.has(ancestor.path)) toggleGroup(ancestor.path);
    });
    addToast(mode === "create" ? "Folder created" : mode === "rename" ? "Folder renamed" : "Folder moved", "success");
  };

  const toggleBranch = (path: string, expanded: boolean) => {
    availableGroups.filter(candidate => inFolder(candidate, path)).forEach(candidate => {
      if (useAppStore.getState().collapsedGroups.has(candidate) === expanded) toggleGroup(candidate);
    });
  };

  const handleVaultSetup = async () => {
    if (!vaultSetupPassword || vaultSetupBusy) return;

    const validationError = validateNewVaultMasterPassword(
      vaultSetupPassword,
      vaultSetupConfirmation,
    );
    if (validationError) {
      setVaultSetupError(validationError);
      return;
    }

    setVaultSetupBusy(true);
    setVaultSetupError(null);
    const result = await unlockVault(vaultSetupPassword);
    setVaultSetupBusy(false);

    if (result.ok) {
      addToast(vaultInitialized ? "Vault unlocked" : "Vault created and unlocked", "success");
      setVaultSetupPassword("");
      setVaultSetupConfirmation("");
      return;
    }

    setVaultSetupError(result.error || "Failed to unlock vault");
  };

  const recentTimestamps = useMemo(() => {
    const result = new Map<number, number>();
    recentConnections.forEach(({ host, timestamp }) => {
      if (host.id >= 0 && Number.isFinite(timestamp)) result.set(host.id, Math.max(result.get(host.id) || 0, timestamp));
    });
    return result;
  }, [recentConnections]);
  const availableGroups = useMemo(() => hostGroupPaths(hosts, definedGroups), [hosts, definedGroups]);
  const filteredHosts = useMemo(() => visibleHosts(hosts, { query: searchQuery, protocol: protocolFilter, group: groupFilter, recentOnly }, hostsPreferences, recentTimestamps),
    [hosts, searchQuery, protocolFilter, groupFilter, recentOnly, hostsPreferences, recentTimestamps]);
  const isSearching = Boolean(searchQuery.trim() || protocolFilter !== "all" || groupFilter !== null || recentOnly);
  const groupTree = useMemo(() => buildGroupTree(hosts, collapsedGroups, definedGroups, hostsPreferences.sort === "group" && hostsPreferences.descending),
    [hosts, collapsedGroups, definedGroups, hostsPreferences.sort, hostsPreferences.descending]);
  const subfolders = useMemo(() => groupFilter ? childFolders(availableGroups, groupFilter) : [], [availableGroups, groupFilter]);
  const clearFilters = () => { setSearchQuery(""); setProtocolFilter("all"); setGroupFilter(null); setRecentOnly(false); };
  const expandVisibleGroups = expandAllGroups;
  const collapseVisibleGroups = collapseAllGroups;
  const folderHostCount = (path: string) => hosts.filter(host => inFolder(normalizeGroupPath(host.group), path)).length;
  const hostActions: HostCollectionActions = {
    onHostClick: handleConnect, onHostOpenFiles: onOpenFiles, onHostAddToMap: onAddToMap,
    onHostEdit: handleEditStart, onHostDelete: handleDeleteClick, onHostMove: setMovingHost, recentTimestamps,
  };
  const filterCount = Number(protocolFilter !== "all") + Number(groupFilter !== null);
  const recentCount = hosts.filter((host) => recentTimestamps.has(host.id)).length;

  return (
    <div className="hosts-workspace flex h-full min-h-0 w-full flex-col overflow-hidden bg-[#080e16]">
      <header className="hosts-header shrink-0 space-y-3 border-b border-white/[0.07] bg-[#0b131e] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3"><h1 className="text-lg font-semibold text-white">Hosts</h1><span role="status" className="text-xs tabular-nums text-gray-500">{isSearching ? `${filteredHosts.length} of ${hosts.length}` : `${hosts.length} total`}</span></div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => handleAddStart("quick")} className="hosts-button"><IoTerminal size={14} />Quick Connect</button>
            <button onClick={handleAddGroupStart} className="hosts-button"><IoFolder size={14} />New Folder</button>
            <button onClick={() => handleAddStart()} className="hosts-button hosts-button-primary"><IoAdd size={16} />New Host</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <IoSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
            <input ref={searchInputRef} type="search" aria-label="Search hosts" placeholder="Search hosts... (Ctrl+K)" value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setSearchQuery(""); }}
              className="h-9 w-full rounded-lg border border-white/10 bg-black/15 pl-9 pr-8 text-xs text-white placeholder:text-gray-500" />
            {searchQuery && <button onClick={() => setSearchQuery("")} aria-label="Clear host search" className="absolute right-1 top-0.5 flex h-8 w-7 items-center justify-center rounded text-gray-400"><IoClose size={14} /></button>}
          </div>
          <Popover className="relative">
            <PopoverButton className={`hosts-button ${filterCount ? "border-sky-400/30 text-sky-200" : ""}`}><IoFilter size={14} />Filters{filterCount > 0 && <span className="rounded bg-sky-400/15 px-1.5 text-[10px]">{filterCount}</span>}</PopoverButton>
            <PopoverPanel portal anchor="bottom start" className="hosts-workspace z-40 w-72 rounded-xl border border-white/10 bg-[#101923] p-4 shadow-2xl [--anchor-gap:8px]">
              <h2 className="mb-3 text-xs font-semibold text-white">Filter hosts</h2>
              <label className="block text-xs text-gray-400">Protocol<select value={protocolFilter} onChange={(event) => setProtocolFilter(event.target.value)} className="mt-1.5 h-9 w-full rounded-lg border border-white/10 bg-[#0b131e] px-2 text-xs text-white">
                <option value="all">All protocols</option><option value="ssh">SSH</option><option value="telnet">Telnet</option><option value="serial">Serial</option><option value="local">Local shell</option>
              </select></label>
              <label className="mt-3 block text-xs text-gray-400">Group<select value={groupFilter === null ? "all" : `group:${groupFilter}`} onChange={(event) => selectFolder(event.target.value === "all" ? null : event.target.value.slice(6))} className="mt-1.5 h-9 w-full rounded-lg border border-white/10 bg-[#0b131e] px-2 text-xs text-white">
                <option value="all">All groups</option><option value="group:">Ungrouped</option>{availableGroups.map((path) => <option key={path} value={`group:${path}`}>{path}</option>)}
              </select></label>
              <p className="mt-2 text-[11px] leading-4 text-gray-500">Includes hosts in subgroups.</p>
              <button className="mt-3 text-xs text-sky-300" onClick={() => { setProtocolFilter("all"); setGroupFilter(null); }}>Reset filters</button>
            </PopoverPanel>
          </Popover>
          <button onClick={() => setRecentOnly(!recentOnly)} aria-pressed={recentOnly} className={`hosts-button ${recentOnly ? "border-sky-400/30 text-sky-200" : ""}`}><IoTimeOutline size={14} />Recent<span className="text-[10px] text-gray-500">{recentCount}</span></button>
          <div className="flex h-9 items-center rounded-lg border border-white/10 bg-white/[0.025]">
            <select aria-label="Sort hosts" value={hostsPreferences.sort} onChange={(event) => { const sort = event.target.value as HostSort; setHostsPreferences({ sort, descending: sort === "recent" }); }} className="h-full rounded-l-lg bg-[#0d1520] pl-2 pr-1 text-xs text-gray-300">
              <option value="name">Name</option><option value="endpoint">Address</option><option value="protocol">Protocol</option><option value="group">Group</option><option value="recent">Last used</option>
            </select>
            <button className="hosts-icon-button" aria-label={hostsPreferences.descending ? "Sort ascending" : "Sort descending"} title={hostsPreferences.descending ? "Descending · Reverse order" : "Ascending · Reverse order"} onClick={() => setHostsPreferences({ descending: !hostsPreferences.descending })}>{hostsPreferences.descending ? <IoArrowDown size={14} /> : <IoArrowUp size={14} />}</button>
          </div>
          <div role="group" aria-label="Host layout" className="flex rounded-lg border border-white/10 p-0.5">
            {([{ mode: "list", label: "List", icon: IoList }, { mode: "compact", label: "Compact", icon: IoApps }, { mode: "grid", label: "Grid", icon: IoGrid }] as const).map(({ mode, label, icon: Icon }) => <button key={mode} aria-label={label} title={label} aria-pressed={hostsViewMode === mode} onClick={() => setHostsViewMode(mode)} className={`hosts-icon-button ${hostsViewMode === mode ? "bg-sky-400/15 text-sky-200" : ""}`}><Icon size={15} /></button>)}
          </div>
          <button onClick={() => setHostsPreferences({ grouped: !hostsPreferences.grouped })} aria-pressed={hostsPreferences.grouped} title="Show or hide the folder browser" className={`hosts-button ${hostsPreferences.grouped ? "text-sky-200" : ""}`}><IoFolder size={14} />Folders</button>
          {hostsPreferences.grouped && availableGroups.length > 0 && <div className="flex"><button className="hosts-icon-button" title="Expand all groups" aria-label="Expand all groups" onClick={expandVisibleGroups}><IoExpandOutline size={15} /></button><button className="hosts-icon-button" title="Collapse all groups" aria-label="Collapse all groups" onClick={collapseVisibleGroups}><IoContractOutline size={15} /></button></div>}
          <button className="hosts-icon-button" title="Refresh hosts" aria-label="Refresh hosts" disabled={isLoading} onClick={() => void loadHosts().catch(() => undefined)}><IoRefresh size={16} className={isLoading ? "animate-spin" : ""} /></button>
        </div>
        {isSearching && <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-400">
          {searchQuery.trim() && <span className="max-w-80 truncate" title={searchQuery}>Matching “{searchQuery.trim()}”</span>}
          {protocolFilter !== "all" && <button className="inline-flex items-center gap-1 rounded bg-white/5 px-2 py-1" onClick={() => setProtocolFilter("all")} aria-label="Clear protocol filter">{protocolFilter.toUpperCase()}<IoClose size={12} /></button>}
          {groupFilter !== null && <button className="inline-flex max-w-64 items-center gap-1 rounded bg-white/5 px-2 py-1" onClick={() => setGroupFilter(null)} aria-label="Clear group filter"><span className="truncate">{groupFilter || "Ungrouped"}</span><IoClose size={12} /></button>}
          {recentOnly && <span>Recent connections only</span>}
          <button onClick={clearFilters} className="text-sky-300 hover:text-sky-100">Clear all filters</button>
        </div>}
      </header>

      <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setActiveHost(null)}>
        <div className="hosts-explorer" data-folders={hostsPreferences.grouped}>
          {hostsPreferences.grouped && <FolderSidebar groups={groupTree} selected={groupFilter} total={hosts.length}
            ungrouped={hosts.filter(host => !normalizeGroupPath(host.group)).length} busy={hostGroupsBusy}
            onSelect={selectFolder} onToggle={toggleGroup} onActions={handleGroupContextMenu}
            onCreate={() => setFolderOperation({ mode: "create", path: "" })} />}
          <div className="hosts-results">
            <div className="hosts-location-bar">
              <nav aria-label="Folder breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs">
                <button type="button" onClick={() => selectFolder(null)} aria-label="Show all hosts" className="hosts-breadcrumb"><IoFolderOpenOutline size={15} />All hosts</button>
                {groupFilter === "" && <><IoChevronForward size={12} className="shrink-0 text-slate-600" /><span className="px-1 text-slate-200">Ungrouped</span></>}
                {groupFilter && folderAncestors(groupFilter).map(ancestor => <React.Fragment key={ancestor.path}><IoChevronForward size={12} className="shrink-0 text-slate-600" /><button type="button" title={ancestor.path} onClick={() => selectFolder(ancestor.path)} aria-current={ancestor.path === groupFilter ? "page" : undefined} className="hosts-breadcrumb">{ancestor.name}</button></React.Fragment>)}
              </nav>
              {groupFilter && <button disabled={hostGroupsBusy} className="hosts-icon-button" aria-label="Current folder actions" title="Folder actions" onClick={event => handleGroupContextMenu(event, groupFilter, getGroupName(groupFilter))}><IoEllipsisHorizontal size={16} /></button>}
            </div>
            <div className="hosts-results-scroll">
      {error && (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200">
          <span>{error}</span>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => { void loadHosts().catch(() => undefined); }}
            className="shrink-0 rounded border border-red-300/20 px-3 py-1 hover:bg-red-300/10 disabled:opacity-40"
          >
            Retry loading hosts
          </button>
        </div>
      )}
      {vaultStatusLoaded && !vaultInitialized && (
        <div className="mb-4 rounded-xl border border-white/[0.08] bg-white/[0.045] p-4 shadow-[0_18px_55px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.055] text-amber-300/90">
                <IoShieldCheckmarkOutline size={20} />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-100">Set up Credential Vault first</h2>
                  <span className="inline-flex items-center gap-1 rounded border border-white/[0.08] bg-white/[0.055] px-2 py-0.5 text-[10px] font-semibold uppercase text-gray-300">
                    <IoLockClosed size={11} />
                    Required for saved secrets
                  </span>
                </div>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-400">
                  Create a local master password now. Saved SSH/SFTP passwords, private keys, and hosts that use stored credentials require the vault to be unlocked.
                </p>
                <p className="mt-1 max-w-2xl text-[11px] leading-4 text-amber-200/70">
                  Use at least 10 characters. Netrix cannot recover this password; resetting the vault deletes saved secrets but keeps host profiles.
                </p>
              </div>
            </div>

            <form
              className="flex min-w-0 flex-col gap-2 lg:w-[520px]"
              onSubmit={(event) => {
                event.preventDefault();
                void handleVaultSetup();
              }}
            >
              <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                <label className="relative min-w-0">
                  <span className="sr-only">Vault master password</span>
                  <IoKeyOutline className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-amber-300/70" size={14} />
                  <input
                    type="password"
                    value={vaultSetupPassword}
                    onChange={(event) => {
                      setVaultSetupPassword(event.target.value);
                      if (vaultSetupError) setVaultSetupError(null);
                    }}
                    placeholder="Master password"
                    autoComplete="new-password"
                    className="h-9 w-full rounded-lg border border-amber-400/20 bg-black/30 pl-9 pr-3 text-xs text-amber-50 placeholder-amber-100/35 outline-none focus:border-amber-300/60"
                  />
                </label>
                <label className="relative min-w-0">
                  <span className="sr-only">Confirm vault master password</span>
                  <IoKeyOutline className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-amber-300/70" size={14} />
                  <input
                    type="password"
                    value={vaultSetupConfirmation}
                    onChange={(event) => {
                      setVaultSetupConfirmation(event.target.value);
                      if (vaultSetupError) setVaultSetupError(null);
                    }}
                    placeholder="Confirm password"
                    autoComplete="new-password"
                    className="h-9 w-full rounded-lg border border-amber-400/20 bg-black/30 pl-9 pr-3 text-xs text-amber-50 placeholder-amber-100/35 outline-none focus:border-amber-300/60"
                  />
                </label>
              </div>
              <button
                type="submit"
                disabled={vaultSetupBusy || !vaultSetupPassword || !vaultSetupConfirmation}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.065] px-3 text-xs font-semibold text-gray-100 hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <IoLockOpen size={14} />
                {vaultSetupBusy ? "Creating..." : "Create & Unlock"}
              </button>
            </form>
          </div>

          {vaultSetupError && (
            <div className="mt-3 text-xs text-red-200">{vaultSetupError}</div>
          )}
        </div>
      )}


              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2"><h2 className="truncate text-sm font-semibold text-slate-100">{groupFilter === null ? "All hosts" : groupFilter === "" ? "Ungrouped" : getGroupName(groupFilter)}</h2><span className="shrink-0 text-[11px] text-slate-500">{filteredHosts.length} host{filteredHosts.length === 1 ? "" : "s"}</span></div>
                {groupFilter && subfolders.length > 0 && <span className="text-[10px] text-slate-500">Includes subfolders</span>}
              </div>
              {subfolders.length > 0 && !searchQuery.trim() && <div className="hosts-subfolders" aria-label="Subfolders">
                {subfolders.map(path => <button type="button" key={path} onClick={() => selectFolder(path)} className="hosts-subfolder" title={path} aria-label={`Browse ${path}, ${folderHostCount(path)} hosts`}>
                  <IoFolderOutline size={20} className="shrink-0 text-sky-300/80" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-slate-200">{getGroupName(path)}</span><span className="text-[10px] text-slate-500">{folderHostCount(path)} host{folderHostCount(path) === 1 ? "" : "s"}</span></span><IoChevronForward size={13} className="text-slate-500" />
                </button>)}
              </div>}
              {isLoading && hosts.length === 0 ? <div className="py-16 text-center text-xs text-slate-400"><div className="spinner mx-auto mb-3 h-6 w-6" />Loading hosts…</div> : <div className="hosts-collection">
                {hostsViewMode === "list" && filteredHosts.length > 0 && <div aria-hidden="true" className="host-list-content host-list-heading min-h-8 border-b border-white/[0.06] pl-3 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                  <span>Name</span><span className="host-list-endpoint">Address / device</span><span>Protocol</span><span className="host-list-user">User / context</span><span className="host-list-group">Folder</span>
                </div>}
                <HostCollection hosts={filteredHosts} viewMode={hostsViewMode} dropGroup={groupFilter ?? undefined} {...hostActions} />
                {filteredHosts.length === 0 && <div className="hosts-empty-state">
                  <IoFolderOpenOutline size={32} className="text-slate-500" />
                  <h2 className="text-sm font-semibold text-slate-100">{searchQuery.trim() || protocolFilter !== "all" || recentOnly ? "No hosts found" : groupFilter !== null ? "This folder is empty" : "Add your first host"}</h2>
                  <p className="max-w-sm text-xs leading-5 text-slate-400">{searchQuery.trim() || protocolFilter !== "all" || recentOnly ? "Try another name or address, or clear the filters." : "Add a host here, or move an existing host into this folder."}</p>
                  <button className="hosts-button" onClick={searchQuery.trim() || protocolFilter !== "all" || recentOnly ? clearFilters : () => handleAddStart()}>{searchQuery.trim() || protocolFilter !== "all" || recentOnly ? "Reset search and filters" : "New Host"}</button>
                </div>}
              </div>}
            </div>
            <footer className="hosts-status-bar"><span>{filteredHosts.length} of {hosts.length} hosts</span><span>Click a host to connect · Use ⋯ for more actions</span></footer>
          </div>
        </div>
        <DragOverlay>{activeHost ? <div className="opacity-90 shadow-2xl"><DraggableHostCard host={activeHost} viewMode={hostsViewMode} onClick={() => {}} overlay /></div> : null}</DragOverlay>
      </DndContext>

      <HostFormModal
        isOpen={isModalOpen}
        intent={formIntent}
        initialGroup={initialHostGroup}
        onClose={() => setIsModalOpen(false)}
        onSave={() => {
          addToast("Host saved successfully", "success");
        }}
        onQuickConnect={(tempHost) => {
          const quickHost: QuickConnectHost = { ...tempHost, id: -1 };
          setSelectedHost(quickHost);
          onConnect(quickHost);
        }}
        hostToEdit={editingHost}
        apiBase={apiBase}
      />

      {movingHost && <MoveHostDialog key={movingHost.id} host={movingHost} groups={availableGroups} onClose={() => setMovingHost(null)} />}

      {contextMenu && <GroupContextMenu
        x={contextMenu.x} y={contextMenu.y} groupPath={contextMenu.groupPath} groupName={contextMenu.groupName}
        onClose={() => setContextMenu(null)} onOpen={() => selectFolder(contextMenu.groupPath)}
        onAddHost={() => handleAddStart("save", contextMenu.groupPath)}
        onAddSubgroup={() => setFolderOperation({ mode: "create", path: contextMenu.groupPath })}
        onRename={() => setFolderOperation({ mode: "rename", path: contextMenu.groupPath })}
        onMove={() => setFolderOperation({ mode: "move", path: contextMenu.groupPath })}
        onExpandAll={() => toggleBranch(contextMenu.groupPath, true)} onCollapseAll={() => toggleBranch(contextMenu.groupPath, false)}
        onDelete={() => {
          const path = contextMenu.groupPath;
          showConfirm({ title: `Delete folder "${contextMenu.groupName}"?`,
            message: `This deletes the folder, all its subfolders and ${folderHostCount(path)} saved host(s). This cannot be undone.`,
            confirmText: "Delete folder and hosts", type: "danger",
            onConfirm: async () => {
              try {
                await deleteGroupWithHosts(path, true);
                setGroupFilter(current => current && inFolder(current, path) ? getParentPath(path) : current);
                addToast("Folder and hosts deleted", "success");
              } catch (error) { addToast(error instanceof Error ? error.message : "Could not delete folder", "error"); }
            },
          });
        }}
      />}
      {folderOperation && <FolderDialog key={`${folderOperation.mode}:${folderOperation.path}`} operation={folderOperation}
        paths={availableGroups} hostCount={folderHostCount(folderOperation.path)} onSubmit={submitFolder} onClose={() => setFolderOperation(null)} />}

    </div>
  );
};

export default HostDashboard;
