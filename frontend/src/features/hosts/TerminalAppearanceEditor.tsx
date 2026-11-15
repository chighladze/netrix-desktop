import { useEffect, useState } from "react";
import { IoChevronDown } from "react-icons/io5";
import type { AppSettings } from "../../state/store";
import type { TerminalTheme } from "../../themes";
import { ANSI_COLOR_KEYS, type AppearanceColorKey, type TerminalAppearance } from "../../types/terminalAppearance";
import TerminalColorControl from "./TerminalColorControl";

const colorName = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, value => value.toUpperCase());
const opaqueColor = (color: string) => {
  if (color.startsWith("#")) return color.slice(0, 7);
  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return rgb ? `#${rgb.slice(1, 4).map(value => Number(value).toString(16).padStart(2, "0")).join("")}` : "#58a6ff";
};

export default function TerminalAppearanceEditor({ id, value, colors, themeColors, settings, errors, onChange }: {
  id: string; value: TerminalAppearance; colors: TerminalTheme["colors"]; themeColors: TerminalTheme["colors"];
  settings: AppSettings; errors: Record<string, string>; onChange: (value: TerminalAppearance) => void;
}) {
  const [selectedColor, setSelectedColor] = useState<typeof ANSI_COLOR_KEYS[number]>("green");
  const [textOpen, setTextOpen] = useState(false), [colorsOpen, setColorsOpen] = useState(false), [cursorOpen, setCursorOpen] = useState(false);
  useEffect(() => {
    const keys = Object.keys(errors);
    if (keys.some(key => /^appearance_(font|line|letter)/.test(key))) setTextOpen(true);
    const invalidAnsi = ANSI_COLOR_KEYS.find(key => errors[`appearance_color_${key}`]);
    if (invalidAnsi) { setColorsOpen(true); setSelectedColor(invalidAnsi); }
    if (errors.appearance_color_cursor || errors.appearance_color_selectionBackground) setCursorOpen(true);
  }, [errors]);
  const update = (patch: Partial<TerminalAppearance>) => onChange({ ...value, ...patch });
  const changeColor = (key: AppearanceColorKey, color: string) => {
    const next = { ...value.colors };
    if (color) next[key] = color; else delete next[key];
    update({ colors: Object.keys(next).length ? next : undefined });
  };
  const field = (key: string) => ({ id: `${id}-${key}`, name: `appearance_${key}`, "aria-invalid": Boolean(errors[`appearance_${key}`]), "aria-describedby": errors[`appearance_${key}`] ? `${id}-${key}-error` : undefined });
  const error = (key: string) => errors[`appearance_${key}`] && <p id={`${id}-${key}-error`} className="host-form-field-error" role="alert">{errors[`appearance_${key}`]}</p>;
  return <div className="host-appearance-advanced">
    <details open={textOpen} onToggle={event => setTextOpen(event.currentTarget.open)}>
      <summary><IoChevronDown aria-hidden="true" />Text & spacing<span>Font, weight, spacing</span></summary>
      <div className="host-appearance-options">
        <div className="host-form-field">
          <label htmlFor={`${id}-font_family`}>Font family</label>
          <input {...field("font_family")} list={`${id}-fonts`} value={value.font_family ?? settings.terminal.fontFamily} onChange={event => update({ font_family: event.target.value })} maxLength={128} />
          <datalist id={`${id}-fonts`}>{["JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Consolas", "Fira Code", "Source Code Pro", "Courier New", "monospace"].map(font => <option key={font} value={font} />)}</datalist>
          {error("font_family")}
          <p className="host-form-hint">Uses fonts installed on this computer, with a monospace fallback.</p>
        </div>
        <div className="host-form-row">
          {([['font_weight', 'Text weight', 400], ['font_weight_bold', 'Bold text weight', 700]] as const).map(([key, label, fallback]) => <div className="host-form-field" key={key}>
            <label htmlFor={`${id}-${key}`}>{label}</label>
            <select {...field(key)} value={value[key] ?? fallback} onChange={event => update({ [key]: Number(event.target.value) })}>
              {[100, 200, 300, 400, 500, 600, 700, 800, 900].map(weight => <option value={weight} key={weight}>{weight}{weight === 400 ? ' · Regular' : weight === 700 ? ' · Bold' : ''}</option>)}
            </select>{error(key)}
          </div>)}
        </div>
        <div className="host-form-row">
          <div className="host-form-field"><label htmlFor={`${id}-line_height`}>Line height <span>×</span></label>
            <input {...field("line_height")} type="number" min={1} max={2} step={.05} value={Number.isNaN(value.line_height) ? "" : value.line_height ?? 1.2} onChange={event => update({ line_height: event.target.valueAsNumber })} />{error("line_height")}</div>
          <div className="host-form-field"><label htmlFor={`${id}-letter_spacing`}>Letter spacing <span>px</span></label>
            <input {...field("letter_spacing")} type="number" min={-1} max={5} step={.1} value={Number.isNaN(value.letter_spacing) ? "" : value.letter_spacing ?? .5} onChange={event => update({ letter_spacing: event.target.valueAsNumber })} />{error("letter_spacing")}</div>
        </div>
      </div>
    </details>
    <details open={colorsOpen} onToggle={event => setColorsOpen(event.currentTarget.open)}>
      <summary><IoChevronDown aria-hidden="true" />Prompt & ANSI colors<span>16 editable colors</span></summary>
      <div className="host-appearance-options">
        <p className="host-form-hint">The sample prompt uses Green for user@host and Cyan for the path. Your shell chooses the actual prompt text and ANSI colors; palette changes also apply to other colored output.</p>
        <div className="host-appearance-palette" role="group" aria-label="ANSI palette">
          {ANSI_COLOR_KEYS.map(key => <button key={key} type="button" aria-label={`Edit ${colorName(key)}`} aria-pressed={selectedColor === key} title={colorName(key)} onClick={() => setSelectedColor(key)} style={{ backgroundColor: colors[key] }} />)}
        </div>
        <TerminalColorControl id={`${id}-color_${selectedColor}`} name={`appearance_color_${selectedColor}`} kind="text" label={colorName(selectedColor)}
          value={value.colors?.[selectedColor] || ""} themeColor={themeColors[selectedColor]} error={errors[`appearance_color_${selectedColor}`]} onChange={color => changeColor(selectedColor, color)} />
        <label className="host-appearance-check"><input type="checkbox" checked={value.bold_bright ?? true} onChange={event => update({ bold_bright: event.target.checked })} />Use bright ANSI colors for bold text</label>
      </div>
    </details>
    <details open={cursorOpen} onToggle={event => setCursorOpen(event.currentTarget.open)}>
      <summary><IoChevronDown aria-hidden="true" />Cursor & selection<span>Shape, blink, colors</span></summary>
      <div className="host-appearance-options">
        <div className="host-form-row">
          <div className="host-form-field"><label htmlFor={`${id}-cursor_style`}>Cursor shape</label>
            <select id={`${id}-cursor_style`} value={value.cursor_style ?? settings.terminal.cursorStyle} onChange={event => update({ cursor_style: event.target.value as TerminalAppearance["cursor_style"] })}>
              <option value="block">Block</option><option value="bar">Bar</option><option value="underline">Underline</option>
            </select></div>
          <label className="host-appearance-check"><input type="checkbox" checked={value.cursor_blink ?? settings.terminal.cursorBlink} onChange={event => update({ cursor_blink: event.target.checked })} />Blink cursor</label>
        </div>
        <div className="host-form-row">
          <TerminalColorControl id={`${id}-color_cursor`} name="appearance_color_cursor" kind="text" label="Cursor" value={value.colors?.cursor || ""} themeColor={themeColors.cursor} error={errors.appearance_color_cursor} onChange={color => changeColor("cursor", color)} />
          <TerminalColorControl id={`${id}-color_selectionBackground`} name="appearance_color_selectionBackground" kind="text" label="Selection" value={value.colors?.selectionBackground || ""} themeColor={opaqueColor(themeColors.selectionBackground)} error={errors.appearance_color_selectionBackground} onChange={color => changeColor("selectionBackground", color)} />
        </div>
      </div>
    </details>
  </div>;
}
