import type { HostConnectionFields } from "../types/host";

/** The actual transport identity reported with the connect acknowledgement. */
export type TerminalConnectionInfo = Pick<HostConnectionFields,
  "hostname" | "port" | "username" | "connection_type" | "serial_port" |
  "serial_speed" | "local_command" | "local_args" | "local_cwd">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNullableString = (value: unknown): value is string | null | undefined =>
  value == null || typeof value === "string";
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function parseConnectionInfo(value: unknown): TerminalConnectionInfo | null {
  if (!isRecord(value)) return null;
  const info = value;
  if (typeof info.hostname !== "string" || typeof info.username !== "string"
    || typeof info.port !== "number" || !Number.isSafeInteger(info.port) || info.port < 0 || info.port > 65535
    || (info.connection_type !== "ssh" && info.connection_type !== "telnet"
      && info.connection_type !== "serial" && info.connection_type !== "local")) return null;
  if (!isNullableString(info.serial_port) || !isNullableString(info.local_command) || !isNullableString(info.local_cwd)) return null;
  if (info.serial_speed != null && (typeof info.serial_speed !== "number" || !Number.isSafeInteger(info.serial_speed) || info.serial_speed <= 0)) return null;
  if (info.local_args != null && !isStringArray(info.local_args)) return null;
  // Copy only public connection fields. Never spread a backend payload into UI state.
  return {
    hostname: info.hostname,
    port: info.port,
    username: info.username,
    connection_type: info.connection_type,
    serial_port: info.serial_port ?? null,
    serial_speed: info.serial_speed ?? null,
    local_command: info.local_command ?? null,
    local_args: info.local_args ?? null,
    local_cwd: info.local_cwd ?? null,
  };
}
