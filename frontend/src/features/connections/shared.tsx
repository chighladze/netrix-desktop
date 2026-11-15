import React, { useState } from "react";
import { useAppStore } from "../../state/store";
export const input =
  "ui-input";
export const button =
  "ui-button";
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col min-w-0 gap-1.5 text-xs text-slate-300">
      {label}
      {children}
    </label>
  );
}
export function useTask() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const run = async (action: () => Promise<void>, success = "") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    run,
    feedback: (
      <>
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-red-400/20 bg-red-400/10 p-3 text-sm text-red-200"
          >
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm text-emerald-300">
            {message}
          </p>
        )}
      </>
    ),
  };
}
export async function refreshHosts() {
  await useAppStore.getState().fetchHosts();
  await useAppStore.getState().refreshVaultStatus();
}
