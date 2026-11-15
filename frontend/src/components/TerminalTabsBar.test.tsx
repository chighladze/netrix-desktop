import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type SavedHostDto } from "../state/store";
import { waitForTerminalRenderer } from "../terminal/useWindowHandoffs";
import { transferTerminalWindow } from "../terminal/windowHandoff";
import TerminalTabsBar from "./TerminalTabsBar";

const windows = vi.hoisted(() => ({ create: vi.fn(), position: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/window", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/window")>(),
  cursorPosition: async () => ({ x: 500, y: 300 }), monitorFromPoint: async () => null,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: class {
  constructor(label: string, options: unknown) { windows.create(label, options); }
  async once(event: string, callback: () => void) { if (event === "tauri://created") callback(); return () => {}; }
  setPosition = windows.position;
} }));

vi.mock("../terminal/useWindowHandoffs", () => ({ waitForTerminalRenderer: vi.fn(async () => {}) }));
vi.mock("../terminal/windowHandoff", () => ({
  transferTerminalWindow: vi.fn(async () => {}),
  TerminalMoveCancelledError: class extends Error {},
}));

const originalSettings = useAppStore.getState().settings;
const host = (id: number): SavedHostDto => ({
  id, revision: 0, name: `router-${id}`, hostname: `router-${id}.example.test`,
  username: "operator", port: 22, connection_type: "ssh",
  has_password: false, has_private_key: false,
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.mocked(waitForTerminalRenderer).mockResolvedValue(undefined);
  useAppStore.setState({
    terminalTabs: [1, 2, 3].map((id) => ({ id: `tab-${id}`, host: host(id), isConnected: id === 1 })),
    activeTabId: "tab-1", tabStatuses: { "tab-1": "connected", "tab-2": "connecting", "tab-3": "error" },
    terminalGroups: [], terminalLayout: "single", pendingTerminalGroupId: null,
    terminalSockets: {}, terminalInstances: {}, terminalTransfers: {}, sessionIds: {},
    broadcastMode: false, confirmDialog: null,
    settings: {
      ...originalSettings,
      window: { ...originalSettings.window, tabPosition: "top", showTabCloseButton: true },
      security: { ...originalSettings.security, confirmBeforeDisconnect: true },
    },
  });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe("terminal session tabs", () => {
  it("opens a standalone session in a workspace window with layout controls", async () => {
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Detach router-1" }));
    await waitFor(() => expect(transferTerminalWindow).toHaveBeenCalledOnce());
    const options = vi.mocked(transferTerminalWindow).mock.calls[0][0];
    expect(options.workspace).toBeUndefined();
    await options.open({ id: "handoff-single", source: "main", target: options.target });
    const url = new URL(windows.create.mock.calls[0][1].url, "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ detached: "true", workspace: "true", handoff: "handoff-single", source: "main", originTabId: "tab-1" });
    expect(windows.position).toHaveBeenCalledOnce();
    expect(useAppStore.getState().terminalTabs).toHaveLength(3);
  });

  it("represents a split as one selectable tab alongside independent sessions", () => {
    useAppStore.getState().setTerminalLayout("rows");
    useAppStore.getState().insertTerminalPane(useAppStore.getState().terminalGroups[0].id, 1, "tab-2");
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    const group = screen.getByRole("tab", { name: "Session group: router-1 + router-2, 2 sessions" });
    expect(group.getAttribute("aria-selected")).toBe("true");
    act(() => useAppStore.getState().setActiveTabId("tab-2"));
    fireEvent.click(screen.getByRole("tab", { name: /router-3/ }));
    expect(useAppStore.getState().terminalLayout).toBe("single");
    fireEvent.click(group);
    expect(useAppStore.getState().activeTabId).toBe("tab-2");
    expect(useAppStore.getState().terminalLayout).toBe("rows");
    fireEvent.click(screen.getByRole("button", { name: "Ungroup sessions" }));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(useAppStore.getState().terminalLayout).toBe("single");
  });

  it("moves every member in the group using one handoff and closes the group with one confirmation", async () => {
    useAppStore.getState().setTerminalLayout("columns");
    useAppStore.getState().insertTerminalPane(useAppStore.getState().terminalGroups[0].id, 1, "tab-2");
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Detach router-1 + router-2" }));
    await waitFor(() => expect(transferTerminalWindow).toHaveBeenCalledOnce());
    const options = vi.mocked(transferTerminalWindow).mock.calls[0][0];
    expect(options.workspace?.tabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);
    expect(options.workspace?.group.layout).toBe("columns");
    fireEvent.click(screen.getByRole("button", { name: "Close router-1 + router-2" }));
    expect(useAppStore.getState().confirmDialog?.message).toContain("2 sessions");
    act(() => useAppStore.getState().confirmDialog?.onConfirm());
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["tab-3"]);
    expect(useAppStore.getState().terminalGroups).toEqual([]);
  });

  it("keeps other open sessions as separate tabs when a layout is chosen", () => {
    useAppStore.getState().setActiveTabId("tab-2");
    useAppStore.getState().setTerminalLayout("grid");
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "Session group: router-2, 1 sessions" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /router-1, ssh/ }));
    expect(useAppStore.getState().terminalLayout).toBe("single");
    expect(useAppStore.getState().terminalGroups[0].tabIds).toEqual(["tab-2"]);
  });
  it.each([1, 2, 3])("restores ordinary tabs after Single with %i grouped sessions", (count) => {
    useAppStore.getState().setTerminalGroup({ id: "g", layout: "grid", tabIds: ["tab-1", "tab-2", "tab-3"].slice(0, count) });
    useAppStore.getState().setActiveTabId(`tab-${count}`);
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Ungroup sessions" })).toBeTruthy();
    act(() => useAppStore.getState().setTerminalLayout("single"));
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: /^Session group:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ungroup sessions" })).toBeNull();
    expect(screen.getByRole("tab", { name: new RegExp(`^router-${count}, ssh,`) }).getAttribute("aria-selected")).toBe("true");
  });

  it("selects the corresponding session and keeps one tab in the keyboard sequence", () => {
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "router-1, ssh, Connected" }).tabIndex).toBe(0);
    const second = screen.getByRole("tab", { name: "router-2, ssh, Connecting" });
    expect(second.tabIndex).toBe(-1);
    fireEvent.click(second);
    expect(useAppStore.getState().activeTabId).toBe("tab-2");
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(second.tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: /router-1/ }).tabIndex).toBe(-1);
    expect(screen.getByRole("tab", { name: /Connection failed/ })).toBeTruthy();
  });

  it("switches with arrows, Home, End and Enter without starting a drag", () => {
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft", code: "ArrowLeft" });
    expect(useAppStore.getState().activeTabId).toBe("tab-3");
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "ArrowRight", code: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: "End", code: "End" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2], { key: "Home", code: "Home" });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[1], { key: "Enter", code: "Enter" });
    expect(useAppStore.getState().activeTabId).toBe("tab-2");
    expect(tabs.every((tab) => tab.dataset.dragging === "false")).toBe(true);
  });

  it("retains Space to move and Escape to cancel keyboard sorting", async () => {
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    const first = screen.getAllByRole("tab")[0];
    act(() => first.focus());
    fireEvent.keyDown(first, { key: " ", code: "Space" });
    await waitFor(() => expect(first.dataset.dragging).toBe("true"));
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(first.dataset.dragging).toBe("false"));
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2", "tab-3"]);
  });

  it("keeps close actions separate from selection and confirms a live disconnect", () => {
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    const close = screen.getByRole("button", { name: "Close router-2" });
    fireEvent.keyDown(close, { key: "Enter", code: "Enter" });
    expect(useAppStore.getState().activeTabId).toBe("tab-1");
    fireEvent.click(close);
    expect(useAppStore.getState().activeTabId).toBe("tab-1");
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-3"]);
    fireEvent.click(screen.getByRole("button", { name: "Close router-1" }));
    expect(useAppStore.getState().confirmDialog?.title).toBe("Active Connection");
    expect(useAppStore.getState().terminalTabs).toHaveLength(2);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /router-3/ }), { button: 1 });
    expect(useAppStore.getState().terminalTabs).toHaveLength(1);
  });

  it("disables tab actions while preparing to move the session", async () => {
    let ready = () => {};
    vi.mocked(waitForTerminalRenderer).mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    const detach = screen.getByRole("button", { name: "Detach router-2" }) as HTMLButtonElement;
    fireEvent.keyDown(detach, { key: " ", code: "Space" });
    expect(screen.getAllByRole("tab").every((tab) => tab.dataset.dragging === "false")).toBe(true);
    fireEvent.click(detach);
    expect(useAppStore.getState().activeTabId).toBe("tab-2");
    expect(detach.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close router-2" }) as HTMLButtonElement).disabled).toBe(true);
    expect(transferTerminalWindow).not.toHaveBeenCalled();
    await act(async () => ready());
    expect(transferTerminalWindow).toHaveBeenCalledOnce();
    expect(detach.disabled).toBe(false);
  });

  it("honors the close-button preference and exposes the toolbar actions", () => {
    const settings = useAppStore.getState().settings;
    useAppStore.setState({ settings: { ...settings, window: { ...settings.window, showTabCloseButton: false } } });
    const onAddTab = vi.fn();
    render(<TerminalTabsBar onAddTab={onAddTab} />);
    expect(screen.queryByRole("button", { name: /^Close router/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New connection" }));
    expect(onAddTab).toHaveBeenCalledOnce();
    const broadcast = screen.getByRole("button", { name: "Broadcast mode" });
    fireEvent.click(broadcast);
    expect(broadcast.getAttribute("aria-pressed")).toBe("true");
    expect(useAppStore.getState().broadcastMode).toBe(true);
  });

  it("shows complete host details above bottom tabs outside the scrolling viewport", () => {
    const settings = useAppStore.getState().settings;
    useAppStore.setState({ settings: { ...settings, window: { ...settings.window, tabPosition: "bottom" } } });
    const view = render(<TerminalTabsBar onAddTab={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByRole("tab", { name: /router-1/ }));
    const tooltip = screen.getByRole("tooltip");
    expect(view.container.contains(tooltip)).toBe(false);
    expect(tooltip.style.bottom).not.toBe("");
    expect(tooltip.textContent).toContain("operator@router-1.example.test");
    fireEvent.scroll(screen.getByRole("tablist"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("reveals a selected tab in an overflowing strip and scrolls without changing sessions", () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-terminal-tabs-dropzone") ? 690 : 0; });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.hasAttribute("data-terminal-tabs-dropzone") ? 400 : 0; });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const viewport = this.closest("[data-terminal-tabs-dropzone]");
      const index = Number(this.dataset.terminalTabId?.replace("tab-", "")) - 1;
      const x = this.hasAttribute("data-terminal-tab-id") ? 40 + index * 230 - (viewport?.scrollLeft || 0) : 40;
      const width = this.hasAttribute("data-terminal-tab-id") ? 224 : 400;
      return { x, y: 0, left: x, top: 0, right: x + width, bottom: 38, width, height: 38, toJSON: () => ({}) };
    });
    render(<TerminalTabsBar onAddTab={vi.fn()} />);
    const viewport = screen.getByRole("tablist");
    const scrollBy = vi.fn((options?: ScrollToOptions | number, _y?: number) => {
      const left = typeof options === "number" ? options : options?.left;
      viewport.scrollLeft = Math.max(0, Math.min(290, viewport.scrollLeft + (left || 0)));
      fireEvent.scroll(viewport);
    });
    viewport.scrollBy = scrollBy;
    act(() => useAppStore.getState().setActiveTabId("tab-3"));
    expect(scrollBy).toHaveBeenCalledWith({ left: 288, behavior: "auto" });
    const right = screen.getByRole("button", { name: "Scroll sessions right" }) as HTMLButtonElement;
    fireEvent.click(right);
    expect(viewport.scrollLeft).toBe(290);
    expect(right.disabled).toBe(true);
    expect(useAppStore.getState().activeTabId).toBe("tab-3");
    fireEvent.click(screen.getByRole("button", { name: "Scroll sessions left" }));
    expect(viewport.scrollLeft).toBe(0);
    expect(useAppStore.getState().activeTabId).toBe("tab-3");
  });
});
