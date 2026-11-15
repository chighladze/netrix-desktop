import { buildHostPatch } from "../features/hosts/api";
import { normalizeGroupPath, isValidGroupPath } from "../utils/groupUtils";
import { Dialog, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
    IoAdd,
    IoChevronDown,
    IoClose,
    IoFlash,
    IoHardwareChip,
    IoEyeOutline,
    IoEyeOffOutline,
    IoFolderOpenOutline,
    IoLockClosedOutline,
    IoRefresh,
    IoTerminal,
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { ApiError } from "../api";
import { validateNewVaultMasterPassword } from "../features/vault/password";
import { useAppStore } from "../state/store";
import { getTerminalSurface, getTerminalTheme, getThemeColors, getThemesList, normalizeTerminalColor } from "../themes";
import type { TerminalAppearance } from "../types/terminalAppearance";
import { appearanceErrors, sanitizeAppearancePreset, sanitizeTerminalAppearance } from "../terminal/appearance";
import { terminalRuntimeOptions } from "../features/settings/terminalOptions";
import TerminalAppearanceEditor from "../features/hosts/TerminalAppearanceEditor";
import TerminalColorControl from "../features/hosts/TerminalColorControl";
import "../features/hosts/hostForm.css";
import type {
  ConnectionType,
  HostMutation,
  QuickConnectRequest,
  SavedHostDto,
} from "../types/host";

interface HostFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  onQuickConnect?: (host: QuickConnectRequest) => void;
  hostToEdit?: SavedHostDto | null;
  apiBase: string;
  intent?: "save" | "quick";
  initialGroup?: string;
}

type HostMutationTarget =
  | { operation: "create" }
  | { operation: "update"; hostId: number };

interface HostSubmission {
  payload: HostMutation;
  initialHost?: SavedHostDto;
  target: HostMutationTarget;
  contextKey: string;
}

interface PendingHostSubmission extends HostSubmission {
  requestId: number;
}

function getMutationTarget(host: SavedHostDto | null | undefined): HostMutationTarget {
  if (host && typeof host.id === "number" && host.id !== -1) {
    return { operation: "update", hostId: host.id };
  }
  return { operation: "create" };
}

