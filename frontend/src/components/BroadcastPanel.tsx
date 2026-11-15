import { sendTerminalInput } from "../terminal/wire";
import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  IoCheckmarkCircle,
  IoCheckmarkDoneSharp,
  IoClose,
  IoEllipseOutline,
  IoRadio,
  IoSend,
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../state/store";

const BroadcastPanel: React.FC = () => {
  const {
    broadcastMode,
    setBroadcastMode,
    broadcastTargets,
    toggleBroadcastTarget,
    setBroadcastTargets,
    terminalTabs,
    terminalSockets,
    activeTabId,
    addToast,
  } = useAppStore(
    useShallow((state) => ({
      broadcastMode: state.broadcastMode,
      setBroadcastMode: state.setBroadcastMode,
      broadcastTargets: state.broadcastTargets,
      toggleBroadcastTarget: state.toggleBroadcastTarget,
      setBroadcastTargets: state.setBroadcastTargets,
      terminalTabs: state.terminalTabs,
      terminalSockets: state.terminalSockets,
      activeTabId: state.activeTabId,
      addToast: state.addToast,
    })),
  );

  const [command, setCommand] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const connectedTabs = useMemo(
    () =>
      terminalTabs.filter((t) => {
        const ws = terminalSockets[t.id];
        return ws?.readyState === WebSocket.OPEN;
      }),
    [terminalTabs, terminalSockets],
  );

  const allSelected = useMemo(
    () =>
      connectedTabs.length > 0 &&
      connectedTabs.every((t) => broadcastTargets.has(t.id)),
    [connectedTabs, broadcastTargets],
  );

  const toggleAll = useCallback(() => {
    if (allSelected) {
      setBroadcastTargets([]);
    } else {
      setBroadcastTargets(connectedTabs.map((t) => t.id));
    }
  }, [allSelected, connectedTabs, setBroadcastTargets]);

  const sendCommand = useCallback(() => {
    if (!command.trim()) return;
    const payload = command + "\n";
    let sent = 0;
    for (const tabId of broadcastTargets) {
      const ws = terminalSockets[tabId];
      if (ws?.readyState === WebSocket.OPEN) {
        sendTerminalInput(ws, payload);
        sent++;
      }
    }
    if (sent > 0) {
      addToast(`Sent to ${sent} terminal${sent > 1 ? "s" : ""}`, "success");
      setCommand("");
      inputRef.current?.focus();
    } else {
      addToast("No connected targets", "error");
    }
  }, [command, broadcastTargets, terminalSockets, addToast]);

  if (!broadcastMode) return null;

  return (
    <div className="fixed bottom-16 right-4 z-[9999] w-80 rounded-xl bg-[#0f1115]/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/50 ring-1 ring-white/5 animate-fade-in">
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/5 bg-white/5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <IoRadio className="text-red-400" size={16} />
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            Broadcast
          </span>
          <span className="text-[10px] text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded-full font-medium">
            LIVE
          </span>
        </div>
        <button
          onClick={() => setBroadcastMode(false)}
          className="text-gray-500 hover:text-white transition-colors"
        >
          <IoClose size={16} />
        </button>
      </div>

      {/* Target Selection */}
      <div className="p-3 space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-500 font-medium">Targets</label>
          <button
            onClick={toggleAll}
            className="text-[10px] text-primary hover:text-primary-light transition-colors font-medium"
          >
            {allSelected ? "DESELECT ALL" : "SELECT ALL"}
          </button>
        </div>
        {connectedTabs.length === 0 && (
          <p className="text-xs text-gray-600 text-center py-2">
            No connected terminals
          </p>
        )}
        {connectedTabs.map((tab) => {
          const selected = broadcastTargets.has(tab.id);
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              onClick={() => toggleBroadcastTarget(tab.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all duration-200 flex items-center justify-between group ${
                selected
                  ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                  : "text-gray-400 hover:bg-white/5 hover:text-gray-200"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                {selected ? (
                  <IoCheckmarkCircle size={14} className="text-primary shrink-0" />
                ) : (
                  <IoEllipseOutline size={14} className="text-gray-600 shrink-0" />
                )}
                <span className="truncate">{tab.host.name}</span>
                {isActive && (
                  <span className="text-[9px] text-gray-600 bg-white/5 px-1 rounded">
                    active
                  </span>
                )}
              </div>
              <span className="text-[10px] text-gray-600 shrink-0 ml-2">
                {tab.host.hostname}
              </span>
            </button>
          );
        })}
      </div>

      {/* Command Input */}
      <div className="px-3 pb-3 pt-1 border-t border-white/5">
        <div className="flex gap-2">
          <div className="relative flex-1 group">
            <input
              ref={inputRef}
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendCommand();
                }
              }}
              placeholder="Command to broadcast..."
              className="w-full bg-black/40 border border-white/10 rounded-lg py-2 pl-3 pr-3 text-sm text-gray-200 focus:border-primary/50 focus:ring-1 focus:ring-primary/50 focus:outline-none transition-all placeholder:text-gray-600"
              autoFocus
            />
          </div>
          <button
            onClick={sendCommand}
            disabled={!command.trim() || broadcastTargets.size === 0}
            className="px-3 rounded-lg bg-primary/[0.15] backdrop-blur-md border border-primary/[0.3] text-primary hover:bg-primary/[0.25] hover:border-primary/[0.5] disabled:opacity-30 transition-all duration-200 active:scale-95 flex items-center gap-1.5"
          >
            <IoSend size={14} />
          </button>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px] text-gray-600">
            {broadcastTargets.size} target{broadcastTargets.size !== 1 ? "s" : ""} selected
          </span>
          <span className="text-[10px] text-gray-600 flex items-center gap-1">
            <IoCheckmarkDoneSharp size={10} />
            Keystrokes forwarded live
          </span>
        </div>
      </div>
    </div>
  );
};

export default BroadcastPanel;
