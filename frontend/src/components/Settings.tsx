import React, { useEffect, useState } from "react";
import { version as appVersion } from "../../package.json";
import TelegramCommunityLink from "../features/feedback/TelegramCommunityLink";
import NumberSettingInput from "../features/settings/NumberSettingInput";
import { parseSettingNumber } from "../features/settings/settings";
import { lockApplication } from "../features/security/api";
import {
    IoAdd,
    IoCheckmark,
    IoChevronForward,
    IoColorPalette,
    IoDesktop,
    IoGlobe,
    IoHeart,
    IoKeypad,
    IoLockClosed,
    IoLockOpen,
    IoRefresh,
    IoSettings,
    IoShieldCheckmarkOutline,
    IoTerminal,
    IoTrash,
    IoVolumeHigh,
    IoVolumeMute
} from "react-icons/io5";
import { useShallow } from "zustand/react/shallow";
import { validateNewVaultMasterPassword } from "../features/vault/password";
import { useAppStore } from "../state/store";
import { getThemesList } from "../themes";

const VAULT_RESET_CONFIRMATION = "RESET VAULT";

type SettingsCategory =
  | "terminal"
  | "connection"
  | "keyboard"
  | "window"
  | "security";

const CATEGORIES = [
  {
    id: "terminal" as const,
    label: "Terminal",
    icon: IoTerminal,
    description: "Appearance and behavior",
  },
  {
    id: "connection" as const,
    label: "Connection",
    icon: IoGlobe,
    description: "Network and timeout",
  },
  {
    id: "keyboard" as const,
    label: "Keyboard",
    icon: IoKeypad,
    description: "Keys and shortcuts",
  },
  {
    id: "window" as const,
    label: "Window",
    icon: IoDesktop,
    description: "Layout and tabs",
  },

  {
    id: "security" as const,
    label: "Security",
    icon: IoLockClosed,
    description: "Protection settings",
  },
];

