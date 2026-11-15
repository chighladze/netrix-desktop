import type { ConnectionTypeDefinition } from "./types";

export const CONNECTION_TYPES: Record<string, ConnectionTypeDefinition> = {
  ethernet: {
    label: "Ethernet",
    color: "#3b82f6",
    icon: "ETH",
    properties: [
      { key: "category", label: "Category", type: "select", options: ["Cat5e", "Cat6", "Cat6a", "Cat7", "Cat8"], default: "Cat6" },
      { key: "speed", label: "Speed", type: "select", options: ["10 Mbps", "100 Mbps", "1 Gbps", "2.5 Gbps", "5 Gbps", "10 Gbps", "25 Gbps", "40 Gbps", "100 Gbps"], default: "1 Gbps" },
      { key: "duplex", label: "Duplex", type: "select", options: ["Full", "Half", "Auto"], default: "Full" },
      { key: "vlan", label: "VLAN ID", type: "number", default: 0 },
    ],
  },
  fiber: {
    label: "Fiber Optic",
    color: "#f59e0b",
    icon: "FBR",
    properties: [
      { key: "mode", label: "Mode", type: "select", options: ["Single-mode (OS2)", "Multi-mode (OM1)", "Multi-mode (OM2)", "Multi-mode (OM3)", "Multi-mode (OM4)", "Multi-mode (OM5)"], default: "Single-mode (OS2)" },
      { key: "strands", label: "Fiber Strands", type: "number", default: 2 },
      { key: "connector", label: "Connector", type: "select", options: ["LC", "SC", "ST", "FC", "MPO/MTP", "E2000"], default: "LC" },
      { key: "speed", label: "Speed", type: "select", options: ["1 Gbps", "10 Gbps", "25 Gbps", "40 Gbps", "100 Gbps", "400 Gbps"], default: "10 Gbps" },
      { key: "wavelength", label: "Wavelength", type: "select", options: ["850 nm", "1310 nm", "1550 nm", "CWDM", "DWDM"], default: "1310 nm" },
    ],
  },
  coaxial: {
    label: "Coaxial",
    color: "#8b5cf6",
    icon: "COAX",
    properties: [
      { key: "type", label: "Cable Type", type: "select", options: ["RG-6", "RG-59", "RG-11", "RG-58", "RG-213"], default: "RG-6" },
      { key: "impedance", label: "Impedance", type: "select", options: ["50 Ω", "75 Ω"], default: "75 Ω" },
      { key: "usage", label: "Usage", type: "select", options: ["CATV", "CCTV", "DOCSIS", "RF/Antenna", "Other"], default: "CATV" },
    ],
  },
  serial: {
    label: "Serial",
    color: "#ef4444",
    dashArray: "8 4",
    icon: "SER",
    properties: [
      { key: "standard", label: "Standard", type: "select", options: ["RS-232", "RS-422", "RS-485", "USB Serial"], default: "RS-232" },
      { key: "baud_rate", label: "Baud Rate", type: "select", options: ["9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600"], default: "9600" },
      { key: "data_bits", label: "Data Bits", type: "select", options: ["7", "8"], default: "8" },
      { key: "parity", label: "Parity", type: "select", options: ["None", "Even", "Odd"], default: "None" },
      { key: "stop_bits", label: "Stop Bits", type: "select", options: ["1", "1.5", "2"], default: "1" },
    ],
  },
  wireless: {
    label: "Wireless",
    color: "#06b6d4",
    dashArray: "4 6",
    icon: "WLAN",
    properties: [
      { key: "standard", label: "Standard", type: "select", options: ["WiFi 4 (802.11n)", "WiFi 5 (802.11ac)", "WiFi 6 (802.11ax)", "WiFi 6E", "WiFi 7 (802.11be)", "WiMAX", "LTE", "5G"], default: "WiFi 6 (802.11ax)" },
      { key: "frequency", label: "Frequency", type: "select", options: ["2.4 GHz", "5 GHz", "6 GHz", "Dual-band", "Tri-band"], default: "5 GHz" },
      { key: "channel_width", label: "Channel Width", type: "select", options: ["20 MHz", "40 MHz", "80 MHz", "160 MHz", "320 MHz"], default: "80 MHz" },
      { key: "security", label: "Security", type: "select", options: ["Open", "WPA2-PSK", "WPA2-Enterprise", "WPA3-PSK", "WPA3-Enterprise"], default: "WPA3-PSK" },
      { key: "ssid", label: "SSID", type: "text", default: "" },
    ],
  },
  trunk: {
    label: "Trunk",
    color: "#10b981",
    icon: "TRK",
    properties: [
      { key: "protocol", label: "Protocol", type: "select", options: ["802.1Q", "ISL", "LACP", "PAgP"], default: "802.1Q" },
      { key: "vlans", label: "Allowed VLANs", type: "text", default: "1-4094" },
      { key: "native_vlan", label: "Native VLAN", type: "number", default: 1 },
      { key: "speed", label: "Speed", type: "select", options: ["1 Gbps", "10 Gbps", "25 Gbps", "40 Gbps", "100 Gbps"], default: "10 Gbps" },
    ],
  },
  crossover: {
    label: "Crossover",
    color: "#ec4899",
    dashArray: "12 3 3 3",
    icon: "XOVR",
    properties: [
      { key: "category", label: "Category", type: "select", options: ["Cat5e", "Cat6", "Cat6a", "Cat7"], default: "Cat6" },
      { key: "speed", label: "Speed", type: "select", options: ["100 Mbps", "1 Gbps", "10 Gbps"], default: "1 Gbps" },
    ],
  },
  custom: {
    label: "Custom",
    color: "#6b7280",
    icon: "CUST",
    properties: [
      { key: "description", label: "Description", type: "text", default: "" },
      { key: "medium", label: "Medium", type: "text", default: "" },
      { key: "bandwidth", label: "Bandwidth", type: "text", default: "" },
    ],
  },
};

export const CONN_TYPE_KEYS = Object.keys(CONNECTION_TYPES);

export function parseConnProps(
  value: string | null | undefined,
): Record<string, string | number> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, item]) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item))));
  } catch {
    return {};
  }
}
