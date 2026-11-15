import { describe, expect, it } from "vitest";
import { CONNECTION_TYPES, CONN_TYPE_KEYS, parseConnProps } from "./connectionTypes";

describe("network map connection types", () => {
  it("keeps registry keys and definitions aligned", () => {
    expect(CONN_TYPE_KEYS).toEqual(Object.keys(CONNECTION_TYPES));
    expect(CONNECTION_TYPES.ethernet).toMatchObject({
      label: "Ethernet",
      color: "#3b82f6",
      icon: "ETH",
    });
  });

  it("parses persisted connection properties", () => {
    expect(parseConnProps('{"speed":"10 Gbps","vlan":42}')).toEqual({
      speed: "10 Gbps",
      vlan: 42,
    });
  });

  it("uses an empty object for absent or malformed properties", () => {
    expect(parseConnProps(null)).toEqual({});
    expect(parseConnProps("not-json")).toEqual({});
    expect(parseConnProps("null")).toEqual({});
    expect(parseConnProps('["802.1Q"]')).toEqual({});
    expect(parseConnProps('{"vlans":[],"speed":"10Gbps","native_vlan":10,"nested":{},"overflow":1e999}')).toEqual({ speed: "10Gbps", native_vlan: 10 });
  });
});
