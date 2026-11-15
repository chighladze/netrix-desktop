import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VaultUnlockModal from "./VaultUnlockModal";

describe("VaultUnlockModal", () => {
  it("submits the master password and closes after a successful unlock", async () => {
    const onClose = vi.fn();
    const onUnlock = vi.fn().mockResolvedValue({ ok: true });

    render(
      <VaultUnlockModal
        isOpen
        linkedHosts={2}
        onClose={onClose}
        onUnlock={onUnlock}
      />,
    );

    fireEvent.change(screen.getByLabelText("Master password"), {
      target: { value: "VaultPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock Vault" }));

    await waitFor(() => {
      expect(onUnlock).toHaveBeenCalledWith("VaultPass123!");
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the dialog open and displays an unlock error", async () => {
    const onClose = vi.fn();
    const onUnlock = vi.fn().mockResolvedValue({
      ok: false,
      error: "Invalid master password",
    });

    render(
      <VaultUnlockModal
        isOpen
        linkedHosts={1}
        onClose={onClose}
        onUnlock={onUnlock}
      />,
    );

    fireEvent.change(screen.getByLabelText("Master password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock Vault" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Invalid master password");
    expect(onClose).not.toHaveBeenCalled();
  });
});
