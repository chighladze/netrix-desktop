import type { Host } from "../../types/host";

export const iconForHost = (host: Host): string => {
  if (host.connection_type === "telnet") return "router";
  if (host.connection_type === "serial") return "switch";
  return "server";
};

export const colorForHost = (host: Host): string => {
  if (host.connection_type === "telnet") return "#10b981";
  if (host.connection_type === "serial") return "#8b5cf6";
  return "#3b82f6";
};

export const hostSearchText = (host: Host): string => [
  host.name,
  host.hostname,
  host.username,
  host.group,
  host.connection_type,
].filter(Boolean).join(" ").toLowerCase();
