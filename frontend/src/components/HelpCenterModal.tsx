import React, { useEffect, useRef } from "react";
import {
  LuBookOpen,
  LuCheck,
  LuChevronRight,
  LuCircleHelp,
  LuClipboardList,
  LuFolderOpen,
  LuKeyRound,
  LuLock,
  LuLockOpen,
  LuNetwork,
  LuServer,
  LuShieldCheck,
  LuTerminal,
  LuWrench,
  LuX,
} from "react-icons/lu";
import VaultCreationForm from "../features/vault/VaultCreationForm";
import type { VaultActionResult } from "../state/store";
import type { View } from "./NavRail";

export const HELP_INTRO_COMPLETED_KEY = "netrix.help.intro.completed.v2";

export type HelpCenterMode = "welcome" | "guide";

interface HelpCenterModalProps {
  isOpen: boolean;
  mode: HelpCenterMode;
  vaultInitialized: boolean;
  vaultUnlocked: boolean;
  onClose: () => void;
  onNavigate: (view: View) => void;
  onCreateVault: (masterPassword: string) => Promise<VaultActionResult>;
  onUnlockVault: () => void;
  onReportProblem: () => void;
}

const workspaceItems: Array<{
  view: View;
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  { view: "connections", title: "Connections", description: "Manage keys, identities, SSH tunnels, imports and encrypted backups.", icon: <LuKeyRound size={17} /> },
  {
    view: "hosts",
    title: "Hosts",
    description: "Save SSH, Telnet, Serial, and local connection profiles.",
    icon: <LuServer size={17} />,
  },
  {
    view: "terminal",
    title: "Terminal",
    description: "Run sessions in tabs, split panes or detached windows.",
    icon: <LuTerminal size={17} />,
  },
  {
    view: "files",
    title: "Files",
    description: "Browse, preview, download, and upload files over SSH/SFTP.",
    icon: <LuFolderOpen size={17} />,
  },
  {
    view: "network-map",
    title: "Network Map",
    description: "Arrange saved hosts into visual topology workspaces.",
    icon: <LuNetwork size={17} />,
  },
  {
    view: "snippets",
    title: "Snippets",
    description: "Keep reusable command templates close to your terminal.",
    icon: <LuClipboardList size={17} />,
  },
  {
    view: "utilities",
    title: "Tool Box",
    description: "Use bounded network checks and everyday engineering tools.",
    icon: <LuWrench size={17} />,
  },
];

