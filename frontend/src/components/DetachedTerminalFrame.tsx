import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { IoArrowDown, IoLayersOutline } from "react-icons/io5";
import TitleBar from "./TitleBar";
import { useTerminalWindowDrag } from "../terminal/useTerminalWindowDrag";
import type { DockPlacement } from "../terminal/docking";
import { useAppStore } from "../state/store";

interface DetachedTerminalFrameProps {
  title: string;
  isConnected: boolean;
  onReturn: (placement?: DockPlacement) => void | Promise<void>;
  onClose: () => void;
  children: ReactNode;
  sessionCount?: number;
}

export default function DetachedTerminalFrame({ title, isConnected, onReturn, onClose, children, sessionCount = 1 }: DetachedTerminalFrameProps) {
  const drag = useTerminalWindowDrag(title, onReturn, sessionCount);
  const outgoing = useAppStore((store) => Object.values(store.terminalTransfers).some((transfer) => transfer.direction === "outgoing"));
  const phase = outgoing ? "returning" : drag.phase;
  const dockArmed = Boolean(drag.target) || phase === "returning";
  const [scale, setScale] = useState(.4);
  useEffect(() => {
    const resize = () => setScale(Math.min(.5, 420 / window.innerWidth, 280 / window.innerHeight));
    resize(); window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const anchor = drag.anchorX || window.innerWidth / 2;
  const labelX = anchor * (1 - scale) + window.innerWidth * scale / 2;

  return (
    <div className="terminal-dock-stage relative flex-1 min-h-0" data-dock-armed={dockArmed} data-phase={phase} style={{ "--terminal-dock-scale": scale, "--terminal-dock-anchor": `${anchor}px`, "--terminal-dock-label-x": `${labelX}px` } as CSSProperties}>
      <div className="terminal-dock-guidance pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-1" aria-hidden={!dockArmed}>
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/70">
          <IoLayersOutline size={13} /> {drag.target?.placement.pane ? `Pane ${drag.target.placement.pane.index + 1}` : "Main window"}
        </div>
        <div className="flex items-center gap-2 text-sm font-semibold text-cyan-100">
          <IoArrowDown size={17} /> {phase === "returning" ? "Docking terminal…" : "Release to dock"}
        </div>
        <span className="terminal-dock-connector h-4 w-px" />
      </div>
      {/* Transform the live surface, preserving xterm layout and the remote PTY size. */}
      <div className="terminal-dock-live absolute inset-0 flex flex-col overflow-hidden bg-background-midnight">
        <TitleBar
          title={title}
          isConnected={isConnected}
          onDragStart={drag.start}
          dockPhase={phase}
          onReturn={drag.returnToMain}
          onClose={onClose}
        />
        {children}
      </div>
    </div>
  );
}
