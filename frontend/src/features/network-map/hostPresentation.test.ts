import { describe, expect, it } from "vitest";
import type { SavedHostDto } from "../../types/host";
import { colorForHost, hostSearchText, iconForHost } from "./hostPresentation";

const host = (connectionType: SavedHostDto["connection_type"]): SavedHostDto => ({
  id: 1,
  revision: 0,
  name: "Core Router",
  hostname: "router.example",
  port: 22,
  username: "Admin",
  connection_type: connectionType,
  group: "Production",
});

describe("network map host presentation", () => {
  it("keeps protocol-specific icon and color mappings", () => {
    expect([iconForHost(host("ssh")), colorForHost(host("ssh"))]).toEqual([
      "server",
      "#3b82f6",
    ]);
    expect([iconForHost(host("telnet")), colorForHost(host("telnet"))]).toEqual([
      "router",
      "#10b981",
    ]);
    expect([iconForHost(host("serial")), colorForHost(host("serial"))]).toEqual([
      "switch",
      "#8b5cf6",
    ]);
  });

  it("normalizes every searchable host field", () => {
    expect(hostSearchText(host("ssh"))).toBe(
      "core router router.example admin production ssh",
    );
  });
});
