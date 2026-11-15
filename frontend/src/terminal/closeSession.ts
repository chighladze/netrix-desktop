import { fetchJsonOrThrow, getApiBase } from "../api";

/** DELETE is idempotent: losing its response must be safe to retry. */
export async function closeBackendSession(sessionId: number): Promise<void> {
  const base = await getApiBase();
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 20_000);
  try {
    const result = await fetchJsonOrThrow<{ ok: boolean }>(
      `${base}/sessions/${sessionId}`,
      { method: "DELETE", signal: abort.signal },
      { retries: 2 },
    );
    if (!result?.ok) throw new Error("Session closure was not acknowledged.");
  } finally {
    window.clearTimeout(timeout);
  }
}
