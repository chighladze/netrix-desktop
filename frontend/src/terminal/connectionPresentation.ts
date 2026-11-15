import type { HostConnectionFields } from "../types/host";
import type { TerminalSessionStatus } from "./TerminalSessionController";

export function connectionTarget(host: HostConnectionFields): string {
  if (host.connection_type === "local") return host.local_command || "Default shell";
  if (host.connection_type === "serial") return host.serial_port || "Serial device";
  const address = host.hostname.includes(":") && !host.hostname.startsWith("[") ? `[${host.hostname}]` : host.hostname;
  return `${address}:${host.port}`;
}

export function connectionPhase(step: string | null): string | null {
  const labels: Record<string, string> = {
    resolving: "Resolving the host address",
    connecting: "Establishing the connection",
    authenticating: "Authenticating the session",
    session: "Preparing the terminal",
  };
  return step ? labels[step] || null : null;
}

export function connectionFeedback(host: HostConnectionFields, status: TerminalSessionStatus, error: string | null, vaultLocked: boolean, sessionUnavailable: boolean) {
  const local = host.connection_type === "local", serial = host.connection_type === "serial";
  if (status === "connected") return { title: "Your terminal is ready", description: "The session is connected. Opening your terminal…", hint: "" };
  if (status === "connecting") return {
    title: local ? "Starting your shell" : serial ? "Opening the serial port" : "Connecting…",
    description: "Your terminal will open as soon as the session is ready.",
    hint: "",
  };
  if (sessionUnavailable) return { title: "This session has ended", description: "The previous session is no longer available.", hint: "Start a new session to connect again." };
  if (vaultLocked) return { title: "Unlock to connect", description: "The saved credentials are protected by your vault.", hint: "" };
  const message = (error || "").toLowerCase();
  if (host.connection_type === "ssh" && /host key|fingerprint|known_hosts/.test(message)) return { title: "Host identity needs attention", description: "The server identity could not be verified.", hint: "Verify the host fingerprint with its administrator before reconnecting." };
  if (!local && !serial && /authentication|authenticate|permission denied|incorrect password|invalid password/.test(message)) return { title: "Authentication failed", description: "The host did not accept the supplied credentials.", hint: "Check the username and saved password or private key in the host settings." };
  if (status === "disconnected") return { title: "Session disconnected", description: "The terminal connection has ended.", hint: "Reconnect when you are ready to continue." };
  if (local) return { title: "Couldn’t start the shell", description: "The local terminal could not be opened.", hint: "Check the shell command and working directory in the host settings." };
  if (serial) return { title: "Couldn’t open the device", description: "The serial port is not available.", hint: "Check the device connection, port name and whether another app is using it." };
  if (/timed? ?out|timeout|did not properly respond|failed to respond/.test(message)) return { title: "The host didn’t respond", description: "The connection attempt timed out before a session was established.", hint: "Check the address, VPN or network connection, and whether the host is reachable." };
  if (/refused/.test(message)) return { title: "Connection refused", description: "The destination refused this connection.", hint: `Check that the ${host.connection_type.toUpperCase()} service is running on port ${host.port}.` };
  return { title: "Couldn’t connect", description: "The connection could not be established.", hint: "Check the host settings and connection details below before trying again." };
}
