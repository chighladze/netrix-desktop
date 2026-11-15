import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { useState, type ReactNode } from "react";
import { LuX } from "react-icons/lu";
import type { MapNode } from "./types";
import { nodeLabel } from "./presentation";

interface Props { node: MapNode; icons: Record<string, { icon: ReactNode; label: string }>; colors: string[]; onSave: (patch: Partial<MapNode>) => Promise<boolean>; onClose: () => void }
export default function NodeAppearanceDialog({ node, icons, colors, onSave, onClose }: Props) {
  const [label, setLabel] = useState(nodeLabel(node));
  const [icon, setIcon] = useState(node.icon);
  const [color, setColor] = useState(node.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <Dialog open onClose={() => { if (!busy) onClose(); }} className="netmap-dialog relative z-[70]">
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
    <div className="fixed inset-0 flex items-center justify-center p-4"><DialogPanel className="netmap-dialog-panel">
      <div className="netmap-panel-heading"><DialogTitle>Edit device</DialogTitle><button disabled={busy} className="netmap-icon-button" onClick={onClose} aria-label="Close device editor"><LuX size={16} /></button></div>
      <form onSubmit={async (event) => { event.preventDefault(); if (busy || !label.trim()) return; setBusy(true); setError(false); try { if (await onSave({ label: label.trim(), icon, color })) onClose(); else setError(true); } catch { setError(true); } finally { setBusy(false); } }}>
        <fieldset disabled={busy} className="netmap-form-fields"><label>Device name<input autoFocus value={label} maxLength={256} required onChange={(event) => setLabel(event.target.value)} /></label>
          <span className="netmap-field-label">Device icon</span><div className="netmap-icon-picker">{Object.entries(icons).map(([key, item]) => <button type="button" key={key} aria-pressed={icon === key} onClick={() => setIcon(key)}>{item.icon}<span>{item.label}</span></button>)}</div>
          <span className="netmap-field-label">Accent color</span><div className="netmap-color-picker">{colors.map((value) => <button type="button" key={value} aria-label={`Use color ${value}`} aria-pressed={color === value} style={{ background: value }} onClick={() => setColor(value)} />)}<input type="color" aria-label="Custom device color" value={color} onChange={(event) => setColor(event.target.value)} /></div>
        </fieldset>
        {error && <p role="alert" className="netmap-form-error">Could not save this device. Your changes are still here.</p>}
        <div className="netmap-dialog-footer"><button type="button" className="netmap-button" disabled={busy} onClick={onClose}>Cancel</button><button className="netmap-button netmap-primary" disabled={busy || !label.trim()}>{busy ? "Saving…" : "Save device"}</button></div>
      </form>
    </DialogPanel></div>
  </Dialog>;
}
