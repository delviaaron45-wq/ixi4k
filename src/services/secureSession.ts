/**
 * Almacenamiento seguro de sesiones - ixi 4k
 *
 * Los tokens de autenticación NUNCA se guardan en localStorage plano.
 * En entorno nativo (Tauri) se usan los comandos secure_store_* respaldados
 * por el gestor de credenciales del sistema operativo (keyring):
 *   - Windows: Credential Manager
 *   - macOS: Keychain
 *   - Linux: Secret Service
 *
 * En modo navegador (desarrollo) la sesión vive SOLO en memoria (RAM)
 * y se pierde al recargar, evitando fugas por localStorage/XSS.
 */

import type { AdminSession } from './authService';

const STORE_KEY = 'admin_session';

// Sesión en memoria (solo navegador) — jamás se escribe en localStorage
let memorySession: AdminSession | null = null;

const isTauri = (): boolean =>
  typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

type StorageBackend = 'keyring' | 'memory';

export async function persistSession(session: AdminSession): Promise<StorageBackend> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_store_save', {
        key: STORE_KEY,
        value: JSON.stringify(session),
      });
      return 'keyring';
    } catch (err) {
      console.warn('[SecureSession] Keyring no disponible, usando memoria:', err);
    }
  }
  memorySession = session;
  return 'memory';
}

export async function loadSession(): Promise<AdminSession | null> {
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke<string | null>('secure_store_load', { key: STORE_KEY });
      if (raw) return JSON.parse(raw) as AdminSession;
    } catch {
      // keyring no disponible → fallback memoria
    }
  }
  return memorySession;
}

export async function wipeSession(): Promise<void> {
  memorySession = null;
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_store_delete', { key: STORE_KEY });
    } catch {
      // sin keyring: la sesión en memoria ya fue borrada
    }
  }
}