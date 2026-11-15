import type { TerminalAppearance } from "./terminalAppearance";

export type ConnectionType = "ssh" | "telnet" | "serial" | "local";

export interface HostConnectionFields {
  name: string;
  hostname: string;
  port: number;
  username: string;
  connection_type: ConnectionType;
  serial_port?: string | null;
  serial_speed?: number | null;
  local_command?: string | null;
  local_args?: string[] | null;
  local_cwd?: string | null;
  jump_host_id?: number | null;
  group?: string;
  terminal_theme?: string;
  terminal_font_size?: number;
  terminal_background?: string | null;
  terminal_foreground?: string | null;
  terminal_appearance?: TerminalAppearance | null;
}

export type HostConnectionUpdate = Partial<HostConnectionFields>;

/** Public host shape returned by saved-host APIs. It never contains secrets. */
export interface SavedHostDto extends HostConnectionFields {
  id: number;
  revision: number;
  credential_id?: number | null;
  has_password?: boolean;
  has_private_key?: boolean;
  password?: never;
  private_key?: never;
  passphrase?: never;
}

/** Body accepted by saved-host create/update endpoints. */
export interface HostMutation {
  name: string;
  hostname: string;
  port: number;
  username: string;
  connection_type: ConnectionType;
  serial_port: string | null;
  serial_speed: number | null;
  local_command: string | null;
  local_args: string[] | null;
  local_cwd: string | null;
  group: string;
  terminal_theme: string;
  terminal_font_size: number;
  terminal_background?: string | null;
  terminal_foreground?: string | null;
  terminal_appearance?: TerminalAppearance | null;
  clear_credentials?: boolean;
  password?: string;
  private_key?: string;
  passphrase?: string;
}

export type HostPatch = Omit<Partial<HostMutation>, "group"> & { revision: number; group?: string | null; jump_host_id?: number | null };

/** Transient connection input. This object must never enter the saved-host list. */
export interface QuickConnectRequest extends HostConnectionFields {
  password?: string;
  private_key?: string;
  passphrase?: string;
}

export interface QuickConnectHost extends QuickConnectRequest {
  id: -1;
}

export type Host = SavedHostDto | QuickConnectHost;

/** Secret-free quick-connect descriptor safe for Zustand/UI state. */
export interface QuickConnectDescriptor extends HostConnectionFields {
  id: -1;
  password?: never;
  private_key?: never;
  passphrase?: never;
}

export type TerminalHost = SavedHostDto | QuickConnectDescriptor;

export const isQuickConnectHost = (host: Host): host is QuickConnectHost =>
  host.id === -1;

export const redactHostSecrets = (host: Host): TerminalHost => {
  if (!isQuickConnectHost(host)) return host;
  const { password, private_key: privateKey, passphrase, ...safe } = host;
  // Destructuring keeps transient credentials out of the object stored in
  // Zustand while preserving the required quick-connect discriminator.
  void password;
  void privateKey;
  void passphrase;
  return safe;
};
