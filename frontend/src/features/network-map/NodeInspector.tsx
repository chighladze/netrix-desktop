import { LuArrowUpRight, LuFolderOpen, LuLink, LuPencil, LuTerminal, LuTrash2, LuX } from "react-icons/lu";
import type { ReactNode } from "react";
import type { MapEdge, MapNode } from "./types";
import { CONNECTION_TYPES } from "./connectionTypes";
import { nodeLabel, nodeReachability } from "./presentation";

interface Props {
  node: MapNode;
  nodes: MapNode[];
  edges: MapEdge[];
  icon: ReactNode;
  typeLabel: string;
  ping: Record<string, boolean | null>;
  pingEnabled: boolean;
  canOpenFiles: boolean;
  onTerminal: () => void;
  onFiles: () => void;
  onLink: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onEdge: (edge: MapEdge) => void;
  onFocus: (node: MapNode) => void;
  onClose: () => void;
}
export default function NodeInspector(props: Props) {
  const { node } = props;
  const status = nodeReachability(node, props.ping, props.pingEnabled);
  const links = props.edges.filter((edge) => edge.source_node_id === node.id || edge.target_node_id === node.id);
  return <aside className="netmap-inspector" aria-label="Device details">
    <div className="netmap-panel-heading"><strong>Device details</strong><button className="netmap-icon-button" onClick={props.onClose} aria-label="Close device details"><LuX size={16} /></button></div>
    <div className="netmap-inspector-body">
      <div className="netmap-device-heading"><span style={{ color: node.color, background: `${node.color}18`, borderColor: `${node.color}35` }}>{props.icon}</span><div><h2>{nodeLabel(node)}</h2><p>{props.typeLabel}{node.host_connection_type ? ` · ${node.host_connection_type.toUpperCase()}` : " · Custom device"}</p></div></div>
      {node.host_id && <div className="netmap-ping-label" data-status={status}><span className="netmap-reachability-dot" data-status={status} />{!props.pingEnabled ? "Ping monitoring paused" : status === "reachable" ? "Responds to ping" : status === "unreachable" ? "No ping response" : "Ping not checked"}</div>}
      <dl className="netmap-device-properties">{node.host_hostname && <><dt>Address</dt><dd>{node.host_hostname}{node.host_port ? ` · ${node.host_port}` : ""}</dd></>}{node.host_username && <><dt>User</dt><dd>{node.host_username}</dd></>}{node.host_group && <><dt>Group</dt><dd>{node.host_group}</dd></>}<dt>Links</dt><dd>{links.length}</dd></dl>
      {node.host_id && <div className="netmap-device-access"><button className="netmap-button netmap-primary" onClick={props.onTerminal}><LuTerminal size={15} />Open terminal</button>{props.canOpenFiles && <button className="netmap-button" onClick={props.onFiles}><LuFolderOpen size={15} />Files</button>}</div>}
      <div className="netmap-device-actions"><button className="netmap-button" onClick={props.onLink}><LuLink size={14} />Link device</button><button className="netmap-button" onClick={props.onEdit}><LuPencil size={14} />Edit</button><button className="netmap-icon-button netmap-danger" onClick={props.onDelete} aria-label="Remove device from map" title="Remove device from map"><LuTrash2 size={15} /></button></div>
      <div className="netmap-section-title"><h3>Connected devices</h3><span>{links.length}</span></div>
      {!links.length && <p className="netmap-muted">No links yet. Choose Link device, then select its neighbor on the map.</p>}
      <div className="netmap-neighbors">{links.map((edge) => {
        const other = props.nodes.find((item) => item.id === (edge.source_node_id === node.id ? edge.target_node_id : edge.source_node_id));
        if (!other) return null;
        const type = CONNECTION_TYPES[edge.connection_type] ?? CONNECTION_TYPES.ethernet;
        return <div key={edge.id}><button onClick={() => props.onEdge(edge)} title="Edit connection"><span className="netmap-neighbor-color" style={{ background: type.color }} /><span><strong>{nodeLabel(other)}</strong><small>{edge.label || type.label} · {edge.ports_count || 1} link{edge.ports_count === 1 ? "" : "s"}</small></span></button><button className="netmap-icon-button" onClick={() => props.onFocus(other)} aria-label={`Locate ${nodeLabel(other)}`}><LuArrowUpRight size={16} /></button></div>;
      })}</div>
    </div>
  </aside>;
}
