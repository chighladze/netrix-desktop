import { useEffect, useRef, useState } from "react";
import { LuCheck, LuRotateCcw, LuTrash2, LuX } from "react-icons/lu";
import { CONNECTION_TYPES, CONN_TYPE_KEYS, parseConnProps } from "./connectionTypes";
import { nodeLabel } from "./presentation";
import { parseWaypoints } from "./geometry";
import type { MapEdge, MapNode } from "./types";

export type EdgeDraft = Pick<MapEdge, "label" | "color" | "stroke_width" | "style" | "waypoints" | "ports_count" | "connection_type" | "connection_properties">;
export function edgeDraft(edge: MapEdge): EdgeDraft {
  const { label, color, stroke_width, style, waypoints, ports_count, connection_type, connection_properties } = edge;
  return { label, color, stroke_width, style, waypoints, ports_count, connection_type, connection_properties };
}
export function edgePatch(edge: MapEdge, draft: EdgeDraft): Partial<EdgeDraft> {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => edge[key as keyof EdgeDraft] !== value));
}
interface Props {
  edge: MapEdge;
  source?: MapNode;
  target?: MapNode;
  draft: EdgeDraft;
  onDraft: (draft: EdgeDraft | null) => void;
  onSave: (patch: Partial<MapEdge>) => Promise<boolean>;
  onDelete: () => void;
  onClose: () => void;
  onFocus: (node: MapNode) => void;
}
export default function EdgeInspector({ edge, source, target, draft, onDraft, onSave, onDelete, onClose, onFocus }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const patch = edgePatch(edge, draft);
  const dirty = Object.keys(patch).length > 0;
  const type = CONNECTION_TYPES[draft.connection_type] ?? CONNECTION_TYPES.ethernet;
  const properties = parseConnProps(draft.connection_properties);
  const change = (values: Partial<EdgeDraft>) => { setError(false); onDraft({ ...draft, ...values }); };
  return <aside className="netmap-inspector" aria-label="Connection details">
    <div className="netmap-panel-heading"><strong>Connection details</strong><button className="netmap-icon-button" onClick={onClose} aria-label="Close connection details"><LuX size={16} /></button></div>
    <form className="netmap-edge-form" onSubmit={async (event) => {
      event.preventDefault(); if (busy || !dirty) return;
      setBusy(true); setError(false);
      try {
        const saved = await onSave(patch);
        if (!mounted.current) return;
        if (saved) onDraft(null); else setError(true);
      } catch { if (mounted.current) setError(true); }
      finally { if (mounted.current) setBusy(false); }
    }}>
      <div className="netmap-inspector-body">
        <div className="netmap-link-endpoints">{[source, target].map((node, index) => <button key={index} type="button" disabled={!node} onClick={() => node && onFocus(node)}><span style={{ background: node?.color }} /><small>{index ? "To" : "From"}</small><strong>{node ? nodeLabel(node) : "Missing device"}</strong></button>)}</div>
        <fieldset disabled={busy} className="netmap-form-fields">
          <label>Connection type<select value={draft.connection_type} onChange={(event) => {
            const definition = CONNECTION_TYPES[event.target.value];
            const defaults = Object.fromEntries(definition.properties.filter((prop) => prop.default !== undefined).map((prop) => [prop.key, prop.default]));
            change({ connection_type: event.target.value, color: definition.color, style: definition.dashArray ? "dashed" : "solid", connection_properties: JSON.stringify(defaults) });
          }}>{!CONNECTION_TYPES[draft.connection_type] && <option value={draft.connection_type}>{draft.connection_type}</option>}{CONN_TYPE_KEYS.map((key) => <option key={key} value={key}>{CONNECTION_TYPES[key].label}</option>)}</select></label>
          <label>Label<input value={draft.label || ""} maxLength={256} onChange={(event) => change({ label: event.target.value })} placeholder="e.g. Uplink to core" /></label>
          <div className="netmap-field-pair"><label>Ports / links<input type="number" min={1} max={999} required value={draft.ports_count} onChange={(event) => change({ ports_count: event.target.value === "" ? 0 : Number(event.target.value) })} /></label><label>Line width<input type="number" min={1} max={32} required value={draft.stroke_width} onChange={(event) => change({ stroke_width: event.target.value === "" ? 0 : Number(event.target.value) })} /></label></div>
          <div className="netmap-section-title"><h3 style={{ color: type.color }}>{type.label} properties</h3></div>
          {type.properties.map((prop) => <label key={prop.key}>{prop.label}{prop.type === "select" ? <select value={String(properties[prop.key] ?? prop.default ?? "")} onChange={(event) => change({ connection_properties: JSON.stringify({ ...properties, [prop.key]: event.target.value }) })}>{(prop.options ?? []).map((option) => <option key={option}>{option}</option>)}</select> : <input type={prop.type === "number" ? "number" : "text"} value={String(properties[prop.key] ?? prop.default ?? "")} onChange={(event) => change({ connection_properties: JSON.stringify({ ...properties, [prop.key]: prop.type === "number" ? Number(event.target.value) : event.target.value }) })} />}</label>)}
          <div className="netmap-section-title"><h3>Appearance</h3></div>
          <div className="netmap-field-pair"><label>Line style<select value={draft.style} onChange={(event) => change({ style: event.target.value })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label><label>Color<input aria-label="Connection color" type="color" value={draft.color} onChange={(event) => change({ color: event.target.value })} /></label></div>
          <button type="button" className="netmap-button" disabled={!parseWaypoints(draft.waypoints).length} onClick={() => change({ waypoints: "[]" })}><LuRotateCcw size={14} />Reset line route</button>
        </fieldset>
      </div>
      <div className="netmap-inspector-footer">
        {error && <p role="alert">Could not save. Your edits are kept; try again.</p>}
        <span className="netmap-draft-status">{busy ? "Saving…" : dirty ? "Unsaved changes · kept while this map is open" : "Changes saved"}</span>
        <div><button type="submit" className="netmap-button netmap-primary" disabled={!dirty || busy}><LuCheck size={14} />{busy ? "Saving…" : "Save changes"}</button><button type="button" className="netmap-button" disabled={!dirty || busy} onClick={() => { onDraft(null); setError(false); }}>Reset</button><button type="button" className="netmap-icon-button netmap-danger" disabled={busy} onClick={onDelete} aria-label="Remove connection"><LuTrash2 size={15} /></button></div>
      </div>
    </form>
  </aside>;
}
