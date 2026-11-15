import {
  fetchJsonOrThrow,
  getApiBase,
  getWsBase,
  refreshApiToken,
} from "../api";
import type { Host } from "../types/host";
import { isQuickConnectHost, redactHostSecrets } from "../types/host";
import { sendTerminalInput, type TerminalSocket } from "./wire";
import { parseConnectionInfo, type TerminalConnectionInfo } from "./connectionInfo";
import { incompleteUtf8Tail, TerminalParserCheckpoint, type TerminalRendererAdapter, type TerminalViewState } from "./viewState";

export type TerminalSessionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface TerminalSessionSnapshot {
  status: TerminalSessionStatus;
  sessionId: number | null;
  errorMessage: string | null;
  isVaultError: boolean;
  sessionUnavailable: boolean;
  latency: number | null;
  progressStep: string | null;
  handoffPending: boolean;
  handoffReady: boolean;
}

export interface TerminalSessionSettings {
  connectionTimeout: number;
  keepaliveInterval: number;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  terminalType: string;
  rowsMultiplier: number;
}

export interface TerminalSessionCallbacks {
  onConnectionInfo?: (connection: TerminalConnectionInfo) => void;
  onSocketChange?: (socket: WebSocket | null) => void;
  onStatusChange?: (status: TerminalSessionStatus) => void;
  onSessionIdChange?: (sessionId: number | null) => void;
  onConnectedChange?: (connected: boolean) => void;
}

export interface TerminalSessionConfig {
  host: Host;
  initialSessionId?: number;
  initialStatus?: TerminalSessionStatus;
  settings?: Partial<TerminalSessionSettings>;
  cols?: number;
  rows?: number;
  callbacks?: TerminalSessionCallbacks;
}

type SnapshotListener = (snapshot: TerminalSessionSnapshot) => void;
type RendererSink = (data: string, replay: boolean, reset?: boolean) => void;

const DEFAULT_SETTINGS: TerminalSessionSettings = {
  connectionTimeout: 30,
  keepaliveInterval: 15,
  autoReconnect: false,
  maxReconnectAttempts: 3,
  terminalType: "xterm-256color",
  rowsMultiplier: 1,
};
const MAX_BUFFER_CHARS = 2 * 1024 * 1024;

const cleanControlText = (value: unknown, fallback: string): string => {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim();
};

export class TerminalSessionController {
  readonly tabId: string;

  private host: Host;
  private settings: TerminalSessionSettings = { ...DEFAULT_SETTINGS };
  private callbacks: TerminalSessionCallbacks = {};
  private snapshot: TerminalSessionSnapshot;
  private socket: WebSocket | null = null;
  private renderer: RendererSink | null = null;
  private listeners = new Set<SnapshotListener>();
  private outputChunks: string[] = [];
  private outputChars = 0;
  private cols = 80;
  private rows = 24;
  private generation = 0;
  private connecting = false;
  private disposed = false;
  private closing = false;
  private heartbeatTimer: number | null = null;
  private lastHeartbeatSentAt: number | null = null;
  private reconnectTimer: number | null = null;
  private reconnectReason: string | null = null;
  private reconnectAttempts = 0;
  private outputOffset: number | null = null;
  private decoderTail: Uint8Array = new Uint8Array();
  private baseView: TerminalViewState | null = null;
  private rendererAdapter: TerminalRendererAdapter | null = null;
  private rendererReady: Promise<void> = Promise.resolve();
  private rendererActive = false;
  private handoffBusy = false;
  private incomingLive = false;
  private parserCheckpoint = new TerminalParserCheckpoint();
  private rendererFailure: Error | null = null;

  constructor(tabId: string, config: TerminalSessionConfig) {
    this.tabId = tabId;
    this.host = config.host;
    this.snapshot = {
      status: config.initialStatus ?? "connecting",
      sessionId: config.initialSessionId ?? null,
      errorMessage: null,
      isVaultError: false,
      sessionUnavailable: false,
      latency: null,
      progressStep: null,
      handoffPending: false,
      handoffReady: false,
    };
    this.configure(config);
  }

