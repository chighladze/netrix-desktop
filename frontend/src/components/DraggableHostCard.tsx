import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import React, { useRef } from "react";
import { IoArrowForward, IoCopyOutline, IoEllipsisHorizontal, IoFolderOpen, IoFolderOutline, IoHardwareChipOutline, IoMapOutline, IoPencil, IoServerOutline, IoTerminal, IoTrash } from "react-icons/io5";
import type { SavedHostDto } from "../state/store";
import { useAppStore } from "../state/store";
import { hostCredentialLabel, hostEndpoint, hostSecondary } from "../features/hosts/presentation";
import { normalizeGroupPath } from "../utils/groupUtils";
import { copyTextWithAutoClear } from "../utils/clipboard";
import "../features/hosts/hosts.css";

interface DraggableHostCardProps {
  host: SavedHostDto;
  viewMode: "grid" | "list" | "compact";
  onClick: () => void;
  onOpenFiles?: () => void;
  onAddToMap?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onMove?: () => void;
  lastUsed?: number;
  overlay?: boolean;
}

const protocolTone: Record<string, string> = {
  ssh: "bg-sky-400/10 text-sky-300",
  telnet: "bg-amber-400/10 text-amber-300",
  serial: "bg-violet-400/10 text-violet-300",
  local: "bg-gray-400/10 text-gray-300",
};

const DraggableHostCard: React.FC<DraggableHostCardProps> = ({ host, viewMode, onClick, onOpenFiles, onAddToMap, onEdit, onDelete, onMove, lastUsed, overlay }) => {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: `host-${host.id}${overlay ? "-overlay" : ""}`, data: { type: "host", host }, disabled: overlay,
  });
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const pointerMoved = useRef(false);
  const endpoint = hostEndpoint(host);
  const secondary = hostSecondary(host);
  const group = normalizeGroupPath(host.group) || "Ungrouped";
  const credential = hostCredentialLabel(host);
  const recentLabel = lastUsed ? `Last used: ${new Date(lastUsed).toLocaleString()}` : "Not in recent connections";
  const protocol = <span className={`inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${protocolTone[host.connection_type] || protocolTone.ssh}`}>{host.connection_type}</span>;
  const HostIcon = host.connection_type === "serial" ? IoHardwareChipOutline : host.connection_type === "local" ? IoTerminal : IoServerOutline;
  const copyEndpoint = async () => {
    try { await copyTextWithAutoClear(endpoint); useAppStore.getState().addToast("Endpoint copied", "success"); }
    catch { useAppStore.getState().addToast("Could not copy endpoint", "error"); }
  };
  const menuItem = (text: string, icon: React.ReactNode, action: () => void, danger = false) => <MenuItem key={text}>
    <button type="button" onClick={action} className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs data-[focus]:bg-white/[0.07] ${danger ? "text-red-300" : "text-gray-300"}`}>{icon}{text}</button>
  </MenuItem>;

  return <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? .4 : 1 }}
    data-layout={viewMode} data-protocol={host.connection_type}
    className={`host-card group/card flex min-w-0 rounded-lg border border-white/[0.08] transition-colors ${viewMode === "grid" ? "flex-col" : "items-center"}`}>
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
      aria-label={`Connect to ${host.name}`} title={`${host.name}
