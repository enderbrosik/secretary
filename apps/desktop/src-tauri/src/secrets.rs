//! OS credential storage: macOS Keychain, Windows Credential Manager, Secret Service on Linux.
//! If no secret service is available (some minimal Linux desktops), falls back to a file
//! in the app data directory readable only by the current user, and reports that it did.

use std::fs;
use std::path::PathBuf;

const SERVICE: &str = "app.secretary.desktop";

pub struct SecretStore {
    fallback_dir: PathBuf,
}

impl SecretStore {
    pub fn new(fallback_dir: PathBuf) -> Self {
        Self { fallback_dir }
    }

    fn entry(key: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(SERVICE, key).ok()
    }

    fn fallback_path(&self, key: &str) -> PathBuf {
        let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        self.fallback_dir.join("secrets").join(safe)
    }

    pub fn get(&self, key: &str) -> Option<String> {
        if let Some(e) = Self::entry(key) {
            match e.get_password() {
                Ok(v) => return Some(v),
                Err(keyring::Error::NoEntry) => {}
                Err(_) => {}
            }
        }
        fs::read_to_string(self.fallback_path(key)).ok()
    }

    /// Returns true when the OS keychain was used, false when the file fallback was used.
    pub fn set(&self, key: &str, value: &str) -> Result<bool, String> {
        if let Some(e) = Self::entry(key) {
            if e.set_password(value).is_ok() {
                let _ = fs::remove_file(self.fallback_path(key));
                return Ok(true);
            }
        }
        let p = self.fallback_path(key);
        fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&p, value).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
        }
        Ok(false)
    }

    pub fn delete(&self, key: &str) {
        if let Some(e) = Self::entry(key) {
            let _ = e.delete_credential();
        }
        let _ = fs::remove_file(self.fallback_path(key));
    }
}
