import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/store";
import { createDefaultSettings } from "../settings/settings";
import AppSecurityBoundary from "./AppSecurityBoundary";
import { SECURITY_CHANGED_EVENT } from "./api";

const mock = vi.hoisted(() => ({ fetch: vi.fn(), invoke: vi.fn(), readiness: vi.fn(), writeText: vi.fn(), label: "main", mount: vi.fn(), unmount: vi.fn() }));
vi.mock("../../api", async (original) => ({ ...await original<typeof import("../../api")>(),
  getApiBase: async () => "http://localhost:1234", fetchJsonOrThrow: mock.fetch,
  waitForBackendReady: mock.readiness,
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: mock.writeText }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}), emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: mock.label, show: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("../../components/TitleBar", () => ({ default: () => null }));

function Session() {
  React.useEffect(() => { mock.mount(); return mock.unmount; }, []);
  const [draft, setDraft] = React.useState("");
  return <input aria-label="Session input" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}
let snapshot: import("./api").SecuritySnapshot = { locked: false, revision: 1, vault_unlocked: true, vault_initialized: true };
const refresh = async () => { await act(async () => { window.dispatchEvent(new Event(SECURITY_CHANGED_EVENT)); }); };

beforeEach(() => {
  vi.clearAllMocks(); mock.label = "main";
  mock.readiness.mockResolvedValue({ status: "ready" });
  mock.invoke.mockReset();
  mock.invoke.mockResolvedValue(undefined);
  mock.writeText.mockResolvedValue(undefined);
  snapshot = { locked: false, revision: 1, vault_unlocked: true, vault_initialized: true };
  useAppStore.setState({ settings: createDefaultSettings(), appSecurity: { locked: null, revision: -1, error: null } });
  mock.fetch.mockImplementation(async (url: string) => url.endsWith("/status") ? snapshot : { ok: true });
});

