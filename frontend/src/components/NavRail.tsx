import clsx from "clsx";
import React, { useState } from "react";
import {
    LuChevronLeft,
    LuChevronRight,
    LuCircleHelp,
    LuCircleUser,
    LuClipboardList,
    LuFolderOpen,
    LuKeyRound,
    LuLock,
    LuLockOpen,
    LuNetwork,
    LuServer,
    LuTerminal,
    LuWrench,
} from "react-icons/lu";
import { useShallow } from "zustand/react/shallow";
import { version as appVersion } from "../../package.json";
import { useAppStore } from "../state/store";
import AboutModal from "./AboutModal";

export type View = "hosts" | "terminal" | "snippets" | "settings" | "utilities" | "network-map" | "files" | "connections";

interface NavRailProps {
  activeView: View;
  onChange: (view: View) => void;
  onOpenHelp: () => void;
  onUnlockVault: () => void;
}

const NavRail: React.FC<NavRailProps> = ({
  activeView,
  onChange,
  onOpenHelp,
  onUnlockVault,
}) => {
  const {
    isSidebarExpanded,
    setSidebarExpanded,
    isVaultUnlocked,
    vaultInitialized,
    vaultStatusLoaded,
    lockVault,
    addToast,
  } = useAppStore(
    useShallow((state) => ({
      isSidebarExpanded: state.isSidebarExpanded,
      setSidebarExpanded: state.setSidebarExpanded,
      isVaultUnlocked: state.isVaultUnlocked,
      vaultInitialized: state.vaultInitialized,
      vaultStatusLoaded: state.vaultStatusLoaded,
      lockVault: state.lockVault,
      addToast: state.addToast,
    })),
  );
  const [showAbout, setShowAbout] = useState(false);
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);

  const handleLockVault = async () => {
    if (vaultBusy) return;
    setVaultBusy(true);
    setVaultError(null);
    const result = await lockVault();
    setVaultBusy(false);
    if (result.ok) {
      addToast("Vault locked", "info");
      return;
    }
    setVaultError(result.error || "Failed to lock vault");
  };

  const navItems: { view: View; icon: React.ReactNode; label: string }[] = [
    { view: "hosts", icon: <LuServer size={22} />, label: "Hosts" },
    { view: "network-map", icon: <LuNetwork size={22} />, label: "Net Map" },
    { view: "terminal", icon: <LuTerminal size={22} />, label: "Terminal" },
    { view: "files", icon: <LuFolderOpen size={22} />, label: "Files" },
    { view: "connections", icon: <LuKeyRound size={22} />, label: "Connections" },
    { view: "snippets", icon: <LuClipboardList size={22} />, label: "Snippets" },
    { view: "utilities", icon: <LuWrench size={22} />, label: "Tool Box" },
  ];

  return (
    <nav
      className={clsx(
        "h-full bg-background-dark flex flex-col no-select overflow-hidden",
        "transition-[width] duration-300 ease-in-out",
        isSidebarExpanded ? "w-64" : "w-[68px]",
      )}
    >
      {/* Brand / Logo Area */}
      <div className="px-3 pt-2 pb-4">
        <button
          type="button"
          onClick={() => setShowAbout(true)}
          aria-label="About Netrix"
          title="About Netrix"
          className={clsx(
            "flex h-12 w-full items-center rounded-xl text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background-dark",
            isSidebarExpanded ? "gap-3" : "justify-center",
          )}
        >
          <img
            src="/icon.png"
            alt=""
            aria-hidden="true"
            width={44}
            height={44}
            draggable={false}
            className="h-11 w-11 shrink-0 object-contain brightness-110"
          />
          <span className="overflow-hidden whitespace-nowrap text-[19px] font-semibold leading-tight tracking-tight text-slate-100">
            {isSidebarExpanded && "Netrix"}
          </span>
        </button>
      </div>

      {/* Navigation Items */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin flex flex-col gap-1.5 px-3">
        {navItems.map((item) => {
          const isActive = activeView === item.view;
          return (
            <button
              key={item.view}
              onClick={() => onChange(item.view)}
              className={clsx(
                "group relative flex items-center rounded-xl h-12 px-3 gap-3 w-full",
                "transition-colors duration-200",
                isActive
                  ? "bg-white/10 text-white"
                  : "text-foreground-muted hover:text-white hover:bg-white/5",
              )}
              title={!isSidebarExpanded ? item.label : undefined}
            >
              {/* Active Glow Background */}
              {isActive && (
                <div className="absolute inset-0 bg-gradient-primary opacity-20 rounded-xl blur-sm" />
              )}

              <div
                className={clsx(
                  "transition-transform duration-200 z-10 flex-shrink-0",
                  isActive
                    ? "text-primary-light scale-110"
                    : "group-hover:scale-110 group-hover:text-white",
                )}
              >
                {item.icon}
              </div>

              <span
                className={clsx(
                  "font-medium text-sm z-10 overflow-hidden whitespace-nowrap",
                  "transition-all duration-300 ease-in-out",
                  isSidebarExpanded ? "opacity-100 w-auto" : "opacity-0 w-0",
                )}
              >
                {item.label}
              </span>

              {/* Active Indicator (vertical bar) */}
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-primary rounded-r-full shadow-[0_0_10px_rgba(59,130,246,0.8)]" />
              )}
            </button>
          );
        })}
      </div>

      {/* Footer Area */}
      <div className="mt-auto flex flex-col">
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={onOpenHelp}
            title={!isSidebarExpanded ? "Help & Getting Started" : undefined}
            className={clsx(
              "flex h-10 w-full items-center rounded-xl border border-transparent text-gray-500 transition-colors hover:border-white/[0.06] hover:bg-white/[0.04] hover:text-gray-200",
              isSidebarExpanded ? "gap-3 px-3" : "justify-center",
            )}
          >
            <LuCircleHelp size={19} className="shrink-0" />
            <span
              className={clsx(
                "overflow-hidden whitespace-nowrap text-xs font-medium transition-all duration-300",
                isSidebarExpanded ? "w-auto opacity-100" : "w-0 opacity-0",
              )}
            >
              Help & Getting Started
            </span>
          </button>
        </div>
        <div className="flex flex-col py-4 px-4 border-t border-gray-800/50">
          <div className="flex items-start gap-3">
            <LuCircleUser
              size={32}
              className={clsx(
                "flex-shrink-0 mt-0.5",
                isVaultUnlocked ? "text-emerald-500/70" : "text-gray-500",
              )}
            />
            <div
              className={clsx(
                "flex min-w-0 flex-1 flex-col justify-center overflow-hidden transition-all duration-300 ease-in-out",
                isSidebarExpanded ? "opacity-100 w-auto" : "opacity-0 w-0",
              )}
            >
              <span className="text-sm font-medium text-white truncate">
                Local Workspace
              </span>
              <div className={clsx(
                "mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-tighter",
                !vaultStatusLoaded
                  ? "text-gray-500"
                  : isVaultUnlocked
                    ? "text-emerald-500"
                    : "text-amber-500",
              )}>
                {isVaultUnlocked ? <LuLockOpen size={11} /> : <LuLock size={11} />}
                <span>
                  {!vaultStatusLoaded
                    ? "Checking Vault"
                    : !vaultInitialized
                      ? "Vault Not Set Up"
                      : isVaultUnlocked
                        ? "Vault Open"
                        : "Vault Locked"}
                </span>
              </div>
            </div>
          </div>

          <div
            className={clsx(
              "flex flex-col overflow-hidden transition-all duration-300 ease-in-out",
              isSidebarExpanded ? "opacity-100 max-h-32 mt-3" : "opacity-0 max-h-0 mt-0",
            )}
          >
            {!vaultStatusLoaded ? (
              <button
                type="button"
                disabled
                className="inline-flex h-8 w-full cursor-wait items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-medium text-gray-500 opacity-70"
              >
                Checking Vault...
              </button>
            ) : vaultInitialized ? (
              isVaultUnlocked ? (
                <button
                  onClick={() => void handleLockVault()}
                  disabled={vaultBusy}
                  className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-medium text-gray-300 transition-all hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LuLock size={13} /> {vaultBusy ? "Locking..." : "Lock Vault"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onUnlockVault}
                  className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 text-xs font-semibold text-amber-300 transition-all hover:bg-amber-500/20 hover:text-amber-100"
                >
                  <LuKeyRound size={13} />
                  Unlock Vault
                </button>
              )
            ) : (
              <button
                onClick={() => onChange("settings")}
                className="inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 text-xs font-medium text-gray-400 transition-all hover:bg-white/10 hover:text-white"
              >
                Set Up Vault
              </button>
            )}

            {vaultError && (
              <p className="mt-1.5 truncate text-[10px] text-red-400 font-medium" title={vaultError}>{vaultError}</p>
            )}
          </div>
        </div>

        {/* Toggle & Version Row */}
        <div className="flex items-center justify-between py-4 px-4">
          <div
            className={clsx(
              "flex flex-col overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out",
              isSidebarExpanded ? "opacity-100 w-auto" : "opacity-0 w-0",
            )}
          >
            <span className="text-[10px] text-gray-600 font-mono tracking-tighter">
              v{appVersion}
            </span>
            <div className="flex items-center gap-1 mt-0.5 px-1.5 py-0.5 bg-primary/5 border border-primary/20 rounded-md">
                <div className="w-1 h-1 rounded-full bg-primary animate-pulse" />
                <span className="text-[8px] font-black text-primary/80 uppercase tracking-[0.1em]">AI Assisted</span>
            </div>
          </div>

          <button
            type="button"
            aria-label={isSidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
            onClick={() => setSidebarExpanded(!isSidebarExpanded)}
            className="p-1.5 rounded-lg bg-gray-800/50 hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
          >
            {isSidebarExpanded ? (
              <LuChevronLeft size={16} />
            ) : (
              <LuChevronRight size={16} />
            )}
          </button>
        </div>
      </div>

      <AboutModal isOpen={showAbout} onClose={() => setShowAbout(false)} />
    </nav>
  );
};

export default NavRail;
