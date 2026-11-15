import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchJsonOrThrow } from "../api";
import { useAppStore, type SavedHostDto } from "../state/store";
import HostFormModal from "./HostFormModal";
import HostDashboard from "./HostDashboard";
import { loadAppSettings } from "../features/settings/settings";

vi.mock("../api", async (original) => ({
  ...(await original<object>()),
  getApiBase: async () => "http://127.0.0.1:8000",
  fetchJsonOrThrow: vi.fn(),
}));
const request = vi.mocked(fetchJsonOrThrow);
const host: SavedHostDto = {
  id: 1,
  revision: 2,
  name: "server",
  hostname: "example.test",
  username: "admin",
  port: 22,
  connection_type: "ssh",
  group: "Production",
  jump_host_id: 8,
  credential_id: 10,
};
beforeEach(() => {
  localStorage.clear();
  request.mockReset();
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      hosts: [host],
      isVaultUnlocked: true,
      vaultInitialized: true,
      vaultStatusLoaded: true,
      refreshStoredVaultPasswordState: async () => undefined,
    },
    true,
  );
});

describe("Hosts form integration", () => {
  it("keeps independent network ports while switching protocols and resets them on a fresh form", () => {
    const props = { apiBase: "http://127.0.0.1:8000", onClose: vi.fn(), onSave: vi.fn() };
    const view = render(<HostFormModal {...props} isOpen />);
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "2222" } });
    fireEvent.click(screen.getByRole("radio", { name: "Telnet" }));
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe(String(useAppStore.getState().settings.connection.defaultTelnetPort));
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "2323" } });
    fireEvent.click(screen.getByRole("radio", { name: "Serial" }));
    fireEvent.click(screen.getByRole("radio", { name: "SSH" }));
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("2222");
    fireEvent.click(screen.getByRole("radio", { name: "Telnet" }));
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("2323");
    view.rerender(<HostFormModal {...props} isOpen={false} />);
    view.rerender(<HostFormModal {...props} isOpen />);
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe(String(useAppStore.getState().settings.connection.defaultSSHPort));
  });

  it.each([
    ["SSH", "ssh"], ["Telnet", "telnet"], ["Serial", "serial"], ["Local shell", "local"],
  ].flatMap(([label, protocol]) => ["Save host", "Connect only"].map(action => ({ label, protocol, action }))))(
    "$action sends only the active $label configuration", async ({ label, protocol, action }) => {
      const quick = vi.fn(), saved = vi.fn();
      request.mockImplementation(async (_url, init) => ({ ...host, ...JSON.parse(String(init?.body)), id: 12, revision: 1, credential_id: null }));
      render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={saved} onQuickConnect={quick} />);
      fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "switch.example.test" } });
      fireEvent.change(screen.getByLabelText("Username"), { target: { value: "operator" } });
      fireEvent.change(screen.getByPlaceholderText("Enter password"), { target: { value: "previous-protocol-secret" } });
      fireEvent.click(screen.getByRole("radio", { name: label }));
      if (protocol === "ssh" || protocol === "telnet") {
        fireEvent.change(screen.getByPlaceholderText("Enter password"), { target: { value: "active-secret" } });
      } else {
        expect(screen.queryByLabelText("Hostname or IP address")).toBeNull();
        expect(screen.queryByLabelText("Username")).toBeNull();
        if (protocol === "serial") {
          fireEvent.change(screen.getByLabelText("Serial device"), { target: { value: "COM7" } });
          fireEvent.change(screen.getByLabelText("Baud rate"), { target: { value: "115200" } });
        } else {
          fireEvent.change(screen.getByLabelText(/^Command/), { target: { value: "pwsh.exe" } });
          fireEvent.change(screen.getByLabelText(/^Arguments/), { target: { value: "-NoLogo\n  spaced value  \n" } });
          fireEvent.change(screen.getByLabelText(/^Working directory/), { target: { value: "C:/My workspace" } });
        }
      }
      fireEvent.click(screen.getByRole("button", { name: action }));
      if (action === "Save host") await waitFor(() => expect(saved).toHaveBeenCalledOnce());
      else expect(quick).toHaveBeenCalledOnce();
      const payload = action === "Save host" ? JSON.parse(String(request.mock.calls[0][1]?.body)) : quick.mock.calls[0][0];
      expect(payload.connection_type).toBe(protocol);
      if (protocol === "ssh" || protocol === "telnet") {
        expect(payload).toMatchObject({ hostname: "switch.example.test", username: "operator", password: "active-secret" });
        expect(payload.serial_port ?? null).toBeNull();
        expect(payload.local_command ?? null).toBeNull();
      } else {
        expect(payload).toMatchObject({ hostname: "localhost", port: 0, username: protocol === "serial" ? "" : "local" });
        expect(payload.password).toBeUndefined();
        if (protocol === "serial") expect(payload).toMatchObject({ name: "COM7", serial_port: "COM7", serial_speed: 115200 });
        else expect(payload).toMatchObject({ local_command: "pwsh.exe", local_args: ["-NoLogo", "  spaced value  ", ""], local_cwd: "C:/My workspace" });
      }
      expect(payload.private_key).toBeUndefined();
      expect(payload.passphrase).toBeUndefined();
      if (action === "Connect only") expect(request).not.toHaveBeenCalled();
      else expect(quick).not.toHaveBeenCalled();
    },
  );

  it("does not silently discard a passphrase without a private key", () => {
    const quick = vi.fn();
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={quick} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.click(screen.getByRole("radio", { name: "Private key" }));
    fireEvent.change(screen.getByLabelText(/Key passphrase/), { target: { value: "key phrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(screen.getByRole("alert").textContent).toContain("private key for this passphrase");
    fireEvent.click(screen.getByRole("button", { name: "Save host" }));
    expect(quick).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Private key" }), { target: { value: "key-contents" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(quick.mock.calls[0][0]).toMatchObject({ private_key: "key-contents", passphrase: "key phrase" });
  });

  it.each(["keep", "unlink", "replace"])("handles saved authentication on protocol changes: %s", async (mode) => {
    const initial = { ...host, port: 2222, has_password: true, jump_host_id: null };
    const saved = vi.fn();
    request.mockImplementation(async (_url, init) => ({ ...initial, ...JSON.parse(String(init?.body)), revision: 3 }));
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" hostToEdit={initial} onClose={vi.fn()} onSave={saved} />);
    fireEvent.click(screen.getByRole("radio", { name: "Telnet" }));
    expect(screen.getByText(/credential link will be removed/).getAttribute("role")).toBe("status");
    if (mode === "keep") {
      fireEvent.click(screen.getByRole("radio", { name: "SSH" }));
      expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("2222");
      expect(screen.queryByText(/credential link will be removed/)).toBeNull();
    } else if (mode === "replace") fireEvent.change(screen.getByPlaceholderText("Enter password"), { target: { value: "telnet-only" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const payload = JSON.parse(String(request.mock.calls[0][1]?.body));
    expect(payload.clear_credentials).toBe(mode === "unlink" ? true : undefined);
    expect(payload.password).toBe(mode === "replace" ? "telnet-only" : undefined);
    if (mode === "keep") expect(payload.connection_type).toBeUndefined();
    else expect(payload.connection_type).toBe("telnet");
  });

  it("discards an in-flight key file after switching protocol", async () => {
    let finish!: (value: string) => void;
    const file = new File(["pending"], "device.key");
    Object.defineProperty(file, "text", { value: () => new Promise<string>(resolve => { finish = resolve; }) });
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Private key" }));
    fireEvent.change(screen.getByLabelText("Private key file"), { target: { files: [file] } });
    expect((screen.getByRole("button", { name: "Save host" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Telnet" }));
    fireEvent.click(screen.getByRole("radio", { name: "SSH" }));
    await act(async () => finish("must-not-return-to-form"));
    expect((screen.getByRole("textbox", { name: "Private key" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("Loaded: device.key")).toBeNull();
    expect((screen.getByRole("button", { name: "Save host" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("generates a bounded password and resets its visibility when switching protocols", () => {
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} />);
    fireEvent.click(screen.getByText("Password generator"));
    fireEvent.change(screen.getByLabelText("Length"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    const password = screen.getByPlaceholderText("Enter password") as HTMLInputElement;
    expect(password.value).toHaveLength(64);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    fireEvent.click(screen.getByRole("radio", { name: "Telnet" }));
    expect((screen.getByPlaceholderText("Enter password") as HTMLInputElement).value).toBe("");
    expect((screen.getByPlaceholderText("Enter password") as HTMLInputElement).type).toBe("password");
  });

  it("remembers successful appearance saves for new hosts without copying identity or credentials", async () => {
    request.mockImplementation(async (_url, init) => ({ ...host, ...JSON.parse(String(init?.body)), revision: 3 }));
    const onSave = vi.fn();
    const props = { apiBase: "http://127.0.0.1:8000", onSave, onClose: vi.fn() };
    const view = render(<HostFormModal {...props} isOpen />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "dev.example.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "engineer" } });
    fireEvent.change(screen.getByLabelText("Password", { exact: true, selector: 'input[type="password"]' }), { target: { value: "not-a-preference" } });
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Set text to Mint" }));
    fireEvent.click(screen.getByText("Text & spacing", { exact: true }));
    fireEvent.change(screen.getByLabelText("Font family"), { target: { value: "Consolas" } });
    fireEvent.change(screen.getByLabelText("Text weight", { exact: true }), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText(/Line height/), { target: { value: "1.4" } });
    fireEvent.click(screen.getByText("Prompt & ANSI colors", { exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Green/ }), { target: { value: "#abc" } });
    expect(screen.getByLabelText("Terminal appearance preview").textContent).toContain("engineer@dev.example.test");
    fireEvent.click(screen.getByRole("button", { name: "Save host" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const remembered = loadAppSettings().terminal.newHostAppearance;
    expect(remembered).toMatchObject({ terminal_foreground: "#8ce5bb", terminal_appearance: { font_family: "Consolas", font_weight: 500, line_height: 1.4, colors: { green: "#aabbcc" } } });
    expect(JSON.stringify(remembered)).not.toMatch(/engineer|dev\.example|not-a-preference/);
    expect(useAppStore.getState().settings.terminal.fontFamily).toBe("JetBrains Mono");
    view.rerender(<HostFormModal {...props} isOpen={false} />);
    view.rerender(<HostFormModal {...props} isOpen />);
    expect((screen.getByLabelText("Hostname or IP address") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    expect((screen.getByRole("textbox", { name: /^Text custom/ }) as HTMLInputElement).value).toBe("#8ce5bb");
    fireEvent.click(screen.getByText("Text & spacing", { exact: true }));
    expect((screen.getByLabelText("Font family") as HTMLInputElement).value).toBe("Consolas");
  });

  it("saves appearance alone and keeps it after a failed host save or cancelled edit", async () => {
    const onClose = vi.fn();
    const view = render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={onClose} onSave={vi.fn()} />);
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Set background to Paper" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as default" }));
    expect(screen.getByText("Saved for new connections.")).toBeDefined();
    const remembered = loadAppSettings().terminal.newHostAppearance;
    fireEvent.click(screen.getByRole("button", { name: "Set background to Black" }));
    expect(screen.queryByText("Saved for new connections.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "failed.test" } });
    request.mockRejectedValue(new Error("Save failed"));
    fireEvent.click(screen.getByRole("button", { name: "Save host" }));
    await screen.findByText("Save failed");
    expect(loadAppSettings().terminal.newHostAppearance).toEqual(remembered);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<HostFormModal isOpen hostToEdit={host} apiBase="http://127.0.0.1:8000" onClose={onClose} onSave={vi.fn()} />);
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    expect((screen.getByRole("textbox", { name: /^Background/ }) as HTMLInputElement).value).toBe("#0b1118");
  });

  it("blocks invalid formatting and passes real renderer preferences through Quick Connect", () => {
    const onQuickConnect = vi.fn();
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    fireEvent.click(screen.getByText("Text & spacing", { exact: true }));
    fireEvent.change(screen.getByLabelText(/Line height/), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(onQuickConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("1 to 2");
    fireEvent.change(screen.getByLabelText(/Line height/), { target: { value: "1.3" } });
    fireEvent.click(screen.getByText("Cursor & selection", { exact: true }));
    fireEvent.change(screen.getByLabelText("Cursor shape"), { target: { value: "underline" } });
    fireEvent.click(screen.getByLabelText("Blink cursor"));
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(onQuickConnect).toHaveBeenCalledWith(expect.objectContaining({ terminal_appearance: { line_height: 1.3, cursor_style: "underline", cursor_blink: false } }));
  });

  it("edits, previews and restores saved terminal colors independently", async () => {
    const coloredHost = { ...host, jump_host_id: null, terminal_background: "#112233", terminal_foreground: "#ddeeff" };
    const onSave = vi.fn();
    request.mockResolvedValue({ ...coloredHost, revision: 3, terminal_background: "#f4f1ea", terminal_foreground: null });
    render(<HostFormModal isOpen hostToEdit={coloredHost} apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    expect((screen.getByRole("textbox", { name: /^Background/ }) as HTMLInputElement).value).toBe("#112233");
    fireEvent.click(screen.getByRole("button", { name: "Set background to Paper" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset text to theme" }));
    expect(screen.getByLabelText("Terminal appearance preview").style.backgroundColor).toBe("rgb(244, 241, 234)");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      revision: 2, terminal_background: "#f4f1ea", terminal_foreground: null,
    });
    expect(useAppStore.getState().hosts[0].terminal_background).toBe("#f4f1ea");
  });

  it("validates custom colors for Quick Connect and sends their normalized values", () => {
    const onQuickConnect = vi.fn();
    render(<HostFormModal isOpen intent="quick" apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Background/ }), { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(onQuickConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("hex color");
    fireEvent.change(screen.getByRole("textbox", { name: /^Background/ }), { target: { value: "#123" } });
    fireEvent.change(screen.getByLabelText("Choose text color"), { target: { value: "#aabbcc" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(onQuickConnect).toHaveBeenCalledWith(expect.objectContaining({ terminal_background: "#112233", terminal_foreground: "#aabbcc" }));
    expect(request).not.toHaveBeenCalled();
  });

  it("clears custom colors when restoring default appearance", async () => {
    request.mockResolvedValue({ ...host, revision: 3, terminal_background: null, terminal_foreground: null });
    const onSave = vi.fn();
    render(<HostFormModal isOpen hostToEdit={{ ...host, terminal_background: "#112233", terminal_foreground: "#ddeeff" }} apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={onSave} />);
    fireEvent.click(screen.getByText("Terminal appearance", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ revision: 2, terminal_background: null, terminal_foreground: null });
  });

  it("submits Quick Connect without saving a profile", () => {
    const onQuickConnect = vi.fn(), onSave = vi.fn(), onClose = vi.fn();
    render(<HostFormModal isOpen intent="quick" apiBase="http://127.0.0.1:8000" onClose={onClose} onSave={onSave} onQuickConnect={onQuickConnect} />);
    const address = screen.getByPlaceholderText("e.g. 10.0.0.1 or srv.local");
    fireEvent.change(address, { target: { value: "quick.test" } });
    fireEvent.submit(address.closest("form")!);
    expect(onQuickConnect).toHaveBeenCalledWith(expect.objectContaining({ hostname: "quick.test" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().hosts).toEqual([host]);
  });

  it("still permits an explicit Save host from Quick Connect", async () => {
    const onQuickConnect = vi.fn(), onSave = vi.fn();
    request.mockResolvedValue({ ...host, id: 9, name: "saved.test", hostname: "saved.test" });
    render(<HostFormModal isOpen intent="quick" apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={onSave} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByPlaceholderText("e.g. 10.0.0.1 or srv.local"), { target: { value: "saved.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Save host" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][1]?.method).toBe("POST");
    expect(onQuickConnect).not.toHaveBeenCalled();
  });

  it.each(["0", "65536", "22.5", ""])("blocks invalid port %s for both connection and saving", async (port) => {
    const onQuickConnect = vi.fn();
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: port } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(screen.getByRole("alert").textContent).toContain("1 to 65535");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Port")));
    fireEvent.click(screen.getByRole("button", { name: "Save host" }));
    expect(onQuickConnect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["Password", "Private key"])("connects using only the selected %s credential", (method) => {
    const onQuickConnect = vi.fn();
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.change(screen.getByPlaceholderText("Enter password"), { target: { value: "password-only" } });
    fireEvent.click(screen.getByRole("radio", { name: "Private key" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Private key" }), { target: { value: "key-only" } });
    fireEvent.change(screen.getByLabelText(/Key passphrase/), { target: { value: "key-phrase" } });
    fireEvent.click(screen.getByRole("radio", { name: method }));
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    const payload = onQuickConnect.mock.calls[0][0];
    if (method === "Password") {
      expect(payload.password).toBe("password-only");
      expect(payload.private_key).toBeUndefined();
      expect(payload.passphrase).toBeUndefined();
    } else {
      expect(payload.password).toBeUndefined();
      expect(payload.private_key).toBe("key-only");
      expect(payload.passphrase).toBe("key-phrase");
    }
  });

  it.each(["Local shell", "Serial"])("drops network credentials when switching to %s", (protocol) => {
    const onQuickConnect = vi.fn();
    render(<HostFormModal isOpen intent="quick" apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByPlaceholderText("Enter password"), { target: { value: "remote-secret" } });
    fireEvent.click(screen.getByRole("radio", { name: protocol }));
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(onQuickConnect).toHaveBeenCalledOnce();
    expect(onQuickConnect.mock.calls[0][0]).toMatchObject({ name: protocol === "Serial" ? "COM1" : "Local Shell", hostname: "localhost", port: 0 });
    expect(onQuickConnect.mock.calls[0][0].password).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it("loads a key file locally and submits its exact contents", async () => {
    const onQuickConnect = vi.fn();
    const contents = "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----\n";
    const file = new File([contents], "id_ed25519");
    Object.defineProperty(file, "text", { value: async () => contents });
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.click(screen.getByRole("radio", { name: "Private key" }));
    fireEvent.change(screen.getByLabelText("Private key file"), { target: { files: [file] } });
    await screen.findByText("Loaded: id_ed25519");
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(onQuickConnect.mock.calls[0][0].private_key).toBe(contents);
  });

  it("ignores a key file read after switching to a different host", async () => {
    let finishRead!: (value: string) => void;
    const file = new File(["key"], "id_ed25519");
    Object.defineProperty(file, "text", { value: () => new Promise<string>((resolve) => { finishRead = resolve; }) });
    const props = { isOpen: true, apiBase: "http://127.0.0.1:8000", onClose: vi.fn(), onSave: vi.fn() };
    const { rerender } = render(<HostFormModal {...props} hostToEdit={host} />);
    fireEvent.click(screen.getByRole("radio", { name: "Private key" }));
    fireEvent.change(screen.getByLabelText("Private key file"), { target: { files: [file] } });
    rerender(<HostFormModal {...props} hostToEdit={{ ...host, id: 2 }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Private key" }));
    await act(async () => finishRead("stale-key"));
    expect((screen.getByRole("textbox", { name: "Private key" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("Loaded: id_ed25519")).toBeNull();
  });

  it("keeps an oversized key-file error until the key input is corrected", async () => {
    const onQuickConnect = vi.fn();
    const file = new File([new Uint8Array(1024 * 1024 + 1)], "too-large.key");
    const read = vi.fn();
    Object.defineProperty(file, "text", { value: read });
    render(<HostFormModal isOpen apiBase="http://127.0.0.1:8000" onClose={vi.fn()} onSave={vi.fn()} onQuickConnect={onQuickConnect} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.click(screen.getByRole("radio", { name: "Private key" }));
    fireEvent.change(screen.getByLabelText("Private key file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(screen.getByRole("alert").textContent).toContain("1 MB");
    expect(read).not.toHaveBeenCalled();
    expect(onQuickConnect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Private key" }), { target: { value: "replacement-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect only" }));
    expect(onQuickConnect.mock.calls[0][0].private_key).toBe("replacement-key");
  });

  it("normalizes a new nested group and supports an explicitly ungrouped profile", async () => {
    const onSave = vi.fn();
    request.mockResolvedValue({ ...host, id: 9, group: "Team/Europe" });
    const props = { isOpen: true, apiBase: "http://127.0.0.1:8000", onClose: vi.fn(), onSave };
    const { rerender } = render(<HostFormModal {...props} />);
    fireEvent.change(screen.getByLabelText("Hostname or IP address"), { target: { value: "host.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
    fireEvent.change(screen.getByLabelText("New folder"), { target: { value: " / Team // Europe / " } });
    fireEvent.click(screen.getByRole("button", { name: "Save host" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).group).toBe("Team/Europe");
    rerender(<HostFormModal {...props} hostToEdit={host} />);
    fireEvent.change(screen.getByLabelText("Folder"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(request.mock.calls[1][1]?.body)).group).toBe("");
  });

  it("preserves spaces and empty arguments when renaming a local profile", async () => {
    const localHost: SavedHostDto = {
      ...host,
      hostname: "localhost",
      username: "local",
      port: 0,
      connection_type: "local",
      local_command: "/tmp/ shell ",
      local_args: ["  value  ", "", "--flag"],
      local_cwd: "/tmp/ folder ",
    };
    useAppStore.setState({ hosts: [localHost] });
    const onSave = vi.fn();
    request.mockResolvedValue({ ...localHost, revision: 3, name: "renamed local" });
    render(
      <HostFormModal
        isOpen
        hostToEdit={localHost}
        apiBase="http://127.0.0.1:8000"
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Display name/), {
      target: { value: "renamed local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      revision: 2,
      name: "renamed local",
    });
    expect(useAppStore.getState().hosts[0].local_args).toEqual(localHost.local_args);
  });

  it("saves a rename with its original revision and updates the list without refetching", async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    request.mockResolvedValue({ ...host, revision: 3, name: "renamed" });
    render(
      <HostFormModal
        isOpen
        hostToEdit={host}
        apiBase="http://127.0.0.1:8000"
        onClose={onClose}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Display name/), {
      target: { value: "renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][1]?.method).toBe("PATCH");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      revision: 2,
      name: "renamed",
    });
    expect(useAppStore.getState().hosts[0]).toMatchObject({
      name: "renamed",
      jump_host_id: 8,
      credential_id: 10,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps typed input visible after a revision conflict", async () => {
    request.mockRejectedValueOnce(new ApiError("Reopen the host editor", 409));
    request.mockResolvedValueOnce([{ ...host, revision: 3 }]);
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(
      <HostFormModal
        isOpen
        hostToEdit={host}
        apiBase="http://127.0.0.1:8000"
        onClose={onClose}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Display name/), {
      target: { value: "my edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Reopen the host editor");
    expect((screen.getByLabelText(/^Display name/) as HTMLInputElement).value).toBe(
      "my edit",
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not submit a vault-gated operation after the editor switches to another host", async () => {
    let finishUnlock!: (value: { ok: boolean }) => void;
    const unlockVault = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finishUnlock = resolve;
        }),
    );
    useAppStore.setState({ isVaultUnlocked: false, unlockVault });
    const props = {
      isOpen: true,
      apiBase: "http://127.0.0.1:8000",
      onClose: vi.fn(),
      onSave: vi.fn(),
    };
    const { rerender } = render(<HostFormModal {...props} hostToEdit={host} />);
    fireEvent.change(screen.getByPlaceholderText("********"), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.change(await screen.findByPlaceholderText("Master password"), {
      target: { value: "master-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Unlock$/ }));
    expect(unlockVault).toHaveBeenCalledOnce();
    rerender(<HostFormModal {...props} hostToEdit={{ ...host, id: 2, name: "other" }} />);
    await act(async () => finishUnlock({ ok: true }));
    expect(request).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/^Display name/) as HTMLInputElement).value).toBe(
      "other",
    );
  });
});

it("renders legacy groups and handles searching a nullable username", async () => {
  useAppStore.setState({
    hosts: [{ ...host, username: null, group: " / Prod // DB / " } as unknown as SavedHostDto],
    fetchHosts: async () => useAppStore.getState().hosts,
  });
  render(<HostDashboard onConnect={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Connect to server" })).toBeDefined();
  fireEvent.change(screen.getByPlaceholderText("Search hosts... (Ctrl+K)"), {
    target: { value: "no matches" },
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Connect to server" })).toBeNull(),
  );
  expect(screen.getByText("0 of 1")).toBeDefined();
});

it("shows a list error and offers a retry without removing saved hosts", async () => {
  const fetchHosts = vi.fn(async () => useAppStore.getState().hosts);
  useAppStore.setState({ hostsError: "Backend is unavailable", fetchHosts });
  render(<HostDashboard onConnect={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("Backend is unavailable");
  await waitFor(() => expect(fetchHosts).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Retry loading hosts" }));
  await waitFor(() => expect(fetchHosts).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Connect to server" })).toBeDefined();
});
