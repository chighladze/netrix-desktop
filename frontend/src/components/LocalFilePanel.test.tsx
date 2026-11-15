import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LocalFilePanel from "./LocalFilePanel";
const mocks = vi.hoisted(() => ({ list: vi.fn(), content: vi.fn() }));
vi.mock("../api", () => ({
  fetchJsonOrThrow: mocks.list, authenticatedFetch: mocks.content,
  getApiBase: async () => "http://127.0.0.1:8000", getApiErrorMessage: async () => "Read failed",
}));

describe("Local file panel", () => {
  beforeEach(() => {
    mocks.list.mockReset().mockResolvedValue({ path: "C:\\Files", parent: "C:\\", truncated: false, entries: [
      { name: "config.txt", path: "C:\\Files\\config.txt", is_directory: false, size: 3 },
      { name: "large.bin", path: "C:\\Files\\large.bin", is_directory: false, size: 129 * 1024 * 1024 },
    ] });
    mocks.content.mockReset();
  });

  it("requires explicit upload and explains why an oversized file cannot be sent", async () => {
    const upload = vi.fn().mockResolvedValue(undefined);
    render(<LocalFilePanel disabled={false} remotePath="/data" onUpload={upload} />);
    fireEvent.click(await screen.findByRole("button", { name: "large.bin" }));
    expect(screen.getByText(/exceeds the 128 MiB/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Upload selected" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "config.txt" }));
    expect(mocks.content).not.toHaveBeenCalled();
    mocks.content.mockResolvedValue({ ok: true, blob: async () => new Blob(["abc"]) });
    fireEvent.click(screen.getByRole("button", { name: "Upload selected" }));
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(upload.mock.calls[0][0].name).toBe("config.txt");
    expect(upload.mock.calls[0][0].size).toBe(3);
  });

  it("shows a recoverable listing failure and retries the attempted path", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Local path unavailable"));
    render(<LocalFilePanel disabled={false} remotePath="/data" onUpload={vi.fn()} />);
    await screen.findByText("Local path unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "config.txt" });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list.mock.calls[0][0]).toBe(mocks.list.mock.calls[1][0]);
  });
});
