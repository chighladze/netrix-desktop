import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetchJsonOrThrow: vi.fn() }));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(), ...api,
  getApiBase: async () => "http://127.0.0.1:3210", getWsBase: async () => "ws://127.0.0.1:3210", refreshApiToken: async () => "test-token",
}));
import { useAppStore } from "../state/store";
import { disposeTerminalSessionController, getTerminalSessionController } from "./TerminalSessionController";
import { TestTerminalSocket } from "../test/terminalSocket";
import { sendTerminalInput } from "./wire";

const hostA = { id: 7, revision: 1, name: "Router", hostname: "a.test", port: 22, username: "alice", connection_type: "ssh" as const };
const hostB = { ...hostA, revision: 2, hostname: "b.test", port: 2323, username: "bob", connection_type: "telnet" as const };
beforeEach(() => {
  vi.stubGlobal("WebSocket", TestTerminalSocket);
  TestTerminalSocket.instances = [];
  useAppStore.setState({ ...useAppStore.getInitialState(), hosts: [hostA] }, true);
});
afterEach(() => {
  for (const tab of useAppStore.getState().terminalTabs) disposeTerminalSessionController(tab.id);
  vi.unstubAllGlobals();
});

it("keeps live A snapshots after a profile edit, then labels only the new session as B before enabling input", async () => {
  const first = useAppStore.getState().addTerminalTab(hostA);
  const second = useAppStore.getState().addTerminalTab(hostA);
  const controller = getTerminalSessionController(first)!;
  await controller.connect();
  await getTerminalSessionController(second)!.connect();
  const [a, peer] = TestTerminalSocket.instances;
  a.open(); peer.open();
  a.control({ type: "connect", session_id: 41, connection: hostA });
  peer.control({ type: "connect", session_id: 42, connection: hostA });
  api.fetchJsonOrThrow.mockResolvedValue(hostB);
  await useAppStore.getState().patchHost(7, hostB);
  expect(useAppStore.getState().terminalTabs.map((tab) => tab.host.hostname)).toEqual(["a.test", "a.test"]);
  a.close();
  await controller.connect();
  const resume = TestTerminalSocket.instances.slice(-1)[0];
  expect(resume.url).toContain("/ws/sessions/41");
  resume.open();
  resume.control({ type: "error", code: "session_unavailable", message: "Session ended" });
  controller.reconnect();
  await vi.waitFor(() => expect(TestTerminalSocket.instances).toHaveLength(4));
  const b = TestTerminalSocket.instances.slice(-1)[0];
  expect(b.url).toContain("/ws/terminal/7?");
  b.open();
  expect(controller.send("before identity")).toBe(false);
  expect(sendTerminalInput(b as unknown as WebSocket, "before identity")).toBe(false);
  const originalSend = b.send.bind(b);
  const send = vi.spyOn(b, "send").mockImplementation((data) => {
    if (typeof data === "string" && data.includes('"ready"')) {
      expect(useAppStore.getState().terminalTabs[0].host).toMatchObject({ hostname: "b.test", port: 2323, username: "bob", connection_type: "telnet" });
    }
    originalSend(data);
  });
  b.control({ type: "connect", session_id: 43, connection: { ...hostB, password: "must-not-leak", private_key: "private", passphrase: "secret" } });
  expect(send).toHaveBeenCalled();
  const tabs = useAppStore.getState().terminalTabs;
  expect(tabs[0].host).toMatchObject({ hostname: "b.test", port: 2323, username: "bob", connection_type: "telnet" });
  expect(tabs[1].host).toMatchObject(hostA);
  expect(JSON.stringify(tabs)).not.toContain("must-not-leak");
  expect(tabs[0].host).not.toHaveProperty("private_key");
  expect(controller.send("to B")).toBe(true);
  expect(b.input()).toBe("to B");
  expect(a.input()).toBe("");
  a.control({ type: "connect", session_id: 41, connection: hostA });
  expect(useAppStore.getState().terminalTabs[0].host.hostname).toBe("b.test");
});

it.each([undefined, null, { ...hostB, port: "2323" }, { ...hostB, connection_type: "invalid" }])(
  "rejects missing or invalid connection identity before acknowledging or sending input: %s", async (connection) => {
    const tab = useAppStore.getState().addTerminalTab(hostA);
    const controller = getTerminalSessionController(tab)!;
    await controller.connect();
    const socket = TestTerminalSocket.instances[0]; socket.open();
    socket.control({ type: "connect", session_id: 51, connection });
    expect(controller.getSnapshot().status).toBe("error");
    expect(controller.send("blocked")).toBe(false);
    expect(socket.sent.some((data) => typeof data === "string" && data.includes('"ready"'))).toBe(false);
    expect(useAppStore.getState().terminalTabs[0].host.hostname).toBe("a.test");
  },
);
