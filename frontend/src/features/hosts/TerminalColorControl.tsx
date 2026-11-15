import { IoRefresh } from "react-icons/io5";
import { normalizeTerminalColor } from "../../themes";

const SWATCHES = {
  background: [
    ["Midnight", "#0d1117"], ["Black", "#000000"], ["Slate", "#17212b"],
    ["Solarized", "#002b36"], ["Paper", "#f4f1ea"], ["White", "#ffffff"],
  ],
  text: [
    ["Soft white", "#d1d5db"], ["White", "#ffffff"], ["Mint", "#8ce5bb"],
    ["Cyan", "#7dd3fc"], ["Amber", "#f2c879"], ["Ink", "#17212b"],
  ],
};

export default function TerminalColorControl({ id, name, kind, label: customLabel, value, themeColor, error, onChange }: {
  id: string;
  name: string;
  kind: "background" | "text";
  label?: string;
  value: string;
  themeColor: string;
  error?: string;
  onChange: (color: string) => void;
}) {
  const label = customLabel || (kind === "background" ? "Background" : "Text");
  const accessibleName = customLabel?.toLowerCase() || kind;
  const resolved = normalizeTerminalColor(value) || themeColor;
  return <div className="host-form-field host-form-color">
    <label htmlFor={id}>{label} <span>{value ? "custom" : "from theme"}</span></label>
    <div className="host-form-color-inputs">
      <input type="color" aria-label={`Choose ${accessibleName} color`} value={resolved} onChange={(event) => onChange(event.target.value)} />
      <input id={id} name={name} type="text" value={value || themeColor} spellCheck={false} autoComplete="off"
        aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => { const color = normalizeTerminalColor(value); if (color) onChange(color); }} />
      <button type="button" className="host-form-icon-button" disabled={!value}
        aria-label={`Reset ${accessibleName} to theme`} title={`Use theme ${accessibleName} color`} onClick={() => onChange("")}><IoRefresh size={16} /></button>
    </div>
    <div className="host-form-color-swatches" role="group" aria-label={`${label} presets`}>
      {SWATCHES[kind].map(([name, color]) => <button key={color} type="button"
        aria-label={`Set ${accessibleName} to ${name}`} title={`${name} · ${color}`}
        aria-pressed={resolved === color} style={{ backgroundColor: color }}
        onClick={() => onChange(color)} />)}
    </div>
    {error && <p id={`${id}-error`} className="host-form-field-error" role="alert">{error}</p>}
  </div>;
}
