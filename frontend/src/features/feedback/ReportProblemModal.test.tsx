import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReportProblemModal from "./ReportProblemModal";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), writeText: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mock.writeText }));
const safe = { app_version: "0.3.0-beta.8", operating_system: "Windows 10.0 (build 26100)", architecture: "x86_64",
  backend_status: "failed", reason: "local_port_in_use", exit_code: 1, os_error: 10048 };

beforeEach(() => {
  mock.invoke.mockReset(); mock.writeText.mockReset();
  mock.invoke.mockImplementation(async (command) => command === "get_problem_report_diagnostics" ? safe : undefined);
  mock.writeText.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });

async function fillAndPreview(actual = "The workspace did not open.") {
  fireEvent.change(screen.getByLabelText("What were you doing?"), { target: { value: "1. Open Netrix." } });
  fireEvent.change(screen.getByLabelText("What did you expect?"), { target: { value: "My workspace opens." } });
  fireEvent.change(screen.getByLabelText("What happened?"), { target: { value: actual } });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Preview report" }).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Preview report" }));
  return screen.findByLabelText("Report preview");
}

describe("ReportProblemModal", () => {
  it("previews exactly what will be copied and prefilled, and opens only after the explicit action", async () => {
    render(<ReportProblemModal onClose={vi.fn()} serviceFailure />);
    expect(screen.getByLabelText<HTMLSelectElement>("Affected area").value).toBe("Installer or startup");
    const preview = await fillAndPreview();
    expect(preview.textContent).toContain("OS error: 10048");
    expect(mock.invoke.mock.calls.map(([command]) => command)).toEqual(["get_problem_report_diagnostics"]);
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await screen.findByText("Report copied.");
    expect(mock.writeText).toHaveBeenCalledWith(preview.textContent);
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub form" }));
    await screen.findByText(/the report has not been sent yet/);
    const request = mock.invoke.mock.calls.find(([command]) => command === "open_problem_report")!;
    expect(new URL(request[1].url).searchParams.get("actual")).toBe("The workspace did not open.");
    fireEvent.click(screen.getByRole("button", { name: "Edit report" }));
    expect(screen.getByLabelText<HTMLTextAreaElement>("What happened?").value).toBe("The workspace did not open.");
  });

  it("allows reporting when shell diagnostics fail without echoing a private error", async () => {
    mock.invoke.mockRejectedValue(new Error("token=private-value C:\\Users\\private-user"));
    render(<ReportProblemModal onClose={vi.fn()} />);
    await screen.findByText(/Some technical details are unavailable/);
    const preview = await fillAndPreview();
    expect(preview.textContent).toContain("Backend status: unavailable");
    expect(preview.textContent).not.toContain("private");
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub form" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Report preview")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).not.toContain("private");
  });

  it("stops waiting after a stalled IPC call and ignores its late response", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    mock.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<ReportProblemModal onClose={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText(/Some technical details are unavailable/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Preview report" }).disabled).toBe(false);
    await act(async () => { resolve(safe); });
    expect(screen.getByText(/Backend status: unavailable/)).toBeTruthy();
  });

  it("preserves long reports and provides a manual fallback when copying fails", async () => {
    mock.writeText.mockRejectedValue(new Error("clipboard unavailable"));
    render(<ReportProblemModal onClose={vi.fn()} />);
    const actual = "Ошибка".repeat(300);
    const preview = await fillAndPreview(actual);
    expect(preview.textContent).toContain(actual);
    expect(screen.getByText(/too long for a prefilled link/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    expect((await screen.findByRole("alert")).textContent).toContain("copy it manually");
    fireEvent.click(screen.getByRole("button", { name: "Open GitHub form" }));
    await screen.findByText(/Paste the copied report/);
    const request = mock.invoke.mock.calls.find(([command]) => command === "open_problem_report")!;
    const url = new URL(request[1].url);
    expect(url.searchParams.get("actual")).toBeNull();
    expect(url.searchParams.get("version")).toBe(safe.app_version);
  });
});
