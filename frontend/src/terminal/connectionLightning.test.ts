import { describe, expect, it } from "vitest";
import { createLightningStrikes, lightningPath, LIGHTNING_VARIANTS, type LightningStrike } from "./connectionLightning";

function seededRandom(seed: number) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
}

describe("connection discharge variations", () => {
  it("uses all ten forms in random bags without consecutive routes or repeating a pair on its next pass", () => {
    expect(LIGHTNING_VARIANTS).toHaveLength(10);
    for (let seed = 0; seed < 100; seed++) {
      const random = seededRandom(seed);
      let previous: LightningStrike[] = [];
      for (let pass = 0; pass < 5; pass++) {
        const strikes = createLightningStrikes(47, previous, random);
        const route = (strike: LightningStrike) => LIGHTNING_VARIANTS[strike.variant].route;
        if (previous.length) expect(route(strikes[0])).not.toBe(route(previous[previous.length - 1]));
        strikes.forEach((strike, i) => {
          if (i) expect(route(strike)).not.toBe(route(strikes[i - 1]));
          if (previous[i]) expect(strike.variant).not.toBe(previous[i].variant);
        });
        for (let start = 0; start < 40; start += 10) {
          expect(new Set(strikes.slice(start, start + 10).map(strike => strike.variant)).size).toBe(10);
        }
        previous = strikes.slice(0, pass % 2 ? 31 : 47);
      }
    }
    expect(createLightningStrikes(0)).toEqual([]);
    const first = createLightningStrikes(47, [], () => 0);
    expect(createLightningStrikes(47, first, () => 0)).toHaveLength(47);
  });

  it("has ten distinct geometries, fresh contacts and stable paths during remeasurement", () => {
    for (const gap of [10, 80]) {
      const from = { x: 20, y: 40, width: 10, height: 22, digit: "0", bitIndex: 0 };
      const to = { ...from, x: 20 + gap, digit: "1", bitIndex: 1 };
      const paths = LIGHTNING_VARIANTS.map((_, variant) => lightningPath(from, to, { variant, seed: 42 }));
      expect(new Set(paths.map(path => path.main + path.branches)).size).toBe(10);
      paths.forEach((path, variant) => {
        expect(path.main + path.branches).not.toMatch(/NaN|Infinity/);
        expect(Math.abs(path.source.y - from.y)).toBeLessThan(from.height * .4);
        expect(Math.abs(path.contact.y - to.y)).toBeLessThan(to.height * .4);
        expect(path).toEqual(lightningPath(from, to, { variant, seed: 42 }));
        const next = lightningPath(from, to, { variant, seed: 43 });
        expect(next.main).not.toBe(path.main);
        expect(next.source).not.toEqual(path.source);
        expect(next.contact).not.toEqual(path.contact);
      });
    }
  });
});
