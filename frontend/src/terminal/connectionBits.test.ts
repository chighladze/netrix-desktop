import { describe, expect, it } from "vitest";
import { createConnectionOctets } from "./connectionBits";

const distance = (a: string, b: string) => [...a].filter((bit, i) => bit !== b[i]).length;

describe("decorative connection bits", () => {
  it("changes every group, avoids previous values and keeps all six groups visually distinct", () => {
    let seed = 23;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
    let previous: string[] = [];
    for (let pass = 0; pass < 500; pass++) {
      const octets = createConnectionOctets(previous, random);
      expect(octets).toHaveLength(6);
      expect(new Set(octets).size).toBe(6);
      octets.forEach((octet, index) => {
        expect(octet).toMatch(/^[01]{8}$/);
        const ones = [...octet].filter(bit => bit === "1").length;
        expect(ones).toBeGreaterThanOrEqual(2);
        expect(ones).toBeLessThanOrEqual(6);
        expect(previous).not.toContain(octet);
        if (previous[index]) expect(distance(octet, previous[index])).toBeGreaterThanOrEqual(3);
        octets.slice(0, index).forEach(peer => expect(distance(octet, peer)).toBeGreaterThanOrEqual(3));
      });
      previous = octets;
    }
  });

  it("still terminates with six different octets when randomness repeatedly chooses the same edge", () => {
    for (const value of [0, .999999]) {
      let previous: string[] = [];
      for (let pass = 0; pass < 20; pass++) {
        const octets = createConnectionOctets(previous, () => value);
        expect(new Set(octets).size).toBe(6);
        expect(octets.every(octet => /^[01]{8}$/.test(octet))).toBe(true);
        previous = octets;
      }
    }
  });
});
