import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const clipboard = vi.hoisted(() => ({ readText: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => clipboard);
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(), getApiBase: async () => "http://127.0.0.1:3210",
  getWsBase: async () => "ws://127.0.0.1:3210", refreshApiToken: async () => "test-token",
}));
vi.mock("../utils/clipboard", () => ({ copyTextWithAutoClear: vi.fn() }));
import { useAppStore } from "../state/store";
import { getTerminalSessionController, disposeTerminalSessionController } from "../terminal/TerminalSessionController";
import { TestTerminalSocket } from "../test/terminalSocket";
import TerminalCanvas from "./TerminalCanvas";
import ConfirmModal from "./ConfirmModal";
import QuickActionBar from "./QuickActionBar";
import { copyTextWithAutoClear } from "../utils/clipboard";

const profile = { id: 71, revision: 1, name: "Paste test", hostname: "127.0.0.1", port: 22221, username: "test", connection_type: "telnet" as const };
beforeEach(() => {
  vi.stubGlobal("WebSocket", TestTerminalSocket);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  TestTerminalSocket.instances = [];
  clipboard.readText.mockReset();
  vi.mocked(copyTextWithAutoClear).mockReset();
  useAppStore.setState(useAppStore.getInitialState(), true);
});
afterEach(async () => {
  cleanup();
  for (const tab of useAppStore.getState().terminalTabs) disposeTerminalSessionController(tab.id);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  vi.unstubAllGlobals();
});

async function mount(broadcast = false) {
  const tab = useAppStore.getState().addTerminalTab(profile);
  useAppStore.getState().setActiveView("terminal");
  const controller = getTerminalSessionController(tab)!;
  await controller.connect();
  const socket = TestTerminalSocket.instances.slice(-1)[0];
  socket.open(); socket.control({ type: "connect", session_id: 71, connection: profile });
  const peer = new TestTerminalSocket("mock://peer"); peer.open();
  useAppStore.setState((state) => ({
    broadcastMode: broadcast, broadcastTargets: new Set(broadcast ? ["peer"] : []),
    terminalSockets: { ...state.terminalSockets, peer: peer as unknown as WebSocket },
  }));
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<><TerminalCanvas tabId={tab} host={profile} /><ConfirmModal /></>); });
  const term = useAppStore.getState().terminalInstances[tab]!;
  socket.sent = []; peer.sent = [];
  return { tab, controller, socket, peer, term, view };
}

