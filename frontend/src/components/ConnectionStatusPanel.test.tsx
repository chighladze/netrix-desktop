import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConnectionStatusPanel from "./ConnectionStatusPanel";
import { copyTextWithAutoClear } from "../utils/clipboard";
import { connectionFeedback, connectionTarget } from "../terminal/connectionPresentation";

vi.mock("../utils/clipboard", () => ({ copyTextWithAutoClear: vi.fn(async () => {}) }));
const host = { name: "DB", hostname: "db.example.test", port: 2222, username: "admin", connection_type: "ssh" as const };
const props = { host, status: "connecting" as const, progressStep: null, errorMessage: null, sessionUnavailable: false, vaultLocked: false, onReconnect: vi.fn(), onClose: vi.fn(async () => true), onUnlock: vi.fn(async () => ({ ok: true })) };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("connection status panel", () => {
  it("shows elapsed time without invented percentages or network stages", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ConnectionStatusPanel {...props} />);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.queryByText(/DNS|TCP|20%/)).toBeNull();
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByLabelText("3s elapsed").textContent).toBe("00:03");
    rerender(<ConnectionStatusPanel {...props} status="error" errorMessage="Timed out" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    rerender(<ConnectionStatusPanel {...props} progressStep="authenticating" />);
    expect(screen.getAllByText("Authenticating the session")).toHaveLength(1);
    expect(screen.getByLabelText("0s elapsed")).toBeDefined();
  });

  it("retains full errors and copies details only on request", async () => {
    const error = `SSH handshake failed: ${"long diagnostic message ".repeat(30)}last detail`;
    const { container } = render(<ConnectionStatusPanel {...props} status="error" errorMessage={error} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("pre")?.textContent).toBe(error);
    expect(copyTextWithAutoClear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Technical details"));
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await screen.findByText("Details copied");
    expect(copyTextWithAutoClear).toHaveBeenCalledWith(error);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(props.onReconnect).toHaveBeenCalledOnce();
  });

  it("keeps a failed cancellation actionable and waits for confirmed closure", async () => {
    const onClose = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<ConnectionStatusPanel {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection" }));
    expect((await screen.findByRole("alert")).textContent).toContain("still open");
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it("distinguishes an ended session from an ordinary retry", () => {
    render(<ConnectionStatusPanel {...props} status="error" sessionUnavailable errorMessage="Session no longer exists" />);
    expect(screen.getByRole("button", { name: "Start new session" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(props.onReconnect).not.toHaveBeenCalled();
  });

  it("unlocks once through the form and reconnects only after success", async () => {
    const onUnlock = vi.fn().mockResolvedValueOnce({ ok: false, error: "Invalid password" }).mockResolvedValueOnce({ ok: true });
    render(<ConnectionStatusPanel {...props} status="error" vaultLocked onUnlock={onUnlock} />);
    const input = screen.getByLabelText("Master password");
    fireEvent.change(input, { target: { value: "test-password" } });
    fireEvent.submit(input.closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid password");
    expect(props.onReconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock & connect" }));
    await waitFor(() => expect(props.onReconnect).toHaveBeenCalledOnce());
    expect((input as HTMLInputElement).value).toBe("");
    expect(onUnlock).toHaveBeenCalledTimes(2);
  });

  it("ignores a vault response after the target changes", async () => {
    let finish!: (result: { ok: boolean }) => void;
    const onUnlock = () => new Promise<{ ok: boolean }>((resolve) => { finish = resolve; });
    const { rerender } = render(<ConnectionStatusPanel {...props} status="error" vaultLocked onUnlock={onUnlock} />);
    fireEvent.change(screen.getByLabelText("Master password"), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock & connect" }));
    rerender(<ConnectionStatusPanel {...props} host={{ ...host, hostname: "other.test" }} status="error" vaultLocked onUnlock={onUnlock} />);
    await act(async () => finish({ ok: true }));
    expect(props.onReconnect).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Master password") as HTMLInputElement).value).toBe("");
  });

  it("uses protocol-specific destination and failure language", () => {
    const local = { ...host, connection_type: "local" as const, local_command: "pwsh.exe" };
    const serial = { ...host, connection_type: "serial" as const, serial_port: "COM4" };
    expect(connectionTarget({ ...host, hostname: "2001:db8::1" })).toBe("[2001:db8::1]:2222");
    expect(connectionTarget(local)).toBe("pwsh.exe");
    expect(connectionFeedback(local, "error", "Permission denied", false, false).title).toBe("Couldn’t start the shell");
    expect(connectionFeedback(serial, "error", "Permission denied", false, false).title).toBe("Couldn’t open the device");
    render(<ConnectionStatusPanel {...props} host={serial} />);
    expect(screen.getByText("COM4")).toBeDefined();
    expect(screen.queryByText("SSH")).toBeNull();
  });
});
