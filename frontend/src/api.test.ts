import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const loadApi = async () => {
  vi.resetModules();
  return import("./api");
};

describe("fetchJsonOrThrow", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue("test-api-token");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns typed JSON and authenticates a successful request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hosts: [1, 2] }));
    const { fetchJsonOrThrow } = await loadApi();

    const result = await fetchJsonOrThrow<{ hosts: number[] }>(
      "http://127.0.0.1:3210/hosts",
    );

    expect(result).toEqual({ hosts: [1, 2] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("X-API-Token")).toBe("test-api-token");
  });

  it("surfaces the backend's structured detail and status", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Host payload was rejected" }, 422));
    const { fetchJsonOrThrow } = await loadApi();

    await expect(
      fetchJsonOrThrow("http://127.0.0.1:3210/hosts"),
    ).rejects.toMatchObject({
      name: "ApiError",
      message: "Host payload was rejected",
      status: 422,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry unless the caller opts in", async () => {
    fetchMock.mockRejectedValue(new TypeError("connection reset"));
    const { fetchJsonOrThrow } = await loadApi();

    await expect(
      fetchJsonOrThrow("http://127.0.0.1:3210/hosts"),
    ).rejects.toThrow("connection reset");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an explicitly opted-in idempotent request", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ detail: "temporarily unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { fetchJsonOrThrow } = await loadApi();

    await expect(
      fetchJsonOrThrow<{ ok: boolean }>(
        "http://127.0.0.1:3210/status",
        { method: "GET" },
        { retries: 1, delayMs: 0 },
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects retries for non-idempotent requests before sending them", async () => {
    const { fetchJsonOrThrow } = await loadApi();

    await expect(
      fetchJsonOrThrow(
        "http://127.0.0.1:3210/hosts",
        { method: "POST", body: "{}" },
        { retries: 1 },
      ),
    ).rejects.toThrow("Retries are not allowed for non-idempotent POST requests");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("backend readiness", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses known phases and trims an optional message", async () => {
    invokeMock.mockResolvedValue({ status: "starting", message: "  launching sidecar  " });
    const { getBackendStatus } = await loadApi();

    await expect(getBackendStatus()).resolves.toEqual({
      status: "starting",
      message: "launching sidecar",
    });
  });

  it("rejects malformed or unknown readiness payloads", async () => {
    invokeMock.mockResolvedValue({ status: "online" });
    const { getBackendStatus } = await loadApi();

    await expect(getBackendStatus()).rejects.toThrow(
      "Backend returned an unknown readiness phase",
    );
  });

  it("preserves a failed process diagnosis and its local log location", async () => {
    const diagnostic = { code: "workspace_busy", message: "Workspace is already open.",
      recovery: "Close the other instance.", details: "Backend exit code: 1 (0x00000001)" };
    invokeMock.mockResolvedValue({ status: "failed", message: diagnostic.message,
      diagnostic, log_path: " C:\\test-profile\\tauri_main.log " });
    const { waitForBackendReady } = await loadApi();
    await expect(waitForBackendReady()).resolves.toEqual({ status: "failed",
      message: diagnostic.message, diagnostic, log_path: "C:\\test-profile\\tauri_main.log" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed diagnostic fields while retaining the failed phase", async () => {
    invokeMock.mockResolvedValue({ status: "failed", message: "unavailable",
      diagnostic: { code: "workspace_busy", message: {}, recovery: "retry", details: "exit 1" }, log_path: 123 });
    const { getBackendStatus } = await loadApi();
    await expect(getBackendStatus()).resolves.toEqual({ status: "failed", message: "unavailable" });
  });

  it("polls starting status until the backend becomes ready", async () => {
    vi.useFakeTimers();
    invokeMock
      .mockResolvedValueOnce({ status: "starting", message: "booting" })
      .mockResolvedValueOnce({ status: "ready" });
    const { waitForBackendReady } = await loadApi();
    const statuses: string[] = [];

    const readiness = waitForBackendReady({
      intervalMs: 50,
      timeoutMs: 1_000,
      onStatus: ({ status }) => statuses.push(status),
    });
    await vi.advanceTimersByTimeAsync(50);

    await expect(readiness).resolves.toEqual({ status: "ready" });
    expect(statuses).toEqual(["starting", "ready"]);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("lets the shell report a startup failure after the extended readiness window", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue({ status: "starting" });
    const { waitForBackendReady } = await loadApi();
    const readiness = waitForBackendReady({ intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(21_000);
    invokeMock.mockResolvedValue({ status: "failed", message: "The workspace lock is still held." });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(readiness).resolves.toEqual({
      status: "failed", message: "The workspace lock is still held.",
    });
  });

  it("honors an already-aborted polling signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { waitForBackendReady } = await loadApi();

    await expect(
      waitForBackendReady({ signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
