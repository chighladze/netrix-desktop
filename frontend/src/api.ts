/**
 * API configuration module for Netrix.
 * Uses direct IP addresses (127.0.0.1) instead of localhost to prevent
 * CORS/IPv6 issues on Windows.
 */

import { invoke } from "@tauri-apps/api/core";

let cachedPort: number | null = null;
let cachedToken: string | null = null;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface FetchRetryPolicy {
  /** Number of retries after the first request. Disabled by default. */
  retries?: number;
  /** Initial retry delay; subsequent delays use a small exponential backoff. */
  delayMs?: number;
}

export type BackendPhase = "starting" | "ready" | "failed";

export interface BackendDiagnostic {
  code: string;
  message: string;
  recovery: string;
  details: string;
}

export interface BackendStatus {
  status: BackendPhase;
  message?: string;
  diagnostic?: BackendDiagnostic;
  log_path?: string;
}

export interface BackendReadinessPollingOptions {
  /** Delay between Tauri status checks while the sidecar is starting. */
  intervalMs?: number;
  /** Upper bound for IPC polling; the sidecar has its own readiness deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onStatus?: (status: BackendStatus) => void;
}

const parseBackendStatus = (value: unknown): BackendStatus => {
  if (!value || typeof value !== "object") {
    throw new Error("Backend returned an invalid readiness status");
  }

  const status = (value as { status?: unknown }).status;
  if (status !== "starting" && status !== "ready" && status !== "failed") {
    throw new Error("Backend returned an unknown readiness phase");
  }

  const message = (value as { message?: unknown }).message;
  const diagnostic = (value as { diagnostic?: unknown }).diagnostic;
  const logPath = (value as { log_path?: unknown }).log_path;
  let parsedDiagnostic: BackendDiagnostic | undefined;
  if (status === "failed" && diagnostic && typeof diagnostic === "object") {
    const fields = diagnostic as Record<string, unknown>;
    const { code, message, recovery, details } = fields;
    if ([code, message, recovery, details].every((field) => typeof field === "string" && field.trim())) {
      parsedDiagnostic = { code, message, recovery, details } as BackendDiagnostic;
    }
  }
  return {
    status,
    ...(typeof message === "string" && message.trim()
      ? { message: message.trim() }
      : {}),
    ...(parsedDiagnostic ? { diagnostic: parsedDiagnostic } : {}),
    ...(status === "failed" && typeof logPath === "string" && logPath.trim()
      ? { log_path: logPath.trim() }
      : {}),
  };
};

export async function getBackendStatus(): Promise<BackendStatus> {
  return parseBackendStatus(await invoke<unknown>("get_backend_status"));
}

/** Poll Tauri only; callers must not start backend HTTP work before `ready`. */
export async function waitForBackendReady(
  options: BackendReadinessPollingOptions = {},
): Promise<BackendStatus> {
  const intervalMs = Math.max(50, Math.min(options.intervalMs ?? 150, 2_000));
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 20_000, 60_000));
  const deadline = Date.now() + timeoutMs;
  let lastStatusError: unknown;

  while (!options.signal?.aborted) {
    try {
      const status = await getBackendStatus();
      options.onStatus?.(status);
      if (status.status !== "starting") return status;
      lastStatusError = undefined;
    } catch (error) {
      // The IPC bridge can be briefly unavailable while a child window mounts.
      lastStatusError = error;
    }

    if (Date.now() >= deadline) {
      const status: BackendStatus = {
        status: "failed",
        message: lastStatusError
          ? "Unable to read backend startup status from the desktop shell."
          : "Backend startup did not complete in time.",
      };
      options.onStatus?.(status);
      return status;
    }

    await waitForDelay(intervalMs, options.signal);
  }

  throw new DOMException("Backend readiness polling was cancelled", "AbortError");
}

async function readApiTokenFromTauri(): Promise<string | null> {
  // Detached windows might mount before the IPC bridge is fully warm.
  // We try up to 5 times with a small delay.
  for (let i = 0; i < 5; i++) {
    try {
      const token = await invoke<string>("get_api_token");
      if (token) {
        cachedToken = token;
        return token;
      }
    } catch (e) {
      if (i === 4) console.warn("[Netrix] Failed to get API token after retries:", e);
    }
    await new Promise(resolve => setTimeout(resolve, i * 50));
  }
  return null;
}

export async function getApiToken(): Promise<string | null> {
  if (cachedToken !== null) {
    return cachedToken;
  }
  return readApiTokenFromTauri();
}

