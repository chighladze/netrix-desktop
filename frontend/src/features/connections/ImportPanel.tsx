import React, { useState } from "react";
import { useAppStore } from "../../state/store";
import { connectionRequest as request } from "./api";
import { input, button, Field, useTask, refreshHosts } from "./shared";
interface Candidate {
  alias: string;
  hostname: string;
  port: number;
  username: string;
  identity_files: string[];
  supported: boolean;
}
export default function ImportConfig() {
  const [content, setContent] = useState("");
  const [system, setSystem] = useState(false);
  const [preview, setPreview] = useState<{
    hosts: Candidate[];
    warnings: string[];
    revision: string;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const task = useTask();
  return (
    <div className="max-w-4xl space-y-4">
      <h2 className="font-semibold text-white">Import OpenSSH config</h2>
      <p className="text-sm text-gray-400">
        Preview hosts before importing. Existing host names are skipped. Key paths are shown for
        reference; import keys through Credentials.
      </p>
      <label className="flex gap-2 text-sm text-gray-300">
        <input
          type="checkbox"
          checked={system}
          onChange={(event) => {
            setSystem(event.target.checked);
            setPreview(null);
          }}
        />
        Read ~/.ssh/config on this computer
      </label>
      {!system && (
        <>
          <textarea
            aria-label="SSH config content"
            rows={9}
            className={`${input} font-mono text-xs`}
            placeholder={"Host production\n  HostName server.example\n  User admin\n  Port 22"}
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setPreview(null);
            }}
          />
          <input
            aria-label="Choose SSH config file"
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                void task.run(async () => {
                  if (file.size > 1024 * 1024) throw new Error("Config exceeds 1 MiB");
                  setContent(await file.text());
                  setPreview(null);
                });
              event.target.value = "";
            }}
          />
        </>
      )}
      <button
        className={button}
        disabled={task.busy}
        onClick={() =>
          void task.run(async () => {
            const value = await request<{
              hosts: Candidate[];
              warnings: string[];
              revision: string;
            }>("/ssh-config/preview", "POST", { content, system });
            setPreview(value);
            setSelected(value.hosts.filter((host) => host.supported).map((host) => host.alias));
          })
        }
      >
        Preview import
      </button>
      {task.feedback}
      {preview?.warnings.map((warning, index) => (
        <p key={index} className="text-xs text-amber-300">
          {warning}
        </p>
      ))}
      {preview && (
        <>
          <div className="divide-y divide-white/10 ui-card">
            {preview.hosts.map((host) => (
              <label
                key={host.alias}
                className={`flex gap-3 p-3 text-sm ${host.supported ? "text-gray-200" : "text-gray-600"}`}
              >
                <input
                  type="checkbox"
                  disabled={!host.supported}
                  checked={selected.includes(host.alias)}
                  onChange={(event) =>
                    setSelected((value) =>
                      event.target.checked
                        ? [...value, host.alias]
                        : value.filter((alias) => alias !== host.alias),
                    )
                  }
                />
                <span>
                  <strong>{host.alias}</strong> · {host.username ? `${host.username}@` : ""}
                  {host.hostname}:{host.port}
                  {host.identity_files.length > 0 && (
                    <span className="mt-1 block font-mono text-xs text-gray-500">
                      {host.identity_files.join(", ")}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
          <button
            className={button}
            disabled={task.busy || !selected.length}
            onClick={() =>
              void task.run(async () => {
                const result = await request<{ imported: number; skipped: string[] }>(
                  "/ssh-config/import",
                  "POST",
                  { content, system, aliases: selected, revision: preview.revision },
                );
                await refreshHosts();
                useAppStore
                  .getState()
                  .addToast(
                    `Imported ${result.imported} hosts; skipped ${result.skipped.length} existing names.`,
                    "success",
                  );
                setPreview(null);
              })
            }
          >
            Import {selected.length} selected hosts
          </button>
        </>
      )}
    </div>
  );
}
