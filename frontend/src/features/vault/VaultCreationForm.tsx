import React, { useState } from "react";
import {
  LuCheck,
  LuEye,
  LuEyeOff,
  LuKeyRound,
  LuLoaderCircle,
  LuShieldAlert,
  LuX,
} from "react-icons/lu";
import type { VaultActionResult } from "../../state/store";
import {
  MIN_VAULT_MASTER_PASSWORD_LENGTH,
  validateNewVaultMasterPassword,
} from "./password";

interface VaultCreationFormProps {
  onCreate: (masterPassword: string) => Promise<VaultActionResult>;
}

const VaultCreationForm: React.FC<VaultCreationFormProps> = ({ onCreate }) => {
  const [masterPassword, setMasterPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordLongEnough = Array.from(masterPassword).length >= MIN_VAULT_MASTER_PASSWORD_LENGTH;
  const confirmationStarted = confirmation.length > 0;
  const passwordsMatch = confirmationStarted && masterPassword === confirmation;

  const submit = async () => {
    if (busy) return;

    const validationError = validateNewVaultMasterPassword(masterPassword, confirmation);
    if (validationError) {
      setError(validationError);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await onCreate(masterPassword);
      if (!result.ok) {
        setError(result.error || "Failed to create the Credential Vault.");
        return;
      }

      setMasterPassword("");
      setConfirmation("");
      setPasswordVisible(false);
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create the Credential Vault.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mt-4 border-t border-amber-200/[0.09] pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold text-gray-300">
            Master password
          </span>
          <span className="relative block">
            <LuKeyRound
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-600"
            />
            <input
              data-help-autofocus
              type={passwordVisible ? "text" : "password"}
              value={masterPassword}
              onChange={(event) => {
                setMasterPassword(event.target.value);
                if (error) setError(null);
              }}
              autoComplete="new-password"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "vault-create-error" : "vault-create-guidance"}
              placeholder={`At least ${MIN_VAULT_MASTER_PASSWORD_LENGTH} characters`}
              className="h-10 w-full select-text rounded-control border border-white/10 bg-black/25 pl-9 pr-10 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-amber-300/45 focus:ring-2 focus:ring-amber-300/10"
            />
            <button
              type="button"
              aria-label={passwordVisible ? "Hide master password" : "Show master password"}
              onClick={() => setPasswordVisible((visible) => !visible)}
              className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-white/[0.06] hover:text-gray-200"
            >
              {passwordVisible ? <LuEyeOff size={15} /> : <LuEye size={15} />}
            </button>
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold text-gray-300">
            Confirm master password
          </span>
          <input
            type={passwordVisible ? "text" : "password"}
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
              if (error) setError(null);
            }}
            autoComplete="new-password"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "vault-create-error" : "vault-create-guidance"}
            placeholder="Enter it again"
            className="h-10 w-full select-text rounded-control border border-white/10 bg-black/25 px-3 text-sm text-gray-100 outline-none transition-colors placeholder:text-gray-600 focus:border-amber-300/45 focus:ring-2 focus:ring-amber-300/10"
          />
        </label>
      </div>

      <div id="vault-create-guidance" className="mt-3 flex flex-wrap gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
            passwordLongEnough
              ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
              : "border-white/[0.08] bg-black/15 text-gray-500"
          }`}
        >
          <LuCheck size={12} />
          {MIN_VAULT_MASTER_PASSWORD_LENGTH}+ characters
        </span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
            passwordsMatch
              ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
              : confirmationStarted
                ? "border-red-300/20 bg-red-300/10 text-red-200"
                : "border-white/[0.08] bg-black/15 text-gray-500"
          }`}
        >
          {confirmationStarted && !passwordsMatch ? <LuX size={12} /> : <LuCheck size={12} />}
          {passwordsMatch ? "Passwords match" : confirmationStarted ? "Passwords do not match" : "Passwords match"}
        </span>
      </div>

      {error && (
        <div
          id="vault-create-error"
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-control border border-red-300/20 bg-red-400/10 px-3 py-2 text-xs leading-5 text-red-100"
        >
          <LuShieldAlert size={15} className="mt-0.5 shrink-0 text-red-300" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-xl text-[11px] leading-4 text-amber-100/65">
          Netrix cannot recover this password. A Vault reset keeps host profiles but permanently removes their saved secrets.
        </p>
        <button
          type="submit"
          disabled={busy || !masterPassword || !confirmation}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-control border border-amber-300/30 bg-amber-300/15 px-4 text-xs font-semibold text-amber-50 transition-colors hover:bg-amber-300/25 focus:outline-none focus:ring-2 focus:ring-amber-300/30 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? <LuLoaderCircle size={15} className="animate-spin" /> : <LuKeyRound size={15} />}
          {busy ? "Creating Vault..." : "Create & Unlock Vault"}
        </button>
      </div>
    </form>
  );
};

export default VaultCreationForm;
