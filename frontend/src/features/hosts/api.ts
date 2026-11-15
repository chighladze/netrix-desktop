import { fetchJsonOrThrow, getApiBase } from "../../api";
import type { HostMutation, HostPatch, SavedHostDto } from "../../types/host";
import { normalizeGroupPath } from "../../utils/groupUtils";
import { normalizeTerminalColor } from "../../themes";
import { sanitizeTerminalAppearance } from "../../terminal/appearance";

/** Decode saved profiles explicitly so secrets never enter shared UI state. */
export function decodeHost(value: unknown): SavedHostDto {
  if (!value || typeof value !== "object") throw new Error("Invalid host response");
  const row = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.id) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0 ||
    typeof row.name !== "string" ||
    typeof row.hostname !== "string" ||
    !Number.isInteger(row.port) ||
    !["ssh", "telnet", "serial", "local"].includes(String(row.connection_type))
  ) {
    throw new Error("Invalid host response; restart the backend and reload Hosts");
  }
  const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : undefined);
  const number = (key: string) => (typeof row[key] === "number" ? (row[key] as number) : undefined);
  return {
    id: Number(row.id),
    revision: Number(row.revision),
    name: row.name,
    hostname: row.hostname,
    port: Number(row.port),
    username: text("username") ?? "",
    connection_type: row.connection_type as SavedHostDto["connection_type"],
    group: normalizeGroupPath(text("group")) || undefined,
    credential_id: number("credential_id") ?? null,
    jump_host_id: number("jump_host_id") ?? null,
    serial_port: text("serial_port"),
    serial_speed: number("serial_speed"),
    terminal_theme: text("terminal_theme"),
    terminal_font_size: number("terminal_font_size"),
    terminal_background: normalizeTerminalColor(text("terminal_background")),
    terminal_foreground: normalizeTerminalColor(text("terminal_foreground")),
    terminal_appearance: sanitizeTerminalAppearance(row.terminal_appearance),
    local_command: text("local_command"),
    local_cwd: text("local_cwd"),
    local_args:
      Array.isArray(row.local_args) && row.local_args.every((v) => typeof v === "string")
        ? row.local_args
        : null,
    has_password: row.has_password === true,
    has_private_key: row.has_private_key === true,
  };
}

export async function requestHosts(): Promise<SavedHostDto[]> {
  const rows = await fetchJsonOrThrow<unknown>(`${await getApiBase()}/hosts/`, {}, { retries: 1 });
  if (!Array.isArray(rows)) throw new Error("Invalid hosts response");
  return rows.map(decodeHost);
}

export async function requestHost(id: number): Promise<SavedHostDto> {
  return decodeHost(await fetchJsonOrThrow<unknown>(`${await getApiBase()}/hosts/${id}`));
}

export async function writeHost(
  payload: HostMutation | HostPatch,
  id?: number,
): Promise<SavedHostDto> {
  return decodeHost(
    await fetchJsonOrThrow<unknown>(`${await getApiBase()}/hosts/${id ?? ""}`, {
      method: id === undefined ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export function buildHostPatch(initial: SavedHostDto, payload: HostMutation): HostPatch {
  const changes: Record<string, unknown> = { revision: initial.revision };
  for (const [key, value] of Object.entries(payload)) {
    if (initial.connection_type === payload.connection_type) {
      if (key.startsWith("serial_") && payload.connection_type !== "serial") continue;
      if (key.startsWith("local_") && payload.connection_type !== "local") continue;
    }
    if (
      key === "group" &&
      normalizeGroupPath(String(value ?? "")) === normalizeGroupPath(initial.group)
    )
      continue;
    const previous = initial[key as keyof SavedHostDto] ?? null;
    if (JSON.stringify(value ?? null) !== JSON.stringify(previous)) changes[key] = value;
  }
  return changes as HostPatch;
}