function nativePaste(textarea: HTMLTextAreaElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  act(() => textarea.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
}

it.each(["select", "escape", "toggle", "unmatched"])("handles hints with real xterm focus without sending %s keys to any session", async (exit) => {
  const { socket, peer, term } = await mount(true);
  await act(() => new Promise<void>((resolve) => term.write("router 192.0.2.10", resolve)));
  term.focus();
  expect(document.activeElement).toBe(term.textarea);
  expect(fireEvent.keyDown(term.textarea!, { key: "H", keyCode: 72, ctrlKey: true, shiftKey: true })).toBe(false);
  expect(screen.getByTitle("IPv4: 192.0.2.10")).toBeDefined();
  await act(async () => {
    if (exit === "select") fireEvent.keyDown(term.textarea!, { key: "a", keyCode: 65 });
    if (exit === "escape") fireEvent.keyDown(term.textarea!, { key: "Escape", keyCode: 27 });
    if (exit === "toggle") fireEvent.keyDown(term.textarea!, { key: "h", keyCode: 72, ctrlKey: true, shiftKey: true });
    if (exit === "unmatched") fireEvent.keyDown(term.textarea!, { key: "z", keyCode: 90 });
  });
  expect(screen.queryByTitle("IPv4: 192.0.2.10")).toBeNull();
  if (exit === "select") expect(copyTextWithAutoClear).toHaveBeenCalledExactlyOnceWith("192.0.2.10");
  else expect(copyTextWithAutoClear).not.toHaveBeenCalled();
  expect(socket.input()).toBe("");
  expect(peer.input()).toBe("");
  // Focus and ordinary terminal input resume once the hints are closed.
  expect(document.activeElement).toBe(term.textarea);
  fireEvent.keyDown(term.textarea!, { key: "c", keyCode: 67, ctrlKey: true });
  expect(socket.input()).toBe("\x03");
  expect(peer.input()).toBe("\x03");
});

it.each(["\x1b[5n", "\x1b[c", "\x1b[>c", "\x1b]10;?\x07", "\x1b]4;1;?\x07"])(
  "keeps an automatic xterm reply in the originating session: %j", async (query) => {
    const { socket, peer, term } = await mount(true);
    await act(() => new Promise<void>((resolve) => term.write(query, resolve)));
    expect(socket.input().length).toBeGreaterThan(0);
    expect(peer.input()).toBe("");
  },
);

it("broadcasts keyboard controls once, without reflecting input to the source twice", async () => {
  const { tab, socket, peer, term } = await mount(true);
  act(() => useAppStore.getState().setBroadcastTargets([tab, "peer"]));
  fireEvent.keyDown(term.textarea!, { key: "c", ctrlKey: true, keyCode: 67 });
  fireEvent.keyDown(term.textarea!, { key: "ArrowUp", keyCode: 38 });
  expect(socket.input()).toBe("\x03\x1b[A");
  expect(peer.input()).toBe(socket.input());
});

it.each([
  [String.raw`marker\r`, "marker\r"],
  [String.raw`first\r\nsecond\t\b\e[31m`, "first\r\nsecond\t\b\x1b[31m"],
  [String.raw`literal\\r and \\`, "literal\\r and \\"],
  ["no-newline", "no-newline"],
  ["first\nsecond", "first\nsecond"],
])("sends identical saved action bytes through click, shortcut and launcher: %j", async (command, expected) => {
  const { socket, peer, term } = await mount(true);
  act(() => useAppStore.setState({ quickActions: [{ id: "byte-action", label: "Test action", color: "blue", command }] }));
  render(<QuickActionBar />);
  fireEvent.click(screen.getByRole("button", { name: "Test action" }));
  expect(socket.input()).toBe(expected); expect(peer.input()).toBe(expected);
  socket.sent = []; peer.sent = [];
  fireEvent.keyDown(term.textarea!, { key: "1", altKey: true, keyCode: 49 });
  expect(socket.input()).toBe(expected); expect(peer.input()).toBe(expected);
  socket.sent = []; peer.sent = [];
  fireEvent.click(screen.getByRole("button", { name: "Open launcher" }));
  fireEvent.keyDown(screen.getByLabelText("Find a saved command"), { key: "Enter" });
  expect(socket.input()).toBe(expected); expect(peer.input()).toBe(expected);
});

it.each(["first\nsecond\n", "first\rsecond\r", "first\r\nsecond\r\n"])(
  "gates native paste and broadcast until confirmation, preserving xterm normalization: %j", async (text) => {
    const { socket, peer, term } = await mount(true);
    nativePaste(term.textarea!, text);
    expect(socket.input()).toBe(""); expect(peer.input()).toBe("");
    expect(screen.getByText(/into 2 terminals/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Paste" }));
    expect(socket.input()).toBe("first\rsecond\r");
    expect(peer.input()).toBe("first\rsecond\r");
    expect(useAppStore.getState().confirmDialog).toBeNull();
  },
);

it("cancels native multiline paste without sending bytes to any recipient", async () => {
  const { socket, peer, term } = await mount(true);
  nativePaste(term.textarea!, "first\nsecond");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(socket.input()).toBe(""); expect(peer.input()).toBe("");
});

it("skips an already disconnected broadcast peer without blocking the source paste", async () => {
  const { socket, peer, term } = await mount(true);
  peer.close();
  nativePaste(term.textarea!, "first\nsecond");
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  expect(socket.input()).toBe("first\rsecond");
  expect(peer.input()).toBe("");
});

it("allows single-line paste and retains xterm bracketed paste after confirmation", async () => {
  const { socket, term } = await mount();
  nativePaste(term.textarea!, "single line");
  expect(socket.input()).toBe("single line");
  expect(useAppStore.getState().confirmDialog).toBeNull();
  socket.sent = [];
  await act(() => new Promise<void>((resolve) => term.write("\x1b[?2004h", resolve)));
  nativePaste(term.textarea!, "first\nsecond");
  expect(socket.input()).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  expect(socket.input()).toBe("\x1b[200~first\rsecond\x1b[201~");
});

it.each(["native", "shortcut"])("rejects oversized %s clipboard text before sending", async (route) => {
  const { socket, peer, term } = await mount(true);
  const text = "x".repeat(1024 * 1024 + 1);
  if (route === "native") nativePaste(term.textarea!, text);
  else {
    clipboard.readText.mockResolvedValue(text);
    await act(async () => { fireEvent.keyDown(term.textarea!, { key: "v", ctrlKey: true, shiftKey: true }); });
  }
  expect(useAppStore.getState().toasts.some((toast) => toast.message.includes("too large"))).toBe(true);
  expect(socket.input()).toBe(""); expect(peer.input()).toBe("");
  expect(useAppStore.getState().confirmDialog).toBeNull();
});

it.each(["shortcut", "middle", "right", "menu"])("gates %s clipboard paste through the same confirmation", async (route) => {
  const { socket, term, view } = await mount();
  clipboard.readText.mockResolvedValue("first\nsecond");
  act(() => useAppStore.getState().updateSettings("keyboard", {
    pasteOnMiddleClick: true, rightClickAction: route === "menu" ? "contextMenu" : "paste",
  }));
  const output = view.container.querySelector(".terminal-session-output")!;
  await act(async () => {
    if (route === "shortcut") fireEvent.keyDown(term.textarea!, { key: "v", ctrlKey: true, shiftKey: true });
    if (route === "middle") fireEvent.mouseDown(output, { button: 1 });
    if (route === "right" || route === "menu") fireEvent.contextMenu(output);
  });
  if (route === "menu") {
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Paste/ })); });
  }
  expect(clipboard.readText).toHaveBeenCalledOnce();
  expect(socket.input()).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Paste" }));
  expect(socket.input()).toBe("first\rsecond");
});

