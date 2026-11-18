import { Dialog, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { IoLockClosedOutline, IoArrowForward, IoReloadOutline, IoEyeOutline, IoEyeOffOutline, IoKeyOutline, IoShieldCheckmarkOutline, IoAlertCircleOutline, IoCheckmark, IoArrowUpOutline, IoEllipseOutline } from "react-icons/io5";
import { fetchJsonOrThrow, getApiBase, getBackendStatus, waitForBackendReady, type BackendStatus } from "../../api";
import BackendFailurePanel from "./BackendFailurePanel";
import TitleBar from "../../components/TitleBar";
import { useAppStore } from "../../state/store";
import { requestApplicationClose } from "../../terminal/appClose";
import { notifySecurityChanged, securityRequest, SECURITY_CHANGED_EVENT, type SecuritySnapshot } from "./api";
import { MIN_VAULT_MASTER_PASSWORD_LENGTH } from "../vault/password";
import "./security.css";

/** A single boundary above every window variant. Keep terminals mounted while obscured. */
export default function AppSecurityBoundary({ children }: { children: React.ReactNode }) {
  const security = useAppStore((state) => state.appSecurity);
  const settings = useAppStore((state) => state.settings.security);
  const [ready, setReady] = useState(false);
  const [backendFailure, setBackendFailure] = useState<BackendStatus | null>(null);
  const [mounted, setMounted] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const polling = useRef(false);
  const unlocking = useRef(false);
  const alive = useRef(true);
  const backendUnavailable = useRef(false);
  const blocked = security.locked !== false || Boolean(security.error);
  const isMain = getCurrentWindow().label === "main";
  const setup = security.databaseMode === "setup";
  const upgrading = security.databaseMode === "upgrade";
  const openingDatabase = setup || upgrading || security.databaseMode === "encrypted";
  const working = busy || Boolean(security.databaseBusy);
  const passwordLongEnough = Array.from(password).length >= MIN_VAULT_MASTER_PASSWORD_LENGTH;
  const passwordsMatch = Boolean(confirmation) && password === confirmation;

  const quit = useCallback(async () => {
    try {
      await invoke("quit_app");
    } catch {
      const { appSecurity, addToast } = useAppStore.getState();
      if (appSecurity.locked !== false || appSecurity.error) setError("Unable to close Netrix");
      else addToast("Could not quit Netrix. Your sessions are still open.", "error");
    }
  }, []);

  useEffect(() => {
    if (!isMain) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    // This boundary exists before the first unlock and after a backend failure.
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      const { appSecurity } = useAppStore.getState();
      if (appSecurity.locked !== false || appSecurity.error) setConfirmExit(true);
      else void requestApplicationClose(quit);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, [isMain, quit]);

  const closeFromLockScreen = () => {
    if (isMain) {
      setConfirmExit(true);
    } else if (backendFailure) {
      const window = getCurrentWindow();
      const close = window.label.startsWith("detached-") ? invoke("close_terminal_window") : window.close();
      void close.catch(() => setError("Unable to close this window"));
    } else {
      setError("Unlock Netrix before closing this window or ending its sessions.");
    }
  };

  const apply = useCallback((snapshot: SecuritySnapshot) => {
    if (!alive.current || backendUnavailable.current) return;
    const previous = useAppStore.getState().appSecurity;
    if (snapshot.revision < previous.revision) return;
    useAppStore.setState({
      appSecurity: { locked: snapshot.locked, revision: snapshot.revision, error: null,
        databaseMode: snapshot.database_mode, databaseEncrypted: snapshot.database_encrypted,
        databaseBusy: snapshot.database_busy },
      isVaultUnlocked: snapshot.vault_unlocked,
      vaultInitialized: snapshot.vault_initialized,
      vaultStatusLoaded: true,
    });
    if (!snapshot.locked) setMounted(true);
  }, []);

  const failBackend = useCallback((failure: BackendStatus) => {
    if (!alive.current) return;
    backendUnavailable.current = true;
    setBackendFailure(failure);
    setReady(false);
    setPassword(""); setConfirmation(""); setPasswordVisible(false); setError(null);
    useAppStore.setState((state) => ({ appSecurity: {
      ...state.appSecurity, error: failure.message || "The local Netrix service is unavailable.",
    } }));
  }, []);

  const refresh = useCallback(async () => {
    if (polling.current || backendUnavailable.current) return;
    polling.current = true;
    try { apply(await securityRequest("status")); }
    catch {
      // Hide content immediately, before asking the shell whether the process died.
      if (alive.current) useAppStore.setState((state) => ({ appSecurity: {
        ...state.appSecurity, error: "Cannot verify the lock. Reconnecting to the local backend…",
      } }));
      try {
        const backend = await getBackendStatus();
        if (backend.status === "failed") failBackend(backend);
      } catch { /* A temporary IPC failure keeps the existing fail-closed retry. */ }
    } finally { polling.current = false; }
  }, [apply, failBackend]);

  useEffect(() => {
    alive.current = true;
    // Show the gate even if backend startup fails; App cannot mount before it.
    void getCurrentWindow().show().catch(() => undefined);
    const abort = new AbortController();
    void waitForBackendReady({ signal: abort.signal }).then(async (status) => {
      if (abort.signal.aborted) return;
      if (status.status !== "ready") { failBackend(status); return; }
      setReady(true);
      await refresh();
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) failBackend({ status: "failed",
        message: reason instanceof Error ? reason.message : "Backend is unavailable",
      });
    });
    return () => { alive.current = false; abort.abort(); };
  }, [refresh, failBackend]);

  useEffect(() => {
    if (!ready) return;
    const interval = window.setInterval(() => { void refresh(); }, 1000);
    const changed = () => { void refresh(); };
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen(SECURITY_CHANGED_EVENT, changed).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(() => undefined);
    window.addEventListener(SECURITY_CHANGED_EVENT, changed);
    window.addEventListener("focus", changed);
    return () => {
      disposed = true; stop?.(); window.clearInterval(interval);
      window.removeEventListener(SECURITY_CHANGED_EVENT, changed);
      window.removeEventListener("focus", changed);
    };
  }, [ready, refresh]);

  useEffect(() => {
    if (!ready || !isMain || blocked) return;
    let active = true;
    let retry: number | undefined;
    const configure = async () => {
      try {
        const base = await getApiBase();
        await fetchJsonOrThrow(`${base}/security/policy`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            app_timeout_seconds: settings.autoLockEnabled ? settings.autoLockTimeout * 60 : null,
            vault_timeout_seconds: settings.vaultAutoLockEnabled ? settings.vaultAutoLockTimeout * 60 : null,
          }),
        });
      } catch {
        if (active) {
          useAppStore.getState().addToast("Auto-lock settings could not be applied. Retrying…", "error");
          retry = window.setTimeout(() => { void configure(); }, 10000);
        }
      }
    };
    void configure();
    return () => { active = false; window.clearTimeout(retry); };
  }, [ready, isMain, blocked, settings.autoLockEnabled, settings.autoLockTimeout,
    settings.vaultAutoLockEnabled, settings.vaultAutoLockTimeout]);

  useEffect(() => {
    if (!ready || blocked) return;
    let lastSent = 0;
    const activity = (event: Event) => {
      // Incoming output, timers, synthetic events and status polling are not activity.
      if (!event.isTrusted || Date.now() - lastSent < 3000) return;
      lastSent = Date.now();
      void getApiBase().then((base) => fetchJsonOrThrow(`${base}/security/activity`, { method: "POST" }))
        .catch(() => { void refresh(); });
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((name) => window.addEventListener(name, activity, { capture: true, passive: true }));
    return () => events.forEach((name) => window.removeEventListener(name, activity, true));
  }, [ready, blocked, refresh]);

  useEffect(() => {
    if (content.current) content.current.inert = blocked;
    document.body.toggleAttribute("data-app-locked", blocked);
    if (blocked && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (blocked) input.current?.focus();
    if (!blocked) { setPassword(""); setConfirmation(""); setError(null); setConfirmExit(false); }
    setPasswordVisible(false); setCapsLock(false);
    return () => { document.body.removeAttribute("data-app-locked"); };
  }, [blocked]);

  useEffect(() => {
    if (working) setPasswordVisible(false);
    if (blocked && ready && !working && security.locked === true) {
      input.current?.focus({ preventScroll: true });
      // The dialog can finish activating after the asynchronous startup check.
      const frame = window.requestAnimationFrame(() => {
        if (document.activeElement === document.body || document.activeElement?.getAttribute("role") === "dialog") {
          input.current?.focus({ preventScroll: true });
        }
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [blocked, ready, working, security.locked]);

  useEffect(() => {
    setPassword(""); setConfirmation(""); setPasswordVisible(false); setCapsLock(false); setError(null);
  }, [security.databaseMode]);

  useEffect(() => {
    const conceal = () => { setPasswordVisible(false); setCapsLock(false); };
    const visibility = () => { if (document.hidden) conceal(); };
    window.addEventListener("blur", conceal);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", conceal); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  const updateCapsLock = (event: React.KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState("CapsLock"));

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    if (unlocking.current || working || !password || !ready || security.locked !== true || security.error) return;
    if (setup && (!passwordLongEnough || password !== confirmation)) {
      setError(password !== confirmation ? "Passwords do not match" : `Use at least ${MIN_VAULT_MASTER_PASSWORD_LENGTH} characters`);
      return;
    }
    unlocking.current = true;
    setBusy(true); setError(null);
    const submitted = password;
    setPassword("");
    setConfirmation("");
    setPasswordVisible(false); setCapsLock(false);
    try {
      apply(await securityRequest("unlock", { master_password: submitted }));
      if (!backendUnavailable.current) await notifySecurityChanged();
    } catch (reason) {
      if (!backendUnavailable.current) setError(reason instanceof Error ? reason.message : "Unable to unlock Netrix");
    } finally { unlocking.current = false; setBusy(false); }
  };

  return <>
    <div ref={content} data-netrix-content aria-hidden={blocked || undefined} style={blocked ? { display: "none" } : undefined}>
      {mounted && children}
    </div>
    <Dialog open={blocked} onClose={() => {}} initialFocus={input} className="relative z-[2147483640]">
      <DialogPanel data-netrix-lock-screen className="fixed inset-0 flex flex-col bg-background-midnight">
        <TitleBar title={backendFailure ? "Netrix · Service unavailable" : "Netrix · Locked"} showSettings={false} onClose={closeFromLockScreen} />
        <div className="workspace-lock-stage">
          <div className="workspace-lock-card">
            <header className="workspace-lock-brand">
              <div className="workspace-lock-mark"><IoLockClosedOutline size={21} aria-hidden="true" /></div>
              <div><span className="workspace-lock-name">Netrix</span><span className="workspace-lock-context">Local workspace</span></div>
              <span className="workspace-lock-badge">{backendFailure ? "Service error" : setup ? "First-time setup" : upgrading ? "Storage upgrade" : "Locked"}</span>
            </header>
            <div className="workspace-lock-body">
              <DialogTitle className="workspace-lock-title">{backendFailure ? "Netrix service unavailable" : security.locked !== true ? "Checking your workspace" : setup ? "Protect your workspace" : upgrading ? "Encrypt your workspace" : openingDatabase ? "Open your workspace" : "Netrix is locked"}</DialogTitle>
              <Description className="workspace-lock-description">
                {backendFailure ? "The local service that opens your workspace is unavailable. Follow the recovery steps below."
                  : security.locked !== true ? "Waiting for the local backend to confirm your workspace is ready."
                  : setup ? "Choose a master password for your local database and saved credentials. You will use it each time Netrix starts."
                  : upgrading ? "Use your existing master password. Netrix will encrypt and verify your database, then keep an encrypted recovery copy."
                  : openingDatabase ? "Enter your master password to open your encrypted local workspace."
                  : "Enter your master password to continue. Your sessions stay connected while Netrix is locked."}
              </Description>
              {backendFailure ? <BackendFailurePanel failure={backendFailure} /> : security.error && <div role="alert" className="workspace-lock-alert" data-tone="warning"><IoAlertCircleOutline size={17} aria-hidden="true" /><span>{security.error}</span></div>}
              {security.locked !== true && !security.error && <p role="status" className="workspace-lock-progress"><IoReloadOutline className="animate-spin" aria-hidden="true" /> Connecting to the local backend…</p>}
              {security.locked === true && ready && <form onSubmit={unlock} className="workspace-lock-form" aria-busy={working}>
                <div>
                  <label htmlFor="workspace-master-password" className="workspace-lock-label">Master password</label>
                  <div className="workspace-lock-field">
                    <IoKeyOutline className="workspace-lock-field-icon" size={17} aria-hidden="true" />
                    <input id="workspace-master-password" ref={input} autoComplete={setup ? "new-password" : "current-password"}
                      type={passwordVisible ? "text" : "password"} value={password} spellCheck={false} autoCapitalize="none"
                      aria-invalid={Boolean(error)} aria-describedby={error ? "app-unlock-error" : setup ? "workspace-password-guidance" : undefined}
                      disabled={working} onChange={(event) => { setPassword(event.target.value); setError(null); }}
                      onKeyDown={updateCapsLock} onKeyUp={updateCapsLock} onBlur={() => setCapsLock(false)}
                      placeholder={setup ? `At least ${MIN_VAULT_MASTER_PASSWORD_LENGTH} characters` : "Enter master password"}
                      className="workspace-lock-input workspace-lock-input-with-actions" />
                    <button type="button" className="workspace-lock-reveal" disabled={working}
                      aria-label={passwordVisible ? "Hide master password" : "Show master password"} aria-pressed={passwordVisible}
                      onMouseDown={(event) => event.preventDefault()} onClick={() => setPasswordVisible((visible) => !visible)}>
                      {passwordVisible ? <IoEyeOffOutline size={18} aria-hidden="true" /> : <IoEyeOutline size={18} aria-hidden="true" />}
                    </button>
                  </div>
                </div>
                {setup && <div>
                  <label htmlFor="workspace-confirm-password" className="workspace-lock-label">Confirm master password</label>
                  <input id="workspace-confirm-password" autoComplete="new-password" type={passwordVisible ? "text" : "password"}
                    value={confirmation} disabled={working} spellCheck={false} autoCapitalize="none" aria-invalid={Boolean(error)}
                    aria-describedby={error ? "app-unlock-error" : "workspace-password-guidance"}
                    onChange={(event) => { setConfirmation(event.target.value); setError(null); }}
                    onKeyDown={updateCapsLock} onKeyUp={updateCapsLock} onBlur={() => setCapsLock(false)}
                    placeholder="Enter your password again" className="workspace-lock-input" />
                  <div id="workspace-password-guidance" className="workspace-lock-guidance">
                    <span data-complete={passwordLongEnough}>{passwordLongEnough ? <IoCheckmark size={13} aria-hidden="true" /> : <IoEllipseOutline size={11} aria-hidden="true" />} {MIN_VAULT_MASTER_PASSWORD_LENGTH}+ characters</span>
                    <span data-complete={passwordsMatch}>{passwordsMatch ? <IoCheckmark size={13} aria-hidden="true" /> : <IoEllipseOutline size={11} aria-hidden="true" />} {passwordsMatch ? "Passwords match" : confirmation ? "Passwords differ" : "Confirm password"}</span>
                  </div>
                </div>}
                {capsLock && <p role="status" className="workspace-lock-caps"><IoArrowUpOutline size={14} aria-hidden="true" /> Caps Lock is on</p>}
                {error && <div id="app-unlock-error" role="alert" className="workspace-lock-alert"><IoAlertCircleOutline size={17} aria-hidden="true" /><span>{error}</span></div>}
                <button disabled={working || !password || (setup && !confirmation) || Boolean(security.error)} type="submit" className="workspace-lock-submit">
                  {working ? <><IoReloadOutline className="animate-spin" aria-hidden="true" /> {upgrading || setup ? "Encrypting and verifying…" : "Unlocking…"}</>
                    : <><span>{upgrading || setup ? "Encrypt and open" : "Unlock Netrix"}</span><IoArrowForward size={17} aria-hidden="true" /></>}
                </button>
                {working && <p role="status" className="workspace-lock-progress">{openingDatabase ? "Keep Netrix open while your workspace is prepared. This may take a moment." : "Verifying your master password…"}</p>}
              </form>}
              {error && (security.locked !== true || !ready) && <div id="app-unlock-error" role="alert" className="workspace-lock-alert"><IoAlertCircleOutline size={17} aria-hidden="true" /><span>{error}</span></div>}
              {security.error && !backendFailure && <button type="button" onClick={() => ready ? void refresh() : window.location.reload()} className="workspace-lock-secondary"><IoReloadOutline size={15} aria-hidden="true" /> Retry connection</button>}
              {backendFailure && isMain && <button type="button" onClick={() => setConfirmExit(true)} className="workspace-lock-secondary workspace-backend-close">Close Netrix</button>}
              {backendFailure && !isMain && <p className="workspace-backend-recovery">Close and reopen Netrix from its main window.</p>}
              {confirmExit && <div className="workspace-lock-exit">
                <p>Exit Netrix? Active connections will close.</p>
                <div>
                  <button type="button" className="workspace-lock-secondary" onClick={() => setConfirmExit(false)}>Stay in Netrix</button>
                  <button type="button" className="workspace-lock-secondary" data-tone="danger" onClick={() => { void quit(); }}>Exit Netrix</button>
                </div>
              </div>}
            </div>
            <footer className="workspace-lock-footer">
              <IoShieldCheckmarkOutline size={17} aria-hidden="true" />
              <div><strong>{backendFailure ? "Keep your workspace files" : openingDatabase ? "Keep your master password safe" : "Your workspace stays on this device"}</strong>
                <p>{backendFailure ? "Preserve your database and identity files while resolving this error." : openingDatabase ? "It cannot be recovered. Encrypted backups also require their password." : "Unlocking restores access across all Netrix windows."}</p>
              </div>
            </footer>
          </div>
        </div>
      </DialogPanel>
    </Dialog>
  </>;
}