describe("shared application lock", () => {
  it("shows recovery and copyable diagnostics instead of waiting after a failed startup", async () => {
    mock.readiness.mockResolvedValue({ status: "failed", message: "A runtime library is missing.",
      diagnostic: { code: "missing_runtime_library", message: "A runtime library is missing.",
        recovery: "Install or repair Microsoft Visual C++ Redistributable x64, then reopen Netrix.",
        details: "Backend exit code: -1073741515 (0xC0000135)" },
      log_path: "C:\\test-profile\\tauri_main.log" });
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    await screen.findByRole("heading", { name: "Netrix service unavailable" });
    expect(screen.getByRole("alert").textContent).toContain("runtime library is missing");
    expect(screen.getByText(/Install or repair Microsoft Visual/)).toBeTruthy();
    expect(screen.queryByText(/Waiting for the local backend/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry connection" })).toBeNull();
    expect(screen.queryByLabelText("Master password")).toBeNull();
    expect(mock.mount).not.toHaveBeenCalled();
    expect(mock.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostic details" }));
    await screen.findByText("Diagnostic details copied.");
    expect(mock.writeText).toHaveBeenCalledWith(expect.stringContaining("0xC0000135"));
    expect(mock.writeText).toHaveBeenCalledWith(expect.stringContaining("C:\\test-profile\\tauri_main.log"));
    fireEvent.click(screen.getByRole("button", { name: "Close Netrix" }));
    expect(mock.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Exit Netrix" }));
    await waitFor(() => expect(mock.invoke).toHaveBeenCalledWith("quit_app"));
  });

  it("keeps an unknown startup error honest and supports manual copying if the clipboard fails", async () => {
    mock.readiness.mockResolvedValue({ status: "failed", message: "The service exited with code 1; the cause is unknown." });
    mock.writeText.mockRejectedValue(new Error("clipboard unavailable"));
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    await screen.findByRole("heading", { name: "Netrix service unavailable" });
    expect(screen.getByRole("alert").textContent).toContain("cause is unknown");
    expect(screen.queryByText(/Visual C\+\+/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostic details" }));
    await screen.findByText(/Could not copy/);
    expect(screen.getByText(/Local log location is unavailable/)).toBeTruthy();
  });

  it("uses the shell diagnosis after a running backend exits and keeps sessions hidden", async () => {
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    await screen.findByRole("textbox", { name: "Session input" });
    mock.fetch.mockRejectedValue(new Error("offline"));
    mock.invoke.mockResolvedValue({ status: "failed", message: "The local service crashed.",
      diagnostic: { code: "backend_crashed", message: "The local service crashed.", recovery: "Close and reopen Netrix.", details: "Backend exit code: 0xC0000005" } });
    await refresh();
    await screen.findByRole("heading", { name: "Netrix service unavailable" });
    expect(screen.queryByRole("textbox", { name: "Session input" })).toBeNull();
    expect(mock.unmount).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("service crashed");
  });

  it("does not let a late unlock response reopen content after a confirmed backend failure", async () => {
    snapshot = { ...snapshot, locked: true, database_mode: "encrypted" };
    let resolveUnlock!: (value: typeof snapshot) => void;
    mock.fetch.mockImplementation(async (url: string) => url.endsWith("/unlock")
      ? new Promise((resolve) => { resolveUnlock = resolve; }) : snapshot);
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText<HTMLInputElement>("Master password");
    fireEvent.change(password, { target: { value: "private-test-password" } });
    fireEvent.submit(password.form!);
    await waitFor(() => expect(resolveUnlock).toBeTypeOf("function"));
    mock.fetch.mockRejectedValue(new Error("offline"));
    mock.invoke.mockResolvedValue({ status: "failed", message: "The backend stopped." });
    await refresh();
    await screen.findByRole("heading", { name: "Netrix service unavailable" });
    await act(async () => { resolveUnlock({ ...snapshot, locked: false, revision: 2 }); });
    expect(screen.getByRole("heading", { name: "Netrix service unavailable" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Session input" })).toBeNull();
    expect(mock.mount).not.toHaveBeenCalled();
    expect(useAppStore.getState().appSecurity.error).toBe("The backend stopped.");
  });

  it("reveals a password on request, conceals it on window blur, and resets on relock", async () => {
    snapshot = { ...snapshot, locked: true, revision: 2, database_mode: "encrypted" };
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText<HTMLInputElement>("Master password");
    fireEvent.change(password, { target: { value: "private-test-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Show master password" }));
    expect(password.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide master password" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.blur(window);
    expect(password.type).toBe("password");
    expect(password.value).toBe("private-test-password");
    fireEvent.click(screen.getByRole("button", { name: "Show master password" }));
    snapshot = { ...snapshot, locked: false, revision: 3, database_mode: "open" };
    await refresh();
    await screen.findByLabelText("Session input");
    snapshot = { ...snapshot, locked: true, revision: 4 };
    await refresh();
    const nextPassword = await screen.findByLabelText<HTMLInputElement>("Master password");
    expect(nextPassword.type).toBe("password");
    expect(nextPassword.value).toBe("");
    expect(JSON.stringify(useAppStore.getState())).not.toContain("private-test-password");
  });

  it("shows Caps Lock from keyboard state and clears it when the field loses focus", async () => {
    snapshot = { ...snapshot, locked: true };
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText("Master password");
    fireEvent.keyDown(password, { key: "A", modifierCapsLock: true });
    expect(screen.getByRole("status").textContent).toContain("Caps Lock is on");
    fireEvent.keyUp(password, { key: "CapsLock", modifierCapsLock: false });
    expect(screen.queryByText("Caps Lock is on")).toBeNull();
    fireEvent.keyDown(password, { key: "A", modifierCapsLock: true });
    fireEvent.blur(password);
    expect(screen.queryByText("Caps Lock is on")).toBeNull();
  });

  it("clears stale validation when edited and counts Unicode characters for new passwords", async () => {
    snapshot = { ...snapshot, locked: true, database_mode: "setup" };
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText<HTMLInputElement>("Master password");
    const confirmation = screen.getByLabelText("Confirm master password");
    for (const field of [password, confirmation]) fireEvent.change(field, { target: { value: "🔐".repeat(5) } });
    fireEvent.submit(password.form!);
    await screen.findByText("Use at least 10 characters");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(mock.fetch.mock.calls.some(([url]) => url.endsWith("/unlock"))).toBe(false);
    fireEvent.change(password, { target: { value: "🔐".repeat(10) } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(password.getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByText("10+ characters").getAttribute("data-complete")).toBe("true");
    fireEvent.change(confirmation, { target: { value: "🔐".repeat(10) } });
    expect(screen.getByText("Passwords match").getAttribute("data-complete")).toBe("true");
  });

  it("submits exact existing passwords once, clears revealed secrets and restores focus after failure", async () => {
    snapshot = { ...snapshot, locked: true, database_mode: "encrypted" };
    let rejectUnlock!: (reason: Error) => void;
    mock.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/unlock")) return new Promise((_, reject) => { rejectUnlock = reject; });
      return snapshot;
    });
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText<HTMLInputElement>("Master password");
    fireEvent.change(password, { target: { value: " a " } });
    fireEvent.click(screen.getByRole("button", { name: "Show master password" }));
    act(() => {
      password.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      password.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(mock.fetch.mock.calls.filter(([url]) => url.endsWith("/unlock"))).toHaveLength(1));
    const request = mock.fetch.mock.calls.find(([url]) => url.endsWith("/unlock"))!;
    expect(JSON.parse(request[1].body)).toEqual({ master_password: " a " });
    expect(password.value).toBe("");
    expect(password.type).toBe("password");
    expect(password.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Unlocking…" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Show master password" }).disabled).toBe(true);
    await act(async () => { rejectUnlock(new Error("Invalid master password")); });
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(password);
    fireEvent.change(password, { target: { value: "next-attempt" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries backend verification before allowing an unlock after a connection error", async () => {
    snapshot = { ...snapshot, locked: true };
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText<HTMLInputElement>("Master password");
    mock.fetch.mockRejectedValue(new Error("offline"));
    await refresh();
    fireEvent.change(password, { target: { value: "test-password" } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Unlock Netrix" }).disabled).toBe(true);
    fireEvent.submit(password.form!);
    expect(mock.fetch.mock.calls.some(([url]) => url.endsWith("/unlock"))).toBe(false);
    mock.fetch.mockResolvedValue(snapshot);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(screen.queryByText(/Cannot verify the lock/)).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Unlock Netrix" }).disabled).toBe(false);
  });

  it("requires a confirmed master password before creating encrypted storage", async () => {
    snapshot = { locked: true, revision: 0, vault_unlocked: false, vault_initialized: false, database_mode: "setup" };
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText("Master password");
    const confirmation = screen.getByLabelText("Confirm master password");
    fireEvent.change(password, { target: { value: "valid-test-password" } });
    fireEvent.change(confirmation, { target: { value: "different-password" } });
    fireEvent.submit(password.closest("form")!);
    await screen.findByText("Passwords do not match");
    expect(mock.fetch.mock.calls.some(([url]) => url.endsWith("/unlock"))).toBe(false);
    mock.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/unlock")) return { ...snapshot, locked: false, revision: 1, vault_unlocked: true, vault_initialized: true, database_mode: "open", database_encrypted: true };
      return snapshot;
    });
    fireEvent.change(confirmation, { target: { value: "valid-test-password" } });
    fireEvent.submit(password.closest("form")!);
    await screen.findByRole("textbox", { name: "Session input" });
    expect(useAppStore.getState().appSecurity.databaseEncrypted).toBe(true);
    expect(JSON.stringify(useAppStore.getState())).not.toContain("valid-test-password");
  });

  it("explains migration and keeps the workspace hidden while another window encrypts it", async () => {
    snapshot = { locked: true, revision: 0, vault_unlocked: false, vault_initialized: true, database_mode: "upgrade", database_busy: true };
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    await screen.findByRole("heading", { name: "Encrypt your workspace" });
    expect(screen.getByText(/encrypted recovery copy/)).toBeTruthy();
    expect((screen.getByLabelText("Master password") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Encrypting and verifying…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mock.mount).not.toHaveBeenCalled();
  });

  it.each(["main", "terminal-test", "terminal-workspace-test", "map-test"])("protects %s and preserves the mounted session", async (label) => {
    mock.label = label;
    const view = render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const terminal = await screen.findByRole("textbox", { name: "Session input" });
    fireEvent.change(terminal, { target: { value: "unfinished command" } });
    snapshot = { ...snapshot, locked: true, revision: 2, vault_unlocked: false };
    await refresh();
    await screen.findByRole("heading", { name: "Netrix is locked" });
    expect(screen.queryByRole("textbox", { name: "Session input" })).toBeNull();
    expect(view.container.contains(terminal)).toBe(true);
    expect((view.container.querySelector("[data-netrix-content]") as HTMLElement).inert).toBe(true);
    expect(mock.unmount).not.toHaveBeenCalled();
    expect(screen.queryByText("Use saved password")).toBeNull();
    // Another window authenticates; this window learns the authoritative state.
    snapshot = { ...snapshot, locked: false, revision: 3, vault_unlocked: true };
    await refresh();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Session input" })).toBe(terminal);
    expect((terminal as HTMLInputElement).value).toBe("unfinished command");
    expect(mock.mount).toHaveBeenCalledOnce();
    expect(mock.invoke).not.toHaveBeenCalledWith("read_vault_password");
    if (label !== "main") expect(mock.fetch.mock.calls.some(([url]) => url.endsWith("/policy"))).toBe(false);
  });

  it("does not mount protected content before the first lock check and rejects bad passwords", async () => {
    snapshot = { ...snapshot, locked: true, revision: 2, vault_unlocked: false };
    mock.fetch.mockImplementation(async (url: string) => {
      if (url.endsWith("/unlock")) throw new Error("Invalid master password");
      return snapshot;
    });
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    const password = await screen.findByLabelText("Master password");
    expect(mock.mount).not.toHaveBeenCalled();
    fireEvent.change(password, { target: { value: "wrong-test-password" } });
    fireEvent.submit(password.closest("form")!);
    await screen.findByText("Invalid master password");
    expect(document.activeElement).toBe(password);
    expect((password as HTMLInputElement).value).toBe("");
    expect(mock.mount).not.toHaveBeenCalled();
    expect(useAppStore.getState().appSecurity.locked).toBe(true);
    expect(JSON.stringify(useAppStore.getState())).not.toContain("wrong-test-password");
    expect(mock.invoke).not.toHaveBeenCalled();
  });

  it("hides existing content if the backend cannot confirm the lock and recovers only after verification", async () => {
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    await screen.findByRole("textbox", { name: "Session input" });
    mock.fetch.mockRejectedValue(new Error("offline"));
    await refresh();
    await screen.findByText(/Cannot verify the lock/);
    expect(screen.queryByRole("textbox", { name: "Session input" })).toBeNull();
    mock.fetch.mockResolvedValue(snapshot);
    await refresh();
    await screen.findByRole("textbox", { name: "Session input" });
  });

  it("never treats a forged event payload or an older status as an unlock", async () => {
    snapshot = { ...snapshot, locked: true, revision: 7, vault_unlocked: false };
    render(<AppSecurityBoundary><Session /></AppSecurityBoundary>);
    await screen.findByLabelText("Master password");
    snapshot = { ...snapshot, locked: false, revision: 6 };
    await act(async () => window.dispatchEvent(new CustomEvent(SECURITY_CHANGED_EVENT, { detail: { locked: false } })));
    expect(useAppStore.getState().appSecurity.locked).toBe(true);
    expect(mock.mount).not.toHaveBeenCalled();
  });
});
