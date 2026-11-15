import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import React, { useState } from "react";
import { IoAlertCircleOutline } from "react-icons/io5";
import type { BackendStatus } from "../../api";

export default function BackendFailurePanel({ failure }: { failure: BackendStatus }) {
  const [copyStatus, setCopyStatus] = useState("");
  const message = failure.diagnostic?.message || failure.message || "The local Netrix service is unavailable.";
  const recovery = failure.diagnostic?.recovery || "Close all Netrix windows and open Netrix again. If the problem continues, copy the diagnostic details and review the local log.";
  const details = [
    failure.diagnostic?.details || message,
    failure.log_path ? `Local log: ${failure.log_path}` : "Local log location is unavailable.",
  ].join("\n");

  const copy = async () => {
    try {
      await writeText(`${message}\n\n${recovery}\n\n${details}`);
      setCopyStatus("Diagnostic details copied.");
    } catch {
      setCopyStatus("Could not copy. Select the diagnostic details below to copy them manually.");
    }
  };

  return <>
    <div role="alert" className="workspace-lock-alert" data-tone="warning">
      <IoAlertCircleOutline size={17} aria-hidden="true" /><span>{message}</span>
    </div>
    <p className="workspace-backend-recovery">{recovery}</p>
    <details className="workspace-backend-details">
      <summary>Diagnostic details</summary>
      <pre>{details}</pre>
    </details>
    <button type="button" className="workspace-lock-secondary" onClick={() => { void copy(); }}>Copy diagnostic details</button>
    {copyStatus && <p role="status" className="workspace-backend-copy-status">{copyStatus}</p>}
  </>;
}
