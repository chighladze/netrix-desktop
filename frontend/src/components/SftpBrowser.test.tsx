import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store";
import SftpBrowser from "./SftpBrowser";
import { sftpTargetKey } from "../features/sftp/api";
const mutate = vi.hoisted(() => vi.fn());
const requests = vi.hoisted(() => ({ list: vi.fn(), file: vi.fn() }));
const desktop = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<object>()),
  ...desktop,
  Channel: class {
    readonly id = 42;
    onmessage = (_message: null) => {};
  },
}));
vi.mock("../features/sftp/TransferPanel", () => ({ default: () => null }));
vi.mock("../features/sftp/api", async (original) => ({
  ...(await original<object>()),
  mutateFile: mutate,
}));
vi.mock("../api", () => ({
  authenticatedFetch: requests.file,
  getApiBase: async () => "http://127.0.0.1:8000",
  fetchJsonOrThrow: requests.list,
  getApiErrorMessage: async () => "Request failed",
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function addSecondHost() {
  const state = useAppStore.getState();
  useAppStore.setState({
    hosts: [...state.hosts, { ...state.hosts[0], id: 2, name: "second-server" }],
    openSftpHostIds: [1, 2],
    sftpCapabilities: {
      ...state.sftpCapabilities,
      2: { host_id: 2, capability: "sftp", status: "supported", can_probe: true },
    },
    sftpBrowserStates: {
      ...state.sftpBrowserStates,
      2: { ...state.sftpBrowserStates[1], hostId: 2 },
    },
  });
}

describe("Files actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    desktop.invoke.mockReset();
    desktop.isTauri.mockReset().mockReturnValue(false);
    mutate.mockReset().mockResolvedValue(undefined);
    requests.list.mockReset().mockResolvedValue({ host_id: 1, path: "/data", entries: [] });
    requests.file.mockReset();
    const entry = { name: "file.txt", path: "/data/file.txt", entry_type: "file", size: 3 };
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      fetchSftpCapability: async () => null,
      hosts: [
        {
          id: 1,
          revision: 0,
          name: "server",
          hostname: "example.test",
          port: 22,
          username: "user",
          connection_type: "ssh",
          has_password: false,
          has_private_key: false,
        },
      ],
      activeSftpHostId: 1,
      openSftpHostIds: [1],
      sftpBusyHosts: {},
      sftpCapabilities: {
        1: { host_id: 1, capability: "sftp", status: "supported", can_probe: true },
      },
      sftpBrowserStates: {
        1: {
          connectionKey: sftpTargetKey({
            id: 1,
            revision: 0,
            name: "server",
            hostname: "example.test",
            port: 22,
            username: "user",
            connection_type: "ssh",
          }),
          hostId: 1,
          directory: { host_id: 1, path: "/data", entries: [entry] },
          currentPath: "/data",
          directoryStatus: "ready",
          directoryError: null,
          selectedEntry: entry,
          updatedAt: 0,
        },
      },
    });
  });

  it("offers a batch download for Ctrl-selected files and disables single-item mutations", async () => {
    const first = useAppStore.getState().sftpBrowserStates[1].selectedEntry!;
    const second = { ...first, name: "error.log", path: "/data/error.log" };
    const folder = { name: "archive", path: "/data/archive", entry_type: "directory" };
    useAppStore.getState().setSftpBrowserState(1, { directory: { host_id: 1, path: "/data", entries: [first, second, folder] } });
    render(<SftpBrowser />);
    fireEvent.focus(screen.getByRole("button", { name: "error.log" }));
    fireEvent.click(screen.getByRole("button", { name: "error.log" }), { ctrlKey: true });
    expect((screen.getByRole("button", { name: "Download 2 files" }) as HTMLButtonElement).disabled).toBe(false);
    for (const name of ["View", "Rename", "Delete", "Permissions"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("button", { name: "error.log" }), { key: "Delete" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "archive" }), { ctrlKey: true });
    expect((screen.getByRole("button", { name: "Download 3 files" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Search remote files"), { target: { value: "error" } });
    await waitFor(() => expect(useAppStore.getState().sftpBrowserStates[1].selectedEntries).toEqual([second]));
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("downloads both Ctrl-selected files through the shared transfer queue", async () => {
    const first = useAppStore.getState().sftpBrowserStates[1].selectedEntry!;
    const second = { ...first, name: "error.log", path: "/data/error.log" };
    useAppStore.getState().setSftpBrowserState(1, { directory: { host_id: 1, path: "/data", entries: [first, second] } });
    let jobNumber = 0;
    requests.list.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/transfers") && init.method === "POST") return { id: `job-${++jobNumber}` };
      return { status: "completed" };
    });
    requests.file.mockImplementation(async () => new Response("log data"));
    const saved: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "error.log" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Download 2 files" }));
    await waitFor(() => expect(saved).toEqual(["file.txt", "error.log"]));
    expect(requests.file.mock.calls.map(([url]) => new URL(url).searchParams.get("path"))).toEqual([first.path, second.path]);
    expect((screen.getByRole("button", { name: "Download 2 files" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it.each(["allow", "cancel", "switch host"])("settles the Files save access request on %s", async (action) => {
    const allow = action === "allow";
    const first = useAppStore.getState().sftpBrowserStates[1].selectedEntry!;
    const second = { ...first, name: "error.log", path: "/data/error.log", size: 1024 };
    useAppStore.getState().setSftpBrowserState(1, {
      directory: { host_id: 1, path: "/data", entries: [first, second] },
    });

    const writer = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
    const directory = {
      getFileHandle: async (_name: string, options?: { create: boolean }) => {
        if (!options?.create) throw new DOMException("No local file", "NotFoundError");
        return { createWritable: async () => writer };
      },
    };
    let onRequest: { id: number; onmessage: (message: null) => void };
    let decide: ((allowed: boolean) => void) | undefined;
    desktop.isTauri.mockReturnValue(true);
    desktop.invoke.mockImplementation(async (command, args) => {
      if (command === "watch_sftp_save_access") {
        onRequest = args.onRequest;
        return true;
      }
      if (command === "finish_sftp_save_access" && args.id === onRequest.id) {
        const settle = decide;
        decide = undefined;
        settle?.(args.allow);
      }
    });
    const pick = vi.fn(() => new Promise((resolve, reject) => {
      decide = (allowed) => {
        if (allowed) resolve(directory);
        else reject(new DOMException("Permission declined", "NotAllowedError"));
      };
      onRequest.onmessage(null);
    }));
    vi.stubGlobal("showDirectoryPicker", pick);
    requests.list.mockImplementation(async (_url, init) => init?.method === "POST" ? { id: "job" } : { status: "completed" });
    requests.file.mockImplementation(async () => new Response("test data"));

    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "error.log" }), { ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Download 2 files" }));
    const prompt = await screen.findByRole("dialog", { name: "Allow local save?" });
    expect(within(prompt).getByText("Selected folder on this computer")).toBeTruthy();
    expect(within(prompt).getByText("file.txt")).toBeTruthy();
    expect(within(prompt).getByText("error.log")).toBeTruthy();
    expect(requests.file).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    if (action === "switch host") {
      act(() => {
        addSecondHost();
        useAppStore.setState({ activeSftpHostId: 2 });
      });
    } else {
      fireEvent.click(within(prompt).getByRole("button", { name: allow ? "Allow & download" : "Cancel" }));
    }

    await waitFor(() => expect(desktop.invoke).toHaveBeenCalledWith("finish_sftp_save_access", { id: 42, allow }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Allow local save?" })).toBeNull());
    if (allow) await waitFor(() => expect(writer.close).toHaveBeenCalledTimes(2));
    expect(pick).toHaveBeenCalledOnce();
    expect(requests.file).toHaveBeenCalledTimes(allow ? 2 : 0);
    expect(writer.close).toHaveBeenCalledTimes(allow ? 2 : 0);
  });

  it("submits a rename only after its dialog is confirmed", async () => {
    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "new.txt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(1, {
        action: "rename",
        path: "/data/file.txt",
        destination: "/data/new.txt",
      }),
    );
  });

  it("cancelling deletion does not call the backend", async () => {
    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete remote item?" });
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mutate).not.toHaveBeenCalled();
  });

  it("restarts an interrupted directory load on returning and ignores its late result", async () => {
    addSecondHost();
    const state = useAppStore.getState();
    state.setSftpBrowserState(1, { directoryStatus: "idle" });
    const old = deferred<{ host_id: number; path: string; entries: [] }>();
    requests.list
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue({ host_id: 1, path: "/fresh", entries: [] });
    render(<SftpBrowser />);
    await waitFor(() => expect(requests.list).toHaveBeenCalledTimes(1));
    const signal = requests.list.mock.calls[0][1].signal as AbortSignal;
    act(() => useAppStore.getState().setActiveSftpHostId(2));
    expect(signal.aborted).toBe(true);
    expect(useAppStore.getState().sftpBrowserStates[1].directoryStatus).toBe("idle");
    act(() => useAppStore.getState().setActiveSftpHostId(1));
    await waitFor(() =>
      expect(useAppStore.getState().sftpBrowserStates[1].currentPath).toBe("/fresh"),
    );
    await act(async () => {
      old.resolve({ host_id: 1, path: "/stale", entries: [] });
      await old.promise;
    });
    expect(useAppStore.getState().sftpBrowserStates[1].currentPath).toBe("/fresh");
    expect(useAppStore.getState().sftpBrowserStates[1].directoryStatus).toBe("ready");
  });

  it("closing a loading preview aborts it and a late response cannot reopen it", async () => {
    const response = deferred<Response>();
    requests.file.mockReturnValueOnce(response.promise);
    render(<SftpBrowser />);
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]);
    await waitFor(() => expect(requests.file).toHaveBeenCalledOnce());
    const signal = requests.file.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      response.resolve(new Response("late contents"));
      await response.promise;
    });
    expect(screen.queryByRole("button", { name: "Close preview" })).toBeNull();
    expect(screen.queryByText("late contents")).toBeNull();
  });

  it("discards paths and selection when the saved profile points to a different server", async () => {
    const listing = deferred<{ host_id: number; path: string; entries: [] }>();
    requests.list.mockReturnValueOnce(listing.promise);
    render(<SftpBrowser />);
    act(() =>
      useAppStore.setState((state) => ({
        hosts: state.hosts.map((host) => ({
          ...host,
          hostname: "other.test",
          revision: host.revision + 1,
        })),
      })),
    );
    await waitFor(() => expect(requests.list).toHaveBeenCalledOnce());
    expect(requests.list.mock.calls[0][0]).toContain("/list?path=.");
    expect(useAppStore.getState().sftpBrowserStates[1].selectedEntry).toBeNull();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: /file\.txt/ })).toBeNull();
    await act(async () => {
      listing.resolve({ host_id: 1, path: "/new-home", entries: [] });
      await listing.promise;
    });
    expect(useAppStore.getState().sftpBrowserStates[1].currentPath).toBe("/new-home");
  });

  it("preserves the listing for cosmetic profile edits", () => {
    render(<SftpBrowser />);
    act(() =>
      useAppStore.setState((state) => ({
        hosts: state.hosts.map((host) => ({
          ...host,
          name: "Renamed",
          terminal_font_size: 18,
          revision: host.revision + 1,
        })),
      })),
    );
    expect(requests.list).not.toHaveBeenCalled();
    expect(useAppStore.getState().sftpBrowserStates[1].selectedEntry?.name).toBe("file.txt");
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("an old mutation cannot unlock actions or clear a preview on another host", async () => {
    addSecondHost();
    const mutation = deferred<void>();
    mutate.mockReturnValueOnce(mutation.promise);
    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    fireEvent.change(within(dialog).getByLabelText("New name"), { target: { value: "new.txt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    fireEvent.doubleClick(screen.getByRole("button", { name: /file\.txt/ }));
    expect(requests.file).not.toHaveBeenCalled();
    act(() => useAppStore.getState().setActiveSftpHostId(2));
    const preview = deferred<Response>();
    requests.file.mockReturnValueOnce(preview.promise);
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0]);
    await waitFor(() => expect(requests.file).toHaveBeenCalledOnce());
    await act(async () => {
      mutation.resolve();
      await mutation.promise;
    });
    expect(screen.getByText("Opening preview")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload", hidden: true }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(requests.list).not.toHaveBeenCalled();
    expect(useAppStore.getState().sftpBrowserStates[1].directoryStatus).toBe("idle");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await act(async () => {
      preview.resolve(new Response("ignored"));
      await preview.promise;
    });
  });

  it("keeps an invalid name in the dialog and allows correcting it", async () => {
    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    const input = within(dialog).getByLabelText("New name");
    fireEvent.change(input, { target: { value: "bad/name" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("without /");
    expect((input as HTMLInputElement).value).toBe("bad/name");
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "correct.txt" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith(1, {
      action: "rename", path: "/data/file.txt", destination: "/data/correct.txt",
    }));
  });

  it("edits the selected folder's permissions and validates octal input", async () => {
    const folder = { name: "config", path: "/data/config", entry_type: "directory", permissions: "drwxr-x---" };
    useAppStore.getState().setSftpBrowserState(1, { directory: { host_id: 1, path: "/data", entries: [folder] }, selectedEntry: folder });
    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    const dialog = await screen.findByRole("dialog", { name: "Change permissions" });
    const input = within(dialog).getByLabelText("Permissions (000-777)") as HTMLInputElement;
    expect(input.value).toBe("750");
    fireEvent.change(input, { target: { value: "888" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "755" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledWith(1, { action: "chmod", path: folder.path, permissions: "755" }));
  });

  it("retries the entered path after a failed navigation without losing the last location", async () => {
    requests.list.mockRejectedValueOnce(new Error("Access denied"));
    render(<SftpBrowser />);
    const input = screen.getByLabelText("Remote directory path");
    fireEvent.change(input, { target: { value: "/private" } });
    fireEvent.click(screen.getByRole("button", { name: "Go to remote path" }));
    await screen.findByText("/private: Access denied");
    expect(useAppStore.getState().sftpBrowserStates[1].currentPath).toBe("/data");
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(requests.list).toHaveBeenCalledTimes(2));
    expect(requests.list.mock.calls[1][0]).toContain("path=%2Fprivate");
  });

  it("keeps remote actions available alongside the local panel", async () => {
    requests.list.mockResolvedValue({ path: "C:\\Users", parent: "C:\\", entries: [], truncated: false });
    render(<SftpBrowser />);
    fireEvent.click(screen.getByRole("button", { name: "Local panel" }));
    await screen.findByRole("region", { name: "Local file workspace" });
    const actions = screen.getByRole("group", { name: "Remote file actions" });
    for (const name of ["View", "Download", "Rename", "Delete", "Permissions"]) {
      expect((within(actions).getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
    await waitFor(() => expect(requests.list).toHaveBeenCalled());
  });

  it("returns to the cached starting folder with Back after entering another path", async () => {
    requests.list.mockResolvedValueOnce({ host_id: 1, path: "/next", entries: [] });
    render(<SftpBrowser />);
    fireEvent.change(screen.getByLabelText("Remote directory path"), { target: { value: "/next" } });
    fireEvent.click(screen.getByRole("button", { name: "Go to remote path" }));
    await waitFor(() => expect(useAppStore.getState().sftpBrowserStates[1].currentPath).toBe("/next"));
    fireEvent.click(screen.getByRole("button", { name: "Remote back" }));
    await waitFor(() => expect(requests.list).toHaveBeenCalledTimes(2));
    expect(requests.list.mock.calls[1][0]).toContain("path=%2Fdata");
  });

  it("supports keyboard rename and clears filtered-out selection before a destructive action", async () => {
    render(<SftpBrowser />);
    fireEvent.keyDown(screen.getByRole("button", { name: "file.txt" }), { key: "F2" });
    const dialog = await screen.findByRole("dialog", { name: "Rename" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.change(screen.getByLabelText("Search remote files"), { target: { value: "missing" } });
    await waitFor(() => expect(useAppStore.getState().sftpBrowserStates[1].selectedEntry).toBeNull());
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("No matching files")).toBeTruthy();
  });
});
