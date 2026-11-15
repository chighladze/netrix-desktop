import { describe, expect, it } from "vitest";
import type { SavedHostDto } from "../../types/host";
import { buildGroupTree } from "../../utils/groupUtils";
import { defaultHostsPreferences, hostCredentialLabel, hostEndpoint, hostGroupPaths, hostSecondary, parseHostsPreferences, visibleHosts, type HostFilters, type HostsPreferences } from "./presentation";

const host = (id: number, changes: Partial<SavedHostDto> = {}): SavedHostDto => ({
  id, revision: 0, name: `Server ${id}`, hostname: `10.0.0.${id}`, port: 22,
  username: "admin", connection_type: "ssh", ...changes,
});
const filters: HostFilters = { query: "", protocol: "all", group: null, recentOnly: false };
const select = (hosts: SavedHostDto[], filter: Partial<HostFilters> = {}, preferences: Partial<HostsPreferences> = {}, recent = new Map<number, number>()) =>
  visibleHosts(hosts, { ...filters, ...filter }, { ...defaultHostsPreferences, ...preferences }, recent).map(({ id }) => id);

describe("Hosts presentation", () => {
  it("sorts names and addresses naturally without mutating the source", () => {
    const hosts = [host(10), host(2), host(1)];
    expect(select(hosts)).toEqual([1, 2, 10]);
    expect(select(hosts, {}, { sort: "endpoint", descending: true })).toEqual([10, 2, 1]);
    expect(hosts.map(({ id }) => id)).toEqual([10, 2, 1]);
  });

  it("matches every search term across endpoint, username and canonical group", () => {
    const hosts = [host(1, { group: " / Prod // DB / " }), host(2, { group: "Prod/Web" })];
    expect(select(hosts, { query: "ADMIN prod/db 10.0.0" })).toEqual([1]);
    expect(select(hosts, { query: "admin missing" })).toEqual([]);
  });

  it("filters a group subtree without matching similarly named groups", () => {
    const hosts = [host(1, { group: " / Prod // DB / " }), host(2, { group: "Production" }), host(3, { group: "Prod" })];
    expect(select(hosts, { group: "Prod" })).toEqual([1, 3]);
  });

  it("distinguishes ungrouped hosts from a real Default group", () => {
    expect(select([host(1, { group: " / " }), host(2, { group: "Default" }), host(3)], { group: "" })).toEqual([1, 3]);
  });

  it("searches local and serial details and supports their protocol filters", () => {
    const hosts = [host(1, { connection_type: "local", local_command: "pwsh.exe", local_cwd: "C:/Work" }), host(2, { connection_type: "serial", serial_port: "COM4", serial_speed: 115200 })];
    expect(select(hosts, { protocol: "local", query: "pwsh work" })).toEqual([1]);
    expect(select(hosts, { protocol: "serial", query: "com4 115200" })).toEqual([2]);
  });

  it("orders recent connections by time, always leaving never-used profiles last", () => {
    const hosts = [host(1), host(2), host(3)], recent = new Map([[1, 100], [2, 200]]);
    expect(select(hosts, {}, { sort: "recent", descending: true }, recent)).toEqual([2, 1, 3]);
    expect(select(hosts, {}, { sort: "recent" }, recent)).toEqual([1, 2, 3]);
    expect(select(hosts, { recentOnly: true }, {}, recent)).toEqual([1, 2]);
  });

  it("uses stable name and ID ties when sorting protocols", () => {
    expect(select([host(3, { name: "same" }), host(2, { name: "same" }), host(1, { name: "alpha" })], {}, { sort: "protocol", descending: true })).toEqual([1, 2, 3]);
  });

  it("includes canonical parent paths and naturally sorts empty groups", () => {
    expect(hostGroupPaths([host(1, { group: " / Prod // DB / " })], new Set(["Rack 10", "Rack 2", "Prod/DB", " / "]))).toEqual(["Prod", "Prod/DB", "Rack 2", "Rack 10"]);
    const tree = buildGroupTree([], new Set(), new Set(["Rack 2/Node 2", "Rack 2/Node 10", "Rack 10"]), true);
    expect(tree.map(({ name }) => name)).toEqual(["Rack 10", "Rack 2"]);
    expect(tree[1].subgroups.map(({ name }) => name)).toEqual(["Node 10", "Node 2"]);
  });

  it("formats IPv6, ports, local shells and serial context without pretending they are SSH", () => {
    expect(hostEndpoint(host(1, { hostname: "2001:db8::1", port: 2222 }))).toBe("[2001:db8::1]:2222");
    expect(hostEndpoint(host(1, { hostname: "[::1]" }))).toBe("[::1]:22");
    expect(hostEndpoint(host(1, { connection_type: "local" }))).toBe("Default shell");
    expect(hostSecondary(host(1, { connection_type: "serial" }))).toBe("9600 baud");
    expect(hostCredentialLabel(host(1, { has_private_key: true }))).toBe("Private key");
    expect(hostCredentialLabel(host(1, { connection_type: "local" }))).toBe("");
  });

  it("validates persisted preferences and discards unrelated fields", () => {
    expect(parseHostsPreferences({ sort: "unknown", descending: "true", grouped: 0 })).toEqual(defaultHostsPreferences);
    expect(parseHostsPreferences(null)).toEqual(defaultHostsPreferences);
    expect(parseHostsPreferences({ sort: "recent", descending: true, grouped: false, password: "must not persist" })).toEqual({ sort: "recent", descending: true, grouped: false });
  });
});
