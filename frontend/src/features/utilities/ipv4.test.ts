import { describe, expect, it } from "vitest";
import { ipToLong, longToIp } from "./ipv4";
describe("IPv4 arithmetic input", () => {
  it("preserves unsigned endpoint values and dotted decimal roundtrips", () => {
    expect(ipToLong("0.0.0.0")).toBe(0);
    expect(ipToLong("255.255.255.255")).toBe(4294967295);
    expect(longToIp(ipToLong("192.168.1.1"))).toBe("192.168.1.1");
  });
  it.each([
    "1.2.3.",
    "1..3.4",
    "1.2.3.4.5",
    "1.2.3.256",
    "1.2.3.-1",
    "1.2.3.1e2",
    "0x10.2.3.4",
    "01.2.3.4",
    "1.2. 3.4",
  ])("rejects ambiguous or malformed octets: %s", (input) => {
    expect(ipToLong(input)).toBe(-1);
  });
});
