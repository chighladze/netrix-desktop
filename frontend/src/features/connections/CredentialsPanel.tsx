import React, { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../state/store";
import { copyTextWithAutoClear } from "../../utils/clipboard";
import { connectionRequest as request } from "./api";
import { input, button, Field, useTask, refreshHosts } from "./shared";
interface Credential {
  id: number;
  name: string;
  linked_hosts: number;
  metadata: { type?: string; username?: string; public_key?: string };
}
export default function Credentials() {
  const [items, setItems] = useState<Credential[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [mode, setMode] = useState("password");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [hostId, setHostId] = useState("");
  const hosts = useAppStore((state) => state.hosts);
  const unlocked = useAppStore((state) => state.isVaultUnlocked);
  const task = useTask();
  const load = useCallback(async () => setItems(await request<Credential[]>("/credentials")), []);
  useEffect(() => {
    void task.run(load);
  }, [load]);
  const clear = () => {
    setEditing(null);
    setName("");
    setUsername("");
    setPassword("");
    setKey("");
    setPassphrase("");
  };
  return (
    <div className="connections-columns">
      <form
        className="space-y-4 ui-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(
            async () => {
              await request(
                editing ? `/credentials/${editing}` : "/credentials",
                editing ? "PUT" : "POST",
                {
                  name,
                  username: username || undefined,
                  password: mode === "password" ? password : undefined,
                  private_key: mode === "import" ? key : undefined,
                  generate: ["ed25519", "rsa"].includes(mode) ? mode : undefined,
                  passphrase: mode !== "password" && passphrase ? passphrase : undefined,
                },
              );
              clear();
              await load();
              await useAppStore.getState().refreshVaultStatus();
            },
            editing
              ? "Credential replaced for all linked hosts."
              : "Credential stored in the encrypted vault.",
          );
        }}
      >
        <h2 className="font-semibold text-white">
          {editing ? "Replace credential" : "New key or identity"}
        </h2>
        {!unlocked && (
          <p className="text-xs text-amber-300">
            Unlock the vault to create, replace, assign or delete credentials.
          </p>
        )}
        {editing && (
          <p className="text-xs text-amber-300">
            This replaces the secret used by every linked host. Leave no required secret field
            empty.
          </p>
        )}
        <Field label="Name">
          <input
            required
            maxLength={255}
            className={input}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Username (optional)">
          <input
            maxLength={255}
            className={input}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Authentication">
          <select
            className={input}
            value={mode}
            onChange={(event) => {
              setMode(event.target.value);
              setPassword("");
              setKey("");
              setPassphrase("");
            }}
          >
            <option value="password">Password identity</option>
            <option value="ed25519">Generate ED25519 key</option>
            <option value="rsa">Generate RSA key</option>
            <option value="import">Import private key</option>
          </select>
        </Field>
        {mode === "password" ? (
          <Field label="Password">
            <input
              required
              type="password"
              autoComplete="new-password"
              className={input}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
        ) : (
          <>
            {mode === "import" && (
              <Field label="OpenSSH / PEM private key">
                <textarea
                  required
                  rows={6}
                  className={`${input} font-mono text-xs`}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                />
                <input
                  type="file"
                  accept=".pem,.key,*"
                  className="text-xs"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file)
                      void task.run(async () => {
                        if (file.size > 128 * 1024) throw new Error("Private key exceeds 128 KiB");
                        setKey(await file.text());
                      });
                    event.target.value = "";
                  }}
                />
              </Field>
            )}
            <Field
              label={
                mode === "import" ? "Key passphrase (if encrypted)" : "Optional key passphrase"
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                className={input}
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </Field>
          </>
        )}
        <div className="flex gap-2">
          <button disabled={task.busy || !unlocked} className={button}>
            {task.busy ? "Working…" : editing ? "Replace secret" : "Create"}
          </button>
          {editing && (
            <button type="button" className={button} onClick={clear}>
              Cancel
            </button>
          )}
        </div>
        {task.feedback}
      </form>
      <div className="min-w-0 space-y-4">
        <form
          className="flex flex-wrap items-end gap-2 ui-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void task.run(async () => {
              await request(`/credentials/${credentialId}/hosts/${hostId}`, "POST");
              await refreshHosts();
              await load();
            }, "Credential assigned. New sessions will use it.");
          }}
        >
          <Field label="Credential">
            <select
              required
              className={input}
              value={credentialId}
              onChange={(event) => setCredentialId(event.target.value)}
            >
              <option value="">Choose credential</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="SSH host">
            <select
              required
              className={input}
              value={hostId}
              onChange={(event) => setHostId(event.target.value)}
            >
              <option value="">Choose host</option>
              {hosts
                .filter((host) => host.connection_type === "ssh")
                .map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name}
                  </option>
                ))}
            </select>
          </Field>
          <button className={`${button} ui-button-primary`} disabled={task.busy || !unlocked}>
            Assign to host
          </button>
        </form>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-white">Credentials ({items.length})</h2>
          <button className={button} disabled={task.busy} onClick={() => void task.run(load)}>
            Refresh
          </button>
        </div>
        {items.length === 0 && (
          <p className="text-sm text-gray-500">
            Create an identity or generate a key, then assign it to an SSH host.
          </p>
        )}
        {items.map((item) => (
          <article key={item.id} className="space-y-3 ui-card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="mr-auto text-sm text-white">{item.name}</strong>
              <span className="text-xs text-gray-500">
                {item.metadata.type || "vault item"} · {item.linked_hosts} hosts
              </span>
              <button
                disabled={task.busy || !unlocked}
                className={button}
                onClick={() => {
                  clear();
                  setEditing(item.id);
                  setName(item.name);
                  setUsername(item.metadata.username || "");
                }}
              >
                Replace
              </button>
              <button
                disabled={task.busy || !unlocked || item.linked_hosts > 0}
                className={button}
                onClick={() =>
                  void task.run(async () => {
                    await request(`/credentials/${item.id}`, "DELETE");
                    await load();
                  }, "Credential deleted.")
                }
              >
                Delete
              </button>
            </div>
            {item.metadata.public_key && (
              <div className="flex gap-2">
                <textarea
                  aria-label={`Public key for ${item.name}`}
                  readOnly
                  rows={2}
                  value={item.metadata.public_key}
                  className={`${input} font-mono text-xs`}
                />
                <button
                  className={button}
                  onClick={() =>
                    void task.run(async () => {
                      await copyTextWithAutoClear(item.metadata.public_key!);
                    }, "Public key copied.")
                  }
                >
                  Copy public key
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
