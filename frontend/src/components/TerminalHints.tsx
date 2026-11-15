import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../state/store";
import { copyTextWithAutoClear } from "../utils/clipboard";

// ─── Pattern matchers for network engineering ───────────────────────

const HINT_PATTERNS: { label: string; regex: RegExp; color: string }[] = [
  {
    label: "IPv4",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\/\d{1,2})?\b/g,
    color: "bg-blue-600",
  },
  {
    label: "IPv6",
    regex: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
    color: "bg-violet-600",
  },
  {
    label: "MAC",
    regex: /\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b|\b[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\b/g,
    color: "bg-amber-600",
  },
  {
    label: "URL",
    regex: /https?:\/\/[^\s'"<>\])+]+/g,
    color: "bg-emerald-600",
  },
  {
    label: "Interface",
    regex: /\b(?:Gi|Fa|Te|Eth|ge-|xe-|et-|ae|lo|Vlan|Port-channel|mgmt)\d[\w/.:-]*/gi,
    color: "bg-cyan-600",
  },
];

// Hint keys for fast selection (single letter → double letter for >26 matches)
function generateHintKeys(count: number): string[] {
  const chars = "asdfghjklqwertyuiopzxcvbnm";
  const keys: string[] = [];
  if (count <= chars.length) {
    for (let i = 0; i < count; i++) keys.push(chars[i]);
  } else {
    for (let i = 0; i < chars.length && keys.length < count; i++) {
      for (let j = 0; j < chars.length && keys.length < count; j++) {
        keys.push(chars[i] + chars[j]);
      }
    }
  }
  return keys;
}

interface HintMatch {
  text: string;
  line: number;
  col: number;
  patternLabel: string;
  color: string;
  key: string;
}

interface TerminalHintsProps {
  tabId: string;
}

const TerminalHints: React.FC<TerminalHintsProps> = ({ tabId }) => {
  const { terminalInstances, addToast } = useAppStore(
    useShallow((state) => ({
      terminalInstances: state.terminalInstances,
      addToast: state.addToast,
    })),
  );
  const [active, setActive] = useState(false);
  const [hints, setHints] = useState<HintMatch[]>([]);
  const [filterKeys, setFilterKeys] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const scanTerminal = useCallback(() => {
    const term = terminalInstances[tabId];
    if (!term) return [];

    const matches: Omit<HintMatch, "key">[] = [];
    const buffer = term.buffer.active;
    const viewStart = buffer.viewportY;
    const viewEnd = viewStart + term.rows;

    for (let row = viewStart; row < viewEnd; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);

      for (const pattern of HINT_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pattern.regex.exec(text)) !== null) {
          // Avoid duplicate matches at same position
          const dup = matches.some(
            (h) => h.line === row && h.col === m!.index && h.text === m![0],
          );
          if (!dup) {
            matches.push({
              text: m[0],
              line: row,
              col: m.index,
              patternLabel: pattern.label,
              color: pattern.color,
            });
          }
        }
      }
    }

    const keys = generateHintKeys(matches.length);
    return matches.map((m, i) => ({ ...m, key: keys[i] }));
  }, [tabId, terminalInstances]);

  const activate = useCallback(() => {
    const found = scanTerminal();
    if (found.length === 0) {
      addToast("No hints found on screen", "info");
      return;
    }
    setHints(found);
    setFilterKeys("");
    setActive(true);
  }, [scanTerminal, addToast]);

  const deactivate = useCallback(() => {
    setActive(false);
    setHints([]);
    setFilterKeys("");
    terminalInstances[tabId]?.focus();
  }, [tabId, terminalInstances]);

  const handleSelect = useCallback(
    async (hint: HintMatch) => {
      try {
        await copyTextWithAutoClear(hint.text);
        addToast(`Copied: ${hint.text}`, "success");
      } catch {
        addToast("Copy failed", "error");
      }
      deactivate();
    },
    [addToast, deactivate],
  );

  // Keyboard filter and global hotkey
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const state = useAppStore.getState();
      if (
        tabId !== "detached" &&
        (state.activeView !== "terminal" || state.activeTabId !== tabId)
      ) return;
      const isTerminalInput = e.target === state.terminalInstances[tabId]?.textarea;
      if (
        !isTerminalInput &&
        (e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          e.target instanceof HTMLSelectElement ||
          (e.target instanceof HTMLElement && e.target.isContentEditable))
      ) {
        return;
      }

      // Ctrl+Shift+H to toggle hints
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "h" &&
        e.type === "keydown"
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (active) deactivate();
        else activate();
        return;
      }

      if (!active) return;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        deactivate();
        return;
      }

      // Build filter string from typed characters
      if (e.key.length === 1 && /[a-z]/i.test(e.key) && e.type === "keydown") {
        e.preventDefault();
        e.stopPropagation();
        const next = filterKeys + e.key.toLowerCase();
        setFilterKeys(next);

        // Check for exact match
        const exactMatch = hints.find((h) => h.key === next);
        if (exactMatch) {
          handleSelect(exactMatch);
          return;
        }

        // Check if any hints still start with the filter
        const remaining = hints.filter((h) => h.key.startsWith(next));
        if (remaining.length === 0) {
          // No match — reset
          deactivate();
        }
      }
    };

    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [tabId, active, activate, deactivate, filterKeys, hints, handleSelect]);

  const visibleHints = useMemo(
    () =>
      filterKeys
        ? hints.filter((h) => h.key.startsWith(filterKeys))
        : hints,
    [hints, filterKeys],
  );

  if (!active) return null;

  const term = terminalInstances[tabId];
  if (!term) return null;

  // Compute pixel positions per hint
  const cellWidth = term.element
    ? term.element.querySelector(".xterm-rows")?.clientWidth! / term.cols
    : 9;
  const cellHeight = term.element
    ? term.element.querySelector(".xterm-rows")?.clientHeight! / term.rows
    : 17;
  const viewStart = term.buffer.active.viewportY;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-50 bg-black/40 backdrop-blur-[1px]"
      onClick={deactivate}
    >
      {/* Status bar */}
      <div className="absolute top-2 right-2 flex items-center gap-2 z-50">
        <div className="rounded-lg bg-[#0f1115]/95 backdrop-blur-xl border border-white/10 shadow-lg px-3 py-1.5 flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {visibleHints.length} hint{visibleHints.length !== 1 ? "s" : ""}
          </span>
          {filterKeys && (
            <span className="text-xs text-primary font-mono font-bold">
              {filterKeys}_
            </span>
          )}
          <span className="text-[10px] text-gray-600">Esc to close</span>
        </div>
      </div>

      {/* Hint labels */}
      {visibleHints.map((hint) => {
        const row = hint.line - viewStart;
        if (row < 0 || row >= term.rows) return null;
        const x = hint.col * cellWidth;
        const y = row * cellHeight;
        const remaining = hint.key.slice(filterKeys.length);

        return (
          <button
            key={hint.key}
            onClick={(e) => {
              e.stopPropagation();
              handleSelect(hint);
            }}
            className={`absolute ${hint.color} text-white text-[10px] font-bold font-mono px-1 rounded shadow-lg shadow-black/50 cursor-pointer hover:scale-110 transition-transform whitespace-nowrap`}
            style={{
              left: x,
              top: y,
              lineHeight: `${cellHeight}px`,
            }}
            title={`${hint.patternLabel}: ${hint.text}`}
          >
            {filterKeys && (
              <span className="opacity-40">{filterKeys}</span>
            )}
            <span>{remaining}</span>
          </button>
        );
      })}
    </div>
  );
};

export default TerminalHints;
