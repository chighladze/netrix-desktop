import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createDefaultSettings } from "./features/settings/settings";
import { useAppStore, type SavedHostDto } from "./state/store";

const lifecycle = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn(), render: vi.fn() }));
vi.mock("./api", async (original) => ({
  ...await original<typeof import("./api")>(),
  getApiBase: vi.fn().mockResolvedValue("http://localhost:1234"),
  fetchJsonOrThrow: vi.fn(async (_url: string, init?: RequestInit) => init?.method === "DELETE" ? { ok: true } : []),
  authenticatedFetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  waitForBackendReady: vi.fn(async ({ onStatus }) => onStatus({ status: "ready" })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main", setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined), unminimize: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined), onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock("./terminal/useWindowHandoffs", () => ({ useWindowHandoffs: vi.fn() }));
vi.mock("./terminal/useTerminalPaneDrag", () => ({ useTerminalPaneDrag: () => ({ preview: null }) }));
vi.mock("./components/TerminalCanvas", async () => {
  const React = await import("react");
  return { default: (props: { tabId: string; host?: SavedHostDto; onConnectionInfo?: (info: import("./terminal/connectionInfo").TerminalConnectionInfo) => void }) => {
    const { tabId } = props;
    lifecycle.render(props);
    const [draft, setDraft] = React.useState("");
    React.useLayoutEffect(() => {
      lifecycle.mount(tabId);
      return () => lifecycle.unmount(tabId);
    }, [tabId]);
    return <input aria-label={`Terminal ${tabId}`} value={draft} onChange={(event) => setDraft(event.target.value)} />;
  } };
});
vi.mock("./components/HostDashboard", () => ({ default: () => <p>Host dashboard</p> }));
vi.mock("./components/NetworkMap", () => ({ default: () => <p>Network map</p> }));
vi.mock("./components/Settings", () => ({ default: () => <p>App settings</p> }));
vi.mock("./components/SftpBrowser", () => ({ default: () => <p>File browser</p> }));
vi.mock("./components/Connections", () => ({ default: () => <p>Connection manager</p> }));
vi.mock("./components/UtilitiesHub", () => ({ default: () => <p>Network utilities</p> }));
vi.mock("./components/SnippetList", () => ({ default: () => <p>Snippet library</p> }));
vi.mock("./components/TitleBar", () => ({ default: () => null }));
vi.mock("./components/DetachedTerminalFrame", () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./components/TerminalTabsBar", () => ({ default: () => null }));
vi.mock("./components/TerminalDockTarget", () => ({ default: () => null }));
vi.mock("./components/QuickActionBar", () => ({ default: () => null }));
vi.mock("./components/HelpCenterModal", () => ({
  default: ({ isOpen, onReportProblem }: { isOpen: boolean; onReportProblem: () => void }) => isOpen
    ? <button onClick={onReportProblem}>Report problem</button> : null,
  HELP_INTRO_COMPLETED_KEY: "test-welcome-complete",
}));

const host: SavedHostDto = {
  id: 1, revision: 0, name: "Router", hostname: "example.test", port: 22,
  username: "admin", connection_type: "ssh", has_password: false, has_private_key: false,
};

describe("main terminal navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("test-welcome-complete", "true");
    const settings = createDefaultSettings();
    settings.window.rememberWindowPosition = false;
    settings.security.vaultRememberPassword = false;
    useAppStore.setState({
      settings, activeView: "hosts", activeTabId: "tab-1",
      appSecurity: { locked: false, revision: 1, error: null },
      terminalTabs: [{ id: "tab-1", host, isConnected: true, sessionId: 101 }],
      terminalLayout: "single", terminalGroups: [], terminalInstances: {}, terminalSockets: {},
      terminalTransfers: {}, tabStatuses: { "tab-1": "connected" }, sessionIds: { "tab-1": 101 },
      pendingTerminalGroupId: null, pendingTerminalPaneIndex: null, confirmDialog: null,
      recentConnections: [], activeSftpHostId: null, openSftpHostIds: [], broadcastMode: false,
      isSidebarExpanded: true, vaultStatusLoaded: true, vaultInitialized: false,
      fetchHosts: vi.fn().mockResolvedValue([host]), restoreLayout: vi.fn(),
      fetchRecentConnections: vi.fn().mockResolvedValue(undefined),
      refreshVaultStatus: vi.fn().mockResolvedValue({ initialized: false, unlocked: false }),
      refreshStoredVaultPasswordState: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("closes a report draft when the workspace becomes blocked and does not restore it on unlock", async () => {
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector("[data-workspace-ready=true]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Help & Getting Started" }));
    fireEvent.click(screen.getByRole("button", { name: "Report problem" }));
    expect(await screen.findByRole("dialog", { name: "Report problem" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: "Unsubmitted draft" } });
    act(() => useAppStore.setState({ appSecurity: { locked: false, revision: 2, error: "Backend unavailable" } }));
    expect(screen.queryByRole("dialog", { name: "Report problem" })).toBeNull();
    act(() => useAppStore.setState({ appSecurity: { locked: false, revision: 3, error: null } }));
    expect(screen.queryByRole("dialog", { name: "Report problem" })).toBeNull();
  });

  it.each(["single", "columns"] as const)("retains the %s workspace and its local state across sidebar navigation", async (layout) => {
    if (layout === "columns") {
      useAppStore.setState({
        terminalLayout: layout,
        terminalTabs: [...useAppStore.getState().terminalTabs, { id: "tab-2", host: { ...host, id: 2 }, isConnected: true, sessionId: 102 }],
        terminalGroups: [{ id: "group-1", layout, tabIds: ["tab-1", "tab-2"] }],
        sessionIds: { "tab-1": 101, "tab-2": 102 },
      });
    }
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector("[data-workspace-ready=true]")).not.toBeNull());
    expect(lifecycle.mount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    const terminal = screen.getByRole("textbox", { name: "Terminal tab-1" });
    fireEvent.change(terminal, { target: { value: "unfinished command" } });
    terminal.scrollTop = 120;
    const surfaces = [...view.container.querySelectorAll("[data-terminal-pane]")];
    const sessionIds = useAppStore.getState().sessionIds;
    const mounts = layout === "columns" ? 2 : 1;

    for (const [module, content] of [
      ["Hosts", "Host dashboard"], ["Files", "File browser"], ["Connections", "Connection manager"],
      ["Net Map", "Network map"], ["Snippets", "Snippet library"], ["Tool Box", "Network utilities"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: module }));
      await screen.findByText(content);
      expect(screen.queryByRole("textbox", { name: "Terminal tab-1" })).toBeNull();
      expect(view.container.contains(terminal)).toBe(true);
      expect(lifecycle.unmount).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
      expect(screen.getByRole("textbox", { name: "Terminal tab-1" })).toBe(terminal);
      expect((terminal as HTMLInputElement).value).toBe("unfinished command");
      expect(terminal.scrollTop).toBe(120);
      expect([...view.container.querySelectorAll("[data-terminal-pane]")]).toEqual(surfaces);
      expect(lifecycle.mount).toHaveBeenCalledTimes(mounts);
      expect(useAppStore.getState().sessionIds).toBe(sessionIds);
    }

    // Keeping the workspace alive must not retain a renderer after its tab closes.
    fireEvent.click(screen.getByRole("button", { name: "Hosts" }));
    await act(async () => { await useAppStore.getState().removeTerminalTab("tab-1"); });
    expect(view.container.contains(terminal)).toBe(false);
    expect(lifecycle.unmount).toHaveBeenCalledWith("tab-1");
  });

  it("leaves restored tabs dormant until Terminal is explicitly opened", async () => {
    const view = render(<App />);
    await waitFor(() => expect(view.container.querySelector("[data-workspace-ready=true]")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    await screen.findByText("Connection manager");
    expect(lifecycle.mount).not.toHaveBeenCalled();
    expect(view.container.querySelector("[data-terminal-view]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(screen.getByRole("textbox", { name: "Terminal tab-1" })).toBeTruthy();
    expect(lifecycle.mount).toHaveBeenCalledOnce();
  });

  it("updates the standalone detached host and exposes paste confirmation in that window", async () => {
    const previousUrl = window.location.href;
    const params = new URLSearchParams({ detached: "true", host: JSON.stringify(host) });
    window.history.replaceState({}, "", `?${params}`);
    useAppStore.setState({ terminalTabs: [], terminalSockets: {}, sessionIds: {}, tabStatuses: {} });
    const view = render(<App />);
    try {
      await screen.findByRole("textbox", { name: "Terminal detached" });
      const props = lifecycle.render.mock.calls.slice(-1)[0][0];
      act(() => props.onConnectionInfo({ hostname: "replacement.test", port: 2323, username: "bob", connection_type: "telnet" }));
      expect(lifecycle.render.mock.calls.slice(-1)[0][0].host).toMatchObject({ hostname: "replacement.test", port: 2323, username: "bob", connection_type: "telnet" });
      const send = vi.fn();
      act(() => useAppStore.getState().showConfirm({ title: "Paste into terminal?", message: "Multiple lines", confirmText: "Paste", onConfirm: send }));
      expect(send).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Paste" }));
      expect(send).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
      window.history.replaceState({}, "", previousUrl);
    }
  });
});
