import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
import DetachedTerminalWorkspace from "./DetachedTerminalWorkspace";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), transfer: vi.fn(async (_options: Parameters<typeof import("../terminal/windowHandoff").transferTerminalWindow>[0]) => {}), fetch: vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true })), closeRequested: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "detached-grid", onCloseRequested: async (callback: unknown) => { mocks.closeRequested(callback); return () => {}; } }) }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), getApiBase: async () => "http://127.0.0.1:1234", fetchJsonOrThrow: mocks.fetch }));
vi.mock("../terminal/windowHandoff", () => ({ transferTerminalWindow: mocks.transfer, TerminalMoveCancelledError: class extends Error {} }));
vi.mock("../terminal/useWindowHandoffs", () => ({ waitForTerminalRenderer: async () => {}, openMainTerminalHandoff: async () => {} }));
vi.mock("./DetachedTerminalFrame", () => ({ default: ({ children, onReturn, onClose }: { children: React.ReactNode; onReturn: () => void; onClose: () => void }) => <div><button onClick={() => onReturn()}>Return group</button><button onClick={onClose}>Close window</button>{children}</div> }));
vi.mock("./TerminalCanvas", () => ({ default: ({ tabId }: { tabId: string }) => <input aria-label={`Terminal ${tabId}`} /> }));
vi.mock("./TerminalDockTarget", () => ({ default: () => null }));
vi.mock("./TerminalTransferOverlay", () => ({ default: () => null }));

