import React, { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../state/store";
import { connectionRequest as request } from "./api";
import { input, button, Field, useTask } from "./shared";
interface Tunnel {
  id: string;
  name: string;
  host_id: number;
  kind: string;
  bind_port: number;
  destination_host?: string;
  destination_port?: number;
  active: boolean;
  actual_port?: number;
}
export default function Tunnels() {
  const hosts = useAppStore((state) => state.hosts);
  const [items, setItems] = useState<Tunnel[]>([]);
  const [name, setName] = useState("");
  const [hostId, setHostId] = useState("");
  const [kind, setKind] = useState("local");
  const [port, setPort] = useState(1080);
  const [destination, setDestination] = useState("127.0.0.1");
  const [destinationPort, setDestinationPort] = useState(5432);
  const task = useTask();
  const load = useCallback(async () => setItems(await request<Tunnel[]>("/tunnels")), []);
  useEffect(() => {
    void task.run(load);
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [load]);
  return (
    <div className="max-w-5xl space-y-5">
      <h2 className="font-semibold text-white">SSH tunnels</h2>
      <p className="text-sm text-gray-400">
        Local forwarding and SOCKS5 CONNECT listen on 127.0.0.1. Each tunnel uses a separate
        verified SSH connection. Saved rules start only when you press Start.
      </p>
      <form
        className="grid gap-3 ui-card p-4 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void task.run(async () => {
            await request("/tunnels", "POST", {
              name,
              host_id: Number(hostId),
              kind,
              bind_port: port,
              destination_host: kind === "local" ? destination : null,
              destination_port: kind === "local" ? destinationPort : null,
            });
            setName("");
            await load();
          }, "Tunnel rule saved.");
        }}
      >
        <Field label="Name">
          <input
            required
            maxLength={255}
            className={input}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
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
        <Field label="Forwarding type">
          <select className={input} value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="local">Local TCP forwarding</option>
            <option value="dynamic">Dynamic SOCKS5 proxy</option>
          </select>
        </Field>
        <Field label="Local port (0 = choose free port)">
          <input
            required
            type="number"
            min={0}
            max={65535}
            className={input}
            value={port}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </Field>
        {kind === "local" && (
          <>
            <Field label="Destination host as seen from SSH server">
              <input
                required
                className={input}
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              />
            </Field>
            <Field label="Destination port">
              <input
                required
                type="number"
                min={1}
                max={65535}
                className={input}
                value={destinationPort}
                onChange={(event) => setDestinationPort(Number(event.target.value))}
              />
            </Field>
          </>
        )}
        <button className={button} disabled={task.busy}>
          Save rule
        </button>
      </form>
      {task.feedback}
      {items.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center gap-3 ui-card p-4"
        >
          <div className="mr-auto">
            <strong className="text-sm text-white">{item.name}</strong>
            <p className="mt-1 text-xs text-gray-400">
              {hosts.find((host) => host.id === item.host_id)?.name || "SSH host"} ·{" "}
              {item.kind === "dynamic"
                ? "SOCKS5"
                : `${item.destination_host}:${item.destination_port}`}{" "}
              · 127.0.0.1:{item.actual_port ?? item.bind_port}
            </p>
          </div>
          <span className={`text-xs ${item.active ? "text-emerald-300" : "text-gray-500"}`}>
            {item.active ? "Running" : "Stopped"}
          </span>
          <button
            disabled={task.busy}
            className={button}
            onClick={() =>
              void task.run(async () => {
                await request(`/tunnels/${item.id}/${item.active ? "stop" : "start"}`, "POST");
                await load();
              })
            }
          >
            {item.active ? "Stop" : "Start"}
          </button>
          <button
            disabled={task.busy || item.active}
            className={button}
            onClick={() =>
              void task.run(async () => {
                await request(`/tunnels/${item.id}`, "DELETE");
                await load();
              })
            }
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
