import React, { useState } from "react";
import { useAppStore, type AppSettings } from "../../state/store";
import { downloadJson, safePreferences } from "./api";
import { connectionRequest as request } from "./api";
import { input, button, Field, useTask } from "./shared";
export default function Backups() {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [restorePhrase, setRestorePhrase] = useState("");
  const [archive, setArchive] = useState<unknown>(null);
  const [filename, setFilename] = useState("");
  const task = useTask();
  const unlocked = useAppStore((state) => state.isVaultUnlocked);
  return (
    <div className="ui-card max-w-3xl space-y-5 p-5">
      <h2 className="font-semibold text-white">Encrypted backup & restore</h2>
      <p className="text-sm leading-6 text-gray-400">
        Backups include hosts, encrypted credentials, snippets, maps, actions, highlighting and
        saved tunnels. Settings are included. Use a separate backup password of at least 12
        characters. Server trust is verified independently on each computer.
      </p>
      <Field label="Backup password">
        <input
          type="password"
          autoComplete="new-password"
          className={input}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label="Confirm password for a new export">
        <input
          type="password"
          autoComplete="new-password"
          className={input}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </Field>
      <button
        className={button}
        disabled={task.busy || !unlocked || password.length < 12 || password !== confirmation}
        onClick={() =>
          void task.run(async () => {
            const state = useAppStore.getState();
            const value = await request("/backups/export", "POST", {
              password,
              preferences: {
                settings: state.settings,
                terminalLayout: state.terminalLayout,
                definedGroups: Array.from(state.definedGroups),
                collapsedGroups: Array.from(state.collapsedGroups),
              },
            });
            downloadJson(
              value,
              `netrix-${new Date().toISOString().slice(0, 10)}.netrix-backup.json`,
            );
            setPassword("");
            setConfirmation("");
          }, "Encrypted backup prepared.")
        }
      >
        Export encrypted backup
      </button>
      {!unlocked && (
        <p className="text-sm text-amber-300">
          Unlock or create this computer’s vault before exporting or restoring.
        </p>
      )}
      <div className="space-y-4 rounded-card border border-amber-400/20 bg-amber-400/5 p-4">
        <h3 className="font-semibold text-amber-200">Restore replaces the current workspace</h3>
        <p className="text-sm text-gray-400">
          Export the current workspace first. Close all terminal sessions and tunnels. Restored
          credentials will use this computer’s existing vault password.
        </p>
        <input
          aria-label="Choose encrypted backup"
          type="file"
          accept=".json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            setArchive(null);
            setFilename("");
            setRestorePhrase("");
            if (file)
              void task.run(async () => {
                if (file.size > 24 * 1024 * 1024) throw new Error("Backup file exceeds 24 MiB");
                const value: unknown = JSON.parse(await file.text());
                if (
                  !value ||
                  typeof value !== "object" ||
                  !("ciphertext" in value) ||
                  !("salt" in value)
                )
                  throw new Error("Choose a Netrix encrypted backup");
                setArchive(value);
                setFilename(file.name);
              });
            event.target.value = "";
          }}
        />
        {filename && <p className="text-sm text-gray-300">Selected: {filename}</p>}
        <Field label="Type RESTORE BACKUP to confirm replacement">
          <input
            className={input}
            value={restorePhrase}
            onChange={(event) => setRestorePhrase(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <button
          className={button}
          disabled={
            task.busy || !unlocked || !archive || !password || restorePhrase !== "RESTORE BACKUP"
          }
          onClick={() =>
            void task.run(async () => {
              const result = await request<{
                preferences?: {
                  settings?: unknown;
                  terminalLayout?: unknown;
                  definedGroups?: unknown;
                  collapsedGroups?: unknown;
                };
              }>("/backups/restore", "POST", { password, archive, confirmation: restorePhrase });
              const state = useAppStore.getState();
              const preferences = safePreferences(
                result.preferences?.settings,
                state.settings as unknown as Record<string, unknown>,
              );
              for (const category of Object.keys(preferences) as (keyof AppSettings)[]) {
                const saved = state.updateSettings(
                  category,
                  preferences[category] as Partial<AppSettings[typeof category]>,
                );
                if (!saved)
                  throw new Error(
                    "Workspace restored, but local preferences could not be saved. Check local storage before reloading.",
                  );
              }
              const layout = result.preferences?.terminalLayout;
              if (
                layout === "single" ||
                layout === "columns" ||
                layout === "rows" ||
                layout === "grid"
              )
                state.setTerminalLayout(layout);
              for (const name of ["definedGroups", "collapsedGroups"] as const) {
                const incoming = result.preferences?.[name];
                const groups = Array.isArray(incoming)
                  ? incoming
                      .filter(
                        (value): value is string =>
                          typeof value === "string" && value.length <= 100,
                      )
                      .slice(0, 10000)
                  : [];
                localStorage.setItem(name, JSON.stringify(groups));
                useAppStore.setState({ [name]: new Set(groups) });
              }
              localStorage.removeItem("netrix_layout");
              setPassword("");
              setConfirmation("");
              setArchive(null);
              window.location.reload();
            })
          }
        >
          {task.busy ? "Restoring…" : "Replace workspace from backup"}
        </button>
      </div>
      {task.feedback}
    </div>
  );
}
