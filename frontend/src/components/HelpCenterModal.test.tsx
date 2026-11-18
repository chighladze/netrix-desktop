import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import HelpCenterModal from "./HelpCenterModal";

const renderGuide = (
  overrides: Partial<ComponentProps<typeof HelpCenterModal>> = {},
) => {
  const props: ComponentProps<typeof HelpCenterModal> = {
    isOpen: true,
    mode: "welcome",
    vaultInitialized: false,
    vaultUnlocked: false,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    onCreateVault: vi.fn().mockResolvedValue({ ok: true }),
    onUnlockVault: vi.fn(),
    onReportProblem: vi.fn(),
    ...overrides,
  };

  render(<HelpCenterModal {...props} />);
  return props;
};

describe("HelpCenterModal", () => {
  it("opens problem reporting from the guide without requiring an unlocked vault", () => {
    const props = renderGuide({ mode: "guide" });
    fireEvent.click(screen.getByRole("button", { name: "Report problem" }));
    expect(props.onReportProblem).toHaveBeenCalledTimes(1);
    expect(props.onUnlockVault).not.toHaveBeenCalled();
  });
  it("creates the Vault directly from the first-run guide", async () => {
    const props = renderGuide();

    expect(screen.getByText("Create your Credential Vault")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Master password"), {
      target: { value: "ProfessionalPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm master password"), {
      target: { value: "ProfessionalPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create & Unlock Vault" }));

    await waitFor(() => {
      expect(props.onCreateVault).toHaveBeenCalledWith("ProfessionalPass123!");
    });
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("explains why a first-run password cannot be submitted", async () => {
    const props = renderGuide();

    fireEvent.change(screen.getByLabelText("Master password"), {
      target: { value: "short" },
    });
    fireEvent.change(screen.getByLabelText("Confirm master password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create & Unlock Vault" }));

    expect((await screen.findByRole("alert")).textContent).toContain("at least 10 characters");
    expect(props.onCreateVault).not.toHaveBeenCalled();
  });

  it("keeps the setup form open when Vault creation fails", async () => {
    renderGuide({
      onCreateVault: vi.fn().mockResolvedValue({
        ok: false,
        error: "Vault service is temporarily unavailable",
      }),
    });

    fireEvent.change(screen.getByLabelText("Master password"), {
      target: { value: "ProfessionalPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm master password"), {
      target: { value: "ProfessionalPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create & Unlock Vault" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Vault service is temporarily unavailable",
    );
  });

  it("opens the shared unlock flow when an initialized Vault is locked", () => {
    const props = renderGuide({
      mode: "guide",
      vaultInitialized: true,
      vaultUnlocked: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Unlock Vault" }));

    expect(props.onUnlockVault).toHaveBeenCalledTimes(1);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("navigates directly to a selected workspace", () => {
    const props = renderGuide({ mode: "guide" });

    fireEvent.click(screen.getByRole("button", { name: /Files/ }));

    expect(props.onNavigate).toHaveBeenCalledWith("files");
  });
});
