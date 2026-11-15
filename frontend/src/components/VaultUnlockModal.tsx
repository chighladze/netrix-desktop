import React, { useEffect, useRef, useState } from "react";
import {
  IoEyeOffOutline,
  IoEyeOutline,
  IoKeyOutline,
  IoLockOpenOutline,
  IoWarningOutline,
} from "react-icons/io5";
import type { VaultActionResult } from "../state/store";

interface VaultUnlockModalProps {
  isOpen: boolean;
  linkedHosts: number;
  onClose: () => void;
  onUnlock: (masterPassword: string) => Promise<VaultActionResult>;
}

const VaultUnlockModal: React.FC<VaultUnlockModalProps> = ({
  isOpen,
  linkedHosts,
  onClose,
  onUnlock,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [masterPassword, setMasterPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setMasterPassword("");
      setPasswordVisible(false);
      setBusy(false);
      setError(null);
      return;
    }

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFrame = requestAnimationFrame(() => passwordInputRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

  const submitUnlock = async () => {
    if (!masterPassword || busy) return;

    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await onUnlock(masterPassword);
      if (!result.ok) {
        setError(result.error || "Invalid master password");
        return;
      }

      setMasterPassword("");
      setPasswordVisible(false);
      onClose();
    } catch (unlockError) {
      setError(
        unlockError instanceof Error
          ? unlockError.message
          : "Failed to unlock the Vault",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close Vault unlock dialog"
        onClick={() => {
          if (!busyRef.current) onClose();
        }}
        className="absolute inset-0 h-full w-full cursor-default bg-black/65 backdrop-blur-md"
      />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-unlock-title"
        aria-describedby="vault-unlock-description"
        className="ui-dialog relative w-full max-w-md rounded-dialog border border-amber-300/20 bg-[#101722]/98 shadow-[0_30px_100px_rgba(0,0,0,0.55)]"
      >
        <div className="border-b border-white/[0.07] px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-amber-300/20 bg-amber-300/10 text-amber-300">
              <IoKeyOutline size={20} />
            </div>
            <div className="min-w-0">
              <h2 id="vault-unlock-title" className="text-sm font-semibold text-gray-100">
                Unlock Credential Vault
              </h2>
              <p id="vault-unlock-description" className="mt-1 text-xs leading-5 text-gray-500">
                {linkedHosts > 0
                  ? `Unlock to use encrypted credentials for ${linkedHosts} saved host${linkedHosts === 1 ? "" : "s"}.`
                  : "Unlock to save and use stored passwords and private keys."}
              </p>
            </div>
          </div>
        </div>

        <form
          className="space-y-3 px-5 py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitUnlock();
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-gray-300">Master password</span>
            <span className="relative block">
              <input
                ref={passwordInputRef}
                type={passwordVisible ? "text" : "password"}
                value={masterPassword}
                onChange={(event) => {
                  setMasterPassword(event.target.value);
                  if (error) setError(null);
                }}
                autoComplete="current-password"
                spellCheck={false}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "vault-unlock-error" : undefined}
                className="h-10 w-full rounded-control border border-white/10 bg-black/30 px-3 pr-11 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-amber-300/50 focus:ring-1 focus:ring-amber-300/20"
                placeholder="Enter master password"
              />
              <button
                type="button"
                aria-label={passwordVisible ? "Hide password" : "Show password"}
                onClick={() => setPasswordVisible((visible) => !visible)}
                className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 hover:bg-white/[0.06] hover:text-gray-200"
              >
                {passwordVisible ? <IoEyeOffOutline size={16} /> : <IoEyeOutline size={16} />}
              </button>
            </span>
          </label>

          {error && (
            <div
              id="vault-unlock-error"
              role="alert"
              className="flex items-start gap-2 rounded-control border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs text-red-200"
            >
              <IoWarningOutline size={15} className="mt-0.5 shrink-0 text-red-300" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-10 flex-1 rounded-control border border-white/10 text-xs font-semibold text-gray-400 transition-colors hover:bg-white/[0.05] hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !masterPassword}
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-control border border-amber-300/25 bg-amber-300/10 text-xs font-semibold text-amber-100 transition-colors hover:bg-amber-300/20 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <IoLockOpenOutline size={16} />
              {busy ? "Unlocking..." : "Unlock Vault"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default VaultUnlockModal;
