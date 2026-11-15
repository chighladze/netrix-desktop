import { IoArrowUpOutline, IoExpandOutline, IoTerminalOutline } from "react-icons/io5";
import type { TabStatus } from "../state/store";

/** A non-interactive drag affordance. It never reads or persists terminal output. */
export default function TerminalWindowPreview({ name, protocol, status }: { name: string; protocol: string; status: TabStatus }) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-3 text-gray-100">
      <div className="terminal-window-preview flex h-full flex-col overflow-hidden rounded-xl border border-cyan-300/30 bg-[#101925]/95 shadow-[0_16px_40px_rgba(0,0,0,.4)]">
        <div className="flex items-center gap-2.5 border-b border-white/[.07] px-4 py-3">
          <IoTerminalOutline className="shrink-0 text-cyan-200" size={19} />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{name}</span>
          <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-400">{protocol}</span>
        </div>
        <div className="flex flex-1 items-center gap-3 px-4 py-3">
          <div className="terminal-window-diagram relative flex h-12 w-16 shrink-0 items-center justify-center rounded-lg border border-cyan-300/30 bg-cyan-300/[.05] text-cyan-200">
            <span className="absolute inset-x-0 top-2 border-t border-cyan-300/20" />
            <IoExpandOutline size={22} />
            <IoArrowUpOutline size={15} className="absolute -right-1 -top-1 rotate-45 bg-[#101925]" />
          </div>
          <div>
            <p className="text-xs font-semibold">Open as a window</p>
            <p className="mt-1 flex items-center gap-1.5 text-[10px] text-gray-400"><span className={`h-1.5 w-1.5 rounded-full ${status === "connected" ? "bg-emerald-400" : "bg-gray-500"}`} />{status === "connected" ? "Session stays connected" : "Terminal moves with you"}</p>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-white/[.06] px-4 py-2 text-[10px]">
          <span className="font-medium text-cyan-200">Release to detach</span><span className="text-gray-500"><kbd className="rounded border border-white/10 px-1 py-0.5 text-[9px]">Esc</kbd> to cancel</span>
        </div>
      </div>
    </div>
  );
}
