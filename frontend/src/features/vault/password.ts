export const MIN_VAULT_MASTER_PASSWORD_LENGTH = 10;

export const validateNewVaultMasterPassword = (
  password: string,
  confirmation: string,
): string | null => {
  if (Array.from(password).length < MIN_VAULT_MASTER_PASSWORD_LENGTH) {
    return `Use at least ${MIN_VAULT_MASTER_PASSWORD_LENGTH} characters for the vault master password.`;
  }

  if (password !== confirmation) {
    return "Master password and confirmation do not match.";
  }

  return null;
};
