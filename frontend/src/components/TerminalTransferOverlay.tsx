import { IoArrowForward, IoClose, IoExpandOutline } from "react-icons/io5";
import { useEffect, useState } from "react";
import { useAppStore } from "../state/store";

export default function TerminalTransferOverlay({ tabId }: { tabId: string }) {
  const transfer = useAppStore((state) => state.terminalTransfers[tabId]);
  const [visible, setVisible] = useState(false);
  const pending = Boolean(transfer);
  useEffect(() => {
    if (!pending) { setVisible(false); return; }
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [pending]);
  if (!transfer || !visible) return null;
  const outgoing = transfer.direction === "outgoing";
  const finishing = transfer.phase === "finishing";
  return (
    <div className={`terminal-transfer-overlay absolute inset-0 z-[95] flex justify-center ${tabId === "detached" ? "pointer-events-none items-end pb-6" : "items-center bg-[#080d16]/25"}`} aria-busy="true">
      <div role="status" className="terminal-transfer-card pointer-events-auto relative flex w-[320px] items-center gap-3 overflow-hidden rounded-xl border border-cyan-300/20 bg-[#0d1420]/95 p-4 shadow-[0_16px_55px_rgba(0,0,0,0.45)]">
        <div className="terminal-transfer-track absolute inset-x-0 top-0 h-px bg-cyan-300/20" />
        <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-300/[0.08] text-cyan-200">
          {outgoing ? <IoExpandOutline size={21} /> : <IoArrowForward size={21} className="rotate-180" />}
        </div>
        <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-gray-100">{finishing ? "Almost there…" : outgoing ? tabId === "detached" ? "Returning to workspace" : "Opening terminal window" : "Getting your terminal ready"}</p>
        <p className="mt-1 text-[11px] text-gray-400">Your session stays connected.</p>
        {!finishing && (
          <button onClick={transfer.cancel} className="mt-2 inline-flex items-center gap-1 rounded-md text-[10px] text-gray-400 transition-colors hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-cyan-300">
            <IoClose size={14} /> Cancel move
          </button>
        )}
        </div>
      </div>
    </div>
  );
}
