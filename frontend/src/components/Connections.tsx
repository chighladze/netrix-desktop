import React, { useState } from "react";
import Credentials from "../features/connections/CredentialsPanel";
import ImportConfig from "../features/connections/ImportPanel";
import Backups from "../features/connections/BackupPanel";
import KnownHosts from "../features/connections/KnownHostsPanel";
import Tunnels from "../features/connections/TunnelsPanel";
export default function Connections() {
  const [tab, setTab] = useState("credentials");
  return (
    <div className="connections-workspace ui-focus flex h-full min-h-0 flex-col bg-[#0b1118]">
      <div className="shrink-0 border-b border-white/[0.07] bg-[#0d1521] px-4 pt-4">
        <h1 className="mb-3 text-base font-semibold text-white">Connections</h1>
        <div className="connections-tabs flex gap-1 overflow-x-auto">
          {[
            ["credentials", "Keys & identities"],
            ["import", "Import SSH config"],
            ["backups", "Backup & restore"],
            ["known", "Known Hosts"],
            ["tunnels", "SSH tunnels"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={`shrink-0 border-b-2 px-3 py-2.5 text-xs transition-colors ${tab === id ? "border-sky-300 bg-sky-300/[0.07] text-sky-200" : "border-transparent text-slate-400 hover:bg-white/5 hover:text-white"}`}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {tab === "credentials" ? (
          <Credentials />
        ) : tab === "import" ? (
          <ImportConfig />
        ) : tab === "backups" ? (
          <Backups />
        ) : tab === "known" ? (
          <KnownHosts />
        ) : (
          <Tunnels />
        )}
      </div>
    </div>
  );
}