  configure(config: TerminalSessionConfig): void {
    // A secret-free descriptor from React must not overwrite quick-connect
    // credentials already held privately by the controller.
    const previousHost = this.host;
    const incomingHost = config.host;
    if (isQuickConnectHost(previousHost) && isQuickConnectHost(incomingHost)
      && previousHost.hostname === incomingHost.hostname
      && previousHost.port === incomingHost.port
      && previousHost.username === incomingHost.username) {
      this.host = {
        ...incomingHost,
        password: incomingHost.password ?? previousHost.password,
        private_key: incomingHost.private_key ?? previousHost.private_key,
        passphrase: incomingHost.passphrase ?? previousHost.passphrase,
      };
    } else {
      this.host = config.host;
    }
    if (config.settings) this.settings = { ...this.settings, ...config.settings };
    if (!this.settings.autoReconnect) {
      const reason = this.reconnectReason;
      this.clearReconnectTimer();
      if (reason) this.updateSnapshot({ errorMessage: `${reason} Automatic reconnect disabled.` });
    }
    if (config.callbacks) this.callbacks = { ...this.callbacks, ...config.callbacks };
    if (typeof config.cols === "number" && config.cols > 0) this.cols = config.cols;
    if (typeof config.rows === "number" && config.rows > 0) this.rows = config.rows;
    // initialSessionId seeds the constructor only. Reconfiguration must not
    // restore an ended session ID after the user explicitly starts a new one.
  }

  getSnapshot(): TerminalSessionSnapshot {
    return { ...this.snapshot };
  }

  getSocket(): WebSocket | null {
    return this.socket;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  attachRenderer(renderer: RendererSink, adapter?: TerminalRendererAdapter): () => void {
    if (this.disposed) return () => {};
    this.renderer = renderer;
    this.rendererFailure = null;
    this.rendererAdapter = adapter ?? null;
    const activate = () => {
      if (this.renderer !== renderer) return;
      this.rendererActive = true;
      if (this.outputChunks.length > 0) renderer(this.outputChunks.join(""), true);
    };
    if (this.baseView && adapter) {
      this.rendererActive = false;
      this.rendererReady = adapter.restore(this.baseView).then(activate);
    } else {
      activate();
      this.rendererReady = Promise.resolve();
    }
    void this.rendererReady.then(() => {
      if (this.snapshot.handoffPending && !this.incomingLive && this.renderer === renderer) {
        this.updateSnapshot({ handoffReady: true });
      }
    }).catch(() => {
      if (this.disposed || this.renderer !== renderer) return;
      this.rendererFailure = new Error("Could not restore the terminal screen.");
      this.updateSnapshot({ status: "error", errorMessage: this.rendererFailure.message });
    });
    return () => {
      if (this.renderer === renderer) {
        this.renderer = null;
        this.rendererAdapter = null;
        this.rendererActive = false;
      }
    };
  }

  async captureView(): Promise<TerminalViewState> {
    if (this.closing) throw new Error("This terminal is being closed.");
    const renderer = this.renderer;
    const adapter = this.rendererAdapter;
    if (!renderer || !adapter) throw new Error("Select this terminal before moving it.");
    // Selecting a previously hidden tab publishes its xterm instance before
    // cached screen restoration finishes. Wait for that renderer's write barrier
    // without delaying checkpoints for an already active renderer.
    if (!this.rendererActive) await this.rendererReady;
    if (this.renderer !== renderer || this.rendererAdapter !== adapter || !this.rendererActive) throw new Error("The terminal view changed while preparing the move. Try again.");
    if (this.snapshot.status === "connecting") throw new Error("Wait for the connection to finish before moving this terminal.");
    if (this.snapshot.status === "connected" && this.outputOffset === null) {
      throw new Error("Terminal output is catching up. Try moving it again.");
    }
    // Capture the cursor before enqueueing the xterm write barrier. Later
    // WebSocket frames belong after this checkpoint, even if parsing is delayed.
    const outputOffset = this.outputOffset ?? 0;
    const decoderTail = Array.from(this.decoderTail);
    const parserTail = this.parserCheckpoint.checkpoint();
    const view = await adapter.capture();
    if (view.serialized.length > 8 * 1024 * 1024) throw new Error("This terminal screen is too large to move safely. Reduce scrollback and try again.");
    return { ...view, outputOffset, decoderTail, parserTail };
  }

  prepareIncomingHandoff(view: TerminalViewState, snapshot: TerminalSessionSnapshot): void {
    this.baseView = view;
    this.parserCheckpoint.reset();
    this.parserCheckpoint.feed(view.parserTail ?? "");
    this.incomingLive = snapshot.status === "connected";
    this.outputOffset = view.outputOffset;
    this.decoderTail = Uint8Array.from(view.decoderTail);
    this.cols = view.cols;
    this.rows = view.rows;
    this.setSessionId(snapshot.sessionId);
    this.updateSnapshot({ ...snapshot, handoffPending: true, handoffReady: false });
  }

  async waitForHandoffReady(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error("Terminal move cancelled.");
    await new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const abort = () => { unsubscribe(); reject(new Error("Terminal move cancelled.")); };
      const check = (snapshot: TerminalSessionSnapshot) => {
        if (this.rendererFailure) reject(this.rendererFailure);
        else if (snapshot.handoffReady) resolve();
        else if (this.incomingLive && (snapshot.status === "error" || snapshot.status === "disconnected")) {
          reject(new Error(snapshot.errorMessage || "The terminal session ended while moving."));
        } else return;
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      unsubscribe = this.subscribe(check);
      check(this.getSnapshot());
    });
    await this.rendererReady;
    await this.rendererAdapter?.flush();
    if (signal.aborted) throw new Error("Terminal move cancelled.");
  }

