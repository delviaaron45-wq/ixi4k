/**
 * Información de dispositivo para registros de auditoría - ixi 4k
 * IP local + hostname + ID de dispositivo persistente (keyring en Tauri).
 */

export interface DeviceInfo {
  deviceId: string;
  hostname: string;
  ip: string;
  platform: string;
}

const isTauri = (): boolean =>
  typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

let cached: DeviceInfo | null = null;

export async function getDeviceInfo(): Promise<DeviceInfo> {
  if (cached) return cached;

  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      cached = await invoke<DeviceInfo>('get_device_info');
      return cached;
    } catch {
      // fallback al modo navegador
    }
  }

  cached = {
    deviceId: `web-${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)}`,
    hostname: 'navegador-web',
    ip: 'N/A (modo navegador)',
    platform: typeof navigator !== 'undefined' ? navigator.platform || 'web' : 'web',
  };
  return cached;
}