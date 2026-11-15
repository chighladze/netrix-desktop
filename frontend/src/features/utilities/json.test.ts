import { describe, expect, it } from "vitest";
import { formatJson } from "./json";
describe("lossless JSON whitespace formatting", () => {
  it("preserves large integers, exponents, negative zero and duplicate keys", () => {
    const input =
      '{ "n": 9007199254740993, "n": -0, "exp": 1e400, "precise": 0.123456789012345678901 }';
    const compact = '{"n":9007199254740993,"n":-0,"exp":1e400,"precise":0.123456789012345678901}';
    expect(formatJson(input, null)).toBe(compact);
    expect(formatJson(formatJson(input), null)).toBe(compact);
  });
  it("preserves escaped strings and supports actual tabs and empty collections", () => {
    const input = '{"text":" {  \\"abc\\" } \\n \\u0041", "empty":[],"nested":{"x":{}}}';
    const formatted = formatJson(input, "\t");
    expect(formatted).toContain('\n\t"text":');
    expect(formatJson(formatted, null)).toBe(input.replace(', "empty"', ',"empty"'));
    expect(formatJson("[  ]")).toBe("[]");
  });
  it("rejects malformed, oversized and excessively nested JSON", () => {
    expect(() => formatJson('{"x":}')).toThrow();
    expect(() => formatJson("[".repeat(129) + "0" + "]".repeat(129))).toThrow("128");
    expect(() => formatJson(" ".repeat(262145))).toThrow("256 KiB");
  });
});