  commitIncomingHandoff(): void {
    this.updateSnapshot({ handoffPending: false });
    if (this.socket) (this.socket as TerminalSocket).__netrixHandoffBusy = this.handoffBusy;
    this.sendResize();
  }

  setHandoffBusy(busy: boolean): void {
    this.handoffBusy = busy;
    if (this.socket) (this.socket as TerminalSocket).__netrixHandoffBusy = busy || this.snapshot.handoffPending;
  }

  updateSize(cols: number, rows: number): void {
    if (Number.isFinite(cols) && cols > 0) this.cols = Math.floor(cols);
    if (Number.isFinite(rows) && rows > 0) this.rows = Math.floor(rows);
    this.sendResize();
  }

  send(data: string): boolean {
    if (this.handoffBusy || this.snapshot.handoffPending || this.snapshot.status !== "connected") return false;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    return sendTerminalInput(this.socket, data);
  }

  sendControl(payload: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  markDetaching(detaching = true): void {
    if (!this.socket) return;
    (this.socket as WebSocket & { __netrixDetaching?: boolean }).__netrixDetaching = detaching;
  }

  setExternalSessionId(sessionId: number | null): void {
    this.setSessionId(sessionId);
  }

  setExternalStatus(status: TerminalSessionStatus): void {
    if (this.snapshot.status === status) return;
    this.updateSnapshot({ status });
  }

  async connect(force = false): Promise<void> {
    if (this.disposed || this.closing) return;
    if (
      !force
      && (this.connecting
        || this.socket?.readyState === WebSocket.OPEN
        || this.socket?.readyState === WebSocket.CONNECTING)
    ) return;

    this.clearReconnectTimer();
    this.connecting = true;
    if (this.socket) (this.socket as TerminalSocket).__netrixInputReady = false;
    const generation = ++this.generation;
    this.updateSnapshot({
      status: "connecting",
      errorMessage: null,
      isVaultError: false,
      progressStep: null,
    });
    this.callbacks.onConnectedChange?.(false);

    try {
      const [wsBase, token] = await Promise.all([getWsBase(), refreshApiToken()]);
      if (!this.isCurrent(generation)) return;

      const existingSessionId = this.snapshot.sessionId;
      const reportedRows = this.rows * Math.max(1, this.settings.rowsMultiplier || 1);
      let connectionUrl: string;

      if (existingSessionId !== null) {
        const checkpoint = this.snapshot.handoffPending && this.baseView
          ? `?after=${this.baseView.outputOffset}` : "";
        connectionUrl = `${wsBase}/ws/sessions/${existingSessionId}${checkpoint}`;
      } else if (isQuickConnectHost(this.host)) {
        const apiBase = await getApiBase();
        if (!this.isCurrent(generation)) return;
        const ticketData = await fetchJsonOrThrow<{ ticket?: unknown }>(
          `${apiBase}/sessions/quick-connect-tickets`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hostname: this.host.hostname,
              port: this.host.port,
              username: this.host.username,
              cols: this.cols,
              rows: reportedRows,
              timeout: this.settings.connectionTimeout,
              keepalive: this.settings.keepaliveInterval,
              type: this.host.connection_type || "ssh",
              term: this.settings.terminalType,
              ...(this.host.serial_port ? { serial_port: this.host.serial_port } : {}),
              ...(this.host.serial_speed ? { serial_speed: this.host.serial_speed } : {}),
              ...(this.host.local_command ? { local_command: this.host.local_command } : {}),
              ...(this.host.local_args?.length
                ? { local_args: JSON.stringify(this.host.local_args) }
                : {}),
              ...(this.host.local_cwd ? { local_cwd: this.host.local_cwd } : {}),
              ...(this.host.password ? { password: this.host.password } : {}),
              ...(this.host.private_key ? { key: this.host.private_key } : {}),
              ...(this.host.passphrase ? { passphrase: this.host.passphrase } : {}),
            }),
          },
        );
        const ticket = ticketData.ticket;
        if (typeof ticket !== "string" || !ticket) {
          throw new Error("Backend returned an invalid quick-connect ticket");
        }
        connectionUrl = `${wsBase}/ws/quick-connect?ticket=${encodeURIComponent(ticket)}`;
      } else {
        const params = new URLSearchParams({
          cols: String(this.cols),
          rows: String(reportedRows),
          term: this.settings.terminalType,
          timeout: String(this.settings.connectionTimeout),
          keepalive: String(this.settings.keepaliveInterval),
        });
        connectionUrl = `${wsBase}/ws/terminal/${this.host.id}?${params.toString()}`;
      }

