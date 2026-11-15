import { useDroppable } from "@dnd-kit/core";
import type { MouseEvent } from "react";
import { IoAdd, IoChevronDown, IoChevronForward, IoEllipsisHorizontal, IoFolderOpenOutline, IoFolderOutline, IoLayersOutline } from "react-icons/io5";
import type { HostGroup } from "../../utils/groupUtils";

const countHosts = (group: HostGroup): number => group.hosts.length + group.subgroups.reduce((sum, child) => sum + countHosts(child), 0);
interface Props {
  groups: HostGroup[]; selected: string | null; total: number; ungrouped: number; busy: boolean;
  onSelect: (path: string | null) => void; onToggle: (path: string) => void;
  onActions: (event: MouseEvent, path: string, name: string) => void;
  onCreate: () => void;
}
function FolderRow({ path, name, count, selected, expanded, onToggle, onSelect, onActions, busy }: {
  path: string | null; name: string; count: number; selected: boolean; expanded?: boolean;
  onToggle?: () => void; onSelect: () => void; onActions?: (event: MouseEvent) => void; busy: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder-nav-${path ?? "all"}`, disabled: path === null || busy, data: { type: "group", groupPath: path } });
  return <div ref={setNodeRef} className="hosts-folder-row" data-selected={selected} data-drop-target={isOver} onContextMenu={event => { if (onActions) { event.preventDefault(); onActions(event); } }}>
    {onToggle ? <button type="button" onClick={onToggle} className="hosts-folder-chevron" aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} folder ${path}`}>{expanded ? <IoChevronDown size={12} /> : <IoChevronForward size={12} />}</button> : <span className="w-5 shrink-0" />}
    <button type="button" className="hosts-folder-link" aria-current={selected ? "page" : undefined} aria-label={path === null ? "All hosts" : `Open folder ${path || "Ungrouped"}`} title={path || name} onClick={onSelect}>
      {path === null ? <IoLayersOutline size={16} /> : selected ? <IoFolderOpenOutline size={16} /> : <IoFolderOutline size={16} />}
      <span className="min-w-0 flex-1 truncate">{name}</span><span className="hosts-folder-count">{count}</span>
    </button>
    {onActions && <button type="button" disabled={busy} onClick={onActions} aria-label={`Actions for folder ${path}`} className="hosts-folder-more" title="Folder actions"><IoEllipsisHorizontal size={14} /></button>}
  </div>;
}
function FolderBranch({ group, ...props }: Props & { group: HostGroup }) {
  return <li>
    <FolderRow path={group.path} name={group.name} count={countHosts(group)} selected={props.selected === group.path} busy={props.busy}
      expanded={group.isExpanded} onToggle={group.subgroups.length ? () => props.onToggle(group.path) : undefined}
      onSelect={() => props.onSelect(group.path)} onActions={event => props.onActions(event, group.path, group.name)} />
    {group.isExpanded && group.subgroups.length > 0 && <ul className="hosts-folder-children">{group.subgroups.map(child => <FolderBranch key={child.path} group={child} {...props} />)}</ul>}
  </li>;
}
export default function FolderSidebar(props: Props) {
  return <aside className="hosts-folder-sidebar" aria-label="Folder browser">
    <div className="flex h-11 shrink-0 items-center justify-between px-3"><h2 className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-500">Folders</h2><button type="button" className="hosts-icon-button" onClick={props.onCreate} aria-label="Create root folder" title="New root folder"><IoAdd size={16} /></button></div>
    <nav aria-label="Host folders" className="min-h-0 flex-1 overflow-auto px-2 pb-3" onKeyDown={event => {
      if (event.target instanceof HTMLButtonElement && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        const links = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".hosts-folder-link")];
        const index = links.indexOf(event.target); if (index < 0) return;
        event.preventDefault(); links[Math.max(0, Math.min(links.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
    }}>
      <FolderRow path={null} name="All hosts" count={props.total} selected={props.selected === null} onSelect={() => props.onSelect(null)} busy={props.busy} />
      <FolderRow path="" name="Ungrouped" count={props.ungrouped} selected={props.selected === ""} onSelect={() => props.onSelect("")} busy={props.busy} />
      <div className="mx-2 my-2 border-t border-white/[0.06]" />
      <ul>{props.groups.map(group => <FolderBranch key={group.path} group={group} {...props} />)}</ul>
      {!props.groups.length && <p className="px-3 py-3 text-xs leading-5 text-slate-500">Create a folder to organize your hosts.</p>}
    </nav>
    <p className="border-t border-white/[0.06] px-4 py-3 text-[10px] leading-4 text-slate-500">Drag hosts into a folder, or use Move to folder in their menu.</p>
  </aside>;
}
