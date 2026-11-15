import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import type { TerminalLayout } from "../features/workspace/panes";

const layouts: { value: TerminalLayout; label: string; description: string }[] = [
  { value: "single", label: "Single", description: "Show sessions as separate tabs" },
  { value: "columns", label: "Side by side", description: "Two terminals in columns" },
  { value: "rows", label: "Stacked", description: "Two terminals in rows" },
  { value: "grid", label: "2 × 2", description: "Four terminals in a grid" },
];

export function TerminalLayoutGlyph({ layout }: { layout: TerminalLayout }) {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0">
      <rect x="3" y="4" width="18" height="16" rx="3" fill="currentColor" fillOpacity="0.08" stroke="currentColor" strokeWidth="1.4" />
      {(layout === "columns" || layout === "grid") && <path d="M12 4.5v15" stroke="currentColor" strokeWidth="1.4" />}
      {(layout === "rows" || layout === "grid") && <path d="M3.5 12h17" stroke="currentColor" strokeWidth="1.4" />}
    </svg>
  );
}

export default function TerminalLayoutControl({ value, onChange, disabled = false }: {
  value: TerminalLayout;
  onChange: (layout: TerminalLayout) => void;
  disabled?: boolean;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const index = layouts.findIndex((layout) => layout.value === value);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, current: number) => {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number;
    switch (event.key) {
      case "ArrowRight": case "ArrowDown": next = (current + 1) % layouts.length; break;
      case "ArrowLeft": case "ArrowUp": next = (current - 1 + layouts.length) % layouts.length; break;
      case "Home": next = 0; break;
      case "End": next = layouts.length - 1; break;
      default: return;
    }
    event.preventDefault();
    onChange(layouts[next].value);
    buttons.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Terminal layout"
      aria-disabled={disabled}
      className="terminal-layout-control relative grid shrink-0 grid-cols-4 rounded-md border p-px"
      style={{ "--layout-index": index } as CSSProperties}
    >
      <span aria-hidden="true" className="terminal-layout-indicator pointer-events-none absolute rounded border" />
      {layouts.map((layout, position) => (
        <button
          key={layout.value}
          ref={(button) => { buttons.current[position] = button; }}
          type="button"
          role="radio"
          aria-label={layout.label}
          aria-checked={value === layout.value}
          disabled={disabled}
          tabIndex={value === layout.value ? 0 : -1}
          title={disabled ? "Finish moving the terminal before changing layout" : layout.description}
          onClick={() => onChange(layout.value)}
          onKeyDown={(event) => navigate(event, position)}
          className="terminal-layout-option relative flex min-w-0 items-center justify-center gap-1.5 rounded px-2 outline-none"
        >
          <TerminalLayoutGlyph layout={layout.value} />
          <span className="terminal-layout-label whitespace-nowrap text-[11px] font-medium">{layout.label}</span>
        </button>
      ))}
    </div>
  );
}