it.each(["switch away and back", "reconnect", "replace peer", "disable broadcast", "unmount"])(
  "invalidates a pending confirmation after %s", async (change) => {
    const { tab, controller, socket, peer, term, view } = await mount(true);
    nativePaste(term.textarea!, "first\nsecond");
    const confirm = useAppStore.getState().confirmDialog!.onConfirm;
    await act(async () => {
      if (change === "switch away and back") {
        useAppStore.setState({ activeTabId: "other" });
        useAppStore.setState({ activeTabId: tab });
      } else if (change === "reconnect") {
        await controller.connect(true);
        const replacement = TestTerminalSocket.instances.slice(-1)[0];
        replacement.open(); replacement.control({ type: "connect", session_id: 71, connection: profile });
      } else if (change === "replace peer") {
        const replacement = new TestTerminalSocket("mock://replacement"); replacement.open();
        useAppStore.setState((state) => ({ terminalSockets: { ...state.terminalSockets, peer: replacement as unknown as WebSocket } }));
      } else if (change === "disable broadcast") useAppStore.getState().setBroadcastMode(false);
      else view.unmount();
      confirm();
    });
    expect(socket.input()).toBe(""); expect(peer.input()).toBe("");
    expect(TestTerminalSocket.instances.every((candidate) => candidate.input() === "")).toBe(true);
  },
);

it.each(["switch", "reconnect", "close"])("binds an asynchronous clipboard read before %s", async (change) => {
  const { tab, controller, socket, term, view } = await mount();
  let resolve!: (text: string) => void;
  clipboard.readText.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
  fireEvent.keyDown(term.textarea!, { key: "v", ctrlKey: true, shiftKey: true });
  expect(clipboard.readText).toHaveBeenCalledOnce();
  await act(async () => {
    if (change === "switch") {
      useAppStore.setState({ activeTabId: "other" });
      useAppStore.setState({ activeTabId: tab });
    } else if (change === "reconnect") {
      await controller.connect(true);
      const replacement = TestTerminalSocket.instances.slice(-1)[0];
      replacement.open(); replacement.control({ type: "connect", session_id: 71, connection: profile });
    } else { controller.beginClose(); view.unmount(); }
    resolve("late clipboard text");
  });
  expect(socket.input()).toBe("");
  expect(TestTerminalSocket.instances.every((candidate) => candidate.input() === "")).toBe(true);
  expect(useAppStore.getState().confirmDialog).toBeNull();
});
