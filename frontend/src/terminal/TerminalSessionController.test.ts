import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  fetchJsonOrThrow: vi.fn(),
  getApiBase: vi.fn(),
  getWsBase: vi.fn(),
  refreshApiToken: vi.fn(),
}));

vi.mock("../api", () => apiMocks);

import { TerminalSessionController } from "./TerminalSessionController";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<string | Uint8Array> = [];
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  message(data: string | ArrayBuffer): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }
}

const host = {
  id: 7,
  name: "router",
  hostname: "192.0.2.7",
  port: 22,
  username: "netops",
  connection_type: "ssh" as const,
};

const quickConnectHost = {
  id: -1,
  name: "temporary router",
  hostname: "192.0.2.8",
  port: 22,
  username: "netops",
  connection_type: "ssh" as const,
  password: "one-time-secret",
};

const createController = () => new TerminalSessionController("tab-test", {
  host,
  settings: {
    autoReconnect: false,
  },
});

describe("TerminalSessionController", () => {
  it("acknowledges the exact new session and prevents reconnect after closing starts", async () => {
    vi.useFakeTimers();
    const controller = new TerminalSessionController("closing", { host, settings: { autoReconnect: true } });
    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 51, connection: host }));
    expect(socket.sent).toContain('{"type":"ready","session_id":51}');
    socket.close();
    controller.beginClose();
    await vi.advanceTimersByTimeAsync(30_000);
    controller.reconnect();
    await controller.connect(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(controller.getSnapshot().sessionId).toBe(51);
    expect(controller.send("must not be sent")).toBe(false);
    await expect(controller.captureView()).rejects.toThrow("being closed");
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores late initialization after closing a pending connection", async () => {
    const controller = createController();
    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    controller.beginClose();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 52, connection: host }));
    expect(socket.sent.some((frame) => typeof frame === "string" && frame.includes('"ready"'))).toBe(false);
    expect(controller.getSnapshot().sessionId).toBeNull();
    controller.dispose();
  });
  it("restores two terminals on the same host by their individual session IDs", async () => {
    const first = new TerminalSessionController("first", { host, settings: { autoReconnect: false } });
    const second = new TerminalSessionController("second", { host, settings: { autoReconnect: false } });
    await first.connect();
    await second.connect();
    const [firstSocket, secondSocket] = FakeWebSocket.instances;
    firstSocket.open(); secondSocket.open();
    firstSocket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 41, connection: host }));
    secondSocket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 42, connection: host }));
    firstSocket.close(); secondSocket.close();
    await second.connect();
    await first.connect();
    expect(FakeWebSocket.instances.slice(2).map((socket) => socket.url)).toEqual([
      "ws://127.0.0.1:3210/ws/sessions/42", "ws://127.0.0.1:3210/ws/sessions/41",
    ]);
    expect(apiMocks.fetchJsonOrThrow).not.toHaveBeenCalled();
    expect(first.getSnapshot().sessionId).toBe(41);
    expect(second.getSnapshot().sessionId).toBe(42);
    first.dispose(); second.dispose();
  });

  it("resumes quick-connect sessions by ID without requesting another credential ticket", async () => {
    const controller = new TerminalSessionController("quick-resume", {
      host: quickConnectHost, initialSessionId: 43, settings: { autoReconnect: false },
    });
    await controller.connect();
    expect(FakeWebSocket.instances[0].url).toBe("ws://127.0.0.1:3210/ws/sessions/43");
    expect(apiMocks.fetchJsonOrThrow).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("rejects a different session returned during reattachment", async () => {
    const controller = new TerminalSessionController("exact-resume", { host, initialSessionId: 41 });
    await controller.connect();
    const socket = FakeWebSocket.instances[0]; socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 42, connection: host }));
    expect(controller.getSnapshot()).toMatchObject({ status: "error", sessionId: 41 });
    expect(controller.getSnapshot().errorMessage).toContain("different terminal session");
    expect(controller.send("must not reach session 42")).toBe(false);
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.sent.some((frame) => typeof frame === "string" && frame.includes('"terminate"'))).toBe(false);
    controller.dispose();
  });

  it("stops automatic retries for an ended session and starts a new one only on explicit retry", async () => {
    vi.useFakeTimers();
    const controller = new TerminalSessionController("ended", { host, initialSessionId: 41, settings: { autoReconnect: true } });
    await controller.connect();
    const socket = FakeWebSocket.instances[0]; socket.open();
    socket.message('__JSON__{"type":"error","code":"session_unavailable","message":"Session ended"}');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(controller.getSnapshot()).toMatchObject({ status: "error", sessionId: 41, sessionUnavailable: true });
    controller.reconnect();
    controller.configure({ host, initialSessionId: 41 }); // A stale React prop must not restore the ended ID.
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const replacement = FakeWebSocket.instances[1];
    expect(new URL(replacement.url).pathname).toBe("/ws/terminal/7");
    expect(new URL(replacement.url).searchParams.has("sid")).toBe(false);
    replacement.open(); replacement.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 44, connection: host }));
    expect(controller.getSnapshot()).toMatchObject({ status: "connected", sessionId: 44, sessionUnavailable: false });
    controller.dispose();
  });

  it("cancels a pending reconnect when settings disable it while the renderer is detached", async () => {
    vi.useFakeTimers();
    const controller = new TerminalSessionController("hidden-retry", { host, settings: { autoReconnect: true } });
    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 41, connection: host }));
    socket.close();
    expect(vi.getTimerCount()).toBe(1);
    controller.configure({ host, settings: { autoReconnect: false } });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(controller.getSnapshot().status).toBe("disconnected");
    expect(controller.getSnapshot().errorMessage).toBe("Terminal link closed. Automatic reconnect disabled.");
    controller.dispose();
  });
  it("replaces the old screen and buffer when the backend starts replay", async () => {
    const controller = createController();
    let screen = "";
    controller.attachRenderer((data, _replay, reset) => { screen = reset ? "" : screen + data; });
    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 41, connection: host }));
    socket.message(Uint8Array.from(new TextEncoder().encode("old output")).buffer);
    socket.message('__JSON__{"type":"replay_start"}');
    socket.message(Uint8Array.from(new TextEncoder().encode("old output + new output")).buffer);
    expect(screen).toBe("old output + new output");
    let replay = "";
    controller.attachRenderer((data) => { replay += data; });
    expect(replay).toBe(screen);
    controller.dispose();
  });

  it("does not retain quick-connect credentials when the destination changes", async () => {
    apiMocks.fetchJsonOrThrow.mockResolvedValue({ticket: "test-ticket"});
    const controller = new TerminalSessionController("quick-switch", {host: {...quickConnectHost, id: -1}});
    controller.configure({host: {...quickConnectHost, id: -1, hostname: "different.test", password: undefined}});
    await controller.connect();
    const options = apiMocks.fetchJsonOrThrow.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(options.body as string)).not.toHaveProperty("password");
    controller.dispose();
  });
  it("preserves split UTF-8 and treats control-looking terminal bytes as data", async () => {
    const controller = createController();
    const output: string[] = [];
    controller.attachRenderer((data) => output.push(data));
    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 41, connection: host }));
    const printed = 'Привет 🌍 __JSON__{"type":"error","message":"remote text"}';
    for (const byte of new TextEncoder().encode(printed)) {
      socket.message(Uint8Array.of(byte).buffer);
    }
    expect(output.join("")).toContain(printed);
    expect(controller.getSnapshot()).toMatchObject({status: "connected", sessionId: 41});
    controller.send('{"type":"terminate"}');
    expect(socket.sent.at(-1)).toEqual(new TextEncoder().encode('{"type":"terminate"}'));
    controller.sendControl({type: "resize", cols: 80, rows: 24});
    expect(socket.sent.at(-1)).toBe('{"type":"resize","cols":80,"rows":24}');
    controller.dispose();
  });

  it("ignores close and error events from replaced sockets without disturbing heartbeat", async () => {
    vi.useFakeTimers();
    const controller = createController();
    await controller.connect();
    const old = FakeWebSocket.instances[0];
    old.open();
    await controller.connect(true);
    const current = FakeWebSocket.instances[1];
    current.open();
    current.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 42, connection: host }));
    old.onclose?.(new CloseEvent("close"));
    old.onerror?.(new Event("error"));
    const sent = current.sent.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(current.sent.length).toBeGreaterThan(sent);
    expect(controller.getSnapshot().status).toBe("connected");
    expect(controller.getSocket()).toBe(current);
    expect(vi.getTimerCount()).toBe(1);
    controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  beforeEach(() => {
    FakeWebSocket.instances = [];
    apiMocks.getWsBase.mockReset().mockResolvedValue("ws://127.0.0.1:3210");
    apiMocks.refreshApiToken.mockReset().mockResolvedValue("session-token");
    apiMocks.getApiBase.mockReset().mockResolvedValue("http://127.0.0.1:3210");
    apiMocks.fetchJsonOrThrow.mockReset();
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps transport handlers alive while no renderer is attached and replays output", async () => {
    const controller = createController();
    const firstRenderer: string[] = [];
    const detach = controller.attachRenderer((data) => firstRenderer.push(data));

    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 41, connection: host }));
    socket.message("first chunk");
    detach();

    socket.message('__JSON__{"type":"latency","ms":27}');
    socket.message(" while hidden");

    const replay: Array<{ data: string; replay: boolean }> = [];
    controller.attachRenderer((data, isReplay) => replay.push({ data, replay: isReplay }));

    expect(firstRenderer.join("")).toContain("first chunk");
    expect(controller.getSnapshot()).toMatchObject({
      status: "connected",
      sessionId: 41,
      latency: 27,
    });
    expect(replay).toHaveLength(1);
    expect(replay[0]?.replay).toBe(true);
    expect(replay[0]?.data).toContain("first chunk while hidden");

    controller.dispose();
  });

  it("caps replay data even when one WebSocket message exceeds the buffer limit", async () => {
    const controller = createController();
    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.message("x".repeat((2 * 1024 * 1024) + 137));
    let replay = "";
    controller.attachRenderer((data, isReplay) => {
      if (isReplay) replay = data;
    });

    expect(replay).toHaveLength(2 * 1024 * 1024);
    expect(replay.endsWith("x".repeat(137))).toBe(true);

    controller.dispose();
  });

  it("closes terminal-error transports and creates a fresh socket on reconnect", async () => {
    const socketChanges: Array<WebSocket | null> = [];
    const controller = new TerminalSessionController("tab-error", {
      host,
      settings: { autoReconnect: false },
      callbacks: { onSocketChange: (socket) => socketChanges.push(socket) },
    });

    await controller.connect();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.open();
    firstSocket.message('__JSON__{"type":"error","message":"authentication failed"}');

    expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);
    expect(controller.getSocket()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      errorMessage: "authentication failed",
    });

    controller.reconnect();
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(controller.getSocket()).toBe(FakeWebSocket.instances[1]);

    controller.dispose();
    expect(FakeWebSocket.instances[1]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(socketChanges.at(-1)).toBeNull();
  });

  it("creates a quick-connect ticket before opening the WebSocket", async () => {
    apiMocks.fetchJsonOrThrow.mockResolvedValue({
      ticket: "ticket-123",
      expires_in_secs: 60,
    });
    const controller = new TerminalSessionController("tab-quick", {
      host: quickConnectHost,
      settings: { autoReconnect: false },
    });

    await controller.connect();

    expect(apiMocks.fetchJsonOrThrow).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "ws://127.0.0.1:3210/ws/quick-connect?ticket=ticket-123",
    );
    controller.dispose();
  });

  it("surfaces a rejected quick-connect ticket without opening a WebSocket", async () => {
    apiMocks.fetchJsonOrThrow.mockRejectedValue(new Error("ticket denied\u0007retry later"));
    const controller = new TerminalSessionController("tab-quick-error", {
      host: quickConnectHost,
      settings: { autoReconnect: false },
    });

    await controller.connect();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(controller.getSnapshot()).toMatchObject({
      status: "error",
      errorMessage: "ticket denied retry later",
    });
    controller.dispose();
  });

  it("restores a handoff screen and split Unicode before acknowledging resume-only readiness", async () => {
    const controller = createController();
    const restored: string[] = [];
    const output: string[] = [];
    const snapshot = { ...controller.getSnapshot(), status: "connected" as const, sessionId: 42 };
    controller.prepareIncomingHandoff({ serialized: "saved screen", cols: 100, rows: 30, viewportY: 4, outputOffset: 9, decoderTail: [0xf0, 0x9f] }, snapshot);
    controller.attachRenderer((data) => output.push(data), {
      capture: async () => ({ serialized: "saved screen", cols: 100, rows: 30, viewportY: 4 }),
      restore: async (view) => { restored.push(view.serialized); }, flush: async () => {},
    });
    await controller.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("ws://127.0.0.1:3210/ws/sessions/42?after=9");
    expect(apiMocks.fetchJsonOrThrow).not.toHaveBeenCalled();
    socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 42, connection: host }));
    socket.message('__JSON__{"type":"replay_start","offset":9}');
    socket.message(Uint8Array.of(0x8c, 0x8d).buffer);
    expect(controller.send("blocked before commit")).toBe(false);
    socket.message('__JSON__{"type":"replay_end","offset":11}');
    await controller.waitForHandoffReady(new AbortController().signal);
    expect(restored).toEqual(["saved screen"]);
    expect(output.join("")).toBe("🌍");
    expect(socket.sent.some((frame) => typeof frame === "string" && frame.includes('"resize"'))).toBe(false);
    controller.commitIncomingHandoff();
    expect(controller.send("ready")).toBe(true);
    controller.dispose({ preserveSession: true });
    expect(socket.sent.some((frame) => typeof frame === "string" && frame.includes('"terminate"'))).toBe(false);
  });

  it("captures the byte checkpoint before waiting for the renderer write queue", async () => {
    const controller = createController();
    let finish = (_view: { serialized: string; cols: number; rows: number; viewportY: number }) => {};
    controller.attachRenderer(() => {}, { restore: async () => {}, flush: async () => {}, capture: () => new Promise((resolve) => { finish = resolve; }) });
    await controller.connect();
    const socket = FakeWebSocket.instances[0]; socket.open();
    socket.message("__JSON__" + JSON.stringify({ type: "connect", session_id: 41, connection: host }));
    socket.message('__JSON__{"type":"replay_start","offset":0}');
    socket.message(Uint8Array.from([0x61, 0xf0, 0x9f]).buffer);
    const capture = controller.captureView();
    socket.message(Uint8Array.from([0x8c, 0x8d]).buffer);
    finish({ serialized: "a", cols: 80, rows: 24, viewportY: 0 });
    expect(await capture).toMatchObject({ outputOffset: 3, decoderTail: [0xf0, 0x9f], serialized: "a" });
    controller.dispose();
  });
  it("waits for a newly selected renderer to restore its cached screen before capture", async () => {
    const controller = createController();
    const saved = { serialized: "cached", cols: 80, rows: 24, viewportY: 0, outputOffset: 27, decoderTail: [] };
    controller.prepareIncomingHandoff(saved, { ...controller.getSnapshot(), status: "connected", sessionId: 42 });
    let restored = () => {};
    const capture = vi.fn(async () => ({ serialized: "restored", cols: 80, rows: 24, viewportY: 0 }));
    controller.attachRenderer(() => {}, { restore: () => new Promise<void>((resolve) => { restored = resolve; }), flush: async () => {}, capture });
    const pending = controller.captureView();
    expect(capture).not.toHaveBeenCalled();
    restored();
    expect(await pending).toMatchObject({ serialized: "restored", outputOffset: 27 });
    controller.dispose();
  });
  it("refuses a pending capture if its restoring renderer was detached", async () => {
    const controller = createController();
    controller.prepareIncomingHandoff({ serialized: "cached", cols: 80, rows: 24, viewportY: 0, outputOffset: 0, decoderTail: [] }, controller.getSnapshot());
    let restored = () => {};
    const capture = vi.fn();
    const detach = controller.attachRenderer(() => {}, { restore: () => new Promise<void>((resolve) => { restored = resolve; }), flush: async () => {}, capture });
    const pending = controller.captureView();
    const rejected = expect(pending).rejects.toThrow("view changed");
    detach(); restored();
    await rejected;
    expect(capture).not.toHaveBeenCalled();
    controller.dispose();
  });
});