// Modern Toggle
const Toggle: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}> = ({ label, checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={disabled}
    onClick={() => !disabled && onChange(!checked)}
    className={`relative w-12 h-6 rounded-full transition-all duration-300 ${
      checked ? "bg-primary shadow-glow-sm" : "bg-[#2a2a35]"
    } ${disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`}
  >
    <div
      className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all duration-300 shadow-lg ${
        checked ? "left-7" : "left-1"
      }`}
    />
  </button>
);

// Premium Slider with Manual Input
const Slider: React.FC<{
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => boolean | void;
  unit?: string;
}> = ({ value, min, max, step = 1, onChange, unit = "" }) => {
  const [tempValue, setTempValue] = React.useState(String(value));

  // Update temp value when prop changes (from external or slider)
  React.useEffect(() => {
    setTempValue(String(value));
  }, [value]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const s = e.target.value;
    setTempValue(s);
    const n = parseSettingNumber(s, min, max, step);
    if (n !== null && Number(s) === n) {
      if (onChange(n) === false) setTempValue(String(value));
    }
  };

  const handleBlur = () => {
    const n = parseSettingNumber(tempValue, min, max, step);
    if (n === null) {
      setTempValue(String(value));
    } else {
      const saved = onChange(n) !== false;
      setTempValue(String(saved ? n : value));
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleBlur();
    }
  };

  return (
    <div className="flex items-center gap-4 w-full max-w-[340px]">
      <div className="flex items-center gap-1.5 bg-[#0b131e] border border-[#2a3747] rounded-control px-3 py-1.5 min-w-[90px] group focus-within:border-primary/40 focus-within:ring-1 focus-within:ring-primary/20 transition-all shadow-inner">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={tempValue}
          onChange={handleInputChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className="bg-transparent text-xs font-bold font-mono text-primary w-full outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none text-right"
        />
        {unit && (
          <span className="text-[9px] font-black text-gray-600 uppercase tracking-widest shrink-0 border-l border-white/5 pl-1.5 pointer-events-none">
            {unit.trim()}
          </span>
        )}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-primary h-1.5 bg-[#1a1a24] rounded-full appearance-none cursor-pointer hover:bg-[#20202c] transition-colors"
      />
    </div>
  );
};

// Select Component
const Select: React.FC<{
  value: string;
  options: { id: string; name: string }[];
  onChange: (value: string) => void;
  icon?: React.ReactNode;
}> = ({ value, options, onChange, icon }) => (
  <div className="relative group min-w-[200px]">
    <div className="flex items-center w-full bg-[#0b131e] border border-[#2a3747] rounded-control px-3 py-2 hover:border-gray-700 transition-all cursor-pointer">
      {icon && (
        <div className="mr-3 text-gray-500 group-hover:text-primary transition-colors">
          {icon}
        </div>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-sm text-gray-200 outline-none flex-1 appearance-none cursor-pointer"
      >
        {options.map((opt) => (
          <option key={opt.id} value={opt.id} className="bg-[#11111b]">
            {opt.name}
          </option>
        ))}
      </select>
      <IoChevronForward size={14} className="rotate-90 text-gray-600 ml-2" />
    </div>
  </div>
);

// Settings Row
const SettingRow: React.FC<{
  label: string;
  description?: string;
  children: React.ReactNode;
}> = ({ label, description, children }) => (
  <div className="settings-row flex items-center justify-between gap-4 py-4 border-b border-white/5 last:border-0">
    <div className="min-w-0 flex-1">
      <label className="block text-sm font-semibold text-gray-100 mb-1">
        {label}
      </label>
      {description && (
        <p className="text-xs text-gray-500 font-medium leading-relaxed">
          {description}
        </p>
      )}
    </div>
    <div className="settings-row-control flex shrink-0 items-center">{children}</div>
  </div>
);

const Settings: React.FC = () => {
  const databaseEncrypted = useAppStore((state) => state.appSecurity.databaseEncrypted);
  const {
    settings,
    updateSettings,
    resetSettings,
    addToast,
    addHighlightRule,
    updateHighlightRule,
    removeHighlightRule,
    isVaultUnlocked,
    vaultInitialized,
    vaultStatusLoaded,
    vaultSecretItems,
    vaultLinkedHosts,
    hasStoredVaultPassword,
    refreshVaultStatus,
    refreshStoredVaultPasswordState,
    unlockVault,
    lockVault,
    changeVaultPassword,
    resetVault,
    getStoredVaultPassword,
  } = useAppStore(
    useShallow((state) => ({
      settings: state.settings,
      updateSettings: state.updateSettings,
      resetSettings: state.resetSettings,
      addToast: state.addToast,
      addHighlightRule: state.addHighlightRule,
      updateHighlightRule: state.updateHighlightRule,
      removeHighlightRule: state.removeHighlightRule,
      isVaultUnlocked: state.isVaultUnlocked,
      vaultInitialized: state.vaultInitialized,
      vaultStatusLoaded: state.vaultStatusLoaded,
      vaultSecretItems: state.vaultSecretItems,
      vaultLinkedHosts: state.vaultLinkedHosts,
      hasStoredVaultPassword: state.hasStoredVaultPassword,
      refreshVaultStatus: state.refreshVaultStatus,
      refreshStoredVaultPasswordState: state.refreshStoredVaultPasswordState,
      unlockVault: state.unlockVault,
      lockVault: state.lockVault,
      changeVaultPassword: state.changeVaultPassword,
      resetVault: state.resetVault,
      getStoredVaultPassword: state.getStoredVaultPassword,
    })),
  );
  const [activeCategory, setActiveCategory] =
    useState<SettingsCategory>(() => (
      vaultStatusLoaded && !isVaultUnlocked ? "security" : "terminal"
    ));
  const themes = getThemesList();
  const [masterPassword, setMasterPassword] = useState("");
  const [masterPasswordConfirmation, setMasterPasswordConfirmation] = useState("");
  const [vaultLoading, setVaultLoading] = useState(false);
  const [vaultResetPhrase, setVaultResetPhrase] = useState("");
  const [vaultResetBusy, setVaultResetBusy] = useState(false);
  const [vaultResetError, setVaultResetError] = useState<string | null>(null);
  const [vaultResetSummary, setVaultResetSummary] = useState<{
    detachedHosts: number;
    deletedItems: number;
  } | null>(null);
  const [vaultSavedUnlockBusy, setVaultSavedUnlockBusy] = useState(false);
  const [changeCurrentPassword, setChangeCurrentPassword] = useState("");
  const [changeNewPassword, setChangeNewPassword] = useState("");
  const [changeConfirmPassword, setChangeConfirmPassword] = useState("");
  const [changePasswordBusy, setChangePasswordBusy] = useState(false);
  const [changePasswordError, setChangePasswordError] = useState<string | null>(null);
  const [changePasswordSummary, setChangePasswordSummary] = useState<string | null>(null);

  const handleReset = () => {
    if (!resetSettings(activeCategory)) return;
    addToast(
      `${CATEGORIES.find((c) => c.id === activeCategory)?.label} settings reset`,
      "info",
    );
  };

  const handleResetAll = () => {
    if (!resetSettings()) return;
    addToast("All settings reset to defaults", "info");
  };

  useEffect(() => {
    if (vaultStatusLoaded && !isVaultUnlocked) {
      setActiveCategory("security");
    }
  }, [isVaultUnlocked, vaultStatusLoaded]);

  useEffect(() => {
    if (activeCategory !== "security") return;
    refreshVaultStatus();
    refreshStoredVaultPasswordState();
  }, [activeCategory, refreshVaultStatus, refreshStoredVaultPasswordState, isVaultUnlocked]);

  const submitVaultUnlock = async () => {
    if (!masterPassword || vaultLoading) return;

    if (!vaultStatusLoaded) {
      addToast("Vault status is still loading. Try again in a moment.", "error");
      return;
    }

    if (!vaultInitialized) {
      const validationError = validateNewVaultMasterPassword(
        masterPassword,
        masterPasswordConfirmation,
      );
      if (validationError) {
        addToast(validationError, "error");
        return;
      }
    }

    setVaultLoading(true);
    const wasInitialized = vaultInitialized;
    const result = await unlockVault(masterPassword);
    setVaultLoading(false);

    if (result.ok) {
      addToast(wasInitialized ? "Vault unlocked" : "Vault created and unlocked", "success");
      setMasterPassword("");
      setMasterPasswordConfirmation("");
      setChangePasswordError(null);
      await refreshVaultStatus();
    } else {
      addToast(result.error || "Invalid master password", "error");
    }
  };

  const unlockWithStoredPassword = async () => {
    setVaultSavedUnlockBusy(true);
    const stored = await getStoredVaultPassword();

    if (!stored) {
      setVaultSavedUnlockBusy(false);
      addToast("No saved vault password found", "error");
      await refreshStoredVaultPasswordState();
      return;
    }

    const result = await unlockVault(stored);
    setVaultSavedUnlockBusy(false);
    if (result.ok) {
      addToast("Vault unlocked", "success");
      setMasterPassword("");
      setChangePasswordError(null);
      await refreshVaultStatus();
    } else {
      addToast(result.error || "Saved vault password is no longer valid", "error");
    }
  };

  const submitChangeMasterPassword = async () => {
    setChangePasswordError(null);
    setChangePasswordSummary(null);

    if (!isVaultUnlocked) {
      setChangePasswordError("Unlock vault before changing master password.");
      return;
    }
    if (!changeCurrentPassword || !changeNewPassword || !changeConfirmPassword) {
      setChangePasswordError("Fill all password fields.");
      return;
    }
    if (changeNewPassword !== changeConfirmPassword) {
      setChangePasswordError("New password and confirmation do not match.");
      return;
    }
    if (changeNewPassword.length < 10) {
      setChangePasswordError("New master password must be at least 10 characters.");
      return;
    }
    if (changeCurrentPassword === changeNewPassword) {
      setChangePasswordError("New password must be different from current password.");
      return;
    }

    setChangePasswordBusy(true);
    const result = await changeVaultPassword(changeCurrentPassword, changeNewPassword);
    setChangePasswordBusy(false);

    if (!result.ok) {
      setChangePasswordError(result.error || "Failed to change master password.");
      return;
    }

    setChangeCurrentPassword("");
    setChangeNewPassword("");
    setChangeConfirmPassword("");
    setChangePasswordSummary(`Master password changed successfully. Re-encrypted ${result.rotatedItems} vault item(s).`);
    addToast("Master password updated", "success");
    await refreshVaultStatus();
    await refreshStoredVaultPasswordState();
  };

  const submitVaultReset = async () => {
    if (vaultResetPhrase.trim() !== VAULT_RESET_CONFIRMATION) {
      setVaultResetError(`Type ${VAULT_RESET_CONFIRMATION} to confirm.`);
      return;
    }

    setVaultResetBusy(true);
    setVaultResetError(null);
    const result = await resetVault(vaultResetPhrase.trim());
    setVaultResetBusy(false);

    if (!result.ok) {
      setVaultResetError(result.error || "Failed to reset vault.");
      return;
    }

    setVaultResetSummary({
      detachedHosts: result.detachedHosts,
      deletedItems: result.deletedItems,
    });
    setVaultResetPhrase("");
    setMasterPassword("");
    addToast("Vault reset completed", "info");
  };

  const renderContent = () => {
    switch (activeCategory) {
      case "terminal":
        return (
          <div className="space-y-1">
            <SettingRow
              label="Font Family"
              description="Choose the terminal font"
            >
              <Select
                value={settings.terminal.fontFamily}
                options={[
                  { id: "Monaco", name: "Monaco" },
                  { id: "JetBrains Mono", name: "JetBrains Mono" },
                  { id: "Fira Code", name: "Fira Code" },
                  { id: "Cascadia Code", name: "Cascadia Code" },
                  { id: "Menlo", name: "Menlo" },
                ]}
                onChange={(v) => updateSettings("terminal", { fontFamily: v })}
              />
            </SettingRow>

            <SettingRow
              label="Font Size"
              description="Adjust text size (10-24px)"
            >
              <Slider
                value={settings.terminal.fontSize}
                min={10}
                max={24}
                onChange={(v) => updateSettings("terminal", { fontSize: v })}
                unit="px"
              />
            </SettingRow>

            <SettingRow label="Color Theme" description="Terminal color scheme">
              <Select
                value={settings.terminal.theme}
                options={themes.map((t) => ({ id: t.id, name: t.name }))}
                onChange={(v) => updateSettings("terminal", { theme: v })}
                icon={<IoColorPalette size={16} />}
              />
            </SettingRow>

            <SettingRow
              label="Terminal Type"
              description="Emulation type reported to remote host"
            >
              <Select
                value={settings.terminal.type || "linux"}
                options={["linux", "xterm-256color", "xterm", "vt100"].map(
                  (t) => ({ id: t, name: t }),
                )}
                onChange={(v) => updateSettings("terminal", { type: v })}
              />
            </SettingRow>

            <SettingRow label="Cursor Style" description="Shape of the cursor">
              <Select
                value={settings.terminal.cursorStyle}
                options={[
                  { id: "block", name: "Block █" },
                  { id: "underline", name: "Underline _" },
                  { id: "bar", name: "Bar |" },
                ]}
                onChange={(v) =>
                  updateSettings("terminal", { cursorStyle: v as any })
                }
              />
            </SettingRow>

            <SettingRow
              label="Cursor Blink"
              description="Enable cursor blinking animation"
            >
              <Toggle
                label="Cursor blink"
                checked={settings.terminal.cursorBlink}
                onChange={(v) => updateSettings("terminal", { cursorBlink: v })}
              />
            </SettingRow>

            <SettingRow
              label="Scrollback Lines"
              description="Number of lines to keep in history"
            >
              <Slider
                value={settings.terminal.scrollbackLines}
                min={1000}
                max={100000}
                step={1000}
                onChange={(v) =>
                  updateSettings("terminal", { scrollbackLines: v })
                }
              />
            </SettingRow>

            <SettingRow
              label="Terminal Rows Multiplier"
              description="Report more rows to remote device to reduce --More-- prompts on routers (Cisco, Huawei, etc.)"
            >
              <Slider
                value={settings.terminal.rowsMultiplier || 1}
                min={1}
                max={5}
                step={1}
                onChange={(v) =>
                  updateSettings("terminal", { rowsMultiplier: v })
                }
              />
            </SettingRow>

            <SettingRow
              label="Bell Sound"
              description="Play sound on terminal bell"
            >
              <div className="flex items-center gap-4">
                <Toggle
                  label="Bell sound"
                  checked={settings.terminal.bellSound}
                  onChange={(v) => updateSettings("terminal", { bellSound: v })}
                />
                {settings.terminal.bellSound ? (
                  <IoVolumeHigh className="text-gray-500" size={18} />
                ) : (
                  <IoVolumeMute className="text-gray-700" size={18} />
                )}
              </div>
            </SettingRow>

            {/* Keyword Highlighting Section */}
            <div className="mt-8 pt-8 border-t border-white/5">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider">Keyword Highlighting</h3>
                  <p className="text-xs text-gray-500 mt-1">Automatically highlight specific words in the terminal</p>
                </div>
                <button
                  onClick={() => {
                    addHighlightRule({
                      keyword: "",
                      color: "#3b82f6", // Default blue
                      highlightType: "background",
                      isActive: true
                    });
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 text-primary hover:bg-primary/20 rounded-control text-xs font-bold transition-all"
                >
                  <IoAdd size={14} />
                  Add Rule
                </button>
              </div>

              <div className="space-y-3">
                {(!settings.terminal.highlightRules || settings.terminal.highlightRules.length === 0) ? (
                  <div className="text-center py-8 bg-black/20 rounded-card border border-dashed border-white/5">
                    <p className="text-xs text-gray-600">No highlight rules yet. Click "Add Rule" to begin.</p>
                  </div>
                ) : (
                  settings.terminal.highlightRules.map((rule) => (
                    <div key={rule.id} className="flex items-center gap-4 p-3 bg-white/5 border border-white/5 rounded-card group hover:border-white/10 transition-all">
                      <div className="flex-1 flex items-center gap-3">
                        <input
                          type="text"
                          value={rule.keyword}
                          onChange={(e) => {
                            updateHighlightRule(rule.id, { keyword: e.target.value });
                          }}
                          placeholder="Keyword..."
                          className="bg-transparent border-none outline-none text-sm text-white placeholder-gray-600 w-full font-mono"
                        />
                      </div>
                      
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1 bg-[#1a1a24] rounded-control p-1 border border-white/5">
                            <button
                                onClick={() => updateHighlightRule(rule.id, { highlightType: 'background' })}
                                className={`px-2 py-1 text-[10px] font-bold rounded-md transition-all ${rule.highlightType === 'background' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                BG
                            </button>
                            <button
                                onClick={() => updateHighlightRule(rule.id, { highlightType: 'foreground' })}
                                className={`px-2 py-1 text-[10px] font-bold rounded-md transition-all ${rule.highlightType === 'foreground' ? 'bg-primary text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                            >
                                TXT
                            </button>
                        </div>

                        <div className="relative group/color">
                           <input 
                            type="color"
                            value={rule.color}
                            onChange={(e) => {
                              updateHighlightRule(rule.id, { color: e.target.value });
                            }}
                            className="w-8 h-8 rounded-control overflow-hidden border-none p-0 bg-transparent cursor-pointer"
                           />
                        </div>

                        <Toggle 
                          label={`Enable highlight rule${rule.keyword ? ` for ${rule.keyword}` : ""}`}
                          checked={rule.isActive}
                          onChange={(v) => {
                            updateHighlightRule(rule.id, { isActive: v });
                          }}
                        />

                        <button 
                          onClick={() => {
                            removeHighlightRule(rule.id);
                          }}
                          className="p-1.5 text-gray-600 hover:text-red-400 hover:bg-red-500/10 rounded-control transition-all"
                        >
                          <IoTrash size={16} />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="mt-8 pt-8 border-t border-white/5 space-y-1">
              <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-6 pl-1">Search Highlighting</h3>
              
              <SettingRow
                label="All Matches Color"
                description="Background color for all search results"
              >
                <div className="flex items-center gap-4">
                  <input
                    type="color"
                    value={settings.terminal.searchMatchBackground?.slice(0, 7) || "#ffffff"}
                    onChange={(e) => {
                      const alpha = settings.terminal.searchMatchBackground?.slice(7) || "20";
                      updateSettings("terminal", { searchMatchBackground: e.target.value + alpha });
                    }}
                    className="w-10 h-10 rounded-card overflow-hidden border-none p-0 bg-transparent cursor-pointer"
                  />
                  <Slider
                    value={parseInt(settings.terminal.searchMatchBackground?.slice(7) || "20", 16)}
                    min={0}
                    max={255}
                    onChange={(v) => {
                      const color = settings.terminal.searchMatchBackground?.slice(0, 7) || "#ffffff";
                      const alpha = v.toString(16).padStart(2, '0');
                      updateSettings("terminal", { searchMatchBackground: color + alpha });
                    }}
                    unit=" op"
                  />
                </div>
              </SettingRow>

              <SettingRow
                label="Active Match Color"
                description="Background color for the current selection"
              >
                <div className="flex items-center gap-4">
                  <input
                    type="color"
                    value={settings.terminal.searchActiveMatchBackground?.slice(0, 7) || "#eab308"}
                    onChange={(e) => {
                      const alpha = settings.terminal.searchActiveMatchBackground?.slice(7) || "99";
                      updateSettings("terminal", { searchActiveMatchBackground: e.target.value + alpha });
                    }}
                    className="w-10 h-10 rounded-card overflow-hidden border-none p-0 bg-transparent cursor-pointer"
                  />
                  <Slider
                    value={parseInt(settings.terminal.searchActiveMatchBackground?.slice(7) || "99", 16)}
                    min={0}
                    max={255}
                    onChange={(v) => {
                      const color = settings.terminal.searchActiveMatchBackground?.slice(0, 7) || "#eab308";
                      const alpha = v.toString(16).padStart(2, '0');
                      updateSettings("terminal", { searchActiveMatchBackground: color + alpha });
                    }}
                    unit=" op"
                  />
                </div>
              </SettingRow>
            </div>
          </div>
        );

      case "connection":
        return (
          <div className="space-y-1">
            <p className="pb-2 text-xs text-gray-400">Defaults for new terminal connections. File transfers and tunnels use separate time limits.</p>
            <SettingRow
              label="Default SSH Port"
              description="Port used for SSH connections"
            >
              <NumberSettingInput
                label="Default SSH port" min={1} max={65535}
                value={settings.connection.defaultSSHPort}
                onChange={(value) =>
                  updateSettings("connection", {
                    defaultSSHPort: value,
                  })
                }
              />
            </SettingRow>

            <SettingRow
              label="Default Telnet Port"
              description="Port used for Telnet connections"
            >
              <NumberSettingInput
                label="Default Telnet port" min={1} max={65535}
                value={settings.connection.defaultTelnetPort}
                onChange={(value) =>
                  updateSettings("connection", {
                    defaultTelnetPort: value,
                  })
                }
              />
            </SettingRow>

            <SettingRow
              label="Connection Timeout"
              description="Seconds to wait before timing out"
            >
              <Slider
                value={settings.connection.connectionTimeout}
                min={5}
                max={120}
                step={5}
                onChange={(v) =>
                  updateSettings("connection", { connectionTimeout: v })
                }
                unit="s"
              />
            </SettingRow>

            <SettingRow
              label="Keepalive Interval"
              description="Seconds between keepalive packets (prevents disconnects)"
            >
              <Slider
                value={settings.connection.keepaliveInterval}
                min={0}
                max={300}
                step={10}
                onChange={(v) =>
                  updateSettings("connection", { keepaliveInterval: v })
                }
                unit="s"
              />
            </SettingRow>

            <SettingRow
              label="Auto-Reconnect"
              description="Automatically reconnect on disconnect"
            >
              <Toggle
                label="Auto-reconnect"
                checked={settings.connection.autoReconnect}
                onChange={(v) =>
                  updateSettings("connection", { autoReconnect: v })
                }
              />
            </SettingRow>

            {settings.connection.autoReconnect && (
              <SettingRow
                label="Reconnect Attempts"
                description="Maximum automatic reconnect attempts"
              >
                <Slider
                  value={settings.connection.maxReconnectAttempts}
                  min={1}
                  max={10}
                  onChange={(v) =>
                    updateSettings("connection", { maxReconnectAttempts: v })
                  }
                />
              </SettingRow>
            )}
          </div>
        );

      case "keyboard":
        return (
          <div className="space-y-1">

            <SettingRow
              label="Right-Click Action"
              description="Action when right-clicking the terminal"
            >
              <Select
                value={settings.keyboard.rightClickAction}
                options={[
                  { id: "copy", name: "Copy (if selected) / Menu" },
                  { id: "paste", name: "Paste" },
                  { id: "contextMenu", name: "Context Menu" },
                ]}
                onChange={(v) =>
                  updateSettings("keyboard", { rightClickAction: v as any })
                }
              />
            </SettingRow>

            <SettingRow
              label="Middle-Click Paste"
              description="Paste clipboard on middle mouse click"
            >
              <Toggle
                label="Middle-click paste"
                checked={settings.keyboard.pasteOnMiddleClick}
                onChange={(v) =>
                  updateSettings("keyboard", { pasteOnMiddleClick: v })
                }
              />
            </SettingRow>

            <SettingRow
              label="Scroll on Output"
              description="Auto-scroll when new output appears"
            >
              <Toggle
                label="Scroll on output"
                checked={settings.keyboard.scrollOnOutput}
                onChange={(v) =>
                  updateSettings("keyboard", { scrollOnOutput: v })
                }
              />
            </SettingRow>

            <SettingRow
              label="Scroll on Keypress"
              description="Scroll to bottom when typing"
            >
              <Toggle
                label="Scroll on keypress"
                checked={settings.keyboard.scrollOnKeyPress}
                onChange={(v) =>
                  updateSettings("keyboard", { scrollOnKeyPress: v })
                }
              />
            </SettingRow>
          </div>
        );

      case "window":
        return (
          <div className="space-y-1">
            <SettingRow
              label="Always on Top"
              description="Keep window above other applications"
            >
              <Toggle
                label="Always on top"
                checked={settings.window.alwaysOnTop}
                onChange={(v) => updateSettings("window", { alwaysOnTop: v })}
              />
            </SettingRow>

            <SettingRow
              label="Remember Window Position"
              description="Restore position on next launch"
            >
              <Toggle
                label="Remember window position"
                checked={settings.window.rememberWindowPosition}
                onChange={(v) =>
                  updateSettings("window", { rememberWindowPosition: v })
                }
              />
            </SettingRow>

            <SettingRow
              label="Tab Position"
              description="Location of terminal tabs"
            >
              <Select
                value={settings.window.tabPosition}
                options={[
                  { id: "top", name: "Top" },
                  { id: "bottom", name: "Bottom" },
                ]}
                onChange={(v) =>
                  updateSettings("window", { tabPosition: v as any })
                }
              />
            </SettingRow>

            <SettingRow
              label="Show Tab Close Button"
              description="Display X button on each tab"
            >
              <Toggle
                label="Show tab close button"
                checked={settings.window.showTabCloseButton}
                onChange={(v) =>
                  updateSettings("window", { showTabCloseButton: v })
                }
              />
            </SettingRow>

            <SettingRow
              label="Confirm Close Multiple Tabs"
              description="Ask before closing window with multiple tabs"
            >
              <Toggle
                label="Confirm before closing multiple tabs"
                checked={settings.window.confirmCloseMultipleTabs}
                onChange={(v) =>
                  updateSettings("window", { confirmCloseMultipleTabs: v })
                }
              />
            </SettingRow>
          </div>
        );



      case "security":
        return (
          <div className="space-y-1">
            {/* Vault Unlock Section */}
            <div className="py-5 border-b border-white/5">
              <div className="flex items-center justify-between mb-3">
                <div className="min-w-0 flex-1">
                  <label className="block text-sm font-semibold text-gray-100 mb-1">
                    Credential Vault
                  </label>
                  <p className="text-xs text-gray-500 font-medium leading-relaxed">
                    {!vaultStatusLoaded
                      ? "Checking the local credential vault status..."
                      : vaultInitialized
                      ? "Unlock the vault to use stored SSH/SFTP credentials when connecting. Unlock stays active for this session."
                      : "Create a local master password after installation. Stored passwords, private keys, and hosts that use saved secrets require an unlocked vault."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {!vaultStatusLoaded ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                      <IoRefresh size={14} className="animate-spin" />
                      Checking
                    </span>
                  ) : !vaultInitialized ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                      <IoLockClosed size={14} />
                      Not set up
                    </span>
                  ) : isVaultUnlocked ? (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                      <IoLockOpen size={14} />
                      Unlocked
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                      <IoLockClosed size={14} />
                      Locked
                    </span>
                  )}
                </div>
              </div>

              {vaultStatusLoaded && !vaultInitialized && (
                <div className="mb-3 rounded-control border border-white/[0.08] bg-white/[0.045] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl">
                  <div className="flex items-start gap-3">
                    <IoShieldCheckmarkOutline size={18} className="mt-0.5 shrink-0 text-amber-300/90" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-gray-100">Welcome to Netrix</div>
                      <p className="mt-1 text-xs leading-5 text-gray-400">
                        Netrix works locally and does not require an account. Start by protecting the SSH/SFTP passwords and private keys you want to save.
                      </p>
                      <div className="mt-3 grid gap-2 md:grid-cols-3">
                        {[
                          ["1", "Create the Vault", "Choose and confirm a local master password."],
                          ["2", "Add a connection", "Save a host or use Quick Connect without saving secrets."],
                          ["3", "Open your tools", "Use Terminal, SSH Files, snippets, maps, and utilities."],
                        ].map(([step, title, description]) => (
                          <div key={step} className="rounded-md border border-white/[0.07] bg-black/15 p-2.5">
                            <div className="text-[10px] font-bold uppercase tracking-wide text-amber-300/80">Step {step}</div>
                            <div className="mt-1 text-xs font-semibold text-gray-200">{title}</div>
                            <p className="mt-1 text-[11px] leading-4 text-gray-500">{description}</p>
                          </div>
                        ))}
                      </div>
                      <p className="mt-3 text-[11px] leading-4 text-amber-200/75">
                        Use at least 10 characters. Netrix cannot recover the master password; resetting the Vault deletes saved secrets but keeps host profiles. Quick Connect and features without saved secrets remain available while the Vault is locked.
                      </p>
                      {settings.security.vaultRememberPassword && (
                        <p className="mt-1 text-[11px] leading-4 text-gray-500">
                          Remember Vault Password is enabled, so Netrix will ask the operating system keychain to store it on this device. You can disable this below.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 mb-3">
                <div className="rounded-control border border-white/10 bg-white/5 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Secrets</div>
                  <div className="text-sm font-semibold text-gray-100">{vaultSecretItems}</div>
                </div>
                <div className="rounded-control border border-white/10 bg-white/5 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500">Linked Hosts</div>
                  <div className="text-sm font-semibold text-gray-100">{vaultLinkedHosts}</div>
                </div>
              </div>

              {!vaultStatusLoaded ? (
                <div className="text-xs text-gray-500">Waiting for Vault status...</div>
              ) : isVaultUnlocked ? (
                <button
                  onClick={async () => {
                    const result = await lockVault();
                    addToast(
                      result.ok
                        ? "Vault locked"
                        : result.error || "Failed to lock vault",
                      result.ok ? "info" : "error",
                    );
                  }}
                  className="px-4 py-2 rounded-control bg-red-500/15 text-red-400 text-xs font-medium hover:bg-red-500/25 transition-colors"
                >
                  Lock Vault
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="password"
                    placeholder={vaultInitialized ? "Master password" : "New master password"}
                    value={masterPassword}
                    onChange={(e) => setMasterPassword(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && masterPassword) {
                        await submitVaultUnlock();
                      }
                    }}
                    autoComplete={vaultInitialized ? "current-password" : "new-password"}
                    className="flex-1 px-3 py-2 rounded-control bg-white/5 border border-white/10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                  />
                  {!vaultInitialized && (
                    <input
                      type="password"
                      placeholder="Confirm master password"
                      value={masterPasswordConfirmation}
                      onChange={(e) => setMasterPasswordConfirmation(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && masterPassword && masterPasswordConfirmation) {
                          await submitVaultUnlock();
                        }
                      }}
                      autoComplete="new-password"
                      className="min-w-[190px] flex-1 px-3 py-2 rounded-control bg-white/5 border border-white/10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                    />
                  )}
                  <button
                    onClick={() => void submitVaultUnlock()}
                    disabled={vaultLoading || !masterPassword || (!vaultInitialized && !masterPasswordConfirmation)}
                    className="px-4 py-2 rounded-control bg-primary/15 text-primary text-xs font-medium hover:bg-primary/25 transition-colors disabled:opacity-30"
                  >
                    {vaultLoading ? "..." : vaultInitialized ? "Unlock" : "Create & Unlock"}
                  </button>
                  {vaultInitialized && settings.security.vaultRememberPassword && settings.security.vaultUnlockMode === "session" && hasStoredVaultPassword && (
                    <button
                      onClick={unlockWithStoredPassword}
                      disabled={vaultSavedUnlockBusy || vaultLoading}
                      className="px-4 py-2 rounded-control bg-emerald-500/15 text-emerald-300 text-xs font-medium hover:bg-emerald-500/25 transition-colors disabled:opacity-30"
                    >
                      {vaultSavedUnlockBusy ? "..." : "Use Saved"}
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="py-5 border-b border-white/5 space-y-3">
              <div>
                <label className="block text-sm font-semibold text-gray-100 mb-1">
                  Change Master Password
                </label>
                <p className="text-xs text-gray-500 font-medium leading-relaxed">
                  Change the password for the encrypted workspace and vault without losing saved data or credentials.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <input
                  type="password"
                  placeholder="Current password"
                  value={changeCurrentPassword}
                  onChange={(e) => setChangeCurrentPassword(e.target.value)}
                  className="px-3 py-2 rounded-control bg-white/5 border border-white/10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
                <input
                  type="password"
                  placeholder="New password"
                  value={changeNewPassword}
                  onChange={(e) => setChangeNewPassword(e.target.value)}
                  className="px-3 py-2 rounded-control bg-white/5 border border-white/10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
                <input
                  type="password"
                  placeholder="Confirm new password"
                  value={changeConfirmPassword}
                  onChange={(e) => setChangeConfirmPassword(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && !changePasswordBusy) {
                      await submitChangeMasterPassword();
                    }
                  }}
                  className="px-3 py-2 rounded-control bg-white/5 border border-white/10 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-gray-500">Minimum length: 10 characters</span>
                <button
                  onClick={submitChangeMasterPassword}
                  disabled={changePasswordBusy || !isVaultUnlocked}
                  className="px-4 py-2 rounded-control bg-blue-500/15 text-blue-300 text-xs font-medium hover:bg-blue-500/25 transition-colors disabled:opacity-30"
                >
                  {changePasswordBusy ? "Updating..." : "Update Password"}
                </button>
              </div>

              {!isVaultUnlocked && (
                <div className="text-xs text-amber-300">Unlock vault first to change master password.</div>
              )}
              {changePasswordError && (
                <div className="text-xs text-red-300">{changePasswordError}</div>
              )}
              {changePasswordSummary && (
                <div className="text-xs text-emerald-300">{changePasswordSummary}</div>
              )}
            </div>

            <div className="py-5 border-b border-white/5">
              <div className="rounded-card border border-red-500/30 bg-red-950/20 p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <label className="block text-sm font-semibold text-red-200 mb-1">
                      Reset Vault
                    </label>
                    <p className="text-xs text-red-300/90 leading-relaxed">
                      This permanently deletes all encrypted vault secrets and detaches saved credentials from hosts.
                      {databaseEncrypted && " Your workspace master password stays unchanged. Hosts, snippets and network maps are kept."}
                    </p>
                  </div>
                </div>

                <p className="text-xs text-red-300">
                  To confirm, type: <span className="font-semibold">{VAULT_RESET_CONFIRMATION}</span>
                </p>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder={VAULT_RESET_CONFIRMATION}
                    value={vaultResetPhrase}
                    onChange={(e) => {
                      setVaultResetPhrase(e.target.value);
                      if (vaultResetError) setVaultResetError(null);
                    }}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && !vaultResetBusy) {
                        await submitVaultReset();
                      }
                    }}
                    className="flex-1 px-3 py-2 rounded-control bg-black/30 border border-red-400/30 text-xs text-red-100 placeholder-red-300/60 focus:outline-none focus:border-red-300"
                  />
                  <button
                    onClick={submitVaultReset}
                    disabled={vaultResetBusy || vaultResetPhrase.trim() !== VAULT_RESET_CONFIRMATION}
                    className="px-4 py-2 rounded-control border border-red-400/40 bg-red-500/20 text-xs text-red-100 hover:bg-red-500/30 disabled:opacity-50"
                  >
                    {vaultResetBusy ? "Resetting..." : "Reset Vault"}
                  </button>
                </div>

                {vaultResetError && (
                  <div className="text-xs text-red-300">{vaultResetError}</div>
                )}

                {vaultResetSummary && (
                  <div className="text-xs text-amber-300">
                    Vault reset completed: detached {vaultResetSummary.detachedHosts} host credentials, deleted {vaultResetSummary.deletedItems} vault items.
                  </div>
                )}
              </div>
            </div>

            {databaseEncrypted ? <SettingRow label="Encrypted workspace" description="Your entire SQLite database is encrypted. Enter the master password on every app start.">
              <span className="text-xs font-medium text-emerald-300">SQLCipher · AES-256</span>
            </SettingRow> : <SettingRow
              label="Vault Unlock Mode"
              description="Choose when the vault requires the master password"
            >
              <Select
                value={settings.security.vaultUnlockMode}
                options={[
                  { id: "session", name: "Unlock once per app session" },
                  { id: "every_start", name: "Require on each app start" },
                ]}
                onChange={(v) =>
                  updateSettings("security", { vaultUnlockMode: v as any })
                }
              />
            </SettingRow>}

            <SettingRow
              label="Remember Vault Password"
              description="Remember in Windows Credential Manager for vault unlock within an open workspace. Opening the database or unlocking the application always requires entering the master password."
            >
              <Toggle
                label="Remember vault password"
                checked={settings.security.vaultRememberPassword}
                onChange={(v) =>
                  updateSettings("security", { vaultRememberPassword: v })
                }
              />
            </SettingRow>

            <SettingRow
              label="Vault Auto-Lock"
              description="Remove the vault key after inactivity across all windows. Existing terminals remain usable."
            >
              <div className="flex items-center gap-4">
                <Toggle
                  label="Vault auto-lock"
                  checked={settings.security.vaultAutoLockEnabled}
                  onChange={(v) =>
                    updateSettings("security", { vaultAutoLockEnabled: v })
                  }
                />
              </div>
            </SettingRow>

            {settings.security.vaultAutoLockEnabled && (
              <SettingRow
                label="Vault Auto-Lock Timeout"
                description="Minutes of inactivity before vault lock"
              >
                <Slider
                  value={settings.security.vaultAutoLockTimeout}
                  min={5}
                  max={240}
                  step={5}
                  onChange={(v) =>
                    updateSettings("security", { vaultAutoLockTimeout: v })
                  }
                  unit=" min"
                />
              </SettingRow>
            )}

            <SettingRow
              label="Auto-Lock"
              description="Protect every Netrix window and block terminal input after inactivity. Requires a configured vault master password."
            >
              <div className="flex items-center gap-4">
                <Toggle
                  label="Application auto-lock"
                  checked={settings.security.autoLockEnabled}
                  onChange={(v) =>
                    updateSettings("security", { autoLockEnabled: v })
                  }
                />
              </div>
            </SettingRow>

            <SettingRow label="Lock all windows" description="Hide your workspace and pause terminal input. Connections remain open.">
              <button type="button" disabled={!vaultInitialized}
                onClick={() => { void lockApplication().catch((error: unknown) => {
                  useAppStore.getState().addToast(error instanceof Error ? error.message : "Could not lock Netrix", "error");
                }); }}
                className="rounded-control border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary disabled:opacity-40">
                Lock Netrix
              </button>
            </SettingRow>

            {settings.security.autoLockEnabled && (
              <SettingRow
                label="Auto-Lock Timeout"
                description="Minutes of inactivity before lock"
              >
                <Slider
                  value={settings.security.autoLockTimeout}
                  min={1}
                  max={60}
                  onChange={(v) =>
                    updateSettings("security", { autoLockTimeout: v })
                  }
                  unit=" min"
                />
              </SettingRow>
            )}

            <SettingRow
              label="Clear Clipboard After"
              description="Auto-clear clipboard (0 = disabled)"
            >
              <Slider
                value={settings.security.clearClipboardAfter}
                min={0}
                max={300}
                step={10}
                onChange={(v) =>
                  updateSettings("security", { clearClipboardAfter: v })
                }
                unit="s"
              />
            </SettingRow>

            <SettingRow
              label="Confirm Before Disconnect"
              description="Ask before closing active connections"
            >
              <Toggle
                label="Confirm before disconnect"
                checked={settings.security.confirmBeforeDisconnect}
                onChange={(v) =>
                  updateSettings("security", { confirmBeforeDisconnect: v })
                }
              />
            </SettingRow>
          </div>
        );
    }
  };

  return (
    <div className="settings-workspace ui-focus flex h-full w-full overflow-hidden bg-[#0b1118]">
      {/* Sidebar - Matte Glass effect */}
      <div className="settings-sidebar w-[224px] shrink-0 bg-[#0e1721] border-r border-white/[0.07] flex flex-col pt-4">
        <div className="flex items-center gap-3 mb-5 px-4">
          <div className="p-2 bg-sky-300/10 rounded-card text-sky-300">
            <IoSettings size={22} />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white leading-none">
              Settings
            </h1>
            <p className="text-[11px] text-slate-400 mt-2">
              Configure Netrix
            </p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-2 overflow-y-auto scrollbar-thin">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isActive = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                aria-pressed={isActive}
                onClick={() => setActiveCategory(cat.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-control text-left transition-all group relative ${
                  isActive
                    ? "bg-sky-300/10 text-sky-200 border border-sky-300/20"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-100 border border-transparent"
                }`}
              >
                <div
                  className={`p-1.5 rounded-control transition-colors ${isActive ? "bg-primary/20 text-sky-300" : "bg-[#1a1a24] text-gray-500 group-hover:text-gray-300"}`}
                >
                  <Icon size={18} />
                </div>
                <div className="flex-1">
                  <span className={`block text-xs font-medium transition-colors ${isActive ? "text-sky-200" : "text-gray-300 group-hover:text-white"}`}>
                    {cat.label}
                  </span>
                  <span
                    className={`block text-[10px] font-medium leading-none mt-1 transition-colors ${isActive ? "text-sky-300/80" : "text-slate-400 group-hover:text-slate-300"}`}
                  >
                    {cat.description}
                  </span>
                </div>
                {isActive && (
                  <div className="absolute left-0 w-1 h-6 bg-primary rounded-r-full shadow-glow-sm" />
                )}
                {isActive && (
                  <IoChevronForward size={14} className="text-primary/40" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-white/[0.07] space-y-1 mt-auto">
          <button
            onClick={handleReset}
            className="w-full flex items-center gap-3 px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 hover:text-white hover:bg-white/5 rounded-card transition-all"
          >
            <IoRefresh size={16} />
            <span>Reset Category</span>
          </button>
          <button
            onClick={handleResetAll}
            className="w-full flex items-center gap-3 px-4 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-card transition-all"
          >
            <IoRefresh size={16} />
            <span>Reset All</span>
          </button>

          <div className="mt-3 border-t border-white/[0.07] px-2 pt-3 text-[11px] text-slate-400">
            <div className="flex items-center justify-between"><span>Netrix</span><span className="font-mono">v{appVersion}</span></div>
            <p className="mt-2 text-[10px] text-slate-500">Built with AI assistance</p>
          </div>
        </div>
      </div>

      {/* Content Area - Absolute positioning for reliable scrolling */}
      <div className="settings-content flex-1 min-w-0 relative">
        <div className="absolute inset-0 overflow-y-auto p-4 lg:p-6 flex flex-col items-center">
          <div className="w-full max-w-4xl pb-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-5">
            {(() => {
              const cat = CATEGORIES.find((c) => c.id === activeCategory);
              if (!cat) return null;
              const Icon = cat.icon;
              return (
                <>
                  <div className="p-2.5 bg-sky-300/10 rounded-card text-sky-300 border border-sky-300/20">
                    <Icon size={22} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white leading-6">
                      {cat.label}
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      {cat.description}
                    </p>
                  </div>
                </>
              );
            })()}
          </div>

          {/* Main Card - Simple wrapper that grows with content */}
          <section className="ui-card relative mb-4">
            <div className="px-4 py-1 lg:px-5 relative z-10">
                {renderContent()}
            </div>
          </section>

          {/* Footer Status */}
          <div className="mb-4 flex items-center gap-3 px-6 text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 shrink-0">
            <div className="w-6 h-6 bg-green-500/10 rounded-full flex items-center justify-center text-green-500 ring-1 ring-green-500/20">
              <IoCheckmark size={14} />
            </div>
            <span className="opacity-50">Settings are saved automatically</span>
          </div>

          {/* Motivational CTA Block */}
          <div className="ui-card mt-5 p-5 text-center relative overflow-hidden">
            <div className="relative z-10">
              <div className="w-14 h-14 mx-auto mb-5 bg-primary/10 rounded-card flex items-center justify-center text-primary ring-1 ring-primary/20">
                <IoHeart size={28} />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">
                Help Us Build Something Great
              </h3>
              <p className="text-gray-400 text-sm leading-relaxed max-w-md mx-auto mb-5">
                We're on a mission to create the most intuitive and powerful terminal experience. 
                Your feedback helps us improve every day.
              </p>
              <div className="flex items-center justify-center">
                <TelegramCommunityLink
                  className="px-6 py-3 bg-primary/10 hover:bg-primary/20 text-primary font-semibold text-sm rounded-card transition-all ring-1 ring-primary/20 hover:ring-primary/40 flex items-center gap-2"
                  iconSize={20}
                />
              </div>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
