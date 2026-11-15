import type { HostConnectionFields, SavedHostDto } from "../../types/host";
import { normalizeGroupPath } from "../../utils/groupUtils";

export type HostSort = "name" | "endpoint" | "protocol" | "group" | "recent";
export interface HostsPreferences { sort: HostSort; descending: boolean; grouped: boolean }
export const defaultHostsPreferences: HostsPreferences = { sort: "name", descending: false, grouped: true };
export function parseHostsPreferences(value: unknown): HostsPreferences {
  const data = value && typeof value === "object" ? value as Partial<HostsPreferences> : {};
  return {
    sort: ["name", "endpoint", "protocol", "group", "recent"].includes(data.sort || "") ? data.sort! : "name",
    descending: typeof data.descending === "boolean" ? data.descending : false,
    grouped: typeof data.grouped === "boolean" ? data.grouped : true,
  };
}

export function hostEndpoint(host: HostConnectionFields): string {
  if (host.connection_type === "serial") return host.serial_port || "No serial port";
  if (host.connection_type === "local") return host.local_command || "Default shell";
  const address = host.hostname.includes(":") && !host.hostname.startsWith("[") ? `[${host.hostname}]` : host.hostname;
  return `${address}:${host.port}`;
}

export function hostSecondary(host: HostConnectionFields): string {
  if (host.connection_type === "serial") return `${host.serial_speed || 9600} baud`;
  if (host.connection_type === "local") return host.local_cwd || "Home directory";
  return host.username || "Default user";
}

export function hostCredentialLabel(host: SavedHostDto): string {
  if (host.connection_type === "local" || host.connection_type === "serial") return "";
  if (host.has_private_key) return "Private key";
  if (host.has_password) return "Password";
  if (host.credential_id) return "Vault credential";
  return "No saved credential";
}

export function hostGroupPaths(hosts: SavedHostDto[], defined: Set<string>): string[] {
  const paths = new Set<string>();
  for (const path of [...hosts.map((host) => host.group), ...defined]) {
    const parts = normalizeGroupPath(path).split("/").filter(Boolean);
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
  }
  return [...paths].sort(new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare);
}

export interface HostFilters { query: string; protocol: string; group: string | null; recentOnly: boolean }
export function visibleHosts(hosts: SavedHostDto[], filters: HostFilters, preferences: HostsPreferences, recent: Map<number, number>): SavedHostDto[] {
  const tokens = filters.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return hosts.filter((host) => {
    const group = normalizeGroupPath(host.group);
    if (filters.protocol !== "all" && host.connection_type !== filters.protocol) return false;
    if (filters.group !== null && group !== filters.group && !(filters.group && group.startsWith(`${filters.group}/`))) return false;
    if (filters.recentOnly && !recent.has(host.id)) return false;
    const searchable = [host.name, hostEndpoint(host), hostSecondary(host), host.connection_type, group || "Ungrouped"].join(" ").toLocaleLowerCase();
    return tokens.every((token) => searchable.includes(token));
  }).sort((left, right) => {
    let comparison = 0;
    if (preferences.sort === "recent") {
      const a = recent.get(left.id), b = recent.get(right.id);
      if (a === undefined || b === undefined) return a === b ? collator.compare(left.name, right.name) || left.id - right.id : a === undefined ? 1 : -1;
      comparison = a - b;
    } else {
      const key = (host: SavedHostDto) => preferences.sort === "endpoint" ? hostEndpoint(host)
        : preferences.sort === "protocol" ? host.connection_type
          : preferences.sort === "group" ? normalizeGroupPath(host.group) : host.name;
      comparison = collator.compare(key(left), key(right));
    }
    return comparison * (preferences.descending ? -1 : 1) || collator.compare(left.name, right.name) || left.id - right.id;
  });
}
