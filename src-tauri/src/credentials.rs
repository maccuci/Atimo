//! Provider API keys, held by the OS credential store.
//!
//! The key is deliberately write-only from the frontend's point of view: the
//! webview can save it, ask whether one exists, and delete it, but there is no
//! command that hands it back. Reads happen here, inside the process that
//! makes the HTTPS request. That is the whole reason the adapter lives in Rust
//! rather than in `fetch()`.

use keyring::Entry;
use serde::Serialize;

/// Keychain service name. Matches the bundle identifier so the entry is
/// recognisable in Keychain Access.
const SERVICE: &str = "com.maccuci.atimo";

fn entry(provider: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider).map_err(|e| format!("credential store unavailable: {e}"))
}

/// Which store the key actually went to, for the one platform where the answer
/// is not "the only one there is".
///
/// On Linux the credential is written to the kernel keyring *and* to the Secret
/// Service, and a save fails outright if the second half is unreachable —
/// keyring reverts the first half rather than leave a key that works until the
/// next reboot. That is the right behaviour and the wrong error message: what
/// comes back is a DBus failure, and the user's actual problem is that no
/// keyring daemon is running.
#[cfg(target_os = "linux")]
fn store_hint(e: &keyring::Error) -> String {
    format!(
        "could not save key: {e}\n\
         Atimo stores keys in the system keyring. Check that a Secret Service \
         provider (gnome-keyring, KWallet) is running and unlocked."
    )
}

#[cfg(not(target_os = "linux"))]
fn store_hint(e: &keyring::Error) -> String {
    format!("could not save key: {e}")
}

pub fn read(provider: &str) -> Option<String> {
    let value = entry(provider).ok()?.get_password().ok()?;
    let trimmed = value.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

pub fn write(provider: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("key is empty".into());
    }
    entry(provider)?
        .set_password(key)
        .map_err(|e| store_hint(&e))
}

pub fn clear(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting a key that was never stored is the state the caller wanted.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not delete key: {e}")),
    }
}

/// What the UI is allowed to know about a stored key.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub present: bool,
    /// Last four characters, so the user can tell two keys apart without the
    /// app ever displaying one.
    pub hint: Option<String>,
}

pub fn status(provider: &str) -> CredentialStatus {
    match read(provider) {
        Some(key) => {
            let hint: String = key
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            CredentialStatus {
                present: true,
                hint: Some(hint),
            }
        }
        None => CredentialStatus {
            present: false,
            hint: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one failure mode this module has that produces no error anywhere.
    ///
    /// keyring ships no default features and does not fail to build on a
    /// platform whose credential store was never enabled — it substitutes an
    /// in-memory mock. Everything then behaves: `write` succeeds, `status`
    /// reports the key present, the hint shows the right four characters, and
    /// the key is gone the next time the app opens. It reaches the user as
    /// "the app keeps forgetting my key", which names neither the platform nor
    /// the cause.
    ///
    /// So the store is asserted rather than assumed. This fails at
    /// `cargo test` on any target missing from the feature list in
    /// `Cargo.toml`, which is where the mistake is actually made.
    #[test]
    fn credential_store_is_not_the_mock() {
        let entry = entry("test-provider").expect("credential store should be constructible");
        assert!(
            entry
                .get_credential()
                .downcast_ref::<keyring::mock::MockCredential>()
                .is_none(),
            "keyring fell back to the mock store on {}: no credential-store \
             feature covers this target, so keys will not survive a restart. \
             Add one to the `keyring` features in Cargo.toml.",
            std::env::consts::OS,
        );
    }

    /// `Entry::new` builds a credential without touching the store, so the test
    /// above stays offline — no keychain prompt, nothing to unlock in CI.
    #[test]
    fn status_of_an_unknown_provider_is_absent() {
        let status = status("provider-that-was-never-connected");
        assert!(!status.present);
        assert!(status.hint.is_none());
    }
}
