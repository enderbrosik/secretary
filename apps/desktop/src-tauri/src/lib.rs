mod secrets;
mod sidecar;

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use secrets::SecretStore;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    mode: String, // "local" | "remote"
    url: String,
    tray_enabled: bool,
    close_to_tray: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self { mode: "local".into(), url: String::new(), tray_enabled: true, close_to_tray: true }
    }
}

struct AppState {
    config: Mutex<DesktopConfig>,
    config_path: PathBuf,
    secrets: SecretStore,
    local: Mutex<Option<sidecar::LocalServer>>,
    local_error: Mutex<Option<String>>,
}

impl AppState {
    fn save(&self) -> Result<(), String> {
        let cfg = self.config.lock().unwrap().clone();
        if let Some(dir) = self.config_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.config_path, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(|e| e.to_string())
    }
    fn server_url(&self) -> String {
        let cfg = self.config.lock().unwrap();
        if cfg.mode == "remote" {
            cfg.url.trim_end_matches('/').to_string()
        } else {
            self.local.lock().unwrap().as_ref().map(|s| s.url.clone()).unwrap_or_default()
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ServerConfig {
    mode: String,
    url: String,
}

#[tauri::command]
fn get_server_config(state: State<AppState>) -> Result<ServerConfig, String> {
    if let Some(err) = state.local_error.lock().unwrap().clone() {
        if state.config.lock().unwrap().mode == "local" {
            return Err(err);
        }
    }
    Ok(ServerConfig { mode: state.config.lock().unwrap().mode.clone(), url: state.server_url() })
}

#[tauri::command]
fn set_server_config(app: AppHandle, state: State<AppState>, config: ServerConfig) -> Result<(), String> {
    if config.mode == "remote" && !(config.url.starts_with("https://") || config.url.starts_with("http://localhost") || config.url.starts_with("http://127.0.0.1")) {
        return Err("Remote servers must use HTTPS".into());
    }
    {
        let mut c = state.config.lock().unwrap();
        c.mode = config.mode;
        c.url = config.url;
    }
    state.save()?;
    app.restart();
}

fn token_key(state: &AppState) -> String {
    format!("session:{}", state.server_url())
}

#[tauri::command]
fn get_session_token(state: State<AppState>) -> Option<String> {
    state.secrets.get(&token_key(&state))
}

#[tauri::command]
fn set_session_token(state: State<AppState>, token: String) -> Result<(), String> {
    state.secrets.set(&token_key(&state), &token).map(|_| ())
}

#[tauri::command]
fn clear_session_token(state: State<AppState>) {
    state.secrets.delete(&token_key(&state));
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopPrefs {
    tray_enabled: bool,
    close_to_tray: bool,
}

#[tauri::command]
fn get_desktop_prefs(state: State<AppState>) -> DesktopPrefs {
    let c = state.config.lock().unwrap();
    DesktopPrefs { tray_enabled: c.tray_enabled, close_to_tray: c.close_to_tray }
}

#[tauri::command]
fn set_desktop_prefs(app: AppHandle, state: State<AppState>, prefs: DesktopPrefs) -> Result<(), String> {
    {
        let mut c = state.config.lock().unwrap();
        c.tray_enabled = prefs.tray_enabled;
        c.close_to_tray = prefs.close_to_tray;
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_visible(prefs.tray_enabled);
    }
    state.save()
}

#[tauri::command]
fn set_tray_badge(app: AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if count == 0 { "Secretary".to_string() } else { format!("Secretary — {count} unread") };
        let _ = tray.set_tooltip(Some(tip));
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(if count == 0 { None } else { Some(count.to_string()) });
    }
}

#[derive(Serialize)]
struct UpdateStatus {
    available: bool,
    version: Option<String>,
    error: Option<String>,
}

/// Updates are verified against a public key compiled into release builds
/// (TAURI_UPDATER_PUBKEY / TAURI_UPDATER_ENDPOINT, set in CI). Dev builds report that.
#[tauri::command]
async fn check_for_updates(app: AppHandle) -> UpdateStatus {
    use tauri_plugin_updater::UpdaterExt;
    let (Some(pubkey), Some(endpoint)) = (option_env!("TAURI_UPDATER_PUBKEY"), option_env!("TAURI_UPDATER_ENDPOINT")) else {
        return UpdateStatus { available: false, version: None, error: Some("Automatic updates aren’t configured for this build.".into()) };
    };
    let url = match endpoint.parse() {
        Ok(u) => u,
        Err(_) => return UpdateStatus { available: false, version: None, error: Some("Invalid update endpoint".into()) },
    };
    let updater = match app.updater_builder().pubkey(pubkey).endpoints(vec![url]).and_then(|b| b.build()) {
        Ok(u) => u,
        Err(e) => return UpdateStatus { available: false, version: None, error: Some(e.to_string()) },
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            tauri::async_runtime::spawn(async move {
                let _ = update.download_and_install(|_, _| {}, || {}).await;
            });
            UpdateStatus { available: true, version: Some(version), error: None }
        }
        Ok(None) => UpdateStatus { available: false, version: None, error: None },
        Err(e) => UpdateStatus { available: false, version: None, error: Some(e.to_string()) },
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Compact quick-access window (today's priorities + quick add), opened from the tray or the global shortcut.
fn toggle_quick(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("index.html#/quick".into()))
        .title("Secretary — Quick view")
        .inner_size(360.0, 520.0)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .build();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let config_path = config_dir.join("desktop.json");
            let config: DesktopConfig = std::fs::read(&config_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let state = AppState {
                config: Mutex::new(config.clone()),
                config_path,
                secrets: SecretStore::new(data_dir.clone()),
                local: Mutex::new(None),
                local_error: Mutex::new(None),
            };

            if config.mode == "local" {
                let node = std::env::current_exe()?.parent().map(|p| p.join(if cfg!(windows) { "secretary-node.exe" } else { "secretary-node" })).unwrap();
                let server_dir = app.path().resource_dir()?.join("server");
                match sidecar::start(node, server_dir, data_dir.join("local"), &state.secrets) {
                    Ok(srv) => *state.local.lock().unwrap() = Some(srv),
                    Err(e) => *state.local_error.lock().unwrap() = Some(e),
                }
            }
            app.manage(state);

            // Tray / menu bar.
            let today = MenuItem::with_id(app, "today", "Open Today", true, None::<&str>)?;
            let quick = MenuItem::with_id(app, "quick", "Quick view", true, Some("CmdOrCtrl+Shift+Space"))?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Secretary", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&today, &quick, &sep, &quit])?;
            let tray = TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Secretary")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "today" => show_main(app),
                    "quick" => toggle_quick(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        toggle_quick(tray.app_handle());
                    }
                })
                .build(app)?;
            tray.set_visible(config.tray_enabled)?;

            let modifier = if cfg!(target_os = "macos") { Modifiers::SUPER } else { Modifiers::CONTROL };
            let shortcut = Shortcut::new(Some(modifier | Modifiers::SHIFT), Code::Space);
            let _ = app.global_shortcut().register(shortcut);

            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            let _ = handle.emit("desktop-ready", ());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let keep = { let c = state.config.lock().unwrap(); c.close_to_tray && c.tray_enabled };
                if window.label() == "quick" || keep {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_server_config,
            set_server_config,
            get_session_token,
            set_session_token,
            clear_session_token,
            get_desktop_prefs,
            set_desktop_prefs,
            set_tray_badge,
            check_for_updates
        ])
        .run(tauri::generate_context!())
        .expect("error while running Secretary");
}
