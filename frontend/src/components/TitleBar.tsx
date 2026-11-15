import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import type { TerminalDragPhase } from "../terminal/useTerminalWindowDrag";
import { IoSettingsOutline } from "react-icons/io5";
import {
    VscChromeClose,
    VscChromeMaximize,
    VscChromeMinimize,
    VscChromeRestore,
    VscLinkExternal
} from "react-icons/vsc";

const appWindow = getCurrentWindow();
interface TitleBarProps {
  showSettings?: boolean;
  onSettings?: () => void;
  onReturn?: () => void | Promise<void>;
  onClose?: (e: React.MouseEvent) => void;
  title?: string;
  isConnected?: boolean;
  onDragStart?: React.PointerEventHandler<HTMLDivElement>;
  dockPhase?: TerminalDragPhase;
}

const TitleBar: React.FC<TitleBarProps> = ({
  showSettings = true,
  onSettings,
  onReturn,
  onClose,
  title,
  isConnected,
  onDragStart,
  dockPhase = "idle",
}) => {
  const [isMaximized, setIsMaximized] = React.useState(false);
  const [returningButton, setReturningButton] = React.useState(false);
  const returningRef = React.useRef(false);
  const returning = returningButton || dockPhase === "returning";
  const dropReturnArmed = dockPhase === "armed";

  React.useEffect(() => {
    let disposed = false;
    const update = async () => {
      const maximized = await appWindow.isMaximized();
      if (!disposed) setIsMaximized(maximized);
    };
    void update();
    const unlisten = appWindow.onResized(() => { void update(); });
    return () => { disposed = true; void unlisten.then((stop) => stop()); };
  }, []);

  const runReturn = async () => {
    if (!onReturn || returningRef.current || returning) return;
    returningRef.current = true;
    setReturningButton(true);
    try { await onReturn(); }
    finally { returningRef.current = false; setReturningButton(false); }
  };

  const handleMinimize = (e: React.MouseEvent) => {
    e.stopPropagation();
    appWindow.minimize();
  };

  const handleMaximize = (e: React.MouseEvent) => {
    e.stopPropagation();
    appWindow.toggleMaximize();
  };

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onClose) {
      onClose(e);
    } else {
      appWindow.close();
    }
  };

  const handleReturnClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    void runReturn();
  };

  return (
    <div
      className={`h-8 border-b flex items-center no-select shrink-0 relative overflow-hidden transition-[background-color,border-color,box-shadow] duration-150 ${
        dropReturnArmed
          ? "bg-[#101a28] border-cyan-400/40 shadow-[inset_0_-1px_0_rgba(34,211,238,0.6)]"
          : "bg-background-dark border-gray-800"
      }`}
    >
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-150 ${
          dropReturnArmed ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/70 to-transparent" />
        <div className="absolute inset-x-8 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-300/80 to-transparent" />
      </div>
      {/* Floating terminals track the complete gesture; other windows use Tauri drag regions. */}
      <div
        data-terminal-window-drag-region
        data-tauri-drag-region={onDragStart ? undefined : true}
        onPointerDown={onDragStart}
        onDoubleClick={onDragStart ? handleMaximize : undefined}
        className={`flex-1 min-w-0 h-full flex items-center px-4 relative z-10 ${onDragStart ? "cursor-grab active:cursor-grabbing" : "cursor-default"}`}
      >
        <div className="flex min-w-0 items-center gap-2.5 pointer-events-none">
          {isConnected !== undefined && (
            <div className="relative flex-shrink-0 w-2 h-2">
              <div
                className={`absolute inset-0 rounded-full transition-colors duration-500 ${
                  isConnected
                    ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]"
                    : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]"
                }`}
              />
              {isConnected && (
                <div className="absolute inset-0 rounded-full bg-emerald-400/50 animate-ping" />
              )}
            </div>
          )}
          <span className="min-w-0 truncate text-[10px] text-gray-400 font-semibold uppercase tracking-widest">
            {title}
          </span>
          {onDragStart && (
            <span className="terminal-return-preview shrink-0 whitespace-nowrap rounded border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-200">
              {dropReturnArmed ? "Ready to dock" : "Floating"}
            </span>
          )}
        </div>
      </div>

      {onReturn ? (
        <button
          onClick={handleReturnClick}
          disabled={returning || dockPhase === "dragging" || dockPhase === "armed"}
          aria-label="Return terminal to main window"
          className={`h-full flex items-center justify-center gap-1.5 border-r px-3 text-[10px] font-bold uppercase tracking-wider transition-all relative z-20 ${
            dropReturnArmed
              ? "border-cyan-300/25 bg-cyan-400/15 text-cyan-100 shadow-[inset_0_0_18px_rgba(34,211,238,0.12)]"
              : "border-gray-800/50 text-gray-500 hover:bg-white/5 hover:text-white"
          }`}
          title="Return terminal to main window"
        >
          <VscLinkExternal size={14} className="rotate-180" />
          <span>{returning ? "Returning..." : dropReturnArmed ? "Release" : "Return"}</span>
        </button>
      ) : showSettings ? (
        <button
          onClick={onSettings}
          className="w-10 h-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/5 transition-colors border-r border-gray-800/50"
          title="Settings"
        >
          <IoSettingsOutline size={16} />
        </button>
      ) : null}

      {/* Window Controls */}
      <div className="flex h-full shrink-0 relative z-50">
        {/* Minimize Button */}
        <button
          onClick={handleMinimize}
          className="w-12 h-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
          title="Minimize"
        >
          <VscChromeMinimize size={16} />
        </button>

        {/* Maximize/Restore Button */}
        <button
          onClick={handleMaximize}
          className="w-12 h-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
          title={isMaximized ? "Restore" : "Maximize"}
        >
          <div className="relative z-10">
            {isMaximized ? (
              <VscChromeRestore size={16} />
            ) : (
              <VscChromeMaximize size={16} />
            )}
          </div>
        </button>

        {/* Close Button - Standard Red Hover */}
        <button
          onClick={handleClose}
          className="w-12 h-full flex items-center justify-center text-gray-500 hover:text-white hover:bg-[#e81123] transition-colors"
          title="Close"
        >
          <VscChromeClose size={16} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
