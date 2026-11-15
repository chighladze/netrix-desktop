import { describe, expect, it } from "vitest";
import { formatSql } from "./sql";
describe("SQL display formatting", () => {
  it("preserves literal contents, quoted identifiers and line-comment boundaries", () => {
    const formatted = formatSql(
      "select 'from  WHERE', 'a''b', \"Mixed Case\", [order by], `select` from t -- WHERE keep  spaces\nwhere x = $tag$SELECT  OR$tag$",
    );
    for (const value of [
      "'from  WHERE'",
      "'a''b'",
      '"Mixed Case"',
      "[order by]",
      "`select`",
      "-- WHERE keep  spaces\n",
      "$tag$SELECT  OR$tag$",
    ])
      expect(formatted).toContain(value);
    expect(formatted).toContain("\nFROM t");
    expect(formatted).toContain("\nWHERE x");
  });
  it("keeps block comments and multiline quoted values unchanged", () => {
    const output = formatSql("select /* outer FROM /* nested */ WHERE */ 'first\n second' from t");
    expect(output).toContain("/* outer FROM /* nested */ WHERE */");
    expect(output).toContain("'first\n second'");
  });
  it("refuses unsupported boundaries and excessive input instead of changing quoted data", () => {
    for (const input of ["select 'broken", "select $$broken", "select /* broken", "select 'a\\'b'"])
      expect(() => formatSql(input)).toThrow();
    expect(() => formatSql("a".repeat(262145))).toThrow("256 KiB");
  });
});
