import { describe, expect, it } from "vitest";
import { safePreferences } from "./api";
describe("backup preferences", () => {
  it("accepts only known primitive fields and bounds terminal dimensions", () => {
    const template = {
      terminal: { fontSize: 14, scrollbackLines: 1000, rowsMultiplier: 1, theme: "default" },
      security: { vaultRememberPassword: false },
    };
    expect(
      safePreferences(
        {
          terminal: {
            fontSize: 0,
            scrollbackLines: 1e12,
            rowsMultiplier: 0,
            theme: {},
            unknown: true,
          },
          security: { vaultRememberPassword: "true" },
          extra: "untrusted",
        },
        template,
      ),
    ).toEqual({ terminal: { fontSize: 6, rowsMultiplier: 1 }, security: {} });
  });
  it("does not import prototype keys or arbitrary objects", () => {
    const incoming: unknown = JSON.parse(
      '{"__proto__":{"polluted":true},"terminal":{"fontSize":18}}',
    );
    expect(safePreferences(incoming, { terminal: { fontSize: 14 } })).toEqual({
      terminal: { fontSize: 18 },
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
