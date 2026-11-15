import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchJsonOrThrow, getApiBase } from "../../api";

export function toolInteger(value: string, min: number, max: number, label: string): number {
  const number = Number(value);
  if (!value.trim() || !Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

/** Each response belongs to one input snapshot. Aborting HTTP does not promise server cancellation. */
export function useNetworkTool<T>() {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const deadline = useRef<number | null>(null);

  const reset = useCallback(() => {
    active.current?.abort();
    active.current = null;
    if (deadline.current !== null) window.clearTimeout(deadline.current);
    deadline.current = null;
    setLoading(false);
    setError("");
    setResult(null);
  }, []);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
      if (deadline.current !== null) window.clearTimeout(deadline.current);
      deadline.current = null;
    },
    [],
  );

  const run = async (path: string, body: () => Record<string, unknown>) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError("");
    setResult(null);
    const isCurrent = () => active.current === controller && !controller.signal.aborted;
    const timer = window.setTimeout(() => {
      if (!isCurrent()) return;
      controller.abort();
      active.current = null;
      deadline.current = null;
      setLoading(false);
      setError("Timed out waiting for the network tool. Try a smaller request.");
    }, 65000);
    deadline.current = timer;
    try {
      const payload = body();
      const base = await getApiBase();
      if (!isCurrent()) return;
      const data = await fetchJsonOrThrow<T>(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (isCurrent()) setResult(data);
    } catch (failure) {
      if (isCurrent())
        setError(
          failure instanceof ApiError && failure.status === 404
            ? "Network tools API is unavailable. Restart the updated Netrix backend."
            : failure instanceof Error
              ? failure.message
              : "Network tool failed",
        );
    } finally {
      window.clearTimeout(timer);
      if (deadline.current === timer) deadline.current = null;
      if (active.current === controller) {
        active.current = null;
        setLoading(false);
      }
    }
  };
  return { result, error, loading, run, reset };
}
