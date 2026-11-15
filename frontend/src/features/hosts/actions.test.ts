import { describe, expect, it, vi } from "vitest";
import { ApiError, fetchJsonOrThrow } from "../../api";
import type { HostMutation, SavedHostDto } from "../../types/host";
import { createHostsActions, type HostsActions, type HostsState } from "./actions";
import { buildHostPatch, decodeHost } from "./api";
import { buildGroupTree, getUngroupedHosts, isValidGroupPath } from "../../utils/groupUtils";

vi.mock("../../api", async (original) => ({
  ...(await original<object>()),
  getApiBase: async () => "http://127.0.0.1:8000",
  fetchJsonOrThrow: vi.fn(),
}));
const request = vi.mocked(fetchJsonOrThrow);
const host = (changes: Partial<SavedHostDto> = {}): SavedHostDto => ({
  id: 1,
  revision: 0,
  name: "server",
  hostname: "example.test",
  port: 22,
  username: "",
  connection_type: "ssh",
  ...changes,
});
function setup(hosts = [host()]) {
  request.mockReset();
  let state = {
    hosts,
    hostsEpoch: 0,
    hostsLoading: false,
    hostsError: null,
    selectedHost: hosts[0] ?? null,
    updateTabHost: vi.fn(),
  } as HostsState & HostsActions;
  Object.assign(
    state,
    createHostsActions(
      (update) => {
        state = { ...state, ...(typeof update === "function" ? update(state) : update) };
      },
      () => state,
    ),
  );
  return () => state;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("saved host updates", () => {
  it("deduplicates loads and reloads an obsolete list without undoing a saved edit", async () => {
    const get = setup();
    const oldList = deferred<SavedHostDto[]>();
    const saved = host({ revision: 1, group: "Production" });
    request.mockImplementation(async (_url, options) =>
      options?.method === "PATCH" ? saved : [saved],
    );
    request.mockImplementationOnce(() => oldList.promise);
    const first = get().fetchHosts();
    expect(get().fetchHosts()).toBe(first);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await get().patchHost(1, { group: "Production" });
    oldList.resolve([host()]);
    expect(await first).toEqual([decodeHost(saved)]);
    expect(get().hosts[0].group).toBe("Production");
    expect(get().hostsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("serializes rapid field edits using the latest saved revision and sends no connection snapshot", async () => {
    const get = setup([host({ group: "Production", jump_host_id: 8 })]);
    request.mockImplementation(async (_url, options) => {
      const patch = JSON.parse(String(options?.body));
      return host({
        revision: patch.revision + 1,
        group: "Production",
        jump_host_id: 8,
        terminal_font_size: patch.terminal_font_size,
      });
    });
    await Promise.all([
      get().patchHost(1, { terminal_font_size: 16 }),
      get().patchHost(1, { terminal_font_size: 17 }),
    ]);
    expect(request.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([
      { revision: 0, terminal_font_size: 16 },
      { revision: 1, terminal_font_size: 17 },
    ]);
    expect(get().hosts[0]).toMatchObject({
      group: "Production",
      jump_host_id: 8,
      terminal_font_size: 17,
    });
    expect(get().updateTabHost).toHaveBeenLastCalledWith(1, {
      name: "server",
      terminal_theme: undefined,
      terminal_font_size: 17,
      terminal_background: null,
      terminal_foreground: null,
        terminal_appearance: null,
    });
  });

  it("preserves the editor revision, reports a conflict and refreshes the saved list", async () => {
    const get = setup([host({ revision: 3 })]);
    request.mockRejectedValueOnce(new ApiError("Reopen the host editor", 409));
    request.mockResolvedValueOnce([host({ revision: 4, name: "changed elsewhere" })]);
    await expect(get().patchHost(1, { revision: 1, name: "my edit" })).rejects.toThrow("Reopen");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      revision: 1,
      name: "my edit",
    });
    expect(get().hosts[0].name).toBe("changed elsewhere");
  });

  it("keeps a host and the selected profile when deletion is rejected", async () => {
    const get = setup();
    request.mockRejectedValueOnce(new ApiError("Host has snippets", 409));
    request.mockResolvedValueOnce([host()]);
    await expect(get().deleteHost(1)).rejects.toThrow("snippets");
    expect(get().hosts).toHaveLength(1);
    expect(get().selectedHost?.id).toBe(1);
  });

  it("builds form patches from changed fields and preserves omitted jump and credential fields", () => {
    const initial = host({
      group: "Production",
      jump_host_id: 8,
      credential_id: 10,
      terminal_theme: "dracula",
      terminal_font_size: 14,
    });
    const payload: HostMutation = {
      name: "renamed",
      hostname: "example.test",
      username: "",
      port: 22,
      connection_type: "ssh",
      group: "Production",
      terminal_theme: "dracula",
      terminal_font_size: 14,
      serial_port: null,
      serial_speed: null,
      local_command: null,
      local_args: null,
      local_cwd: null,
    };
    expect(buildHostPatch(initial, payload)).toEqual({ revision: 0, name: "renamed" });
  });
});

describe("host decoding and group paths", () => {
  it("normalizes nullable usernames and strips unexpected secret fields", () => {
    const safe = decodeHost({
      ...host(),
      username: null,
      password: "secret",
      private_key: "secret",
      passphrase: "secret",
    });
    expect(safe.username.toLowerCase()).toBe("");
    expect(JSON.stringify(safe)).not.toContain("secret");
    expect(() => decodeHost({ ...host(), revision: undefined })).toThrow("restart the backend");
  });

  it("keeps hosts visible in noncanonical and empty legacy groups", () => {
    const server = host({ group: " / Prod // DB / " });
    const tree = buildGroupTree([server], new Set(), new Set(["Prod/ DB"]));
    expect(tree).toHaveLength(1);
    expect(tree[0].subgroups).toHaveLength(1);
    expect(tree[0].subgroups[0].hosts).toEqual([server]);
    expect(getUngroupedHosts([host({ group: " /// " })])).toHaveLength(1);
    expect(isValidGroupPath("Продакшн/База данных")).toBe(true);
    expect(isValidGroupPath("Prod/../DB")).toBe(false);
    expect(isValidGroupPath("Prod/DB\u0000")).toBe(false);
  });
});