describe("detached terminal workspace", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    mocks.transfer.mockResolvedValue(undefined);
    mocks.fetch.mockResolvedValue({ ok: true });
    useAppStore.setState({ ...useAppStore.getInitialState(),
      terminalTabs: [1, 2].map((id) => ({ id: `t${id}`, host: { id, revision: 0, name: `host-${id}`, hostname: "example.test", port: 22, username: "test", connection_type: "ssh" }, isConnected: true })),
      activeTabId: "t2", terminalLayout: "rows", terminalGroups: [{ id: "g", layout: "rows", tabIds: ["t1", "t2"] }],
      sessionIds: { t1: 41, t2: 42 },
    });
  });

  it("offers all layouts for one detached session without replacing its terminal or session", () => {
    const initial = useAppStore.getState();
    useAppStore.setState({ terminalTabs: initial.terminalTabs.slice(0, 1), activeTabId: "t1", terminalGroups: [], terminalLayout: "single", sessionIds: { t1: 41 } });
    const sessions = useAppStore.getState().sessionIds;
    const view = render(<DetachedTerminalWorkspace allowClose={{ current: false }} />);
    const terminal = screen.getByRole("textbox", { name: "Terminal t1" });
    expect(screen.getByRole("radio", { name: "Single" }).getAttribute("aria-checked")).toBe("true");
    for (const [label, layout, emptyPanes] of [["Side by side", "columns", 1], ["Stacked", "rows", 1], ["2 × 2", "grid", 3], ["Single", "single", 0]] as const) {
      fireEvent.click(screen.getByRole("radio", { name: label }));
      expect(view.container.querySelector("[data-terminal-pane-grid]")?.getAttribute("data-layout")).toBe(layout);
      expect(view.container.querySelectorAll("[data-terminal-empty-pane]")).toHaveLength(emptyPanes);
      expect(screen.getByRole("textbox", { name: "Terminal t1" })).toBe(terminal);
      expect(useAppStore.getState().sessionIds).toBe(sessions);
      expect(useAppStore.getState().activeTabId).toBe("t1");
    }
    expect(useAppStore.getState().terminalGroups).toEqual([]);
    expect(mocks.transfer).not.toHaveBeenCalled();
  });

  it("returns every member and keeps the window open until source release", async () => {
    const allowClose = { current: false };
    render(<DetachedTerminalWorkspace allowClose={allowClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Return group" }));
    await waitFor(() => expect(mocks.transfer).toHaveBeenCalledOnce());
    const options = mocks.transfer.mock.calls[0][0];
    expect(options.tabId).toBe("t2");
    expect(options.workspace?.tabs.map((tab) => tab.id)).toEqual(["t1", "t2"]);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => { await options.release(); });
    expect(allowClose.current).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("close_terminal_window");
  });

  it("waits for every authenticated deletion before closing the window", async () => {
    let finish = () => {};
    mocks.fetch.mockImplementation(async (url: string) => { if (url.endsWith("/42")) await new Promise<void>((resolve) => { finish = resolve; }); return { ok: true }; });
    render(<DetachedTerminalWorkspace allowClose={{ current: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect all sessions" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(mocks.fetch).toHaveBeenCalledWith("http://127.0.0.1:1234/sessions/41", expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }), { retries: 2 });
    await waitFor(() => expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["t2"]));
    expect(mocks.invoke).not.toHaveBeenCalled();
    await act(async () => finish());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_terminal_window"));
  });

  it("keeps the window available when session deletion fails", async () => {
    mocks.fetch.mockRejectedValue(new Error("Delete failed"));
    render(<DetachedTerminalWorkspace allowClose={{ current: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect all sessions" }));
    await waitFor(() => expect(useAppStore.getState().toasts.some((toast) => toast.message.includes("Could not confirm session closure"))).toBe(true));
    expect(useAppStore.getState().terminalTabs).toHaveLength(2);
    expect(mocks.invoke).not.toHaveBeenCalled();
    const retries = await screen.findAllByRole("button", { name: "Retry closing" });
    mocks.fetch.mockResolvedValue({ ok: true });
    retries.forEach((button) => fireEvent.click(button));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_terminal_window"));
    expect(useAppStore.getState().terminalTabs).toEqual([]);
  });

  it("opens a connection picker inside the detached window and fills the selected fourth pane", async () => {
    const saved = { id: 3, revision: 0, name: "Saved server", hostname: "saved.example", port: 22, username: "test", connection_type: "ssh" as const };
    useAppStore.setState({ hosts: [saved], fetchHosts: vi.fn(async () => [saved]), refreshVaultStatus: vi.fn(async () => null), addRecentConnection: vi.fn(async () => {}) });
    useAppStore.getState().setTerminalGroup({ id: "g", layout: "grid", tabIds: ["t1", "t2"] });
    render(<DetachedTerminalWorkspace allowClose={{ current: false }} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose a connection for pane 4" }));
    fireEvent.click(await screen.findByRole("button", { name: /Saved server/ }));
    const state = useAppStore.getState();
    expect(state.terminalGroups[0].paneSlots).toEqual(["t1", "t2", null, state.activeTabId]);
    expect(state.terminalTabs.find((tab) => tab.id === state.activeTabId)?.host.id).toBe(3);
    expect(mocks.transfer).not.toHaveBeenCalled();
    state.removeTerminalTab(state.activeTabId!);
  });
  it("keeps independent local tabs accessible after Single and returns each without regrouping", async () => {
    render(<DetachedTerminalWorkspace allowClose={{ current: false }} />);
    act(() => useAppStore.getState().setTerminalLayout("single"));
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByRole("tab", { name: /^Session group:/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^host-1,/ }));
    expect(useAppStore.getState().activeTabId).toBe("t1");
    expect(useAppStore.getState().sessionIds).toEqual({ t1: 41, t2: 42 });
    mocks.transfer.mockImplementation(async (options) => { await options.release(); });
    fireEvent.click(screen.getByRole("button", { name: "Return group" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("close_terminal_window"));
    expect(mocks.transfer.mock.calls.map(([options]) => options.tabId)).toEqual(["t2", "t1"]);
    expect(mocks.transfer.mock.calls.every(([options]) => options.workspace === undefined)).toBe(true);
    expect(useAppStore.getState().terminalTabs).toEqual([]);
  });
  it("retains an unreturned Single session if a later return fails", async () => {
    act(() => useAppStore.getState().setTerminalLayout("single"));
    const allowClose = { current: false };
    mocks.transfer.mockImplementation(async (options) => { if (options.tabId === "t2") throw new Error("Replay failed"); await options.release(); });
    render(<DetachedTerminalWorkspace allowClose={allowClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Return group" }));
    await waitFor(() => expect(useAppStore.getState().toasts.some((toast) => toast.message === "Replay failed")).toBe(true));
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["t2"]);
    expect(useAppStore.getState().sessionIds.t2).toBe(42);
    expect(allowClose.current).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