${endpoint}
${secondary}${credential ? ` · ${credential}` : ""}
${recentLabel}`}
      onPointerDown={(event) => {
        pointerStart.current = { x: event.clientX, y: event.clientY }; pointerMoved.current = false;
        listeners?.onPointerDown?.(event);
      }}
      onPointerMove={(event) => {
        const start = pointerStart.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 8) pointerMoved.current = true;
      }}
      onPointerUp={() => { pointerStart.current = null; }}
      onPointerCancel={() => { pointerStart.current = null; pointerMoved.current = true; }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onClick(); }
      }}
      onClick={() => { if (!pointerMoved.current && !isDragging) onClick(); }}
      className={`min-w-0 flex-1 rounded-lg text-left ${viewMode === "list" ? "host-list-content min-h-12 px-3 py-2" : "w-full px-3 py-2.5"}`}>
      {viewMode === "list" ? <>
        <span className="min-w-0"><span className="block truncate text-[13px] font-medium text-gray-100">{host.name}</span><span className="host-inline-endpoint mt-0.5 hidden truncate font-mono text-[11px] text-gray-400">{endpoint}</span></span>
        <span className="host-list-endpoint truncate font-mono text-xs text-gray-400">{endpoint}</span>
        {protocol}
        <span className="host-list-user truncate text-xs text-gray-400" title={secondary}>{secondary}</span>
        <span className="host-list-group truncate text-xs text-gray-500" title={group}>{group}</span>
      </> : <>
        <span className="flex items-start gap-2">
          {viewMode === "grid" && <span className="host-identity-icon"><HostIcon size={18} /></span>}
          <span className={`min-w-0 flex-1 text-[13px] font-semibold leading-5 text-gray-100 ${viewMode === "grid" ? "host-card-name" : "truncate"}`}>{host.name}</span>{protocol}
        </span>
        <span className={`mt-2 block font-mono text-[11px] leading-4 text-slate-400 ${viewMode === "grid" ? "host-card-endpoint" : "truncate"}`}>{endpoint}</span>
        {viewMode === "grid" ? <span className="mt-2 flex min-w-0 items-center justify-between gap-2 text-[11px] text-slate-500"><span className="truncate" title={secondary}>{secondary}</span>{credential && <span className="truncate" title={credential}>{credential}</span>}</span>
          : <span className="mt-1 block truncate text-[10px] text-slate-500" title={group}>{group}</span>}
      </>}
    </button>
    <div className={`flex shrink-0 items-center gap-1 ${viewMode === "grid" ? "justify-between border-t border-white/[0.05] px-2 py-1" : "pr-2"}`}>
      {viewMode === "grid" && <><span className="min-w-0 flex-1 truncate px-1 text-[10px] text-slate-500" title={group}>{group}</span><button type="button" onClick={onClick} aria-label={`Open terminal for ${host.name}`} className="host-connect-button">Connect<IoArrowForward size={12} /></button></>}
      {host.connection_type === "ssh" && onOpenFiles
        ? <button type="button" onClick={onOpenFiles} title="Open Files" aria-label={`Files for ${host.name}`} className="hosts-icon-button"><IoFolderOpen size={15} /></button>
        : viewMode !== "grid" && <button type="button" onClick={onClick} title="Connect" aria-label={`Open terminal for ${host.name}`} className="hosts-icon-button"><IoTerminal size={15} /></button>}
      <Menu as="div" className="relative">
        <MenuButton aria-label={`Actions for ${host.name}`} title="More actions" className="hosts-icon-button"><IoEllipsisHorizontal size={16} /></MenuButton>
        <MenuItems portal anchor="bottom end" className="z-[100] w-60 rounded-xl border border-white/10 bg-[#101923] p-1 shadow-2xl [--anchor-gap:5px] focus:outline-none">
          <div className="border-b border-white/[0.07] px-3 py-2"><p className="truncate text-xs font-medium text-white">{host.name}</p><p className="mt-1 truncate text-[11px] text-gray-400">{credential || secondary}</p><p className="mt-1 text-[10px] text-gray-500">{recentLabel}</p></div>
          {menuItem("Connect", <IoTerminal size={14} />, onClick)}
          {host.connection_type === "ssh" && onOpenFiles && menuItem("Open Files", <IoFolderOpen size={14} />, onOpenFiles)}
          {menuItem("Copy endpoint", <IoCopyOutline size={14} />, () => void copyEndpoint())}
          {onEdit && menuItem("Edit host", <IoPencil size={14} />, onEdit)}
          {onMove && menuItem("Move to folder", <IoFolderOutline size={14} />, onMove)}
          {onAddToMap && menuItem("Add to map", <IoMapOutline size={14} />, onAddToMap)}
          {onDelete && <div className="mt-1 border-t border-white/[0.07] pt-1">{menuItem("Delete host", <IoTrash size={14} />, onDelete, true)}</div>}
        </MenuItems>
      </Menu>
    </div>
  </div>;
};

export default DraggableHostCard;
