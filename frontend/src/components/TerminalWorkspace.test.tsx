import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type SavedHostDto } from "../state/store";
import TerminalWorkspace from "./TerminalWorkspace";
const counts = vi.hoisted(() => ({ mounted: new Map<string, number>(), disposed: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), getApiBase: async () => "http://127.0.0.1:1234", fetchJsonOrThrow: async () => ({ ok: true }) }));
vi.mock("./TerminalCanvas", async () => {
  const React = await import("react");
  return {
    default: ({ tabId }: { tabId: string }) => {
      const [draft, setDraft] = React.useState("");
      React.useLayoutEffect(() => {
        counts.mounted.set(tabId, (counts.mounted.get(tabId) || 0) + 1);
        return () => counts.disposed(tabId);
      }, [tabId]);
      return <input aria-label={`Terminal ${tabId}`} value={draft} onChange={(event) => setDraft(event.target.value)} />;
    },
  };
});
const host = (id: number): SavedHostDto => ({
  id,
  revision: 0,
  name: `host-${id}`,
  hostname: "example.test",
  username: "admin",
  port: 22,
  connection_type: "ssh",
  has_password: false,
  has_private_key: false,
});
describe("TerminalWorkspace", () => {
  beforeEach(() => {
    counts.mounted.clear();
    counts.disposed.mockClear();
    useAppStore.setState({
      terminalTabs: [1, 2, 3].map((id) => ({
        id: `tab-${id}`,
        host: host(id),
        isConnected: false,
      })),
      activeTabId: "tab-1",
      terminalLayout: "columns",
      terminalGroups: [{ id: "group-1", layout: "columns", tabIds: ["tab-1", "tab-2"] }],
      pendingTerminalGroupId: null,
      terminalInstances: {}, terminalSockets: {}, terminalTransfers: {}, terminalClosures: {}, tabStatuses: {},
      sessionIds: { "tab-1": 101, "tab-2": 102, "tab-3": 103 }, confirmDialog: null,
    });
    localStorage.removeItem("terminalLayout");
  });
  it("shows two sessions and changes focus without remounting either terminal", async () => {
    render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    expect(screen.getByLabelText("Terminal tab-1")).toBeTruthy();
    expect(screen.getByLabelText("Terminal tab-2")).toBeTruthy();
    fireEvent.focus(screen.getByLabelText("Terminal tab-2"));
    await waitFor(() => expect(useAppStore.getState().activeTabId).toBe("tab-2"));
    expect(counts.mounted.get("tab-1")).toBe(1);
    expect(counts.mounted.get("tab-2")).toBe(1);
    fireEvent.change(screen.getByLabelText("Session in pane 2"), { target: { value: "tab-3" } });
    expect(screen.getByLabelText("Terminal tab-3")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Terminal tab-2" })).toBeNull();
    expect(counts.mounted.get("tab-1")).toBe(1);
  });

  it("applies every layout, persists it and retains the renderers that remain visible", () => {
    const view = render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    const visible = () => [...view.container.querySelectorAll<HTMLElement>("[data-terminal-pane]")].map((pane) => pane.dataset.terminalPane);
    fireEvent.click(screen.getByRole("radio", { name: "Stacked" }));
    expect(useAppStore.getState().terminalLayout).toBe("rows");
    expect(visible()).toEqual(["tab-1", "tab-2"]);
    expect(counts.mounted.get("tab-1")).toBe(1);
    expect(counts.mounted.get("tab-2")).toBe(1);
    fireEvent.click(screen.getByRole("radio", { name: "2 × 2" }));
    expect(visible()).toEqual(["tab-1", "tab-2"]);
    expect(JSON.parse(localStorage.getItem("terminalLayout")!)).toBe("grid");
    expect(view.container.querySelectorAll("[data-terminal-empty-pane]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Single" }));
    expect(visible()).toEqual(["tab-1"]);
    expect(counts.mounted.get("tab-1")).toBe(1);
    expect(useAppStore.getState().sessionIds).toEqual({ "tab-1": 101, "tab-2": 102, "tab-3": 103 });
  });

  it("restores the chosen split after maximizing a pane", () => {
    render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Session in pane 2"), { target: { value: "tab-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Maximize host-3" }));
    expect(useAppStore.getState().terminalLayout).toBe("single");
    expect(screen.getByLabelText("Terminal tab-3")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Terminal tab-1" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    expect((screen.getByLabelText("Session in pane 1") as HTMLSelectElement).value).toBe("tab-1");
    expect((screen.getByLabelText("Session in pane 2") as HTMLSelectElement).value).toBe("tab-3");
    expect(counts.mounted.get("tab-3")).toBe(1);
    expect(counts.mounted.get("tab-1")).toBe(1);
    expect(counts.disposed).not.toHaveBeenCalled();
  });

  it("opens an outside tab independently and restores the split group when selected again", () => {
    const view = render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    act(() => useAppStore.getState().setActiveTabId("tab-3"));
    expect(screen.queryByRole("textbox", { name: "Terminal tab-1" })).toBeNull();
    expect(screen.getByLabelText("Terminal tab-3")).toBeTruthy();
    expect(view.container.querySelectorAll("[data-terminal-pane]")).toHaveLength(1);
    act(() => useAppStore.getState().setActiveTabId("tab-1"));
    expect(screen.getByLabelText("Terminal tab-1")).toBeTruthy();
    expect(screen.getByLabelText("Terminal tab-2")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Terminal tab-3" })).toBeNull();
    expect(counts.mounted.get("tab-1")).toBe(1);
    expect(counts.mounted.get("tab-2")).toBe(1);
    expect(counts.disposed).not.toHaveBeenCalled();
    expect([...screen.getByLabelText("Session in pane 1").querySelectorAll("option")].map((option) => option.value)).not.toContain("tab-2");
  });

  it("opens the connection picker from an empty pane", () => {
    const onAddConnection = vi.fn();
    render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={onAddConnection} />);
    fireEvent.click(screen.getByRole("radio", { name: "2 × 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose a connection for pane 4" }));
    expect(onAddConnection).toHaveBeenCalledOnce();
    expect(screen.getByText("2 of 3 sessions visible")).toBeTruthy();
  });

  it("respects disconnect confirmation and closes an inactive pane without selecting it", async () => {
    const settings = useAppStore.getState().settings;
    useAppStore.setState({ tabStatuses: { "tab-2": "connected" }, settings: { ...settings, security: { ...settings.security, confirmBeforeDisconnect: true } } });
    render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    const close = screen.getByRole("button", { name: "Close host-2" });
    fireEvent.pointerDown(close);
    fireEvent.focus(close);
    fireEvent.click(close);
    expect(useAppStore.getState().activeTabId).toBe("tab-1");
    expect(useAppStore.getState().terminalTabs).toHaveLength(3);
    expect(useAppStore.getState().confirmDialog?.title).toBe("Active Connection");
    await act(async () => { useAppStore.getState().confirmDialog?.onConfirm(); });
    expect(useAppStore.getState().terminalTabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-3"]);
    expect(screen.queryByLabelText("Terminal tab-3")).toBeNull();
    expect(screen.getByText("Pane 2 is ready")).toBeTruthy();
    expect(counts.mounted.get("tab-1")).toBe(1);
  });

  it("locks layout and pane actions until an in-progress window move finishes", () => {
    useAppStore.setState({ terminalTransfers: { "tab-1": { direction: "outgoing", phase: "connecting", cancel: vi.fn() } } });
    render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    const layout = screen.getByRole("radio", { name: "Single" }) as HTMLButtonElement;
    expect(layout.disabled).toBe(true);
    fireEvent.click(layout);
    expect(useAppStore.getState().terminalLayout).toBe("columns");
    expect((screen.getByLabelText("Session in pane 1") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Close host-1" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => useAppStore.getState().setTerminalTransfer("tab-1", null));
    expect(layout.disabled).toBe(false);
    fireEvent.click(layout);
    expect(useAppStore.getState().terminalLayout).toBe("single");
  });

  it("renders every group member for a window move even while one pane is maximized", () => {
    const view = render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize host-2" }));
    expect(view.container.querySelectorAll("[data-terminal-pane]")).toHaveLength(1);
    act(() => {
      useAppStore.getState().setTerminalTransfer("tab-1", { direction: "outgoing", phase: "preparing", cancel: vi.fn() });
      useAppStore.getState().setTerminalTransfer("tab-2", { direction: "outgoing", phase: "preparing", cancel: vi.fn() });
    });
    expect(screen.getByLabelText("Terminal tab-1")).toBeTruthy();
    expect(screen.getByLabelText("Terminal tab-2")).toBeTruthy();
    expect(useAppStore.getState().terminalGroups[0].layout).toBe("single");
    act(() => {
      useAppStore.getState().setTerminalTransfer("tab-1", null);
      useAppStore.getState().setTerminalTransfer("tab-2", null);
    });
    expect(view.container.querySelectorAll("[data-terminal-pane]")).toHaveLength(1);
    expect(screen.getByLabelText("Terminal tab-2")).toBeTruthy();
  });

  it("does not mount unrelated hidden panes while receiving one session into a visible vacancy", () => {
    const tabs = useAppStore.getState().terminalTabs;
    useAppStore.setState({ terminalTabs: [...tabs, { id: "tab-4", host: host(4), isConnected: false }], terminalGroups: [{ id: "group-1", layout: "columns", tabIds: ["tab-1", "tab-2", "tab-3"], paneSlots: ["tab-1", null, "tab-2", "tab-3"] }] });
    render(<TerminalWorkspace onBack={vi.fn()} onAddConnection={vi.fn()} />);
    act(() => {
      useAppStore.getState().insertTerminalPane("group-1", 1, "tab-4");
      useAppStore.getState().setTerminalTransfer("tab-4", { direction: "incoming", phase: "connecting", cancel: vi.fn() });
    });
    expect(screen.getByLabelText("Terminal tab-4")).toBeTruthy();
    expect(screen.queryByLabelText("Terminal tab-2")).toBeNull();
    expect(screen.queryByLabelText("Terminal tab-3")).toBeNull();
    expect(counts.mounted.get("tab-1")).toBe(1);
  });

  it("retains visited tabs and their local state until they close, without starting unvisited tabs", async () => {
    useAppStore.setState({ terminalLayout: "single", terminalGroups: [] });
    const view = render(<TerminalWorkspace onBack={vi.fn()} />);
    const first = screen.getByRole("textbox", { name: "Terminal tab-1" }) as HTMLInputElement;
    fireEvent.change(first, { target: { value: "unfinished command" } });
    first.setSelectionRange(2, 7);
    first.scrollTop = 120;
    const sessions = useAppStore.getState().sessionIds;
    for (let i = 0; i < 3; i++) {
      act(() => useAppStore.getState().setActiveTabId("tab-2"));
      expect(screen.queryByRole("textbox", { name: "Terminal tab-1" })).toBeNull();
      expect(view.container.contains(first)).toBe(true);
      expect(counts.mounted.has("tab-3")).toBe(false);
      act(() => useAppStore.getState().setActiveTabId("tab-1"));
      expect(screen.getByRole("textbox", { name: "Terminal tab-1" })).toBe(first);
      expect(first.value).toBe("unfinished command");
      expect([first.selectionStart, first.selectionEnd, first.scrollTop]).toEqual([2, 7, 120]);
    }
    expect(counts.mounted.get("tab-1")).toBe(1);
    expect(counts.mounted.get("tab-2")).toBe(1);
    expect(counts.disposed).not.toHaveBeenCalled();
    expect(useAppStore.getState().sessionIds).toBe(sessions);
    await act(async () => { await useAppStore.getState().removeTerminalTab("tab-2"); });
    expect(screen.queryByLabelText("Terminal tab-2")).toBeNull();
    expect(counts.disposed).toHaveBeenCalledExactlyOnceWith("tab-2");
  });

  it("keeps pane positions and renderers when tab order differs from layout order", () => {
    useAppStore.setState({ terminalLayout: "grid", terminalGroups: [{ id: "g", layout: "grid", tabIds: ["tab-2", "tab-1"], paneSlots: ["tab-2", null, "tab-1", null] }] });
    const view = render(<TerminalWorkspace onBack={vi.fn()} />);
    const first = view.container.querySelector<HTMLElement>('[data-terminal-pane="tab-1"]')!;
    const second = view.container.querySelector<HTMLElement>('[data-terminal-pane="tab-2"]')!;
    expect([first.style.gridColumn, first.style.gridRow]).toEqual(["1", "2"]);
    expect([second.style.gridColumn, second.style.gridRow]).toEqual(["1", "1"]);
    const empty = view.container.querySelector<HTMLElement>('[data-terminal-empty-pane="2"]')!;
    expect([empty.style.gridColumn, empty.style.gridRow]).toEqual(["2", "1"]);
    act(() => useAppStore.getState().reorderTerminalTabs([...useAppStore.getState().terminalTabs].reverse()));
    expect(view.container.querySelector('[data-terminal-pane="tab-1"]')).toBe(first);
    expect(view.container.querySelector('[data-terminal-pane="tab-2"]')).toBe(second);
    expect(counts.disposed).not.toHaveBeenCalled();
  });
});
