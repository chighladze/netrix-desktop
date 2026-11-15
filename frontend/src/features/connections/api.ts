import { fetchJsonOrThrow, getApiBase } from "../../api";
export async function connectionRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  return fetchJsonOrThrow<T>(`${await getApiBase()}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}
export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function safePreferences(
  incoming: unknown,
  current: Record<string, unknown>,
): Record<string, unknown> {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(current)) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    const value = (incoming as Record<string, unknown>)[key];
    if (template && typeof template === "object" && !Array.isArray(template))
      result[key] = safePreferences(value, template as Record<string, unknown>);
    else if (
      typeof value === typeof template &&
      ["string", "number", "boolean"].includes(typeof value) &&
      (typeof value !== "number" || (Number.isFinite(value) && value >= 0 && value <= 100_000)) &&
      (typeof value !== "string" || value.length <= 4096)
    ) {
      if (typeof value === "number" && (key === "fontSize" || key === "defaultFontSize"))
        result[key] = Math.min(72, Math.max(6, value));
      else if (typeof value === "number" && key === "rowsMultiplier")
        result[key] = Math.min(10, Math.max(1, value));
      else result[key] = value;
    }
  }
  return result;
}
