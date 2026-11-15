import { describe, expect, it } from "vitest";
import {
  MIN_VAULT_MASTER_PASSWORD_LENGTH,
  validateNewVaultMasterPassword,
} from "./password";

describe("validateNewVaultMasterPassword", () => {
  it("requires the configured minimum length", () => {
    expect(validateNewVaultMasterPassword("short", "short")).toBe(
      `Use at least ${MIN_VAULT_MASTER_PASSWORD_LENGTH} characters for the vault master password.`,
    );
  });

  it("requires an exact confirmation", () => {
    expect(
      validateNewVaultMasterPassword("LongEnough1!", "LongEnough2!"),
    ).toBe("Master password and confirmation do not match.");
  });

  it("accepts a matching password with at least ten characters", () => {
    expect(
      validateNewVaultMasterPassword("LongEnough1!", "LongEnough1!"),
    ).toBeNull();
  });
});
