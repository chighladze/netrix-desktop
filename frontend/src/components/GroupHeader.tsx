import type { MouseEvent } from "react";
import { IoChevronDown, IoChevronForward, IoEllipsisHorizontal, IoFolderOutline } from "react-icons/io5";
import type { HostGroup } from "../utils/groupUtils";

interface GroupHeaderProps {
  group: HostGroup;
  level: number;
  isRoot?: boolean;
  onToggle: () => void;
  hostsCount: number;
  isDropTarget?: boolean;
  onContextMenu?: (event: MouseEvent, path: string, name: string) => void;
  onMoreClick?: (event: MouseEvent, path: string, name: string) => void;
}

export default function GroupHeader({ group, level, onToggle, hostsCount, isDropTarget, onContextMenu, onMoreClick }: GroupHeaderProps) {
  return <div className={`flex min-w-0 items-center gap-1 rounded-lg ${isDropTarget ? "bg-sky-400/10 ring-1 ring-sky-400/40" : "hover:bg-white/[0.025]"}`}
    onContextMenu={(event) => { event.preventDefault(); onContextMenu?.(event, group.path, group.name); }}>
    <button type="button" onClick={onToggle} aria-expanded={group.isExpanded} aria-label={`${group.isExpanded ? "Collapse" : "Expand"} group ${group.path}`}
      className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-xs text-gray-300" title={group.path}>
      {group.isExpanded ? <IoChevronDown size={13} className="shrink-0 text-gray-500" /> : <IoChevronForward size={13} className="shrink-0 text-gray-500" />}
      <IoFolderOutline size={15} className="shrink-0 text-sky-300/80" />
      <span className="truncate font-semibold">{level >= 3 ? group.path : group.name}</span>
      <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] tabular-nums text-gray-500">{hostsCount}</span>
    </button>
    {onMoreClick && <button type="button" className="hosts-icon-button" aria-label={`Actions for group ${group.path}`} title="Group actions"
      onClick={(event) => onMoreClick(event, group.path, group.name)}><IoEllipsisHorizontal size={15} /></button>}
  </div>;
}
