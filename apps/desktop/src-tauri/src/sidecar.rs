//! Local mode: runs the bundled Secretary server (Node.js + embedded PostgreSQL via PGlite)
//! bound to 127.0.0.1 on a random free port. The master encryption key is generated once and
//! kept in the OS credential store, so data at rest is unreadable without the user's login.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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

/// The app's own OAuth apps, compiled into release builds from CI secrets, so people
/// just click Connect. Desktop OAuth clients can't keep a secret confidential; Google and
/// Slack/Todoist still require one, and every flow is bound to a single-use state (plus PKCE
/// where the provider supports it).
const BUILT_IN_OAUTH: [(&str, Option<&str>); 8] = [
    ("GOOGLE_CLIENT_ID", option_env!("SECRETARY_GOOGLE_CLIENT_ID")),
    ("GOOGLE_CLIENT_SECRET", option_env!("SECRETARY_GOOGLE_CLIENT_SECRET")),
    ("MICROSOFT_CLIENT_ID", option_env!("SECRETARY_MICROSOFT_CLIENT_ID")),
    ("MICROSOFT_CLIENT_SECRET", option_env!("SECRETARY_MICROSOFT_CLIENT_SECRET")),
    ("SLACK_CLIENT_ID", option_env!("SECRETARY_SLACK_CLIENT_ID")),
    ("SLACK_CLIENT_SECRET", option_env!("SECRETARY_SLACK_CLIENT_SECRET")),
    ("TODOIST_CLIENT_ID", option_env!("SECRETARY_TODOIST_CLIENT_ID")),
    ("TODOIST_CLIENT_SECRET", option_env!("SECRETARY_TODOIST_CLIENT_SECRET")),
];

/// HTTPS page that forwards Slack/Todoist sign-in redirects to the local server.
const DEFAULT_OAUTH_RELAY: &str = "https://getsecretary.vercel.app/oauth/";

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

/// Last lines of the server log, included in startup errors so problems are diagnosable.
fn log_tail(log: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// Starts the server and waits (off the UI thread) until it reports ready, exits, or times out.
/// All server output goes to `log_path`.
pub fn start(node_bin: PathBuf, server_dir: PathBuf, data_dir: PathBuf, extra_env: Option<PathBuf>, store: &SecretStore, log_path: PathBuf) -> Result<LocalServer, String> {
    if let Some(dir) = log_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut log = OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| format!("Cannot write log {}: {e}", log_path.display()))?;
    let _ = writeln!(log, "\n--- starting local server: {} {}", node_bin.display(), server_dir.join("main.mjs").display());
    if !node_bin.exists() {
        return Err(format!("The bundled runtime is missing: {}", node_bin.display()));
    }
    if !server_dir.join("main.mjs").exists() {
        return Err(format!("The bundled server is missing: {}", server_dir.display()));
    }
    let port = free_port().map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db = data_dir.join("db");
    let mut cmd = Command::new(node_bin);
    for (key, value) in BUILT_IN_OAUTH {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            cmd.env(key, v);
        }
    }
    cmd.env("OAUTH_RELAY_URL", option_env!("SECRETARY_OAUTH_RELAY_URL").filter(|v| !v.is_empty()).unwrap_or(DEFAULT_OAUTH_RELAY));
    // Developer overrides (KEY=VALUE lines in server.env); core settings below always win.
    if let Some(path) = extra_env {
        if let Ok(text) = std::fs::read_to_string(path) {
            for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
                if let Some((k, v)) = line.split_once('=') {
                    let k = k.trim();
                    if k.ends_with("_CLIENT_ID") || k.ends_with("_CLIENT_SECRET") || k == "MICROSOFT_TENANT" || k == "CUSTOM_OAUTH_APPS" || k == "OAUTH_RELAY_URL" {
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
        .stderr(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .spawn()
        .map_err(|e| format!("Could not start the local server: {e}"))?;

    // Mirror stdout to the log and watch for the readiness line.
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = writeln!(log, "{line}");
            if line.starts_with("SECRETARY_READY") {
                let _ = tx.send(());
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if rx.recv_timeout(Duration::from_millis(250)).is_ok() {
            return Ok(LocalServer { url, child });
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("The local server stopped during startup ({status}).\n\n{}\n\nFull log: {}", log_tail(&log_path, 25), log_path.display()));
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err(format!("The local server did not start within 90 seconds.\n\n{}\n\nFull log: {}", log_tail(&log_path, 25), log_path.display()));
        }
    }
}