function getMutationContextKey(target: HostMutationTarget): string {
  return target.operation === "update" ? `update:${target.hostId}` : "create";
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const CONNECTION_TYPES: {
  value: ConnectionType;
  label: string;
  defaultPort: number;
  description: string;
}[] = [
  { value: "ssh", label: "SSH", defaultPort: 22, description: "Encrypted connection to a remote host." },
  { value: "telnet", label: "Telnet", defaultPort: 23, description: "Remote terminal over an unencrypted connection." },
  { value: "serial", label: "Serial", defaultPort: 0, description: "Direct connection to a serial device." },
  { value: "local", label: "Local shell", defaultPort: 0, description: "Runs on this computer. No remote credentials needed." },
];

const SERIAL_SPEEDS = [9600, 19200, 38400, 57600, 115200];
const PASSPHRASE_KEY_ERROR = "Load or paste the private key for this passphrase.";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{}<>.?";

function generateSecurePassword(length: number, withSymbols: boolean): string {
  const targetLength = Math.max(8, Math.min(64, Math.floor(length || 20)));
  const groups = [LOWER, UPPER, DIGITS, ...(withSymbols ? [SYMBOLS] : [])];
  const pool = groups.join("");

  const pick = (charset: string) => {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    return charset[r[0] % charset.length];
  };

  const chars: string[] = [];
  groups.forEach((g) => chars.push(pick(g)));
  while (chars.length < targetLength) chars.push(pick(pool));

  for (let i = chars.length - 1; i > 0; i--) {
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    const j = r[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

const HostFormModal: React.FC<HostFormModalProps> = ({
  isOpen,
  onClose,
  onSave,
  onQuickConnect,
  hostToEdit,
  apiBase,
  intent = "save",
  initialGroup = "Default",
}) => {
  const {
    hosts,
    settings,
    definedGroups,
    unlockVault,
    isVaultUnlocked,
    vaultInitialized,
    vaultStatusLoaded,
    hasStoredVaultPassword,
    getStoredVaultPassword,
    refreshStoredVaultPasswordState,
  } = useAppStore(
    useShallow((state) => ({
      hosts: state.hosts,
      settings: state.settings,
      definedGroups: state.definedGroups,
      unlockVault: state.unlockVault,
      isVaultUnlocked: state.isVaultUnlocked,
      vaultInitialized: state.vaultInitialized,
      vaultStatusLoaded: state.vaultStatusLoaded,
      hasStoredVaultPassword: state.hasStoredVaultPassword,
      getStoredVaultPassword: state.getStoredVaultPassword,
      refreshStoredVaultPasswordState: state.refreshStoredVaultPasswordState,
    })),
  );
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState(settings.connection.defaultSSHPort);
  const networkPorts = useRef({ ssh: settings.connection.defaultSSHPort, telnet: settings.connection.defaultTelnetPort });
  const [username, setUsername] = useState("");
  const [connectionType, setConnectionType] = useState<ConnectionType>("ssh");
  const [serialPort, setSerialPort] = useState("COM1");
  const [serialSpeed, setSerialSpeed] = useState(9600);
  const [localCommand, setLocalCommand] = useState("");
  const [localArgs, setLocalArgs] = useState("");
  const [localCwd, setLocalCwd] = useState("");
  const [group, setGroup] = useState("Default");
  const [newGroupName, setNewGroupName] = useState("");
  const [isAddingNewGroup, setIsAddingNewGroup] = useState(false);
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const vaultInputRef = useRef<HTMLInputElement>(null);
  const keyReadVersionRef = useRef(0);
  const [keyReading, setKeyReading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [keyFileName, setKeyFileName] = useState("");
  const [generatorNotice, setGeneratorNotice] = useState("");
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [isPasswordAuth, setIsPasswordAuth] = useState(true);
  const [passwordLength, setPasswordLength] = useState(20);
  const [includeSymbols, setIncludeSymbols] = useState(true);
  const [clearStoredCredential, setClearStoredCredential] = useState(false);
  const [vaultPrompt, setVaultPrompt] = useState(false);
  const [vaultPassword, setVaultPassword] = useState("");
  const [vaultPasswordConfirmation, setVaultPasswordConfirmation] = useState("");
  const [vaultUnlocking, setVaultUnlocking] = useState(false);
  const pendingSubmissionRef = useRef<PendingHostSubmission | null>(null);
  const pendingRequestIdRef = useRef(0);
  const activeFormContextRef = useRef<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState(settings.terminal.theme);
  const [terminalBackground, setTerminalBackground] = useState("");
  const [terminalForeground, setTerminalForeground] = useState("");
  const [terminalAppearance, setTerminalAppearance] = useState<TerminalAppearance>({});
  const [appearanceNotice, setAppearanceNotice] = useState("");
  const [terminalFontSize, setTerminalFontSize] = useState(
    settings.terminal.fontSize,
  );

  const mutationTarget = getMutationTarget(hostToEdit);
  const formContextKey = getMutationContextKey(mutationTarget);
  activeFormContextRef.current = isOpen ? formContextKey : null;

  // Extract unique groups from existing hosts and explicitly defined empty groups
  const existingGroups = Array.from(
    new Set([
      "Default",
      normalizeGroupPath(group),
      ...hosts.map((h) => normalizeGroupPath(h.group)),
      ...Array.from(definedGroups || []).map(normalizeGroupPath),
    ]),
  ).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const hasExistingCredential = Boolean(
    hostToEdit &&
      hostToEdit.id !== -1 &&
      (hostToEdit.credential_id || hostToEdit.has_password || hostToEdit.has_private_key),
  );
  const protocolChanged = Boolean(hostToEdit && hostToEdit.connection_type !== connectionType);
  const canKeepCredential = hasExistingCredential && !protocolChanged;

  const clearPendingVaultState = useCallback(() => {
    pendingSubmissionRef.current = null;
    setVaultPrompt(false);
    setVaultPassword("");
    setVaultPasswordConfirmation("");
    setVaultUnlocking(false);
  }, []);

  const clearCredentialState = useCallback(() => {
    clearPendingVaultState();
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setClearStoredCredential(false);
  }, [clearPendingVaultState]);

  const resetForm = useCallback(() => {
    setName("");
    setHostname("");
    setPort(settings.connection.defaultSSHPort);
    networkPorts.current = { ssh: settings.connection.defaultSSHPort, telnet: settings.connection.defaultTelnetPort };
    setUsername("");
    setConnectionType("ssh");
    setSerialPort("COM1");
    setSerialSpeed(9600);
    setLocalCommand("");
    setLocalArgs("");
    setLocalCwd("");
    setGroup(initialGroup);
    setNewGroupName("");
    setIsAddingNewGroup(false);
    setShowPassword(false);
    setShowPassphrase(false);
    setAppearanceOpen(false);
    setFieldErrors({});
    setGeneratorNotice("");
    setKeyFileName("");
    setKeyReading(false);
    keyReadVersionRef.current += 1;
    setIsPasswordAuth(true);
    setPasswordLength(20);
    setIncludeSymbols(true);
    setError(null);
    setLoading(false);
    clearCredentialState();
    const remembered = useAppStore.getState().settings.terminal.newHostAppearance;
    setTerminalTheme(remembered?.terminal_theme || settings.terminal.theme);
    setTerminalBackground(remembered?.terminal_background || "");
    setTerminalForeground(remembered?.terminal_foreground || "");
    setTerminalFontSize(remembered?.terminal_font_size || settings.terminal.fontSize);
    setTerminalAppearance(remembered?.terminal_appearance || {});
    setAppearanceNotice("");
  }, [
    clearCredentialState,
    initialGroup,
    settings.connection.defaultSSHPort,
    settings.connection.defaultTelnetPort,
    settings.terminal.fontSize,
    settings.terminal.theme,
  ]);

  useEffect(() => {
    if (isOpen) {
      void refreshStoredVaultPasswordState();
    }
  }, [isOpen, refreshStoredVaultPasswordState]);

  useEffect(() => {
    // Opening, closing, or switching the target always starts with a clean
    // credential context. Non-secret edit fields are then populated afresh.
    resetForm();
    if (!isOpen) return;

    if (hostToEdit) {
      setName(hostToEdit.name);
      setHostname(hostToEdit.hostname);
      setPort(hostToEdit.port);
      if (hostToEdit.connection_type === "ssh" || hostToEdit.connection_type === "telnet") {
        networkPorts.current[hostToEdit.connection_type] = hostToEdit.port;
      }
      setUsername(hostToEdit.username ?? "");
      setConnectionType(hostToEdit.connection_type || "ssh");
      setIsPasswordAuth(!hostToEdit.has_private_key);
      setSerialPort(hostToEdit.serial_port || "COM1");
      setSerialSpeed(hostToEdit.serial_speed || 9600);
      setLocalCommand(hostToEdit.local_command || "");
      setLocalArgs(
        Array.isArray(hostToEdit.local_args)
          ? hostToEdit.local_args.join("\n")
          : "",
      );
      setLocalCwd(hostToEdit.local_cwd || "");
      setGroup(normalizeGroupPath(hostToEdit.group));
      setIsAddingNewGroup(false);

      setTerminalTheme(hostToEdit.terminal_theme || settings.terminal.theme);
      setTerminalBackground(hostToEdit.terminal_background || "");
      setTerminalForeground(hostToEdit.terminal_foreground || "");
      setTerminalAppearance(hostToEdit.terminal_appearance || {});
      setTerminalFontSize(
        hostToEdit.terminal_font_size || settings.terminal.fontSize,
      );
    }
  }, [hostToEdit, isOpen, resetForm]);

  useEffect(() => { setAppearanceNotice(""); }, [terminalTheme, terminalFontSize, terminalBackground, terminalForeground, terminalAppearance]);

  useEffect(() => {
    return () => {
      pendingSubmissionRef.current = null;
      activeFormContextRef.current = null;
      keyReadVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (vaultPrompt) vaultInputRef.current?.focus();
  }, [vaultPrompt]);

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleConnectionTypeChange = (type: ConnectionType) => {
    if (type === connectionType) return;
    if (connectionType === "ssh" || connectionType === "telnet") networkPorts.current[connectionType] = port;
    clearCredentialState();
    keyReadVersionRef.current += 1;
    setKeyReading(false);
    setKeyFileName("");
    setGeneratorNotice("");
    setShowPassword(false);
    setShowPassphrase(false);
    setFieldErrors({});
    setError(null);
    setConnectionType(type);
    if (type === "ssh" || type === "telnet") setPort(networkPorts.current[type]);
    formRef.current?.querySelector(".host-form-scroll")?.scrollTo?.({ top: 0 });
  };

  const clearFieldError = (field: string) => {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const validateForm = (forSave: boolean) => {
    const errors: Record<string, string> = {};
    if (connectionType === "ssh" || connectionType === "telnet") {
      if (!hostname.trim()) errors.hostname = "Enter a hostname or IP address.";
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.port = "Use a port from 1 to 65535.";
      }
    } else if (connectionType === "serial") {
      if (!serialPort.trim()) errors.serialPort = "Enter a serial device.";
      if (!Number.isInteger(serialSpeed) || serialSpeed < 1 || serialSpeed > 4294967295) {
        errors.serialSpeed = "Choose a valid baud rate.";
      }
    }
    if (connectionType === "ssh" && !isPasswordAuth && !clearStoredCredential && fieldErrors.privateKey) {
      errors.privateKey = fieldErrors.privateKey;
    }
    if (connectionType === "ssh" && !isPasswordAuth && !clearStoredCredential && passphrase && !privateKey.trim() && !errors.privateKey) {
      errors.privateKey = PASSPHRASE_KEY_ERROR;
    }
    if (forSave) {
      const path = normalizeGroupPath(isAddingNewGroup ? newGroupName : group);
      if (isAddingNewGroup && !path) errors.group = "Enter a name for the new folder.";
      else if (path && !isValidGroupPath(path)) {
        errors.group = "Use up to 100 characters and 16 levels; avoid control characters and . or .. segments.";
      }
    }
    if (!Number.isInteger(terminalFontSize) || terminalFontSize < 6 || terminalFontSize > 72) {
      errors.terminalFontSize = "Use a whole number from 6 to 72.";
      setAppearanceOpen(true);
    }
    for (const [field, color] of [["terminalBackground", terminalBackground], ["terminalForeground", terminalForeground]]) {
      if (color && !normalizeTerminalColor(color)) {
        errors[field] = "Enter a hex color, e.g. #8ce5bb.";
        setAppearanceOpen(true);
      }
    }
    const formattingErrors = appearanceErrors(terminalAppearance);
    if (Object.keys(formattingErrors).length) { Object.assign(errors, formattingErrors); setAppearanceOpen(true); }
    setFieldErrors(errors);
    const first = Object.keys(errors)[0];
    if (first) {
      requestAnimationFrame(() => {
        const control = formRef.current?.elements.namedItem(first);
        if (control instanceof HTMLElement) control.focus();
      });
    }
    return !first;
  };

  const changeAuthMethod = (passwordAuth: boolean) => {
    setIsPasswordAuth(passwordAuth);
    keyReadVersionRef.current += 1;
    setKeyReading(false);
    setShowPassword(false);
    setShowPassphrase(false);
    clearFieldError("privateKey");
  };

  const loadKeyFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const version = ++keyReadVersionRef.current;
    if (file.size > 1024 * 1024) {
      setKeyReading(false);
      setFieldErrors((current) => ({ ...current, privateKey: "Choose a key file smaller than 1 MB." }));
      return;
    }
    setKeyReading(true);
    clearFieldError("privateKey");
    try {
      const contents = await file.text();
      if (version !== keyReadVersionRef.current) return;
      if (!contents.trim()) throw new Error("The selected key file is empty.");
      setPrivateKey(contents);
      setKeyFileName(file.name);
    } catch (reason: unknown) {
      if (version === keyReadVersionRef.current) {
        setFieldErrors((current) => ({ ...current, privateKey: getErrorMessage(reason, "Could not read the key file.") }));
      }
    } finally {
      if (version === keyReadVersionRef.current) setKeyReading(false);
    }
  };

  const sendSubmission = async ({ payload, target, initialHost }: HostSubmission) => {
    const state = useAppStore.getState();
    const saved = target.operation === "update" && initialHost
      ? await state.patchHost(target.hostId, buildHostPatch(initialHost, payload))
      : await state.createHost(payload);
    // Remember only after persistence succeeds, including vault-gated saves.
    state.updateSettings("terminal", { newHostAppearance: sanitizeAppearancePreset(payload) });
    return saved;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || vaultUnlocking || vaultPrompt || keyReading || !validateForm(true)) return;
    // A fresh submit always supersedes any earlier vault-gated operation.
    clearPendingVaultState();
    setError(null);
    setLoading(true);

    if (!apiBase) {
      setError("API not ready. Please wait...");
      setLoading(false);
      return;
    }

    const finalGroup = normalizeGroupPath(isAddingNewGroup ? newGroupName : group);

    const isLocal = connectionType === "local";
    const parsedLocalArgs = localArgs === "" ? [] : localArgs.split(/\r?\n/);
    const preserveLocalArgs = isLocal && hostToEdit?.connection_type === "local"
      && localArgs === (hostToEdit.local_args ?? []).join("\n");

    const payload: HostMutation = {
      name: name.trim() || (isLocal ? "Local Shell" : connectionType === "serial" ? serialPort.trim() : hostname.trim()),
      hostname: connectionType === "serial" || isLocal ? "localhost" : hostname.trim(),
      port: connectionType === "serial" || isLocal ? 0 : port,
      username: isLocal ? "local" : connectionType === "serial" ? "" : (mutationTarget.operation === "create" ? (username || "user") : username),
      connection_type: connectionType,
      serial_port: connectionType === "serial" ? serialPort.trim() : null,
      serial_speed: connectionType === "serial" ? serialSpeed : null,
      local_command: isLocal ? (localCommand || null) : null,
      local_args: isLocal ? (preserveLocalArgs ? hostToEdit?.local_args ?? null : parsedLocalArgs) : null,
      local_cwd: isLocal ? (localCwd || null) : null,
      group: finalGroup,

      terminal_theme: terminalTheme,
      terminal_font_size: terminalFontSize,
      terminal_background: normalizeTerminalColor(terminalBackground),
      terminal_foreground: normalizeTerminalColor(terminalForeground),
      terminal_appearance: sanitizeTerminalAppearance(terminalAppearance),
    };

    if (connectionType === "ssh") {
      if (clearStoredCredential) {
        payload.clear_credentials = true;
      } else if (isPasswordAuth && password) {
        payload.password = password;
      } else if (!isPasswordAuth && privateKey) {
        payload.private_key = privateKey;
        if (passphrase) {
          payload.passphrase = passphrase;
        }
      }
    } else if (connectionType === "telnet" && password && !clearStoredCredential) {
      payload.password = password;
    } else if (clearStoredCredential) {
      payload.clear_credentials = true;
    }
    // Saved authentication must not silently follow a different transport.
    if (hasExistingCredential && protocolChanged && !payload.password && !payload.private_key) payload.clear_credentials = true;

    const submission: HostSubmission = {
      payload,
      initialHost: hostToEdit ? { ...hostToEdit, terminal_theme: hostToEdit.terminal_theme || settings.terminal.theme, terminal_font_size: hostToEdit.terminal_font_size || settings.terminal.fontSize } : undefined,
      target: mutationTarget,
      contextKey: formContextKey,
    };
    const wantsCredentialStorage = Boolean(payload.password || payload.private_key);

    if (wantsCredentialStorage && !isVaultUnlocked) {
      if (!vaultStatusLoaded) {
        setLoading(false);
        setError("Vault status is unavailable. Wait a moment and try saving again.");
        return;
      }

      const requestId = ++pendingRequestIdRef.current;
      pendingSubmissionRef.current = { ...submission, requestId };
      setVaultPrompt(true);
      setLoading(false);
      return;
    }

    try {
      await sendSubmission(submission);

      onSave();
      if (activeFormContextRef.current === submission.contextKey) {
        handleClose();
      }
    } catch (err: unknown) {
      if (activeFormContextRef.current === submission.contextKey) {
        if (
          err instanceof ApiError
          && err.status === 401
          && err.message.includes("Vault must be unlocked")
        ) {
          const requestId = ++pendingRequestIdRef.current;
          pendingSubmissionRef.current = { ...submission, requestId };
          setVaultPrompt(true);
        }
        setError(getErrorMessage(err, "Failed to save host"));
      }
    } finally {
      if (activeFormContextRef.current === submission.contextKey) {
        setLoading(false);
      }
    }
  };

  const submitPendingSubmission = async (requestId: number) => {
    const pending = pendingSubmissionRef.current;
    if (!pending || pending.requestId !== requestId) return;

    if (activeFormContextRef.current !== pending.contextKey) {
      clearPendingVaultState();
      return;
    }

    // Consume the exact queued operation before issuing the request. A retry
    // must be created from the currently visible form, never from a stale ref.
    pendingSubmissionRef.current = null;
    setVaultPrompt(false);
    setVaultPassword("");
    setLoading(true);

    try {
      await sendSubmission(pending);

      onSave();
      if (activeFormContextRef.current === pending.contextKey) {
        handleClose();
      }
    } catch (err: unknown) {
      if (activeFormContextRef.current === pending.contextKey) {
        setError(getErrorMessage(err, "Failed to save host"));
      }
    } finally {
      if (activeFormContextRef.current === pending.contextKey) {
        setLoading(false);
      }
    }
  };

  const handleVaultUnlock = async () => {
    const pending = pendingSubmissionRef.current;
    if (!vaultPassword || !pending || vaultUnlocking) return;

    if (!vaultInitialized) {
      const validationError = validateNewVaultMasterPassword(
        vaultPassword,
        vaultPasswordConfirmation,
      );
      if (validationError) {
        setError(validationError);
        return;
      }
    }

    const submittedPassword = vaultPassword;
    setVaultPassword("");
    setVaultPasswordConfirmation("");
    setVaultUnlocking(true);
    const result = await unlockVault(submittedPassword);
    setVaultUnlocking(false);

    if (pendingSubmissionRef.current?.requestId !== pending.requestId) return;
    if (!result.ok) {
      clearPendingVaultState();
      setError(result.error || "Invalid master password");
      return;
    }
    await submitPendingSubmission(pending.requestId);
  };

  const handleVaultUnlockWithSavedPassword = async () => {
    const pending = pendingSubmissionRef.current;
    if (!pending || vaultUnlocking) return;

    setVaultUnlocking(true);
    try {
      const storedPassword = await getStoredVaultPassword();
      if (!storedPassword) {
        clearPendingVaultState();
        setError("No saved vault password found");
        await refreshStoredVaultPasswordState();
        return;
      }

      const result = await unlockVault(storedPassword);
      if (pendingSubmissionRef.current?.requestId !== pending.requestId) return;
      if (!result.ok) {
        clearPendingVaultState();
        setError(result.error || "Saved vault password is no longer valid");
        return;
      }

      await submitPendingSubmission(pending.requestId);
    } catch (err: unknown) {
      if (pendingSubmissionRef.current?.requestId === pending.requestId) {
        clearPendingVaultState();
        setError(getErrorMessage(err, "Failed to use the saved vault password"));
      }
    } finally {
      setVaultUnlocking(false);
    }
  };

  const handleQuickConnect = () => {
    if (loading || vaultUnlocking || vaultPrompt || keyReading || !onQuickConnect || !validateForm(false)) return;
    setError(null);

    const isLocal = connectionType === "local";
    const parsedLocalArgs = isLocal ? (localArgs === "" ? [] : localArgs.split(/\r?\n/)) : undefined;

    const finalGroup = normalizeGroupPath(isAddingNewGroup ? newGroupName : group);
    const tempHost: QuickConnectRequest = {
      name: name.trim() || (isLocal ? "Local Shell" : connectionType === "serial" ? serialPort.trim() : hostname.trim()),
      hostname: connectionType === "serial" || isLocal ? "localhost" : hostname.trim(),
      port: connectionType === "serial" || isLocal ? 0 : port,
      username: isLocal ? "local" : connectionType === "serial" ? "" : (username || "user"),
      connection_type: connectionType,
      serial_port: connectionType === "serial" ? serialPort.trim() : undefined,
      serial_speed: connectionType === "serial" ? serialSpeed : undefined,
      local_command: isLocal ? (localCommand || null) : undefined,
      local_args: isLocal ? (parsedLocalArgs || null) : undefined,
      local_cwd: isLocal ? (localCwd || null) : undefined,
      group: finalGroup || "Default",
      terminal_theme: terminalTheme,
      terminal_font_size: terminalFontSize,
      terminal_background: normalizeTerminalColor(terminalBackground),
      terminal_foreground: normalizeTerminalColor(terminalForeground),
      terminal_appearance: sanitizeTerminalAppearance(terminalAppearance),
    };

    if (!clearStoredCredential) {
      if (connectionType === "telnet" || (connectionType === "ssh" && isPasswordAuth)) {
        if (password) tempHost.password = password;
      } else if (connectionType === "ssh" && privateKey) {
        tempHost.private_key = privateKey;
        if (passphrase) tempHost.passphrase = passphrase;
      }
    }

    if (onQuickConnect) {
      onQuickConnect(tempHost);
      handleClose();
    }
  };

  if (!isOpen) return null;

  const applyGeneratedPassword = () => {
    try {
      const generated = generateSecurePassword(passwordLength, includeSymbols);
      setPassword(generated);
      setPasswordLength(generated.length);
      setIsPasswordAuth(true);
      setGeneratorNotice(`Generated a ${generated.length}-character password.`);
      setError(null);
    } catch {
      setError("Failed to generate password");
    }
  };

  const isSerial = connectionType === "serial";
  const isLocal = connectionType === "local";
  const isNetwork = !isSerial && !isLocal;
  const busy = loading || vaultUnlocking;
  const canQuickConnect = Boolean(onQuickConnect && !hostToEdit);
  const quickIsPrimary = intent === "quick" && canQuickConnect;
  const theme = getTerminalTheme(terminalTheme);
  const previewColors = getThemeColors(terminalTheme, {
    terminal_background: terminalBackground,
    terminal_foreground: terminalForeground,
    terminal_appearance: terminalAppearance,
  });
  const previewOptions = terminalRuntimeOptions(settings, sanitizeTerminalAppearance(terminalAppearance));
  const saveAppearanceDefault = () => {
    const errors = appearanceErrors(terminalAppearance);
    if (!Number.isInteger(terminalFontSize) || terminalFontSize < 6 || terminalFontSize > 72) errors.terminalFontSize = "Use a whole number from 6 to 72.";
    for (const [key, color] of [["terminalBackground", terminalBackground], ["terminalForeground", terminalForeground]]) {
      if (color && !normalizeTerminalColor(color)) errors[key] = "Enter a hex color, e.g. #8ce5bb.";
    }
    setFieldErrors(current => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("appearance_") && !key.startsWith("terminal"))), ...errors }));
    if (Object.keys(errors).length) return;
    const saved = useAppStore.getState().updateSettings("terminal", { newHostAppearance: sanitizeAppearancePreset({
      terminal_theme: terminalTheme, terminal_font_size: terminalFontSize, terminal_background: terminalBackground,
      terminal_foreground: terminalForeground, terminal_appearance: terminalAppearance,
    }) });
    if (saved) setAppearanceNotice("Saved for new connections.");
  };
  const field = (key: string, hint?: string) => ({
    id: `${formId}-${key}`,
    name: key,
    "aria-invalid": Boolean(fieldErrors[key]),
    "aria-describedby": [hint && `${formId}-${hint}`, fieldErrors[key] && `${formId}-${key}-error`].filter(Boolean).join(" ") || undefined,
  });
  const fieldError = (key: string) => fieldErrors[key] ? (
    <p id={`${formId}-${key}-error`} className="host-form-field-error" role="alert">{fieldErrors[key]}</p>
  ) : null;
  const requestClose = () => { if (!busy) handleClose(); };
  const connectButton = canQuickConnect && (
    <button
      type={quickIsPrimary ? "submit" : "button"}
      name="quick-connect"
      disabled={busy || vaultPrompt || keyReading}
      onClick={quickIsPrimary ? undefined : handleQuickConnect}
      className={`host-form-button ${quickIsPrimary ? "host-form-button-primary" : ""}`}
    >
      <IoFlash aria-hidden="true" size={14} /> Connect only
    </button>
  );
  const saveButton = (
    <button
      type={quickIsPrimary ? "button" : "submit"}
      name="save-host"
      onClick={quickIsPrimary ? (event) => void handleSubmit(event) : undefined}
      disabled={busy || vaultPrompt || keyReading}
      className={`host-form-button ${!quickIsPrimary ? "host-form-button-primary" : ""}`}
    >
      {loading ? "Saving…" : hostToEdit ? "Save changes" : "Save host"}
    </button>
  );

  return (
    <Dialog open onClose={requestClose} className="host-form-dialog">
      <div className="host-form-backdrop" aria-hidden="true" />
      <div className="host-form-position">
        <DialogPanel className="host-form-panel" data-protocol={connectionType}>
          <header className="host-form-header">
            <span className="host-form-mark" aria-hidden="true"><IoTerminal size={21} /></span>
            <div>
              <DialogTitle>{hostToEdit ? "Edit connection" : intent === "quick" ? "Quick connect" : "New connection"}</DialogTitle>
            </div>
            <button type="button" onClick={requestClose} disabled={busy} aria-label="Close connection form" className="host-form-icon-button">
              <IoClose size={20} />
            </button>
          </header>

          <form ref={formRef} noValidate className="host-form" onSubmit={(event) => {
            const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            if (quickIsPrimary && submitter?.name !== "save-host") { event.preventDefault(); handleQuickConnect(); }
            else void handleSubmit(event);
          }}>
            <fieldset className="host-form-protocols" disabled={busy || vaultPrompt}>
              <legend className="host-form-sr-only">Connection type</legend>
              <div className="host-form-protocol-options">
                {CONNECTION_TYPES.map((type) => (
                  <label key={type.value}>
                    <input type="radio" name="connectionType" value={type.value} checked={connectionType === type.value}
                      onChange={() => handleConnectionTypeChange(type.value)} />
                    <span>
                      {type.value === "serial" ? <IoHardwareChip aria-hidden="true" size={17} />
                        : type.value === "ssh" ? <IoLockClosedOutline aria-hidden="true" size={17} />
                          : <IoTerminal aria-hidden="true" size={17} />}
                      {type.label}
                    </span>
                  </label>
                ))}
              </div>
              <Description className="host-form-hint">{CONNECTION_TYPES.find((type) => type.value === connectionType)?.description}</Description>
            </fieldset>
            <div className="host-form-scroll">
              {error && !vaultPrompt && <div className="host-form-alert" role="alert">{error}</div>}
              {vaultPrompt && (
                <section className="host-form-vault" aria-label="Credential vault">
                  <h3><IoLockClosedOutline aria-hidden="true" /> {vaultInitialized ? "Unlock your vault to save" : "Create your credential vault"}</h3>
                  <p>{vaultInitialized
                    ? "Your password or key will be stored in the encrypted vault."
                    : "Choose a master password for your encrypted credentials. Netrix cannot recover this password."}</p>
                  {error && <p role="alert">{error}</p>}
                  <div className="host-form-row">
                    <div className="host-form-field">
                      <label htmlFor={`${formId}-vault`}>{vaultInitialized ? "Master password" : "New master password"}</label>
                      <input ref={vaultInputRef} id={`${formId}-vault`} type="password" disabled={busy}
                        placeholder={vaultInitialized ? "Master password" : "New master password"} value={vaultPassword}
                        onChange={(event) => setVaultPassword(event.target.value)}
                        autoComplete={vaultInitialized ? "current-password" : "new-password"}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void handleVaultUnlock(); } }} />
                    </div>
                    {!vaultInitialized && (
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-vault-confirm`}>Confirm master password</label>
                        <input id={`${formId}-vault-confirm`} type="password" disabled={busy} placeholder="Confirm master password"
                          value={vaultPasswordConfirmation} onChange={(event) => setVaultPasswordConfirmation(event.target.value)}
                          autoComplete="new-password"
                          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void handleVaultUnlock(); } }} />
                      </div>
                    )}
                  </div>

                </section>
              )}

              <fieldset className="host-form-fields" hidden={vaultPrompt} disabled={busy || vaultPrompt}>
                {hostToEdit?.jump_host_id != null && (
                  <p role="status" className="host-form-alert host-form-alert-warning">
                    This profile requires a jump host. Jump host connections are not supported yet;
                    new terminal, SFTP, snippet and tunnel connections are blocked. Editing this
                    profile preserves its jump host setting.
                  </p>
                )}

                {hasExistingCredential && protocolChanged && <p role="status" className="host-form-credential-note">
                  Saved authentication belongs to the original protocol. Its credential link will be removed when saving this protocol; enter new credentials if needed.
                </p>}
                <section className="host-form-section" aria-label="Destination">
                  {isLocal ? (
                    <>
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-command`}>Command <span>optional</span></label>
                        <input id={`${formId}-command`} name="localCommand" data-autofocus value={localCommand}
                          onChange={(event) => setLocalCommand(event.target.value)} placeholder="Default system shell" autoComplete="off" spellCheck={false} />
                      </div>
                      <div className="host-form-row">
                        <div className="host-form-field">
                          <label htmlFor={`${formId}-args`}>Arguments <span>one per line</span></label>
                          <textarea id={`${formId}-args`} name="localArgs" rows={3} value={localArgs}
                            onChange={(event) => setLocalArgs(event.target.value)} placeholder={'--login\n--interactive'}
                            aria-describedby={`${formId}-args-hint`} spellCheck={false} />
                          <p id={`${formId}-args-hint`} className="host-form-hint">Each line is one argument, including spaces.</p>
                        </div>
                        <div className="host-form-field">
                          <label htmlFor={`${formId}-cwd`}>Working directory <span>optional</span></label>
                          <input id={`${formId}-cwd`} name="localCwd" value={localCwd} onChange={(event) => setLocalCwd(event.target.value)}
                            placeholder="Default home directory" autoComplete="off" spellCheck={false} />
                        </div>
                      </div>
                    </>
                  ) : isSerial ? (
                    <div className="host-form-row host-form-endpoint">
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-serialPort`}>Serial device</label>
                        <input {...field("serialPort")} data-autofocus value={serialPort}
                          onChange={(event) => { setSerialPort(event.target.value); clearFieldError("serialPort"); }}
                          placeholder="COM1 or /dev/ttyUSB0" autoComplete="off" spellCheck={false} />
                        {fieldError("serialPort")}
                      </div>
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-serialSpeed`}>Baud rate</label>
                        <select {...field("serialSpeed")} value={serialSpeed} onChange={(event) => { setSerialSpeed(Number(event.target.value)); clearFieldError("serialSpeed"); }}>
                          {!SERIAL_SPEEDS.includes(serialSpeed) && <option value={serialSpeed}>{serialSpeed}</option>}
                          {SERIAL_SPEEDS.map((speed) => <option key={speed} value={speed}>{speed}</option>)}
                        </select>
                        {fieldError("serialSpeed")}
                      </div>
                    </div>
                  ) : (
                    <div className="host-form-row host-form-endpoint">
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-hostname`}>Hostname or IP address</label>
                        <input {...field("hostname")} data-autofocus value={hostname}
                          onChange={(event) => { setHostname(event.target.value); clearFieldError("hostname"); }}
                          placeholder="e.g. 10.0.0.1 or srv.local" autoComplete="off" spellCheck={false} />
                        {fieldError("hostname")}
                      </div>
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-port`}>Port</label>
                        <input {...field("port")} type="number" min={1} max={65535} value={Number.isNaN(port) ? "" : port}
                          onChange={(event) => { setPort(event.target.valueAsNumber); clearFieldError("port"); }} />
                        {fieldError("port")}
                      </div>
                    </div>
                  )}
                </section>

                {isNetwork && (
                  <section className="host-form-section host-form-separated" aria-labelledby={`${formId}-auth-heading`}>
                    <div className="host-form-section-heading">
                      <h3 id={`${formId}-auth-heading`}>Authentication</h3>
                      {connectionType === "ssh" && (
                        <fieldset className="host-form-auth-options">
                          <legend className="host-form-sr-only">Authentication method</legend>
                          {[{ label: "Password", value: true }, { label: "Private key", value: false }].map((method) => (
                            <label key={method.label}>
                              <input type="radio" name="authMethod" checked={isPasswordAuth === method.value}
                                onChange={() => changeAuthMethod(method.value)} disabled={clearStoredCredential} />
                              <span>{method.label}</span>
                            </label>
                          ))}
                        </fieldset>
                      )}
                    </div>
                    {canKeepCredential && (
                      <div className="host-form-credential-note">
                        <IoLockClosedOutline aria-hidden="true" size={15} />
                        <p>{clearStoredCredential ? "Saved credentials will be removed on save." : "Saved credentials linked. Leave fields blank to keep them."}</p>
                        <button type="button" className="host-form-text-button" onClick={() => {
                          setClearStoredCredential(!clearStoredCredential);
                          keyReadVersionRef.current += 1;
                          setKeyReading(false);
                          setShowPassword(false);
                          setShowPassphrase(false);
                        }}>{clearStoredCredential ? "Undo" : "Remove"}</button>
                      </div>
                    )}
                    <div className="host-form-row">
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-username`}>Username</label>
                        <input {...field("username")} value={username} onChange={(event) => setUsername(event.target.value)}
                          placeholder={hostToEdit ? "Account name" : "user (default)"} autoComplete="username" spellCheck={false} />

                      </div>
                      {!isPasswordAuth && connectionType === "ssh" && (
                        <div className="host-form-field">
                          <label htmlFor={`${formId}-passphrase`}>Key passphrase <span>if encrypted</span></label>
                          <div className="host-form-secret">
                            <input id={`${formId}-passphrase`} name="passphrase" type={showPassphrase ? "text" : "password"}
                              value={passphrase} onChange={(event) => { setPassphrase(event.target.value); if (fieldErrors.privateKey === PASSPHRASE_KEY_ERROR) clearFieldError("privateKey"); }} placeholder="Enter key passphrase"
                              disabled={clearStoredCredential} autoComplete="new-password" />
                            <button type="button" onClick={() => setShowPassphrase(!showPassphrase)} disabled={clearStoredCredential}
                              aria-label={showPassphrase ? "Hide passphrase" : "Show passphrase"} aria-pressed={showPassphrase} className="host-form-icon-button">
                              {showPassphrase ? <IoEyeOffOutline size={17} /> : <IoEyeOutline size={17} />}
                            </button>
                          </div>
                        </div>
                      )}
                      {(isPasswordAuth || connectionType === "telnet") && (
                        <div className="host-form-field">
                          <label htmlFor={`${formId}-password`}>Password</label>
                          <div className="host-form-secret">
                            <input id={`${formId}-password`} name="password" type={showPassword ? "text" : "password"}
                              value={password} onChange={(event) => { setPassword(event.target.value); setGeneratorNotice(""); }}
                              placeholder={canKeepCredential ? "********" : "Enter password"}
                              disabled={clearStoredCredential} autoComplete="new-password" spellCheck={false} />
                            <button type="button" onClick={() => setShowPassword(!showPassword)} disabled={clearStoredCredential}
                              aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} className="host-form-icon-button">
                              {showPassword ? <IoEyeOffOutline size={17} /> : <IoEyeOutline size={17} />}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    {!isPasswordAuth && connectionType === "ssh" ? (
                      <>
                        <div className="host-form-field">
                          <div className="host-form-label-row">
                            <label htmlFor={`${formId}-privateKey`}>Private key</label>
                            <button type="button" className="host-form-text-button" disabled={clearStoredCredential || keyReading}
                              onClick={() => keyInputRef.current?.click()}><IoFolderOpenOutline aria-hidden="true" size={14} /> {keyReading ? "Reading…" : "Load key file"}</button>
                          </div>
                          <label htmlFor={`${formId}-key-file`} className="host-form-sr-only">Private key file</label>
                          <input ref={keyInputRef} id={`${formId}-key-file`} type="file" hidden onChange={(event) => void loadKeyFile(event)} disabled={clearStoredCredential} />
                          <textarea {...field("privateKey", "key-hint")} rows={3} value={privateKey}
                            onChange={(event) => { keyReadVersionRef.current += 1; setKeyReading(false); setPrivateKey(event.target.value); setKeyFileName(""); clearFieldError("privateKey"); }}
                            placeholder="Paste an OpenSSH or PEM private key" disabled={clearStoredCredential} autoComplete="off" spellCheck={false} />
                          <p id={`${formId}-key-hint`} className="host-form-hint host-form-file-name">{keyFileName ? `Loaded: ${keyFileName}` : "Load from this computer or paste the key contents."}</p>
                          {fieldError("privateKey")}
                        </div>
                      </>
                    ) : (
                      <details className="host-form-generator">
                        <summary><IoChevronDown aria-hidden="true" size={12} /> Password generator</summary>
                        <div className="host-form-generator-content">
                          <div className="host-form-generator-controls">
                            <label htmlFor={`${formId}-length`}>Length</label>
                            <input id={`${formId}-length`} type="number" min={8} max={64} value={Number.isNaN(passwordLength) ? "" : passwordLength}
                              onChange={(event) => setPasswordLength(event.target.valueAsNumber)} disabled={clearStoredCredential} />
                            <label className="host-form-checkbox"><input type="checkbox" checked={includeSymbols}
                              onChange={(event) => setIncludeSymbols(event.target.checked)} disabled={clearStoredCredential} /> Symbols</label>
                            <button type="button" onClick={applyGeneratedPassword} disabled={clearStoredCredential} className="host-form-button"><IoRefresh aria-hidden="true" size={14} /> Generate</button>
                          </div>
                          <p className="host-form-hint">Fills this field with a new password. It does not change the remote account.</p>
                          {generatorNotice && <p role="status" className="host-form-hint">{generatorNotice}</p>}
                        </div>
                      </details>
                    )}
                  </section>
                )}

                <section className="host-form-section host-form-separated" aria-labelledby={`${formId}-profile-heading`}>
                  <h3 id={`${formId}-profile-heading`} className="host-form-sr-only">Host profile</h3>
                  <div className="host-form-row">
                    <div className="host-form-field">
                      <label htmlFor={`${formId}-name`}>Display name <span>optional</span></label>
                      <input id={`${formId}-name`} name="displayName" value={name} onChange={(event) => setName(event.target.value)}
                        placeholder={isLocal ? "Local Shell" : isSerial ? serialPort.trim() || "Serial connection" : hostname.trim() || "Use hostname or IP address"} autoComplete="off" />

                    </div>
                    <div className="host-form-field">
                      <label htmlFor={`${formId}-group`}>{isAddingNewGroup ? "New folder" : "Folder"}</label>
                      <div className="host-form-group-control">
                        {isAddingNewGroup ? (
                          <input {...field("group", "group-hint")} autoFocus value={newGroupName}
                            onChange={(event) => { setNewGroupName(event.target.value); clearFieldError("group"); }}
                            placeholder="e.g. Production/Europe" autoComplete="off" />
                        ) : (
                          <select {...field("group")} value={group} onChange={(event) => { setGroup(event.target.value); clearFieldError("group"); }}>
                            <option value="">Ungrouped</option>
                            {existingGroups.map((path) => <option key={path} value={path}>{path}</option>)}
                          </select>
                        )}
                        <button type="button" className="host-form-icon-button host-form-add-group" aria-label={isAddingNewGroup ? "Cancel new folder" : "Create folder"}
                          onClick={() => { setIsAddingNewGroup(!isAddingNewGroup); clearFieldError("group"); }}>
                          {isAddingNewGroup ? <IoClose size={18} /> : <IoAdd size={18} />}
                        </button>
                      </div>
                      {isAddingNewGroup && <p id={`${formId}-group-hint`} className="host-form-hint">Use / to create nested folders.</p>}
                      {fieldError("group")}
                    </div>
                  </div>
                </section>

                <details className="host-form-appearance" open={appearanceOpen} onToggle={(event) => setAppearanceOpen(event.currentTarget.open)}>
                  <summary><IoChevronDown aria-hidden="true" size={14} /><span>Terminal appearance</span><span className="host-form-appearance-value">{theme.name}{terminalBackground || terminalForeground || sanitizeTerminalAppearance(terminalAppearance) ? " · Custom" : ""} · {Number.isNaN(terminalFontSize) ? "—" : terminalFontSize} px</span></summary>
                  <div className="host-form-appearance-content">
                    <div className="host-form-row host-form-endpoint">
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-theme`}>Color theme</label>
                        <select id={`${formId}-theme`} value={terminalTheme} onChange={(event) => setTerminalTheme(event.target.value)}>
                          {getThemesList().map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                        </select>
                      </div>
                      <div className="host-form-field">
                        <label htmlFor={`${formId}-terminalFontSize`}>Font size <span>px</span></label>
                        <input {...field("terminalFontSize")} type="number" min={6} max={72} value={Number.isNaN(terminalFontSize) ? "" : terminalFontSize}
                          onChange={(event) => { setTerminalFontSize(event.target.valueAsNumber); clearFieldError("terminalFontSize"); }} />
                        {fieldError("terminalFontSize")}
                      </div>
                    </div>
                    <div className="host-form-row">
                      <TerminalColorControl id={`${formId}-terminalBackground`} name="terminalBackground" kind="background"
                        value={terminalBackground} themeColor={theme.colors.background} error={fieldErrors.terminalBackground}
                        onChange={(color) => { setTerminalBackground(color); clearFieldError("terminalBackground"); }} />
                      <TerminalColorControl id={`${formId}-terminalForeground`} name="terminalForeground" kind="text"
                        value={terminalForeground} themeColor={theme.colors.foreground} error={fieldErrors.terminalForeground}
                        onChange={(color) => { setTerminalForeground(color); clearFieldError("terminalForeground"); }} />
                    </div>
                    <p className="host-form-hint">Custom colors override the selected theme.</p>
                    <div className="host-form-terminal-preview" aria-label="Terminal appearance preview"
                      style={{ ...getTerminalSurface(terminalTheme, terminalBackground), color: previewColors.foreground, fontSize: Math.min(72, Math.max(6, terminalFontSize || 14)), fontFamily: previewOptions.fontFamily, fontWeight: previewOptions.fontWeight, lineHeight: previewOptions.lineHeight, letterSpacing: previewOptions.letterSpacing }}>
                      <div><span style={{ color: previewColors.green }}>{username.trim() || "user"}@{hostname.trim() || "host"}</span><span style={{ color: previewColors.cyan }}> ~ </span>$ echo hello</div>
                      <div>hello<span className={`host-form-preview-cursor cursor-${previewOptions.cursorStyle}${previewOptions.cursorBlink ? " cursor-blink" : ""}`} style={{ background: previewColors.cursor }} /></div>
                      <div className="host-appearance-sample"><span style={{ fontWeight: previewOptions.fontWeightBold, color: previewOptions.drawBoldTextInBrightColors ? previewColors.brightGreen : previewColors.green }}>bold</span>{"  "}<span style={{ fontStyle: "italic" }}>italic</span>{"  "}<span style={{ textDecoration: "underline" }}>underline</span>{"  "}<span style={{ background: previewColors.selectionBackground }}>selection</span></div>
                    </div>
                    <TerminalAppearanceEditor id={`${formId}-appearance`} value={terminalAppearance} colors={previewColors} themeColors={getThemeColors(terminalTheme, { terminal_background: terminalBackground, terminal_foreground: terminalForeground })} settings={settings} errors={fieldErrors}
                      onChange={value => { setTerminalAppearance(value); setFieldErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("appearance_")))); }} />
                    <div className="host-appearance-defaults">
                    <button type="button" className="host-form-text-button" onClick={() => {
                      setTerminalTheme(settings.terminal.theme); setTerminalFontSize(settings.terminal.fontSize); clearFieldError("terminalFontSize");
                      setTerminalBackground(""); setTerminalForeground(""); clearFieldError("terminalBackground"); clearFieldError("terminalForeground");
                      setTerminalAppearance({}); setFieldErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("appearance_"))));
                    }}>Reset appearance</button>
                    <button type="button" className="host-form-button" onClick={saveAppearanceDefault}>Save as default</button>
                    </div>
                    <p className="host-form-hint" role="status">{appearanceNotice || "New connections use your last saved appearance. Saving a host remembers it automatically."}</p>
                  </div>
                </details>
              </fieldset>
            </div>
            <footer className="host-form-footer">
              {vaultPrompt ? (
                  <div className="host-form-inline-actions host-form-vault-actions">
                    <button type="button" onClick={() => { clearPendingVaultState(); setError(null); }} disabled={busy} className="host-form-button">Back to form</button>
                    {settings.security.vaultRememberPassword && settings.security.vaultUnlockMode === "session" && hasStoredVaultPassword && (
                      <button type="button" onClick={() => void handleVaultUnlockWithSavedPassword()} disabled={busy} className="host-form-button">Use saved password</button>
                    )}
                    <button type="button" onClick={() => void handleVaultUnlock()}
                      disabled={busy || !vaultPassword || (!vaultInitialized && !vaultPasswordConfirmation)} className="host-form-button host-form-button-primary">
                      {vaultUnlocking ? "Unlocking…" : vaultInitialized ? "Unlock" : "Create & unlock"}
                    </button>
                  </div>
              ) : (
              <div className="host-form-footer-actions">
                <button type="button" onClick={requestClose} disabled={busy} className="host-form-button host-form-cancel">Cancel</button>
                <div>{quickIsPrimary ? <>{saveButton}{connectButton}</> : <>{connectButton}{saveButton}</>}</div>
              </div>
              )}
            </footer>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  );
};

export default HostFormModal;
