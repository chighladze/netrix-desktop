export interface ParsedCron {
  sets: Array<Set<number> | null>;
  dayOr: boolean;
  error?: string;
}

const parseField = (
  value: string,
  min: number,
  max: number,
  sunday = false,
): Set<number> | null => {
  if (value === "*") return null;
  const values = new Set<number>();
  for (const item of value.split(",")) {
    const parts = item.split("/");
    if (parts.length > 2 || !parts[0]) throw new Error("Invalid list or step");
    const [range, stepText] = parts;
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : NaN;
    if (!Number.isSafeInteger(step) || step < 1) throw new Error("Step must be a positive integer");
    let start = min,
      end = max;
    if (range !== "*") {
      if (!/^\d+(?:-\d+)?$/.test(range)) throw new Error("Use numeric values, ranges, lists or *");
      const bounds = range.split("-").map(Number);
      start = bounds[0];
      end = bounds[1] ?? start;
      if (stepText !== undefined && bounds.length === 1)
        throw new Error("Use */n or a-b/n for steps");
    }
    if (start < min || end > max || start > end)
      throw new Error(`Expected an ascending range within ${min}-${max}`);
    for (let i = start; i <= end; i += step) values.add(sunday && i === 7 ? 0 : i);
  }
  return values;
};

/** Numeric five-field cron. Day-of-month/week follow crontab's OR rule when both are restricted. */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (expression.length > 256 || fields.length !== 5)
    return { sets: [], dayOr: false, error: "Use standard 5-field numeric cron: m h dom mon dow" };
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  const names = ["minute", "hour", "day of month", "month", "day of week"];
  const sets: ParsedCron["sets"] = [];
  for (let i = 0; i < fields.length; i++) {
    try {
      sets.push(parseField(fields[i], bounds[i][0], bounds[i][1], i === 4));
    } catch (error) {
      return {
        sets: [],
        dayOr: false,
        error: `Invalid ${names[i]}: ${error instanceof Error ? error.message : "invalid field"}`,
      };
    }
  }
  return { sets, dayOr: !fields[2].includes("*") && !fields[4].includes("*") };
}

export function cronMatches(date: Date, cron: ParsedCron): boolean {
  if (cron.error || cron.sets.length !== 5) return false;
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  const matches = cron.sets.map((set, i) => !set || set.has(values[i]));
  return (
    matches[0] &&
    matches[1] &&
    matches[3] &&
    (cron.dayOr ? matches[2] || matches[4] : matches[2] && matches[4])
  );
}
