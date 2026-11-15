import { useDroppable } from "@dnd-kit/core";
import type { MouseEvent } from "react";
import type { HostGroup } from "../utils/groupUtils";
import HostCollection, { type HostCollectionActions } from "../features/hosts/HostCollection";
import GroupHeader from "./GroupHeader";

interface GroupTreeNodeProps extends HostCollectionActions {
  group: HostGroup;
  level: number;
  viewMode: "grid" | "list" | "compact";
  onToggle: (path: string) => void;
  onGroupContextMenu?: (event: MouseEvent, path: string, name: string) => void;
  onGroupMoreClick?: (event: MouseEvent, path: string, name: string) => void;
}
const totalHosts = (group: HostGroup): number => group.hosts.length + group.subgroups.reduce((count, child) => count + totalHosts(child), 0);

export default function GroupTreeNode({ group, level, viewMode, onToggle, onGroupContextMenu, onGroupMoreClick, ...actions }: GroupTreeNodeProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `group-header-${group.path}`, data: { type: "group", groupPath: group.path } });
  return <section className="min-w-0" aria-label={`Group ${group.path}`}>
    <div ref={setNodeRef}><GroupHeader group={group} level={level} onToggle={() => onToggle(group.path)} hostsCount={totalHosts(group)}
      isDropTarget={isOver} onContextMenu={onGroupContextMenu} onMoreClick={onGroupMoreClick} /></div>
    {group.isExpanded && <div className="pb-2">
      {(group.hosts.length > 0 || !group.subgroups.length) && <HostCollection hosts={group.hosts} viewMode={viewMode} dropGroup={group.path}
        emptyLabel="Empty group · Move or drag a host here" {...actions} />}
      {group.subgroups.length > 0 && <div className={`mt-1 space-y-1 ${level < 3 ? "ml-3 border-l border-white/[0.06] pl-3" : ""}`}>
        {group.subgroups.map((child) => <GroupTreeNode key={child.path} group={child} level={level + 1} viewMode={viewMode}
          onToggle={onToggle} onGroupContextMenu={onGroupContextMenu} onGroupMoreClick={onGroupMoreClick} {...actions} />)}
      </div>}
    </div>}
  </section>;
}
