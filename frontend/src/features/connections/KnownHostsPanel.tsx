import React, { useState, useEffect, useCallback } from "react";
import { connectionRequest as request } from "./api";
import { input, button, Field, useTask } from "./shared";
interface KnownHost {
  address: string;
  key: string;
  fingerprint?: string;
}
export default function KnownHosts() {
  const [items, setItems] = useState<KnownHost[]>([]);
  const [selected, setSelected] = useState<KnownHost | null>(null);
  const [phrase, setPhrase] = useState("");
  const task = useTask();
  const load = useCallback(async () => setItems(await request<KnownHost[]>("/known-hosts")), []);
  useEffect(() => {
    void task.run(load);
  }, [load]);
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-white">Trusted SSH server keys</h2>
        <button className={button} disabled={task.busy} onClick={() => void task.run(load)}>
          Refresh
        </button>
      </div>
      <p className="text-sm text-gray-400">
        A changed server key blocks connections. Verify a rotation with the server administrator
        before removing the old key.
      </p>
      {items.length === 0 && (
        <p className="text-sm text-gray-500">
          Server keys appear after the first trusted connection.
        </p>
      )}
      {items.map((item) => (
        <div
          key={item.address}
          className="flex flex-wrap items-center gap-3 ui-card p-4"
        >
          <div className="mr-auto">
            <strong className="text-sm text-white">{item.address}</strong>
            <p className="mt-1 break-all font-mono text-xs text-gray-400">
              {item.fingerprint || item.key}
            </p>
          </div>
          <button
            className={button}
            onClick={() => {
              setSelected(item);
              setPhrase("");
            }}
          >
            Forget key…
          </button>
        </div>
      ))}
      {selected && (
        <form
          className="space-y-3 rounded-card border border-red-400/25 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void task.run(async () => {
              const split = selected.address.lastIndexOf(":");
              await request("/known-hosts", "DELETE", {
                host: selected.address.slice(0, split),
                port: Number(selected.address.slice(split + 1)),
                expected_key: selected.key,
                confirmation: phrase,
              });
              setSelected(null);
              setPhrase("");
              await load();
            }, "Trust removed. The next connection will verify and save the server key again.");
          }}
        >
          <p className="text-sm text-red-200">Remove trust for {selected.address}?</p>
          <Field label="Type FORGET HOST KEY">
            <input
              className={input}
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
            />
          </Field>
          <button disabled={task.busy || phrase !== "FORGET HOST KEY"} className={button}>
            Forget server key
          </button>
          <button type="button" className={`${button} ml-2`} onClick={() => setSelected(null)}>
            Cancel
          </button>
        </form>
      )}
      {task.feedback}
    </div>
  );
}
