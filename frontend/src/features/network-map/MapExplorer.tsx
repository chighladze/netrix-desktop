import type { RefObject } from "react";
import { LuCrosshair, LuSearch, LuX } from "react-icons/lu";
import { nodeLabel, nodeReachability, type ReachabilityFilter } from "./presentation";
import type { MapNode } from "./types";

interface Props {
  nodes: MapNode[];
  total: number;
  query: string;
  filter: ReachabilityFilter;
  selectedId: string | null;
  ping: Record<string, boolean | null>;
  pingEnabled: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onQuery: (value: string) => void;
  onFilter: (value: ReachabilityFilter) => void;
  onFocus: (node: MapNode) => void;
  onClose: () => void;
}
const statusLabels = { all: "All devices", reachable: "Ping reachable", unreachable: "No ping response", unknown: "Not checked" };

export default function MapExplorer({ nodes, total, query, filter, selectedId, ping, pingEnabled, inputRef, onQuery, onFilter, onFocus, onClose }: Props) {
  const stepResult = (direction: number) => {
    if (!nodes.length) return;
    const current = nodes.findIndex((node) => node.id === selectedId);
    onFocus(nodes[current < 0 ? direction < 0 ? nodes.length - 1 : 0 : (current + direction + nodes.length) % nodes.length]);
  };
  return <aside className="netmap-explorer" aria-label="Map devices">
    <div className="netmap-panel-heading"><div><strong>Devices</strong><span>{nodes.length} of {total}</span></div><button className="netmap-icon-button" onClick={onClose} aria-label="Close device explorer"><LuX size={16} /></button></div>
    <div className="netmap-explorer-controls">
      <div className="netmap-search"><LuSearch size={15} aria-hidden="true" /><input ref={inputRef} aria-label="Find map devices" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Name, address, group…" onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); stepResult(event.key === "ArrowUp" || event.shiftKey ? -1 : 1); }
        if (event.key === "Escape") { event.stopPropagation(); if (query) onQuery(""); else onClose(); }
      }} />{query && <button onClick={() => onQuery("")} aria-label="Clear device search"><LuX size={13} /></button>}</div>
      <select aria-label="Filter devices by ping status" value={filter} onChange={(event) => onFilter(event.target.value as ReachabilityFilter)}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    </div>
    <div className="netmap-device-list">
      {nodes.map((node) => <button key={node.id} className="netmap-device-result" aria-pressed={selectedId === node.id} onClick={() => onFocus(node)} title={`Focus ${nodeLabel(node)}`}>
        <span className="netmap-device-accent" style={{ background: node.color }} />
        <span className="netmap-device-result-text"><strong>{nodeLabel(node)}</strong><span>{node.host_hostname || node.icon}{node.host_group ? ` · ${node.host_group}` : ""}</span></span>
        <span className="netmap-reachability-dot" data-status={nodeReachability(node, ping, pingEnabled)} title={statusLabels[nodeReachability(node, ping, pingEnabled)]} />
        <LuCrosshair size={13} className="netmap-result-target" aria-hidden="true" />
      </button>)}
      {!nodes.length && <div className="netmap-panel-empty"><LuSearch size={24} /><strong>{total ? "No matching devices" : "No devices yet"}</strong><p>{total ? "Try another search or ping filter." : "Add a host or a custom device to start your map."}</p>{(query || filter !== "all") && <button className="netmap-button" onClick={() => { onQuery(""); onFilter("all"); }}>Clear filters</button>}</div>}
    </div>
    <p className="netmap-explorer-hint">Click to locate · ↑ ↓ or Enter to browse</p>
  </aside>;
}
