import { describe, expect, it } from "vitest";
import { floatingTerminalPlacement } from "./windowPlacement";

describe("floating terminal placement", () => {
  it.each([1, 1.25, 1.5, 2])("fits the destination monitor work area at scale %s, including a negative origin", (scaleFactor) => {
    const monitor = { scaleFactor, workArea: { position: { x: -1920, y: 200 }, size: { width: 1920, height: 1040 } } };
    for (const point of [{ x: -1900, y: 205 }, { x: -10, y: 1220 }]) {
      const placed = floatingTerminalPlacement(point, monitor, 1);
      expect(placed.x).toBeGreaterThanOrEqual(-1920);
      expect(placed.y).toBeGreaterThanOrEqual(200);
      expect(placed.x + placed.width * scaleFactor).toBeLessThanOrEqual(0);
      expect(placed.y + placed.height * scaleFactor).toBeLessThanOrEqual(1240);
    }
  });
});
