import { useEffect, useId, useRef, useState } from "react";
import { IoArrowForward, IoChevronDown, IoCopyOutline, IoRefresh } from "react-icons/io5";
import type { HostConnectionFields } from "../types/host";
import type { TerminalSessionStatus } from "../terminal/TerminalSessionController";
import { connectionFeedback, connectionPhase, connectionTarget } from "../terminal/connectionPresentation";
import { copyTextWithAutoClear } from "../utils/clipboard";
import ConnectionBitStream from "./ConnectionBitStream";
import { DEFAULT_TERMINAL_SURFACE } from "../themes";
import "../terminal/connectionStatus.css";

interface Props {
  host: HostConnectionFields;
  status: TerminalSessionStatus;
  errorMessage: string | null;
  progressStep: string | null;
  sessionUnavailable: boolean;
  vaultLocked: boolean;
  exiting?: boolean;
  closing?: boolean;
  onReady?: () => void;
  onReconnect: () => void;
  onClose: () => Promise<boolean>;
  onUnlock: (password: string) => Promise<{ ok: boolean; error?: string }>;
}

export default function ConnectionStatusPanel({ host, status, errorMessage, progressStep, sessionUnavailable, vaultLocked, exiting, closing, onReady, onReconnect, onClose, onUnlock }: Props) {
  const titleId = useId(), passwordId = useId();
  const [elapsed, setElapsed] = useState(0);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"unlock" | "close" | null>(null);
  const [actionError, setActionError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const requestVersion = useRef(0);
  const actionBusy = Boolean(busy || closing);
  const waiting = status === "connecting", connected = status === "connected";
  const needsUnlock = status === "error" && vaultLocked;
  const feedback = connectionFeedback(host, status, errorMessage, needsUnlock, sessionUnavailable);
  const phase = connectionPhase(progressStep);
  const target = connectionTarget(host);
  const targetKey = JSON.stringify([host.connection_type, target, host.username, host.local_cwd, host.local_args, host.serial_speed]);
  const local = host.connection_type === "local", serial = host.connection_type === "serial";
  const tone = connected ? "success" : needsUnlock ? "warning" : waiting ? "pending" : "error";

  useEffect(() => {
    requestVersion.current += 1;
    setBusy(null); setActionError(""); setPassword(""); setCopyStatus("");
    return () => { requestVersion.current += 1; };
  }, [status, targetKey]);

  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [waiting, targetKey]);

  const unlock = async () => {
    if (!password || actionBusy) return;
    const version = ++requestVersion.current;
    setBusy("unlock"); setActionError("");
    try {
      const result = await onUnlock(password);
      if (version !== requestVersion.current) return;
      if (result.ok) { setPassword(""); onReconnect(); }
      else setActionError(result.error || "Could not unlock the vault. Try again.");
    } catch {
      if (version === requestVersion.current) setActionError("Could not unlock the vault. Try again.");
    } finally {
      if (version === requestVersion.current) setBusy(null);
    }
  };
  const close = async () => {
    if (actionBusy) return;
    const version = ++requestVersion.current;
    setBusy("close"); setActionError("");
    try {
      const closed = await onClose();
      if (!closed && version === requestVersion.current) setActionError("Could not confirm closure. Your tab is still open; try again.");
    } catch {
      if (version === requestVersion.current) setActionError("Could not close this session. Try again.");
    } finally {
      if (version === requestVersion.current) setBusy(null);
    }
  };

  return <section aria-labelledby={titleId} className={`connection-screen connection-${tone}${exiting ? " connection-exiting" : ""}`} style={DEFAULT_TERMINAL_SURFACE}
    onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
    <div className="connection-shell">
      <header className="connection-header">
        <p className="connection-host-name" title={host.name}>{host.name}</p>
        <div className="connection-route" aria-label="Connection destination">
          <span className="connection-protocol">{host.connection_type.toUpperCase()}</span>
          <span className="connection-endpoint">{!local && !serial && <><span className="connection-user">{host.username || "Default user"}</span><span className="connection-at">@</span></>}{target}</span>
          {(local || serial) && <span className="connection-context">{local ? host.local_cwd || "Home directory" : `${host.serial_speed || 9600} baud`}</span>}
        </div>
      </header>

      <div className="connection-layout">
        <div className="connection-main">
          <div role="status" aria-live="polite" aria-atomic="true">
            <h2 id={titleId} className="connection-title">{feedback.title}</h2>
            <p className="connection-description">{feedback.description}</p>
          </div>
          {feedback.hint && <p className="connection-hint">{feedback.hint}</p>}
          {!waiting && errorMessage?.includes("Reconnecting in ") && <p className="connection-retry-note">Automatic retry scheduled.</p>}

          {needsUnlock && <form className="connection-unlock" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
            <label htmlFor={passwordId}>Master password</label>
            <div className="connection-unlock-row"><input id={passwordId} type="password" autoComplete="current-password" value={password} disabled={actionBusy} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your master password" />
              <button className="connection-button connection-primary" disabled={!password || actionBusy}>{busy === "unlock" ? "Unlocking…" : "Unlock & connect"}<IoArrowForward aria-hidden="true" /></button></div>
          </form>}
          {!connected && <div className="connection-actions">
            {!waiting && !needsUnlock && <button className="connection-button connection-primary" disabled={actionBusy} onClick={onReconnect}><IoRefresh aria-hidden="true" />{sessionUnavailable ? "Start new session" : "Reconnect"}</button>}
            <button className="connection-button connection-secondary" disabled={actionBusy} onClick={() => void close()}>{busy === "close" || closing ? "Closing…" : waiting ? "Cancel connection" : "Close tab"}</button>
          </div>}
          {actionError && <p className="connection-action-error" role="alert">{actionError}</p>}

          {!waiting && errorMessage && <details className="connection-details">
            <summary><IoChevronDown aria-hidden="true" />Technical details</summary>
            <pre>{errorMessage}</pre>
            <div className="connection-details-actions"><button className="connection-copy" onClick={() => {
              void copyTextWithAutoClear(errorMessage).then(() => setCopyStatus("Details copied"), () => setCopyStatus("Could not copy details"));
            }}><IoCopyOutline aria-hidden="true" />Copy details</button><span role="status">{copyStatus}</span></div>
          </details>}
        </div>

        <div className="connection-activity">
          <ConnectionBitStream running={waiting} complete={connected} onComplete={onReady} />
          {waiting && <div className="connection-signal-meta">
            <span>{phase || (local ? "Starting the process" : serial ? "Waiting for the device" : "Waiting for a response")}</span>
            <span className="connection-elapsed" aria-label={`${elapsed}s elapsed`}>{String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}</span>
          </div>}
        </div>
      </div>
    </div>
  </section>;
}
