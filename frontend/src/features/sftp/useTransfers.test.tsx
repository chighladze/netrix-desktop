import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTransfers } from "./useTransfers";
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("../../api", () => ({
  authenticatedFetch: mocks.fetch,
  getApiBase: async () => "http://127.0.0.1:8000",
  getApiErrorMessage: async () => "Transfer stopped",
}));
vi.mock("./api", () => ({
  createTransfer: mocks.create,
  cancelTransfer: mocks.cancel,
  requireCompletedTransfer: mocks.complete,
}));

function options(controller = new AbortController()) {
  return {
    hostId: 1,
    remotePath: "/data",
    entries: [] as { name: string; path: string; entry_type: string }[],
    ask: vi.fn().mockResolvedValue(""),
    track: vi.fn(() => controller),
    release: vi.fn(),
    busy: vi.fn(),
    toast: vi.fn(),
    reload: vi.fn().mockResolvedValue(undefined),
  };
}

const files = [
  { name: "app.log", path: "/data/app.log", entry_type: "file" },
  { name: "error.log", path: "/data/error.log", entry_type: "file" },
];
function folderPicker() {
  const writers: { name: string; write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }[] = [];
  const getFileHandle = vi.fn(async (name: string, config?: { create: boolean }) => {
    if (!config?.create) throw new DOMException("Not found", "NotFoundError");
    const writer = { name, write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
    writers.push(writer);
    return { createWritable: async () => writer };
  });
  const picker = vi.fn().mockResolvedValue({ getFileHandle });
  (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = picker;
  return { writers, picker, getFileHandle };
}

describe("SFTP transfers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({ id: "job" });
    mocks.cancel.mockResolvedValue({ status: "cancelled" });
    mocks.complete.mockResolvedValue({ status: "completed" });
    mocks.fetch.mockResolvedValue(new Response("{}"));
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  afterEach(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    vi.restoreAllMocks();
  });

  it("downloads selected files sequentially with one folder picker and forwards growth notices", async () => {
    const { writers, picker } = folderPicker();
    mocks.fetch.mockImplementation(async () => new Response("log contents"));
    mocks.complete.mockResolvedValueOnce({ status: "completed", warning: "File grew; later bytes excluded" });
    mocks.create.mockImplementation(async () => {
      if (mocks.create.mock.calls.length === 2) expect(writers[0].close).toHaveBeenCalledOnce();
      return { id: `job-${mocks.create.mock.calls.length}` };
    });
    const config = options();
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.downloadMany(files));
    expect(picker).toHaveBeenCalledOnce();
    expect(writers.map((writer) => writer.name)).toEqual(["app.log", "error.log"]);
    for (const writer of writers) { expect(writer.write).toHaveBeenCalled(); expect(writer.close).toHaveBeenCalledOnce(); expect(writer.abort).not.toHaveBeenCalled(); }
    expect(mocks.create.mock.calls.map((call) => call[2])).toEqual(files.map((file) => file.path));
    expect(config.toast).toHaveBeenCalledWith("app.log: File grew; later bytes excluded", "info");
    expect(config.toast).toHaveBeenCalledWith("Downloaded 2 files", "success");
    expect(config.busy.mock.calls).toEqual([["download"], [null]]);
  });

  it("stops the remaining downloads when their originating view is cancelled", async () => {
    const { writers } = folderPicker();
    const controller = new AbortController();
    const config = options(controller);
    mocks.complete.mockImplementationOnce(async () => { controller.abort(); return { status: "completed" }; });
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.downloadMany(files));
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledWith("job");
    expect(writers[0].abort).toHaveBeenCalledOnce();
    expect(writers[0].close).not.toHaveBeenCalled();
    expect(config.toast).not.toHaveBeenCalledWith(expect.any(String), "success");
  });

  it("does not overwrite an existing local file when replacement is declined", async () => {
    const { getFileHandle } = folderPicker();
    const writable = { name: "app.log", write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    getFileHandle.mockResolvedValueOnce({ createWritable: async () => writable });
    const config = options(); config.ask.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.downloadMany(files));
    expect(config.ask).toHaveBeenCalledWith(expect.objectContaining({ title: "Replace local file?", description: "app.log" }));
    expect(getFileHandle).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(writable.write).not.toHaveBeenCalled();
  });

  it("uses individual browser downloads for a batch when folder access is unavailable", async () => {
    const links: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { links.push(this.download); });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    mocks.fetch.mockImplementation(async () => new Response("data"));
    const savePicker = vi.fn();
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = savePicker;
    const config = options();
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.downloadMany([{ ...files[0], name: "a:b.log" }, { ...files[1], name: "a?b.log" }]));
    expect(links).toEqual(["a_b.log", "a_b (2).log"]);
    expect(savePicker).not.toHaveBeenCalled();
    expect(config.toast).toHaveBeenCalledWith("Downloaded 2 files", "success");
  });

  it("does not start any downloads after the folder chooser is cancelled", async () => {
    const { picker } = folderPicker();
    picker.mockRejectedValueOnce(new DOMException("Cancelled", "AbortError"));
    const config = options();
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.downloadMany(files));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(config.busy).toHaveBeenLastCalledWith(null);
  });

  it("reports a partial batch and stops before the next file when the local save fails", async () => {
    const { writers } = folderPicker();
    mocks.fetch.mockImplementation(async () => new Response("data"));
    mocks.complete.mockImplementation(async () => {
      if (writers.length === 2) writers[1].close.mockRejectedValueOnce(new Error("Local disk full"));
      return { status: "completed" };
    });
    const config = options();
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.downloadMany([...files, { ...files[0], name: "third.log", path: "/data/third.log" }]));
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(writers[0].close).toHaveBeenCalledOnce();
    expect(writers[0].abort).not.toHaveBeenCalled();
    expect(writers[1].abort).toHaveBeenCalledOnce();
    expect(config.toast).toHaveBeenCalledWith("1 of 3 files downloaded. Local disk full", "error");
    expect(config.toast).not.toHaveBeenCalledWith(expect.any(String), "success");
  });

  it("does not start a replacement when confirmation is cancelled", async () => {
    const config = options();
    config.entries = [{ name: "file", path: "/data/file", entry_type: "file" }];
    config.ask.mockResolvedValue(null);
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.uploadFiles([new File(["abc"], "file")]));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("cancels the backend job and stops the remaining queue when the request is aborted", async () => {
    const controller = new AbortController();
    mocks.fetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Cancelled", "AbortError")),
          );
        }),
    );
    const config = options(controller);
    const { result } = renderHook(() => useTransfers(config));
    let pending: Promise<void>;
    act(() => {
      pending = result.current.uploadFiles([new File(["abc"], "one"), new File(["def"], "two")]);
    });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    await act(async () => {
      controller.abort();
      await pending;
    });
    expect(mocks.cancel).toHaveBeenCalledWith("job");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(config.reload).not.toHaveBeenCalled();
    expect(config.toast).not.toHaveBeenCalledWith(expect.any(String), "success");
  });

  it("requires a committed backend result before showing upload success", async () => {
    mocks.complete.mockRejectedValueOnce(new Error("CLOSE failed"));
    const config = options();
    const { result } = renderHook(() => useTransfers(config));
    await act(() => result.current.uploadFiles([new File(["abc"], "file")]));
    expect(config.toast).toHaveBeenCalledWith("CLOSE failed", "error");
    expect(config.toast).not.toHaveBeenCalledWith(expect.any(String), "success");
  });

  it("aborts the local destination instead of saving a download whose job failed", async () => {
    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi
      .fn()
      .mockResolvedValue({ createWritable: async () => writer });
    mocks.fetch.mockResolvedValueOnce(new Response("partial contents"));
    mocks.complete.mockRejectedValueOnce(new Error("Remote file changed"));
    const config = options();
    const { result } = renderHook(() => useTransfers(config));
    await act(() =>
      result.current.download({ name: "file", path: "/data/file", entry_type: "file" }),
    );
    expect(writer.write).toHaveBeenCalled();
    expect(writer.abort).toHaveBeenCalled();
    expect(writer.close).not.toHaveBeenCalled();
    expect(config.toast).toHaveBeenCalledWith("Remote file changed", "error");
  });
});
