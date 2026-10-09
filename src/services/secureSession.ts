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
 * En el navegador la sesión vive en sessionStorage (POR PESTAÑA):
 *   - sobrevive a un recargado de página (F5) → no expulsa al administrador,
 *   - desaparece al cerrar la pestaña → cierre de sesión automático,
 *   - no es compartido entre pestañas ni sobrevive al cierre del navegador,
 *   - jamás se escribe en localStorage (que sí persiste y se comparte).
 */

import type { AdminSession } from './authService';

const STORE_KEY = 'admin_session';

// Sesión en memoria (respaldo si sessionStorage no está disponible)
let memorySession: AdminSession | null = null;

const isTauri = (): boolean =>
  typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

type StorageBackend = 'keyring' | 'sessionStorage' | 'memory';

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
      console.warn('[SecureSession] Keyring no disponible, usando sessionStorage:', err);
    }
  }
  memorySession = session;
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(session));
    return 'sessionStorage';
  } catch {
    // Sin sessionStorage (modo privado restringido): solo memoria
    return 'memory';
  }
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
    return memorySession;
  }
  if (memorySession) return memorySession;
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AdminSession;
      memorySession = parsed;
      return parsed;
    }
  } catch {
    // Sin sessionStorage o dato corrupto → sin sesión
  }
  return null;
}

export async function wipeSession(): Promise<void> {
  memorySession = null;
  try {
    sessionStorage.removeItem(STORE_KEY);
  } catch {
    // Sin sessionStorage: la sesión en memoria ya fue borrada
  }
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secure_store_delete', { key: STORE_KEY });
    } catch {
      // sin keyring: la sesión en memoria ya fue borrada
    }
  }
}