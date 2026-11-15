import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/store";
import CredentialsPanel from "./CredentialsPanel";
import BackupPanel from "./BackupPanel";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  connectionRequest: mocks.request,
}));
describe("connection management workflows", () => {
  beforeEach(() => {
    mocks.request.mockReset();
    mocks.request.mockResolvedValue([]);
    useAppStore.setState({ isVaultUnlocked: false, hosts: [] });
  });
  it("permits metadata browsing but disables credential mutations while locked", async () => {
    render(<CredentialsPanel />);
    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith("/credentials"));
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Assign to host" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("requires restore confirmation and surfaces a rejected archive without proceeding", async () => {
    useAppStore.setState({ isVaultUnlocked: true });
    mocks.request.mockRejectedValue(new Error("Backup password is incorrect"));
    render(<BackupPanel />);
    const restore = screen.getByRole("button", {
      name: "Replace workspace from backup",
    }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    const file = new File(["sealed"], "test.netrix-backup.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: async () => JSON.stringify({ version: 1, salt: "test", ciphertext: "sealed" }),
    });
    fireEvent.change(screen.getByLabelText("Choose encrypted backup"), {
      target: { files: [file] },
    });
    await screen.findByText("Selected: test.netrix-backup.json");
    fireEvent.change(screen.getByLabelText("Backup password"), {
      target: { value: "wrong-password" },
    });
    expect(restore.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type RESTORE BACKUP to confirm replacement"), {
      target: { value: "RESTORE BACKUP" },
    });
    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Backup password is incorrect",
    );
    expect(mocks.request).toHaveBeenCalledWith(
      "/backups/restore",
      "POST",
      expect.objectContaining({ confirmation: "RESTORE BACKUP" }),
    );
    expect(screen.getByText("Selected: test.netrix-backup.json")).toBeTruthy();
  });
  it("reports that workspace restore completed when local preference persistence then fails", async () => {
    useAppStore.setState({ isVaultUnlocked: true });
    mocks.request.mockResolvedValue({ preferences: { settings: { terminal: { fontSize: 18 } } } });
    const before = useAppStore.getState().settings;
    render(<BackupPanel />);
    const file = new File(["sealed"], "test.netrix-backup.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: async () => JSON.stringify({ version: 1, salt: "test", ciphertext: "sealed" }),
    });
    fireEvent.change(screen.getByLabelText("Choose encrypted backup"), {
      target: { files: [file] },
    });
    await screen.findByText("Selected: test.netrix-backup.json");
    fireEvent.change(screen.getByLabelText("Backup password"), {
      target: { value: "backup-password" },
    });
    fireEvent.change(screen.getByLabelText("Type RESTORE BACKUP to confirm replacement"), {
      target: { value: "RESTORE BACKUP" },
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage denied");
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace workspace from backup" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Workspace restored, but local preferences could not be saved",
    );
    expect(useAppStore.getState().settings).toBe(before);
  });
});
