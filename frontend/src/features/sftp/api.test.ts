import { describe, expect, it, vi } from "vitest";
import { disconnectSftp, requireCompletedTransfer, validateFileName, visitDirectory } from "./api";
const request = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({
  fetchJsonOrThrow: request,
  authenticatedFetch: request,
  getApiErrorMessage: async () => "Disconnect was rejected",
  getApiBase: async () => "http://127.0.0.1:8000",
}));

describe("SFTP navigation and completion", () => {
  it("does not report disconnect success when the backend rejects it", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await expect(disconnectSftp(7)).rejects.toThrow("Disconnect was rejected");
  });
  it("preserves forward history when going back, and discards it on a new branch", () => {
    const a = visitDirectory(undefined, "/a");
    const b = visitDirectory(a, "/b");
    const back = visitDirectory(b, "/a", 0);
    expect(back.paths).toEqual(["/a", "/b"]);
    expect(visitDirectory(back, "/c").paths).toEqual(["/a", "/c"]);
  });
  it("rejects path components while allowing names with spaces", () => {
    expect(validateFileName(" report ")).toBe(" report ");
    for (const name of ["", ".", "..", "a/b", "x\0y"])
      expect(() => validateFileName(name)).toThrow();
  });
  it("does not treat HTTP EOF or fully acknowledged bytes as a committed file", async () => {
    request.mockResolvedValueOnce({ status: "committing", bytes_done: 10, bytes_total: 10 });
    await expect(requireCompletedTransfer("job")).rejects.toThrow("committing");
    request.mockResolvedValueOnce({ status: "failed", error: "Disk full" });
    await expect(requireCompletedTransfer("job")).rejects.toThrow("Disk full");
    request.mockResolvedValueOnce({ status: "completed", warning: "File grew" });
    await expect(requireCompletedTransfer("job")).resolves.toMatchObject({ status: "completed", warning: "File grew" });
  });
});