const HelpCenterModal: React.FC<HelpCenterModalProps> = ({
  isOpen,
  mode,
  vaultInitialized,
  vaultUnlocked,
  onClose,
  onNavigate,
  onCreateVault,
  onUnlockVault,
  onReportProblem,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => {
      const preferredFocus = dialogRef.current?.querySelector<HTMLElement>("[data-help-autofocus]");
      (preferredFocus ?? closeButtonRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const vaultState = !vaultInitialized
    ? {
        eyebrow: "Recommended first step",
        title: "Create your Credential Vault",
        description:
          "Choose a local master password before saving credentials. Netrix cannot recover this password, so keep it somewhere safe.",
        badge: "Setup required",
        icon: <LuKeyRound size={21} />,
        action: undefined,
        onAction: undefined,
        tone: "amber",
      }
    : !vaultUnlocked
      ? {
          eyebrow: "Credential access paused",
          title: "Your Vault is locked",
          description:
            "Unlock it to use saved passwords, private keys, passphrases, and SSH/SFTP credentials linked to hosts.",
          badge: "Locked",
          icon: <LuLock size={21} />,
          action: "Unlock Vault",
          onAction: onUnlockVault,
          tone: "amber",
        }
      : {
          eyebrow: "Security ready",
          title: "Your Vault is unlocked",
          description:
            "Saved credentials are available only to the local Netrix session and remain encrypted at rest.",
          badge: "Ready",
          icon: <LuLockOpen size={21} />,
          action: "Open Hosts",
          onAction: () => onNavigate("hosts"),
          tone: "emerald",
        };

  const isReady = vaultState.tone === "emerald";

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-3 sm:p-6">
      <button
        type="button"
        aria-label="Close Netrix guide"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-[#02050a]/80 backdrop-blur-md"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-center-title"
        aria-describedby="help-center-description"
        className="ui-dialog relative flex max-h-[92vh] w-full max-w-[880px] flex-col overflow-hidden rounded-dialog border border-white/[0.09] bg-[#0b111a] shadow-[0_32px_120px_rgba(0,0,0,0.68)]"
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(circle_at_20%_0%,rgba(59,130,246,0.16),transparent_52%),radial-gradient(circle_at_82%_0%,rgba(34,211,238,0.09),transparent_42%)]" />

        <header className="relative flex shrink-0 items-start gap-4 border-b border-white/[0.07] px-5 py-5 sm:px-7">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            {mode === "welcome" ? <LuShieldCheck size={22} /> : <LuBookOpen size={22} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-primary/80">
              <span>{mode === "welcome" ? "Welcome to Netrix" : "Help & Getting Started"}</span>
              <span className="h-1 w-1 rounded-full bg-gray-700" />
              <span className="text-gray-500">Local-first workspace</span>
            </div>
            <h2 id="help-center-title" className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
              {mode === "welcome" ? "Start with a secure, organized workspace" : "Everything you need to find your way around"}
            </h2>
            <p id="help-center-description" className="mt-1.5 max-w-2xl text-xs leading-5 text-gray-400 sm:text-sm">
              {mode === "welcome"
                ? "Netrix keeps connections, credentials, files, terminal sessions, and network tools together on this device."
                : "Use this guide whenever you need a quick explanation or a direct path to a workspace."}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close guide"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <LuX size={19} />
          </button>
        </header>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-5 scrollbar-thin sm:px-7 sm:py-6">
          <section
            className={`overflow-hidden rounded-xl border p-4 sm:p-5 ${
              isReady
                ? "border-emerald-400/20 bg-emerald-400/[0.065]"
                : "border-amber-300/20 bg-amber-300/[0.065]"
            }`}
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${
                  isReady
                    ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-300"
                    : "border-amber-300/20 bg-amber-300/10 text-amber-300"
                }`}
              >
                {vaultState.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className={`text-[10px] font-bold uppercase tracking-[0.15em] ${isReady ? "text-emerald-300/80" : "text-amber-300/80"}`}>
                  {vaultState.eyebrow}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-gray-100 sm:text-base">{vaultState.title}</h3>
                  <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${isReady ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200" : "border-amber-300/20 bg-amber-300/10 text-amber-200"}`}>
                    {vaultState.badge}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-5 text-gray-400">{vaultState.description}</p>
              </div>
              {vaultState.action && vaultState.onAction && (
                <button
                  type="button"
                  onClick={vaultState.onAction}
                  className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg border px-4 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 ${
                    isReady
                      ? "border-emerald-300/25 bg-emerald-300/10 text-emerald-100 hover:bg-emerald-300/20 focus:ring-emerald-300/30"
                      : "border-amber-300/25 bg-amber-300/10 text-amber-100 hover:bg-amber-300/20 focus:ring-amber-300/30"
                  }`}
                >
                  {vaultState.action}
                  <LuChevronRight size={15} />
                </button>
              )}
            </div>
            {!vaultInitialized && <VaultCreationForm onCreate={onCreateVault} />}
          </section>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_1.4fr]">
            <section>
              <div className="mb-3 flex items-center gap-2">
                <LuCircleHelp size={16} className="text-primary" />
                <h3 className="text-xs font-bold uppercase tracking-[0.13em] text-gray-300">How Netrix works</h3>
              </div>
              <div className="space-y-2">
                {[
                  ["1", "Protect credentials", "Create and unlock the Vault when you want Netrix to save passwords or private keys."],
                  ["2", "Add or open a host", "Save a reusable profile, or use Quick Connect for a one-time connection."],
                  ["3", "Work in context", "Move between terminal, files, snippets, maps, and utilities without losing your place."],
                ].map(([step, title, description]) => (
                  <div key={step} className="flex gap-3 rounded-lg border border-white/[0.07] bg-white/[0.025] p-3">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-[10px] font-bold text-primary">
                      {step}
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-gray-200">{title}</h4>
                      <p className="mt-1 text-[11px] leading-4 text-gray-500">{description}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 rounded-lg border border-white/[0.07] bg-black/20 p-3">
                <div className="flex items-start gap-2.5">
                  <LuCheck size={15} className="mt-0.5 shrink-0 text-emerald-400" />
                  <p className="text-[11px] leading-4 text-gray-400">
                    <span className="font-semibold text-gray-200">No account or cloud login is required.</span>{" "}
                    Quick Connect, local/serial sessions, maps, and utilities that do not use saved secrets remain available while the Vault is locked.
                  </p>
                </div>
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-xs font-bold uppercase tracking-[0.13em] text-gray-300">Workspace map</h3>
                <span className="text-[10px] text-gray-600">Select an area to open it</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {workspaceItems.map((item) => (
                  <button
                    key={item.view}
                    type="button"
                    onClick={() => onNavigate(item.view)}
                    className="group flex min-h-[82px] items-start gap-3 rounded-lg border border-white/[0.07] bg-white/[0.025] p-3 text-left transition-all hover:border-primary/25 hover:bg-primary/[0.06] focus:outline-none focus:ring-2 focus:ring-primary/30"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-black/20 text-gray-400 transition-colors group-hover:border-primary/20 group-hover:text-primary">
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2 text-xs font-semibold text-gray-200 group-hover:text-white">
                        {item.title}
                        <LuChevronRight size={13} className="shrink-0 text-gray-700 transition-all group-hover:translate-x-0.5 group-hover:text-primary" />
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-gray-500">{item.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>

        <footer className="relative flex shrink-0 flex-col gap-3 border-t border-white/[0.07] bg-black/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <LuShieldCheck size={14} className="text-emerald-400/80" />
            Credentials stay encrypted locally and are never stored in this guide.
          </div>
          <button type="button" onClick={onReportProblem}
            className="h-9 shrink-0 rounded-lg border border-primary/30 bg-primary/10 px-4 text-xs font-semibold text-primary focus:outline-none focus:ring-2 focus:ring-primary/40">
            Report problem
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-gray-300 transition-colors hover:bg-white/[0.08] hover:text-white focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {mode === "welcome" ? "Continue to Netrix" : "Close Guide"}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default HelpCenterModal;