export async function refreshApiToken(): Promise<string | null> {
  const previous = cachedToken;
  cachedToken = null;
  const refreshed = await readApiTokenFromTauri();
  if (!refreshed && previous) {
    // Keep last known token if bridge is temporarily unavailable.
    cachedToken = previous;
    return previous;
  }
  return refreshed;
}

export async function getBackendPort(): Promise<number> {
  if (cachedPort !== null) {
    return cachedPort;
  }

  try {
    const port = await invoke<number>("get_backend_port");
    console.log(`[Netrix] Backend active on port: ${port}`);
    cachedPort = port;
    return port;
  } catch (e) {
    console.error("[Netrix] Could not connect to Tauri core:", e);
    throw new Error("Backend port is unavailable because the Tauri IPC bridge is not ready.");
  }
}

export async function getApiBase(): Promise<string> {
  const port = await getBackendPort();
  return `http://127.0.0.1:${port}`;
}

export async function getWsBase(): Promise<string> {
  const port = await getBackendPort();
  return `ws://127.0.0.1:${port}`;
}

export function apiBaseSync(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function wsBaseSync(port: number): string {
  return `ws://127.0.0.1:${port}`;
}

export async function authenticatedFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const doFetch = async (token: string): Promise<Response> => {
    const headers = new Headers(options.headers || {});
    headers.set("X-API-Token", token);
    return fetch(url, { ...options, headers });
  };

  const token = await getApiToken();
  if (!token) {
    throw new Error("Netrix API token is unavailable because the Tauri IPC bridge is not ready.");
  }
  let response = await doFetch(token);

  // If backend token rotated (common in tauri dev restarts), refresh and retry once.
  if (response.status === 401 || response.status === 403) {
    const refreshed = await refreshApiToken();
    if (refreshed && refreshed !== token) {
      response = await doFetch(refreshed);
    }
  }

  return response;
}

/**
 * Extract a user-facing message from the backend's structured error response.
 * Call this only for a non-successful response because reading the body consumes it.
 */
export async function getApiErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body: unknown = await response.json();
      if (body && typeof body === "object") {
        for (const key of ["detail", "message", "error"] as const) {
          const value = (body as Record<string, unknown>)[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
      }
    } else {
      const text = (await response.text()).trim();
      if (text) return text;
    }
  } catch {
    // Fall through to a stable message when the response body is absent or malformed.
  }

  return `${fallback} (HTTP ${response.status})`;
}

/**
 * Perform an authenticated request, reject non-2xx responses with the
 * backend's structured `detail`, and deserialize a typed JSON result.
 *
 * Retries are opt-in and accepted only for idempotent HTTP methods. This
 * prevents a caller from accidentally replaying a create/action request.
 */
export async function fetchJsonOrThrow<T>(
  url: string,
  options: RequestInit = {},
  retryPolicy: FetchRetryPolicy = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const retries = Math.max(0, Math.min(retryPolicy.retries ?? 0, 3));
  if (retries > 0 && !IDEMPOTENT_METHODS.has(method)) {
    throw new Error(`Retries are not allowed for non-idempotent ${method} requests`);
  }

  let lastNetworkError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await authenticatedFetch(url, options);
      if (!response.ok) {
        if (
          attempt < retries &&
          RETRYABLE_HTTP_STATUSES.has(response.status)
        ) {
          await response.body?.cancel().catch(() => undefined);
          await waitForRetry(retryPolicy.delayMs, attempt);
          continue;
        }
        throw new ApiError(
          await getApiErrorMessage(response, "Request failed"),
          response.status,
        );
      }

      if (response.status === 204 || response.status === 205) {
        return undefined as T;
      }

      const text = await response.text();
      if (!text.trim()) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ApiError("Backend returned an invalid JSON response", response.status);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      lastNetworkError = error;
      if (attempt >= retries) break;
      await waitForRetry(retryPolicy.delayMs, attempt);
    }
  }

  if (lastNetworkError instanceof Error) throw lastNetworkError;
  throw new Error("Backend request failed");
}

async function waitForRetry(delayMs: number | undefined, attempt: number): Promise<void> {
  const initialDelay = Math.max(0, Math.min(delayMs ?? 150, 5_000));
  const delay = initialDelay * 2 ** attempt;
  await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
}

async function waitForDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException("Backend readiness polling was cancelled", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Backend readiness polling was cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}
