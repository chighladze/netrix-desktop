import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TransferPanel from "./TransferPanel";
import type { TransferJob } from "./api";
const mocks = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn() }));
vi.mock("./api", async (original) => ({ ...(await original<object>()), sftpRequest: mocks.list, cancelTransfer: mocks.cancel }));

function job(id: string, status: TransferJob["status"]): TransferJob {
  return { id, host_id: 1, kind: "upload", path: `/data/${id}`, status, bytes_done: 8, bytes_total: 16, error: null };
}

describe("Transfer drawer", () => {
  beforeEach(() => { mocks.list.mockReset(); mocks.cancel.mockReset().mockResolvedValue({}); });
  it("shows successful growing-file downloads with their bounded-copy notice", async () => {
    mocks.list.mockResolvedValue({ transfers: [{ ...job("app.log", "completed"), kind: "download", warning: "Remote file grew. Saved the first 8 bytes." }] });
    render(<TransferPanel hostId={1} />);
    expect(await screen.findByText("Remote file grew. Saved the first 8 bytes.")).toBeDefined();
    expect(screen.getByText("Completed")).toBeDefined();
    expect(screen.queryByText("Failed")).toBeNull();
  });
  it("keeps active jobs visible ahead of history and only clears finished entries", async () => {
    mocks.list.mockResolvedValue({ transfers: [
      ...Array.from({ length: 13 }, (_, index) => job(`done-${index}`, "completed")), job("current", "running"),
    ] });
    render(<TransferPanel hostId={1} />);
    const section = await screen.findByRole("region", { name: "SFTP transfers" });
    expect(within(section).getAllByRole("progressbar")[0].getAttribute("aria-label")).toBe("Transfer /data/current");
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(screen.queryByText("/data/done-0")).toBeNull();
    expect(screen.getByText("/data/current")).toBeTruthy();
    expect(mocks.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Transfers/ }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Transfers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel transfer /data/current" }));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith("current"));
  });
});