      if (!this.isCurrent(generation)) return;

      this.replaceSocket(null);
      const protocols = token
        ? ["netrix.v1", `netrix-token.${token}`]
        : ["netrix.v1"];
      const socket = new WebSocket(connectionUrl, protocols);
      this.replaceSocket(socket);
      this.bindSocket(socket, generation, Boolean(existingSessionId));
    } catch (error) {
      if (!this.isCurrent(generation)) return;
      this.connecting = false;
      const message = cleanControlText(
        error instanceof Error ? error.message : undefined,
        "Terminal connection failed",
      );
      this.updateSnapshot({ status: "error", errorMessage: message });
      this.callbacks.onConnectedChange?.(false);
      this.scheduleAutoReconnect(message);
    }
  }

  reconnect(): void {
    if (this.disposed || this.closing || this.snapshot.handoffPending || this.handoffBusy) return;
    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    if (this.snapshot.sessionUnavailable) {
      // Only an explicit user retry may replace an ended session. Automatic
      // reconnect retains the old ID and stops when the backend rejects it.
      this.setSessionId(null);
      this.baseView = null;
      this.outputOffset = null;
      this.decoderTail = new Uint8Array();
      this.parserCheckpoint.reset();
      this.renderer?.("", true, true);
    }
    if (!this.snapshot.sessionId) this.clearOutput();
    this.updateSnapshot({
      status: "connecting",
      errorMessage: null,
      isVaultError: false,
      sessionUnavailable: false,
      progressStep: null,
    });
    void this.connect(true);
  }

  /** Stop transport/reconnect immediately, but retain the view until DELETE is acknowledged. */
  beginClose(): void {
    this.closing = true;
    this.generation += 1;
    this.connecting = false;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    const socket = this.socket;
    if (socket) {
      (socket as WebSocket & { __netrixTerminating?: boolean }).__netrixTerminating = true;
      try {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "terminate" }));
      } catch { /* HTTP DELETE is the authoritative close path. */ }
      try { socket.close(); } catch { /* already closed */ }
    }
    this.replaceSocket(null, false);
    this.callbacks.onConnectedChange?.(false);
    this.updateSnapshot({ status: "disconnected", errorMessage: "Closing session..." });
  }

  dispose(options: { preserveSession?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.connecting = false;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    const socket = this.socket;
    if (socket) {
      try {
        if (options.preserveSession) {
          (socket as WebSocket & { __netrixDetaching?: boolean }).__netrixDetaching = true;
        } else {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "terminate" }));
          }
          (socket as WebSocket & { __netrixTerminating?: boolean }).__netrixTerminating = true;
        }
        socket.close();
      } catch {
        try { socket.close(); } catch { /* already closed */ }
      }
    }
    this.socket = null;
    this.callbacks.onSocketChange?.(null);
    this.renderer = null;
    this.rendererAdapter = null;
    this.baseView = null;
    this.listeners.clear();
    this.outputChunks = [];
    this.outputChars = 0;
    this.host = redactHostSecrets(this.host);
  }

  private bindSocket(
    socket: WebSocket,
    generation: number,
    existingSessionConnect: boolean,
  ): void {
    const expectedSessionId = this.snapshot.sessionId;
    let wasConnected = false;
    let hadError = false;
    let disconnectMessage: string | null = null;
    socket.binaryType = "arraybuffer";
    const outputDecoder = new TextDecoder();
    if (this.snapshot.handoffPending && this.baseView?.decoderTail.length) {
      outputDecoder.decode(Uint8Array.from(this.baseView.decoderTail), { stream: true });
    }

    socket.onopen = () => {
      if (!this.isCurrent(generation)) return;
      this.sendHeartbeat();
      const intervalMs = Math.max(
        5_000,
        Math.min((this.settings.keepaliveInterval || 15) * 1_000, 30_000),
      );
      this.heartbeatTimer = window.setInterval(() => this.sendHeartbeat(), intervalMs);
    };

    socket.onmessage = (event) => {
      if (!this.isCurrent(generation)) return;
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        this.decoderTail = incompleteUtf8Tail(this.decoderTail, bytes);
        if (this.outputOffset !== null) this.outputOffset += bytes.length;
        this.emitOutput(outputDecoder.decode(event.data, { stream: true }));
        return;
      }
      if (typeof event.data !== "string") return;
      const message = event.data;
      if (message.startsWith("__JSON__")) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(message.slice("__JSON__".length)) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = data.type;
        if (type === "replay_start") {
          this.clearOutput();
          this.outputOffset = typeof data.offset === "number" ? data.offset : 0;
          if (!this.snapshot.handoffPending) {
            this.baseView = null;
            this.decoderTail = new Uint8Array();
            this.parserCheckpoint.reset();
            this.renderer?.("", true, true);
          }
          return;
        }
        if (type === "replay_end") {
          void this.rendererReady.then(() => this.rendererAdapter?.flush()).then(() => {
            if (this.isCurrent(generation)) this.updateSnapshot({ handoffReady: true });
          }).catch(() => {
            if (this.isCurrent(generation)) this.updateSnapshot({ status: "error", errorMessage: "Could not restore the terminal screen." });
          });
          return;
        }
        if (type === "output_gap") {
          this.outputOffset = null;
          if (this.snapshot.handoffPending) {
            hadError = true;
            this.updateSnapshot({ status: "error", errorMessage: "Terminal output changed too quickly. Try moving it again." });
            socket.close();
            return;
          }
          this.emitOutput("\r\n\x1b[33m[Some terminal output was skipped because the receiver fell behind.]\x1b[0m\r\n");
          return;
        }
        if (type === "progress" && typeof data.step === "string") {
          this.updateSnapshot({ progressStep: data.step });
          return;
        }
        if (type === "error") {
          hadError = true;
          this.connecting = false;
          this.clearHeartbeat();
          const errorMessage = cleanControlText(data.message, "Connection failed.");
          const isVaultError = data.vault_locked === true;
          const sessionUnavailable = data.code === "session_unavailable";
          this.updateSnapshot({
            status: "error",
            errorMessage,
            isVaultError,
            sessionUnavailable,
          });
          this.callbacks.onConnectedChange?.(false);
          // A terminal error is final for this transport. Keeping the socket
          // open would also keep its heartbeat alive while the UI reports an
          // error. Vault errors need explicit user action; other failures may
          // still follow the configured reconnect policy.
          try { socket.close(); } catch { /* already closed */ }
          if (!isVaultError) this.scheduleAutoReconnect(errorMessage);
          return;
        }
        if (type === "disconnect") {
          disconnectMessage = cleanControlText(data.message, "Remote terminal session ended.");
          this.connecting = false;
          this.updateSnapshot({ status: "disconnected", errorMessage: disconnectMessage });
          this.callbacks.onConnectedChange?.(false);
          return;
        }
        if (type === "latency" && typeof data.ms === "number") {
          this.updateSnapshot({ latency: data.ms });
          return;
        }
        if (type === "pong") {
          this.handlePong(data.sent_at);
          return;
        }
        if (type === "connect" && typeof data.session_id === "number") {
          if (!Number.isSafeInteger(data.session_id)
            || (expectedSessionId !== null && data.session_id !== expectedSessionId)) {
            hadError = true;
            this.connecting = false;
            this.clearHeartbeat();
            this.updateSnapshot({ status: "error", errorMessage: "The server returned a different terminal session. Reattachment was cancelled." });
            this.callbacks.onConnectedChange?.(false);
            try { socket.close(); } catch { /* already closed */ }
            return;
          }
          const connection = parseConnectionInfo(data.connection);
          if (!connection) {
            hadError = true;
            this.connecting = false;
            this.clearHeartbeat();
            this.updateSnapshot({ status: "error", errorMessage: "The server did not identify the terminal destination. Update the app and reconnect." });
            this.callbacks.onConnectedChange?.(false);
            try { socket.close(); } catch { /* already closed */ }
            return;
          }
          this.host = { ...this.host, ...connection };
          this.callbacks.onConnectionInfo?.(connection);
          this.clearReconnectTimer();
          this.reconnectAttempts = 0;
          this.connecting = false;
          this.setSessionId(data.session_id);
          // The backend keeps a new transport only after the client knows its ID.
          socket.send(JSON.stringify({ type: "ready", session_id: data.session_id }));
          (socket as TerminalSocket).__netrixInputReady = true;
          this.updateSnapshot({
            status: "connected",
            errorMessage: null,
            isVaultError: false,
            sessionUnavailable: false,
          });
          wasConnected = true;
          this.callbacks.onConnectedChange?.(true);
          if (!existingSessionConnect) {
            this.emitOutput(`\x1b[32m✔ Connected to ${this.host.name}\x1b[0m\r\n`);
          }
          this.sendResize();
        }
        return;
      }

      if (this.consumeLegacyPong(message)) return;
      this.emitOutput(message);
    };

    socket.onclose = () => {
      if (!this.isCurrent(generation)) return;
      this.clearHeartbeat();
      this.connecting = false;
      if (this.socket === socket) this.replaceSocket(null, false);
      if (hadError) return;
      this.callbacks.onConnectedChange?.(false);
      if ((socket as WebSocket & { __netrixDetaching?: boolean }).__netrixDetaching) return;
      if (!wasConnected) {
        const message = `Connection failed before session initialization (${this.host.hostname}:${this.host.port}).`;
        this.updateSnapshot({ status: "error", errorMessage: message });
        this.scheduleAutoReconnect(message);
        return;
      }

      const message = disconnectMessage || "Terminal link closed.";
      const color = disconnectMessage ? "248;113;113" : "251;191;36";
      this.updateSnapshot({ status: "disconnected", errorMessage: message });
      this.emitOutput(`\r\n\x1b[38;2;${color}m✖ ${message}\x1b[0m\r\n`);
      this.scheduleAutoReconnect(message);
    };

    socket.onerror = () => {
      if (!this.isCurrent(generation)) return;
      this.clearHeartbeat();
      this.connecting = false;
      hadError = true;
      const message = `Connection transport error (${this.host.hostname}:${this.host.port}). Waiting for backend diagnostics failed.`;
      this.updateSnapshot({
        status: "error",
        errorMessage: this.snapshot.errorMessage || message,
      });
      this.callbacks.onConnectedChange?.(false);
      try { socket.close(); } catch { /* already closed */ }
      this.scheduleAutoReconnect(message);
    };
  }

  private emitOutput(data: string): void {
    if (!data) return;
    this.parserCheckpoint.feed(data);
    if (data.length >= MAX_BUFFER_CHARS) {
      const retained = data.slice(-MAX_BUFFER_CHARS);
      this.outputChunks = [retained];
      this.outputChars = retained.length;
    } else {
      this.outputChunks.push(data);
      this.outputChars += data.length;
      while (this.outputChars > MAX_BUFFER_CHARS && this.outputChunks.length > 1) {
        const removed = this.outputChunks.shift();
        this.outputChars -= removed?.length ?? 0;
      }
    }
    if (this.rendererActive) this.renderer?.(data, false);
  }

  private clearOutput(): void {
    this.outputChunks = [];
    this.outputChars = 0;
  }

  private updateSnapshot(patch: Partial<TerminalSessionSnapshot>): void {
    const previousStatus = this.snapshot.status;
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.status && patch.status !== previousStatus) {
      this.callbacks.onStatusChange?.(patch.status);
    }
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private setSessionId(sessionId: number | null): void {
    if (this.snapshot.sessionId === sessionId) return;
    this.snapshot = { ...this.snapshot, sessionId };
    this.callbacks.onSessionIdChange?.(sessionId);
    const snapshot = this.getSnapshot();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private replaceSocket(socket: WebSocket | null, closePrevious = true): void {
    const previous = this.socket;
    if (previous === socket) return;
    this.clearHeartbeat();
    if (previous && closePrevious && previous.readyState !== WebSocket.CLOSED) {
      try { previous.close(); } catch { /* already closing */ }
    }
    this.socket = socket;
    if (socket) {
      (socket as TerminalSocket).__netrixHandoffBusy = this.handoffBusy || this.snapshot.handoffPending;
      (socket as TerminalSocket).__netrixInputReady = false;
    }
    this.callbacks.onSocketChange?.(socket);
  }

  private sendHeartbeat(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.lastHeartbeatSentAt = Date.now();
    this.socket.send(JSON.stringify({
      type: "heartbeat",
      sent_at: this.lastHeartbeatSentAt,
    }));
  }

  private handlePong(sentAt: unknown): void {
    const timestamp = typeof sentAt === "number" ? sentAt : this.lastHeartbeatSentAt;
    if (timestamp) this.updateSnapshot({ latency: Math.max(0, Date.now() - timestamp) });
  }

  private consumeLegacyPong(message: string): boolean {
    const trimmed = message.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}") || trimmed.includes("\n")) {
      return false;
    }
    try {
      const data = JSON.parse(trimmed) as { type?: unknown; sent_at?: unknown };
      if (data.type !== "pong") return false;
      this.handlePong(data.sent_at);
      return true;
    } catch {
      return false;
    }
  }

  private sendResize(): void {
    if (this.snapshot.handoffPending || this.handoffBusy) return;
    this.sendControl({
      type: "resize",
      cols: this.cols,
      rows: this.rows * Math.max(1, this.settings.rowsMultiplier || 1),
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectReason = null;
  }

  private scheduleAutoReconnect(reason: string): void {
    if (this.closing || this.snapshot.handoffPending || this.snapshot.sessionUnavailable || !this.settings.autoReconnect || this.reconnectTimer !== null || this.disposed) return;
    const maxAttempts = Math.max(1, Math.min(this.settings.maxReconnectAttempts || 1, 10));
    if (this.reconnectAttempts >= maxAttempts) {
      this.updateSnapshot({
        errorMessage: `${reason} Automatic reconnect stopped after ${maxAttempts} attempts.`,
      });
      return;
    }
    const attempt = ++this.reconnectAttempts;
    const delayMs = Math.min(1_000 * (2 ** (attempt - 1)), 15_000);
    this.updateSnapshot({
      errorMessage: `${reason} Reconnecting in ${Math.ceil(delayMs / 1_000)}s (${attempt}/${maxAttempts})…`,
    });
    this.reconnectReason = reason;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectReason = null;
      void this.connect(true);
    }, delayMs);
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && this.generation === generation;
  }
}

const controllers = new Map<string, TerminalSessionController>();

export const ensureTerminalSessionController = (
  tabId: string,
  config: TerminalSessionConfig,
): TerminalSessionController => {
  const existing = controllers.get(tabId);
  if (existing) {
    existing.configure(config);
    return existing;
  }
  const controller = new TerminalSessionController(tabId, config);
  controllers.set(tabId, controller);
  return controller;
};

export const getTerminalSessionController = (
  tabId: string,
): TerminalSessionController | undefined => controllers.get(tabId);

export const disposeTerminalSessionController = (
  tabId: string,
  options: { preserveSession?: boolean } = {},
): void => {
  const controller = controllers.get(tabId);
  if (!controller) return;
  controllers.delete(tabId);
  controller.dispose(options);
};
