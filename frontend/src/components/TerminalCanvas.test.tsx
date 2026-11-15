import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    options = {};
    unicode = { activeVersion: "" };
    cols = 80;
    rows = 24;
    line = "Password: ";
    buffer = { active: { type: "normal", baseY: 0, cursorY: 0, viewportY: 0, length: 0,
      getLine: () => ({ translateToString: () => this.line }) }, onBufferChange: () => ({ dispose() {} }) };
    input: (data: string) => void = () => {};
    key: (event: KeyboardEvent) => boolean = () => true;
    constructor(options = {}) { this.options = options; FakeTerminal.instances.push(this); }
    loadAddon() {}
    open() {}
    focus() {}
    write = vi.fn();
    scrollToBottom() {}
    dispose() {}
    clearSelection() {}
    getSelection() { return ""; }
    onData(callback: (data: string) => void) { this.input = callback; return { dispose() {} }; }
    onKey() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    onScroll() { return { dispose() {} }; }
    onRender() { return { dispose() {} }; }
    onWriteParsed() { return { dispose() {} }; }
    onSelectionChange() { return { dispose() {} }; }
    onBell() { return { dispose() {} }; }
    attachCustomKeyEventHandler(callback: (event: KeyboardEvent) => boolean) { this.key = callback; }
  }
  class FakeAddon {
    fit() {}
    clearDecorations() {}
    findNext = vi.fn();
    findPrevious = vi.fn();
    onDidChangeResults() { return { dispose() {} }; }
  }
  const socket = { readyState: 1, send: vi.fn(), __netrixHandoffBusy: false };
  const snapshot: import("../terminal/TerminalSessionController").TerminalSessionSnapshot = { status: "connected", sessionId: 42, errorMessage: null,
    isVaultError: false, sessionUnavailable: false, latency: null, progressStep: null, handoffPending: false, handoffReady: false };
  let subscriber: ((value: typeof snapshot) => void) | null = null;
  let renderer: ((data: string, replay: boolean) => void) | null = null;
  const controller = {
    getSnapshot: () => snapshot, getSocket: () => socket, configure: vi.fn(),
    subscribe: (callback: (value: typeof snapshot) => void) => { subscriber = callback; return () => { subscriber = null; }; },
    attachRenderer: (callback: NonNullable<typeof renderer>) => { renderer = callback; return () => { renderer = null; }; },
    connect: vi.fn(), reconnect: vi.fn(), send: vi.fn(), updateSize: vi.fn(),
  };
  const emit = (updates: Partial<typeof snapshot>) => { Object.assign(snapshot, updates); subscriber?.(snapshot); };
  const output = (data: string) => renderer?.(data, false);
  return { FakeTerminal, FakeAddon, socket, controller, snapshot, emit, output };
});

vi.mock("xterm", () => ({ Terminal: harness.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: harness.FakeAddon }));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: harness.FakeAddon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: harness.FakeAddon }));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: harness.FakeAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: harness.FakeAddon }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: harness.FakeAddon }));
vi.mock("../terminal/TerminalSessionController", async (importOriginal) => ({
  ...await importOriginal<typeof import("../terminal/TerminalSessionController")>(),
  ensureTerminalSessionController: () => harness.controller,
}));
vi.mock("../api", () => ({ getApiBase: async () => "http://127.0.0.1:8080", fetchJsonOrThrow: vi.fn() }));
vi.mock("./TerminalHints", () => ({ default: () => null }));
vi.mock("./TerminalTransferOverlay", () => ({ default: () => null }));

import type { SavedHostDto } from "../state/store";

let useAppStore: typeof import("../state/store").useAppStore;
let TerminalCanvas: typeof import("./TerminalCanvas").default;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
const originalAnimations = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getAnimations");

