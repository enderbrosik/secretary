//! Local mode: runs the bundled Secretary server (Node.js + embedded PostgreSQL via PGlite)
//! bound to 127.0.0.1 on a random free port. The master encryption key is generated once and
//! kept in the OS credential store, so data at rest is unreadable without the user's login.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use base64::Engine;
use rand::RngCore;

use crate::secrets::SecretStore;

pub struct LocalServer {
    pub url: String,
    child: Child,
}

impl Drop for LocalServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Preferred fixed port, so OAuth redirect URIs (http://127.0.0.1:47821/api/integrations/callback/…)
/// can be registered once. Falls back to a random free port if it is taken.
pub const PREFERRED_PORT: u16 = 47821;

fn free_port() -> std::io::Result<u16> {
    if TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).is_ok() {
        return Ok(PREFERRED_PORT);
    }
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn master_key(store: &SecretStore) -> Result<String, String> {
    if let Some(k) = store.get("master-key") {
        return Ok(k);
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let k = base64::engine::general_purpose::STANDARD.encode(bytes);
    store.set("master-key", &k)?;
    Ok(k)
}

pub fn start(node_bin: PathBuf, server_dir: PathBuf, data_dir: PathBuf, extra_env: Option<PathBuf>, store: &SecretStore) -> Result<LocalServer, String> {
    let port = free_port().map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db = data_dir.join("db");
    let mut cmd = Command::new(node_bin);
    // Optional OAuth app credentials for local mode (KEY=VALUE lines); core settings below always win.
    if let Some(path) = extra_env {
        if let Ok(text) = std::fs::read_to_string(path) {
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
                if let Some((k, v)) = line.split_once('=') {
                    let k = k.trim();
                    if k.ends_with("_CLIENT_ID") || k.ends_with("_CLIENT_SECRET") || k == "MICROSOFT_TENANT" {
                        cmd.env(k, v.trim());
                    }
                }
            }
        }
    }
    let mut child = cmd
        .arg(server_dir.join("main.mjs"))
        .current_dir(&server_dir)
        .env("NODE_ENV", "production")
        .env("LOCAL_MODE", "true")
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("PUBLIC_URL", &url)
        .env("APP_URL", &url)
        .env("WEB_ORIGINS", "tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:5173")
        .env("DATABASE_URL", format!("pglite://{}", db.display()))
        .env("MIGRATIONS_DIR", server_dir.join("migrations"))
        .env("MASTER_KEY", master_key(store)?)
        .env("LOG_LEVEL", "warn")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Could not start the local server: {e}"))?;

    // Wait for the readiness line.
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with("SECRETARY_READY") {
                let _ = tx.send(());
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(()) => Ok(LocalServer { url, child }),
        Err(_) => {
            let _ = child.kill();
            Err("The local server did not start within 60 seconds.".into())
        }
    }
}
