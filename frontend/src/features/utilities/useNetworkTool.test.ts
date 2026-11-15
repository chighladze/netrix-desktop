import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetchJsonOrThrow: vi.fn(), getApiBase: vi.fn() }));
vi.mock("../../api", async (original) => ({ ...(await original<object>()), ...api }));
import { useNetworkTool } from "./useNetworkTool";
afterEach(() => {
  vi.useRealTimers();
});
it("releases deadline timers on reset and unmount even if a transport ignores abort", async () => {
  vi.useFakeTimers();
  api.getApiBase.mockResolvedValue("http://127.0.0.1:3210");
  api.fetchJsonOrThrow.mockReturnValue(new Promise(() => {}));
  const view = renderHook(() => useNetworkTool());
  await act(async () => {
    void view.result.current.run("/network-tools/scan/tcp", () => ({ target: "127.0.0.1" }));
  });
  expect(vi.getTimerCount()).toBe(1);
  act(() => view.result.current.reset());
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    void view.result.current.run("/network-tools/scan/tcp", () => ({ target: "127.0.0.1" }));
  });
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