function mockConnectionSweep() {
  const sweep = Object.assign(new EventTarget(), {
    animationName: "connection-light-sweep",
    effect: { getComputedTiming: () => ({ duration: 6000, progress: .1, currentIteration: 0 }), updateTiming: vi.fn() },
    updatePlaybackRate: vi.fn(), finish: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "getAnimations", { configurable: true, value: () => [sweep] });
  return sweep;
}

const host: SavedHostDto = { id: 1, revision: 0, name: "Test host", hostname: "example.test",
  port: 22, username: "admin", connection_type: "ssh", has_password: false, has_private_key: false };
const legacyKeys = ["netrix_terminal_recent_commands_v1", "netrix_terminal_recent_commands_v2"];
const terminal = () => harness.FakeTerminal.instances[harness.FakeTerminal.instances.length - 1];
const key = (key: string, modifiers: KeyboardEventInit = {}) => act(() => {
  terminal().key(new KeyboardEvent("keydown", { key, ...modifiers }));
});
const openLauncher = () => key("p", { ctrlKey: true, shiftKey: true });
const input = (...chunks: string[]) => act(() => chunks.forEach((chunk) => terminal().input(chunk)));

async function mount(tabId = "tab-history", profile = host) {
  useAppStore.setState({ activeView: "terminal", activeTabId: tabId,
    terminalTabs: [{ id: tabId, host: profile, isConnected: true, sessionId: 42 }],
    terminalInstances: {}, terminalSockets: { [tabId]: harness.socket as unknown as WebSocket },
    sessionIds: { [tabId]: 42 }, tabStatuses: { [tabId]: "connected" }, overlayStates: {},
    terminalTransfers: {}, broadcastMode: false, quickActions: [
      { id: "safe-action", label: "List files", command: "ls -la", color: "blue" },
    ],
  });
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<TerminalCanvas tabId={tabId} host={profile} />); });
  return view;
}

