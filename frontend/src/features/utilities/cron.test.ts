import { describe, expect, it } from "vitest";
import { cronMatches, parseCron } from "./cron";

describe("numeric crontab preview", () => {
  it("handles its default step expression and bounded stepped ranges", () => {
    const cron = parseCron("*/5 * * * *");
    expect(cron.error).toBeUndefined();
    expect(cronMatches(new Date(2026, 9, 22, 12, 5), cron)).toBe(true);
    expect(cronMatches(new Date(2026, 9, 22, 12, 6), cron)).toBe(false);
    expect([...parseCron("1-9/3,15 * * * *").sets[0]!]).toEqual([1, 4, 7, 15]);
  });
  it("treats 7 as Sunday without losing the end of a weekday range", () => {
    const cron = parseCron("0 0 * * 5-7");
    expect([...cron.sets[4]!]).toEqual([5, 6, 0]);
    expect(cronMatches(new Date(2026, 9, 25, 0, 0), cron)).toBe(true);
    expect(cronMatches(new Date(2026, 9, 26, 0, 0), cron)).toBe(false);
  });
  it("matches either restricted day field while still respecting month/hour/minute", () => {
    const cron = parseCron("30 4 1,15 * 5");
    expect(cronMatches(new Date(2026, 9, 1, 4, 30), cron)).toBe(true);
    expect(cronMatches(new Date(2026, 9, 23, 4, 30), cron)).toBe(true);
    expect(cronMatches(new Date(2026, 9, 22, 4, 30), cron)).toBe(false);
    expect(cronMatches(new Date(2026, 9, 23, 5, 30), cron)).toBe(false);
    expect(cronMatches(new Date(2026, 9, 22, 4, 30), parseCron("30 4 * * 5"))).toBe(false);
  });
  it.each([
    "*/0 * * * *",
    "*/-1 * * * *",
    "1/5 * * * *",
    "60 * * * *",
    "9-1 * * * *",
    "0 24 * * *",
    "0 0 0 * *",
    "0 0 * 13 *",
    "0 0 * * 8",
    "0 0 * * ?",
    "0 0 * * MON",
    "1,,2 * * * *",
    "*/2/3 * * * *",
  ])("rejects invalid or unsupported fields: %s", (expression) => {
    expect(parseCron(expression).error).toBeTruthy();
    expect(cronMatches(new Date(), parseCron(expression))).toBe(false);
  });
});
