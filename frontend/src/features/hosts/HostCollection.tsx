import { useDroppable } from "@dnd-kit/core";
import type { SavedHostDto } from "../../types/host";
import DraggableHostCard from "../../components/DraggableHostCard";

export interface HostCollectionActions {
  onHostClick: (host: SavedHostDto) => void;
  onHostOpenFiles?: (host: SavedHostDto) => void;
  onHostAddToMap?: (host: SavedHostDto) => void;
  onHostEdit?: (host: SavedHostDto) => void;
  onHostDelete?: (host: SavedHostDto) => void;
  onHostMove?: (host: SavedHostDto) => void;
  recentTimestamps?: Map<number, number>;
}
interface Props extends HostCollectionActions {
  hosts: SavedHostDto[];
  viewMode: "grid" | "list" | "compact";
  dropGroup?: string;
  emptyLabel?: string;
}

export default function HostCollection({ hosts, viewMode, dropGroup, emptyLabel, recentTimestamps, ...actions }: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: `host-collection-${dropGroup ?? "flat"}`, disabled: dropGroup === undefined,
    data: { type: "group", groupPath: dropGroup },
  });
  return <div ref={setNodeRef} className={`hosts-collection rounded-lg ${isOver ? "bg-sky-400/5 ring-1 ring-inset ring-sky-400/40" : ""}`}>
    <div className={`hosts-${viewMode}`}>
      {hosts.map((host) => <DraggableHostCard key={host.id} host={host} viewMode={viewMode}
        lastUsed={recentTimestamps?.get(host.id)} onClick={() => actions.onHostClick(host)}
        onOpenFiles={actions.onHostOpenFiles ? () => actions.onHostOpenFiles!(host) : undefined}
        onAddToMap={actions.onHostAddToMap ? () => actions.onHostAddToMap!(host) : undefined}
        onEdit={actions.onHostEdit ? () => actions.onHostEdit!(host) : undefined}
        onDelete={actions.onHostDelete ? () => actions.onHostDelete!(host) : undefined}
        onMove={actions.onHostMove ? () => actions.onHostMove!(host) : undefined} />)}
    </div>
    {!hosts.length && emptyLabel && <p className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-xs text-gray-500">{emptyLabel}</p>}
  </div>;
}
