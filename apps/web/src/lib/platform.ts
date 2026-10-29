/**
 * Thin bridge between the shared web UI and the desktop shell (Tauri).
 * In a browser every function degrades to a web equivalent.
 */
export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface ServerConfig {
  mode: 'local' | 'remote';
  url: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function getServerConfig(): Promise<ServerConfig | null> {
  if (!isDesktop) return null;
  return invoke<ServerConfig>('get_server_config');
}

export async function setServerConfig(cfg: ServerConfig): Promise<void> {
  await invoke('set_server_config', { config: cfg });
}

/** Session tokens live in the OS credential store (Keychain / Credential Manager / Secret Service). */
export async function loadSessionToken(): Promise<string | null> {
  if (!isDesktop) return null;
  return invoke<string | null>('get_session_token');
}
export async function saveSessionToken(token: string): Promise<void> {
  if (isDesktop) await invoke('set_session_token', { token });
}
export async function clearSessionToken(): Promise<void> {
  if (isDesktop) await invoke('clear_session_token');
}

export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (isDesktop) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export async function showSystemNotification(title: string, body?: string): Promise<void> {
  if (isDesktop) {
    const n = await import('@tauri-apps/plugin-notification');
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === 'granted';
    if (granted) n.sendNotification({ title, body });
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    new Notification(title, { body, tag: title });
  }
}

export async function requestWebNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (isDesktop) return 'granted';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.requestPermission();
}

export async function getAutostart(): Promise<boolean | null> {
  if (!isDesktop) return null;
  const a = await import('@tauri-apps/plugin-autostart');
  return a.isEnabled();
}
export async function setAutostart(on: boolean): Promise<void> {
  if (!isDesktop) return;
  const a = await import('@tauri-apps/plugin-autostart');
  if (on) await a.enable();
  else await a.disable();
}

export async function getDesktopPrefs(): Promise<{ trayEnabled: boolean; closeToTray: boolean } | null> {
  if (!isDesktop) return null;
  return invoke('get_desktop_prefs');
}
export async function setDesktopPrefs(p: { trayEnabled: boolean; closeToTray: boolean }): Promise<void> {
  if (isDesktop) await invoke('set_desktop_prefs', { prefs: p });
}

export async function checkForUpdates(): Promise<{ available: boolean; version?: string; error?: string }> {
  if (!isDesktop) return { available: false };
  return invoke('check_for_updates');
}

export async function setTrayBadge(count: number): Promise<void> {
  if (isDesktop) await invoke('set_tray_badge', { count }).catch(() => undefined);
}
