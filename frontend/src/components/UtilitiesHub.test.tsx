import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ fetchJsonOrThrow: vi.fn(), getApiBase: vi.fn() }));
vi.mock("../api", async (original) => ({ ...(await original<object>()), ...api }));
vi.mock("../utils/clipboard", () => ({ copyTextWithAutoClear: vi.fn() }));
import UtilitiesHub from "./UtilitiesHub";

const result = (target: string) => ({
  target,
  resolved_ip: "127.0.0.1",
  scanned_ports: 3,
  duration_ms: 2,
  open_ports: [],
  note: "test-only",
});
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("netrix.utilities.activeCategory", "network");
  api.fetchJsonOrThrow.mockReset();
  api.getApiBase.mockReset().mockResolvedValue("http://127.0.0.1:3210");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});
describe("Toolbox network workflows", () => {
  it("ignores an old target response even if the transport resolves after abort", async () => {
    let finishOld!: (value: ReturnType<typeof result>) => void;
    api.fetchJsonOrThrow
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockResolvedValueOnce(result("new.target"));
    render(<UtilitiesHub />);
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() => expect(api.fetchJsonOrThrow).toHaveBeenCalledTimes(1));
    const oldSignal = api.fetchJsonOrThrow.mock.calls[0][1].signal as AbortSignal;
    fireEvent.change(screen.getByLabelText("Scan target"), { target: { value: "new.target" } });
    expect(oldSignal.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByText("new.target");
    await act(async () => {
      finishOld(result("old.target"));
    });
    expect(screen.queryByText("old.target")).toBeNull();
    expect(screen.getByText("new.target")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Scan ports"), { target: { value: "22" } });
    expect(screen.queryByText("new.target")).toBeNull();
  });
  it("stops waiting and aborts pending view requests on unmount", async () => {
    api.fetchJsonOrThrow.mockReturnValue(new Promise(() => {}));
    const view = render(<UtilitiesHub />);
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() => expect(api.fetchJsonOrThrow).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));
    expect(api.fetchJsonOrThrow.mock.calls[0][1].signal.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() => expect(api.fetchJsonOrThrow).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(api.fetchJsonOrThrow.mock.calls[1][1].signal.aborted).toBe(true);
  });
  it("rejects invalid numeric edits instead of silently substituting defaults", async () => {
    render(<UtilitiesHub />);
    fireEvent.change(screen.getByLabelText("Scan concurrency"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Concurrency must be an integer",
    );
    fireEvent.change(screen.getByLabelText("TLS port"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((node) => node.textContent?.includes("Port must be an integer")),
      ).toBe(true),
    );
    expect(api.fetchJsonOrThrow).not.toHaveBeenCalled();
  });
  it("shows a backend error without presenting an empty scan as success", async () => {
    api.fetchJsonOrThrow.mockRejectedValue(new Error("DNS resolution timed out"));
    render(<UtilitiesHub />);
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect((await screen.findByRole("alert")).textContent).toBe("DNS resolution timed out");
    expect(screen.queryByText(/No open TCP ports/)).toBeNull();
  });
});