beforeEach(async () => {
  // Each test starts a new window/module lifetime, including its memory-only history.
  vi.resetModules();
  useAppStore = (await import("../state/store")).useAppStore;
  TerminalCanvas = (await import("./TerminalCanvas")).default;
  vi.useFakeTimers();
  harness.FakeTerminal.instances = [];
  harness.socket.__netrixHandoffBusy = false;
  Object.assign(harness.snapshot, { status: "connected", sessionId: 42, errorMessage: null, isVaultError: false, sessionUnavailable: false, progressStep: null });
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

describe("connection presentation lifecycle", () => {
  it("applies color changes to the existing renderer and resets to its theme", async () => {
    const colored = { ...host, terminal_theme: "nord", terminal_background: "#112233", terminal_foreground: "#abcdef" };
    const view = await mount("colors", colored);
    const instance = terminal();
    expect(instance.options).toMatchObject({ theme: { background: "#112233", foreground: "#abcdef", cursor: "#abcdef" } });
    expect((view.container.firstChild as HTMLElement).style.backgroundColor).toBe("rgb(17, 34, 51)");
    await act(async () => { view.rerender(<TerminalCanvas tabId="colors" host={{ ...colored, terminal_background: null, terminal_foreground: "#ffffff" }} />); });
    expect(terminal()).toBe(instance);
    expect(instance.options).toMatchObject({ theme: { background: "#2e3440", foreground: "#ffffff" } });
    expect((view.container.firstChild as HTMLElement).style.backgroundColor).toBe("rgb(46, 52, 64)");
    await act(async () => { view.rerender(<TerminalCanvas tabId="colors" host={{ ...colored, terminal_appearance: { font_family: "Consolas", font_weight: 500, font_weight_bold: 800, line_height: 1.4, letter_spacing: 1, cursor_style: "bar", cursor_blink: false, colors: { green: "#ffeeaa", cursor: "#ff0000" } } }} />); });
    expect(terminal()).toBe(instance);
    expect(instance.options).toMatchObject({ fontFamily: "Consolas, Menlo, Consolas, monospace", fontWeight: 500, fontWeightBold: 800, lineHeight: 1.4, letterSpacing: 1, cursorStyle: "bar", cursorBlink: false, theme: { green: "#ffeeaa", cursor: "#ff0000" } });
    await act(async () => { view.rerender(<TerminalCanvas tabId="colors" host={colored} />); });
    expect(instance.options).toMatchObject({ fontWeight: 400, fontWeightBold: 700, lineHeight: 1.2, letterSpacing: .5, cursorStyle: "block", cursorBlink: true });
    await act(async () => { view.rerender(<TerminalCanvas tabId="colors" host={{ ...host, terminal_theme: "default" }} />); });
    expect(terminal()).toBe(instance);
    expect(instance.options).toMatchObject({ allowTransparency: true, theme: { background: "#0b111800", cursorAccent: "#0b1118" } });
    expect((view.container.firstChild as HTMLElement).style.backgroundColor).toBe("rgb(11, 17, 24)");
    expect((view.container.firstChild as HTMLElement).style.backgroundImage).toContain("radial-gradient");
    await act(async () => { view.rerender(<TerminalCanvas tabId="colors" host={{ ...host, terminal_theme: "default", terminal_background: "#112233" }} />); });
    expect(terminal()).toBe(instance);
    expect(instance.options).toMatchObject({ theme: { background: "#112233" } });
    expect((view.container.firstChild as HTMLElement).style.backgroundImage).toBe("none");
  });

  async function mountFresh() {
    Object.assign(harness.snapshot, { status: "connecting", sessionId: null });
    useAppStore.setState({ activeView: "terminal", activeTabId: "fresh",
      terminalTabs: [{ id: "fresh", host, isConnected: false }], terminalInstances: {},
      terminalSockets: {}, sessionIds: {}, tabStatuses: { fresh: "connecting" }, terminalClosures: {},
    });
    await act(async () => { render(<TerminalCanvas tabId="fresh" host={host} />); });
  }

  it("keeps receiving output while the last discharge finishes, then reveals and focuses the terminal", async () => {
    const sweep = mockConnectionSweep();
    await mountFresh();
    expect(screen.getByRole("heading", { name: "Connecting…" })).toBeDefined();
    expect(document.querySelector("[inert]")).not.toBeNull();
    const focus = vi.spyOn(terminal(), "focus");
    const instance = terminal();
    act(() => harness.emit({ status: "connected", sessionId: 43 }));
    act(() => { harness.output("Welcome\r\n$ "); vi.advanceTimersByTime(200); });
    expect(instance.write).toHaveBeenCalledWith("Welcome\r\n$ ", expect.any(Function));
    expect(screen.getByRole("heading", { name: "Your terminal is ready" })).toBeDefined();
    expect(document.querySelector("[inert]")).not.toBeNull();
    expect(document.querySelector(".connection-exiting")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
    act(() => sweep.dispatchEvent(new Event("finish")));
    expect(document.querySelector(".connection-exiting")).not.toBeNull();
    act(() => vi.advanceTimersByTime(180));
    expect(screen.queryByRole("region", { name: "Your terminal is ready" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    act(() => vi.advanceTimersByTime(50));
    expect(focus).toHaveBeenCalledOnce();
    expect(terminal()).toBe(instance);
  });

  it("keeps a disconnect visible if it interrupts the success transition", async () => {
    const sweep = mockConnectionSweep();
    await mountFresh();
    act(() => harness.emit({ status: "connected", sessionId: 43 }));
    act(() => sweep.dispatchEvent(new Event("finish")));
    act(() => vi.advanceTimersByTime(80));
    act(() => harness.emit({ status: "disconnected", errorMessage: "Connection closed" }));
    act(() => { sweep.dispatchEvent(new Event("finish")); vi.advanceTimersByTime(2000); });
    expect(screen.getByRole("heading", { name: "Session disconnected" })).toBeDefined();
    expect(document.querySelector(".connection-exiting")).toBeNull();
    expect(document.querySelector("[inert]")).not.toBeNull();
  });

  it("keeps a session handoff free of the full connection screen", async () => {
    harness.snapshot.status = "connecting";
    await mount();
    expect(screen.queryByRole("heading", { name: "Connecting…" })).toBeNull();
  });

  it("reveals the connected terminal without animation waits with reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    await mountFresh();
    act(() => harness.emit({ status: "connected", sessionId: 43 }));
    act(() => vi.advanceTimersByTime(0));
    expect(screen.queryByRole("heading", { name: "Your terminal is ready" })).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("routes reconnect and cancellation through the existing session actions", async () => {
    await mountFresh();
    act(() => harness.emit({ status: "error", errorMessage: "Connection timed out" }));
    expect(screen.getByRole("heading", { name: "The host didn’t respond" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(harness.controller.reconnect).toHaveBeenCalledOnce();
    const removeTerminalTab = vi.fn(async () => true);
    act(() => useAppStore.setState({ removeTerminalTab }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel connection" })); });
    expect(removeTerminalTab).toHaveBeenCalledWith("fresh");
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  if (originalAnimations) Object.defineProperty(HTMLElement.prototype, "getAnimations", originalAnimations);
  else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
});

describe("session controls", () => {
  it("switches between docked tools and preserves the terminal and search text", async () => {
    await mount();
    const instance = terminal();
    const focus = vi.spyOn(instance, "focus");
    const toolbar = screen.getByRole("group", { name: "Session controls" });
    const launcher = screen.getByRole("button", { name: "Open launcher" });
    const find = screen.getByRole("button", { name: "Find in terminal" });
    expect(toolbar.contains(launcher)).toBe(true);
    expect(toolbar.contains(find)).toBe(true);
    expect(toolbar.closest(".terminal-session-output")).toBeNull();

    fireEvent.click(find);
    const search = screen.getByRole("search", { name: "Find in terminal" });
    expect(search.closest(".terminal-session-output")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Find in terminal output" }), { target: { value: "health" } });
    fireEvent.click(launcher);
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.getByRole("region", { name: "Terminal launcher" }).closest(".terminal-session-output")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close launcher" }));
    expect((screen.getByRole("textbox", { name: "Find in terminal output" }) as HTMLInputElement).value).toBe("health");
    fireEvent.click(screen.getByTitle("Close Search (Esc)"));
    expect(screen.queryByRole("search")).toBeNull();
    expect(focus).toHaveBeenCalled();
    expect(terminal()).toBe(instance);
    expect(harness.controller.send).not.toHaveBeenCalled();
    expect(harness.socket.send).not.toHaveBeenCalled();
  });

  it("does not steal focus from session controls when a pane becomes active", async () => {
    await mount();
    const launcher = screen.getByRole("button", { name: "Open launcher" });
    act(() => { launcher.focus(); useAppStore.setState({ activeTabId: "peer" }); });
    const focus = vi.spyOn(terminal(), "focus");
    act(() => useAppStore.setState({ activeTabId: "tab-history" }));
    act(() => vi.advanceTimersByTime(60));
    expect(document.activeElement).toBe(launcher);
    expect(focus).not.toHaveBeenCalled();
    fireEvent.keyDown(launcher, { key: "p", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("region", { name: "Terminal launcher" })).toBeDefined();
    fireEvent.keyDown(launcher, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Terminal launcher" })).toBeNull();
  });
});

describe("terminal command history privacy", () => {
  it("does not clear an existing selection when a neighboring terminal mounts or closes", async () => {
    await mount();
    const first = terminal();
    const clear = vi.spyOn(first, "clearSelection");
    const peer = new harness.FakeTerminal();
    act(() => useAppStore.getState().setTerminalInstance("peer", peer as unknown as import("xterm").Terminal));
    act(() => useAppStore.getState().setTerminalInstance("peer", null));
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(["tab-history", "detached"])("does not collect typed passwords, paste or screen text in %s", async (tabId) => {
    for (const storageKey of legacyKeys) localStorage.setItem(storageKey, JSON.stringify(["legacy-secret"]));
    await mount(tabId);
    const typed = [..."typed-secret", "\u007f", "!", "\r"];
    const pasted = ["\x1b[200~pasted-secret\x1b[201~", "\r"];
    input(...typed, ...pasted);
    terminal().line = "admin@host $ echoed-secret";
    input("\r", ..."ordinary-command", "\r");
    expect(harness.controller.send.mock.calls.map(([data]) => data)).toEqual([
      ...typed, ...pasted, "\r", ..."ordinary-command", "\r",
    ]);
    openLauncher();
    for (const secret of ["typed-secre!", "pasted-secret", "echoed-secret", "ordinary-command", "legacy-secret"]) {
      expect(screen.queryByText(secret, { exact: false })).toBeNull();
    }
    for (const storageKey of legacyKeys) expect(localStorage.getItem(storageKey)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const toasts = useAppStore.getState().toasts;
    expect(toasts[toasts.length - 1]?.message).toBe("No recent commands to export");
  });

  it("does not record edits or Enter after inserting a saved action", async () => {
    await mount();
    openLauncher();
    fireEvent.click(screen.getByRole("button", { name: /List files/ }));
    expect(harness.socket.send).toHaveBeenCalledWith(new TextEncoder().encode("ls -la"));
    input("\u0015", ..."replacement-secret", "\r");
    terminal().line = "replacement-secret";
    input("\r");
    openLauncher();
    expect(screen.queryByText("Recent", { exact: true })).toBeNull();
    expect(screen.queryByText(/replacement-secret/)).toBeNull();
  });

  it("does not record an action blocked by a window handoff", async () => {
    await mount();
    harness.socket.__netrixHandoffBusy = true;
    key("1", { altKey: true });
    expect(harness.socket.send).not.toHaveBeenCalled();
    openLauncher();
    expect(screen.queryByText("Recent", { exact: true })).toBeNull();
  });

  it("keeps explicit Quick Action history and exports only that history", async () => {
    await mount();
    key("1", { altKey: true });
    expect(harness.socket.send).toHaveBeenCalledWith(new TextEncoder().encode("ls -la"));
    input(..."export-secret", "\r");
    openLauncher();
    expect(screen.getByText("Recent", { exact: true })).toBeTruthy();
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("showSaveFilePicker", vi.fn().mockResolvedValue({ createWritable: async () => ({ write, close }) }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Export CSV" })); });
    const blob = write.mock.calls[0][0] as Blob;
    vi.useRealTimers(); // FileReader schedules its completion through the browser event loop.
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(csv).toContain('"ls -la",1,');
    expect(csv).not.toContain("export-secret");
    for (const storageKey of legacyKeys) expect(localStorage.getItem(storageKey)).toBeNull();
  });
});
