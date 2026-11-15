//! Runtime policy for saved hosts, shared by terminals, SFTP, exec and tunnels.
use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

use crate::{
    auth::AppState,
    error::{AppError, AppResult},
    models::Host,
    vault,
};

pub const JUMP_HOST_UNSUPPORTED: &str =
    "Jump host connections are not supported yet. This profile was not connected directly.";
const INVALID_CREDENTIAL: &str =
    "Saved host credentials are invalid or unavailable. Repair or replace them in Connections.";

// Internal only: deliberately no Debug/Serialize implementation.
#[derive(Default, Deserialize)]
pub struct SavedCredentials {
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

impl Drop for SavedCredentials {
    fn drop(&mut self) {
        self.password.zeroize();
        self.private_key.zeroize();
        self.passphrase.zeroize();
    }
}

pub fn validate_route(host: &Host) -> AppResult<()> {
    if host.jump_host_id.is_some() {
        return Err(AppError::BadRequest(JUMP_HOST_UNSUPPORTED.into()));
    }
    Ok(())
}

pub async fn load_credentials(st: &AppState, host: &Host) -> AppResult<SavedCredentials> {
    validate_route(host)?;
    // Legacy columns are migration input only, never an authentication fallback.
    let Some(id) = host.credential_id else {
        if host.password.is_some() || host.private_key.is_some() {
            return Err(AppError::Unauthorized(
                "Unlock the vault to migrate this host's legacy credentials before connecting."
                    .into(),
            ));
        }
        return Ok(SavedCredentials::default());
    };
    let secret = Zeroizing::new(
        vault::retrieve_secret(&st.vault, &st.db, id)
            .await
            .map_err(|error| match error {
                vault::VaultError::Locked => AppError::Unauthorized(
                    "Vault is locked. Unlock the vault, then reconnect.".into(),
                ),
                _ => AppError::Conflict(INVALID_CREDENTIAL.into()),
            })?,
    );
    // Never include serde's error: malformed field values can contain secrets.
    let credentials: SavedCredentials = serde_json::from_slice(&secret)
        .map_err(|_| AppError::Conflict(INVALID_CREDENTIAL.into()))?;
    if credentials.password.is_none()
        && credentials
            .private_key
            .as_deref()
            .is_none_or(|key| key.trim().is_empty())
    {
        return Err(AppError::Conflict(INVALID_CREDENTIAL.into()));
    }
    if credentials
        .passphrase
        .as_ref()
        .is_some_and(|value| !value.is_empty())
        && credentials.private_key.is_none()
    {
        return Err(AppError::Conflict(INVALID_CREDENTIAL.into()));
    }
    Ok(credentials)
}
