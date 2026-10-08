/**
 * Servicios del Panel de Administrador — ixi 4k
 *
 * Wrappers sobre comandos nativos (Rust/Tauri) para 2FA, sesiones activas,
 * re-verificación de contraseña y estado de servicios LOCALES.
 *
 * Fuera de la app de escritorio TODAS las funciones devuelven `available:
 * false` con un motivo honesto: aquí no se simulan respuestas ni se inventan
 * "servidores" que ixi 4k no tiene (es una app local, sin backend propio).
 */

const isTauriEnv = (): boolean =>
  typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

async function nativeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Mensaje de error legible para cadenas de error del backend */
function backendMessage(err: unknown): string {
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  const map: Record<string, string> = {
    INVALID_CODE: 'Código de verificación no válido',
    SESSION_EXPIRED: 'La sesión pendiente caducó: vuelve a iniciar sesión',
    SESSION_INVALID: 'La sesión admin no es válida',
    SESSION_NOT_FOUND: 'Esa sesión ya no existe',
    RATE_LIMITED: 'Demasiados intentos: espera un momento',
    '2FA_NOT_CONFIGURED': 'El 2FA todavía no está configurado',
    '2FA_NOT_ENABLED': 'El 2FA no está activo',
    '2FA_ALREADY_ENABLED': 'El 2FA ya está activo',
  };
  for (const [key, label] of Object.entries(map)) {
    if (raw.includes(key)) {
      if (key === 'RATE_LIMITED') {
        const seconds = raw.split(':')[1] || '60';
        return `${label} (${seconds}s)`;
      }
      return label;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 2FA (TOTP) — estado y ciclo de configuración
// ---------------------------------------------------------------------------

export interface TwoFactorStatus {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  reason?: string;
}

export interface TwoFactorSetupInfo {
  secret: string;
  otpauthUri: string;
}

/** Estado del 2FA. `available:false` = fuera de la app de escritorio. */
export async function getTwoFactorStatus(): Promise<TwoFactorStatus> {
  if (!isTauriEnv()) {
    return {
      available: false,
      enabled: false,
      configured: false,
      reason: 'El 2FA se gestiona en el backend de la app de escritorio (Rust)',
    };
  }
  try {
    const res = await nativeInvoke<{ enabled: boolean; configured: boolean }>('two_factor_status');
    return { available: true, enabled: !!res?.enabled, configured: !!res?.configured };
  } catch (err) {
    return { available: false, enabled: false, configured: false, reason: backendMessage(err) };
  }
}

/** Paso 1: genera/reutiliza el secreto pendiente (exige sesión admin). */
export async function setupTwoFactor(adminToken: string): Promise<TwoFactorSetupInfo> {
  const res = await nativeInvoke<{ secret: string; otpauthUri: string }>('two_factor_setup', {
    adminToken,
  });
  return { secret: res.secret, otpauthUri: res.otpauthUri };
}

/** Paso 2: activa el 2FA verificando un código válido. */
export async function enableTwoFactor(adminToken: string, code: string): Promise<void> {
  await nativeInvoke('two_factor_enable', { adminToken, code: code.trim() });
}

/** Desactiva el 2FA (exige código vigente). */
export async function disableTwoFactor(adminToken: string, code: string): Promise<void> {
  await nativeInvoke('two_factor_disable', { adminToken, code: code.trim() });
}

// ---------------------------------------------------------------------------
// Sesiones y dispositivos activos (visibilidad + cierre remoto)
// ---------------------------------------------------------------------------

export interface AdminSessionView {
  id: string;
  device: string;
  hostname: string;
  ip: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  current: boolean;
}

export interface SessionsResult {
  available: boolean;
  sessions: AdminSessionView[];
  reason?: string;
}

/** Lista las sesiones admin vivas (el backend nunca devuelve tokens). */
export async function listAdminSessions(adminToken: string): Promise<SessionsResult> {
  if (!isTauriEnv()) {
    return {
      available: false,
      sessions: [],
      reason: 'La gestión de sesiones vive en el backend de la app de escritorio',
    };
  }
  try {
    const sessions = await nativeInvoke<AdminSessionView[]>('list_admin_sessions', { adminToken });
    return { available: true, sessions: sessions ?? [] };
  } catch (err) {
    return { available: false, sessions: [], reason: backendMessage(err) };
  }
}

/** Cierre remoto de UNA sesión concreta. */
export async function revokeAdminSessionById(
  adminToken: string,
  id: string
): Promise<void> {
  await nativeInvoke('revoke_admin_session_by_id', { adminToken, id });
}

/** Cierre remoto de TODAS las sesiones menos la actual. */
export async function revokeOtherAdminSessions(adminToken: string): Promise<number> {
  return nativeInvoke<number>('revoke_other_admin_sessions', { adminToken });
}

// ---------------------------------------------------------------------------
// Protección adicional para acciones críticas: re-verificación de contraseña
// ---------------------------------------------------------------------------

/**
 * Re-verifica las credenciales del administrador en el backend antes de una
 * acción crítica (restaurar copias, desactivar 2FA…). La contraseña nunca se
 * guarda ni se compara en el frontend.
 */
export async function verifyAdminPassword(email: string, password: string): Promise<boolean> {
  if (!isTauriEnv()) return false;
  try {
    return await nativeInvoke<boolean>('verify_admin_credentials', { email, password });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Estado de servicios LOCALES (ixi 4k no tiene servidores propios)
// ---------------------------------------------------------------------------

export type ServiceStatus = 'operational' | 'unavailable' | 'error';

export interface ServiceCheck {
  id: string;
  name: string;
  detail: string;
  status: ServiceStatus;
}

export interface ServicesReport {
  checkedAt: number;
  checks: ServiceCheck[];
}

/**
 * Comprueba el estado REAL de los servicios locales de los que depende ixi 4k:
 * FFmpeg, backend nativo, red del dispositivo, almacenamiento local y
 * service worker (PWA en web). Se ejecuta bajo demanda (sin sondeos
 * permanentes que consuman batería/CPU).
 */
export async function checkLocalServices(): Promise<ServicesReport> {
  const checks: ServiceCheck[] = [];

  // 1) FFmpeg (motor de exportación de la app de escritorio)
  if (isTauriEnv()) {
    try {
      const version = await nativeInvoke<string>('check_ffmpeg');
      checks.push({
        id: 'ffmpeg',
        name: 'FFmpeg (motor de vídeo)',
        detail: typeof version === 'string' && version ? version : 'Instalado y disponible',
        status: 'operational',
      });
    } catch (err) {
      checks.push({
        id: 'ffmpeg',
        name: 'FFmpeg (motor de vídeo)',
        detail: backendMessage(err),
        status: 'error',
      });
    }
    checks.push({
      id: 'backend',
      name: 'Backend nativo (Rust/Tauri)',
      detail: 'Comandos locales disponibles (sesiones, 2FA, exportación)',
      status: 'operational',
    });
  } else {
    checks.push({
      id: 'backend',
      name: 'Backend nativo (Rust/Tauri)',
      detail: 'No disponible en el navegador — usa la app de escritorio',
      status: 'unavailable',
    });
    // Exportación WebCodecs del navegador
    const webcodecs =
      typeof window !== 'undefined' && 'VideoEncoder' in window && 'VideoDecoder' in window;
    checks.push({
      id: 'webcodecs',
      name: 'Exportación WebCodecs (navegador)',
      detail: webcodecs ? 'Disponible en este navegador' : 'Este navegador no admite WebCodecs',
      status: webcodecs ? 'operational' : 'unavailable',
    });
  }

  // 2) Conectividad de red del dispositivo (sin contactar servidores propios)
  const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  checks.push({
    id: 'network',
    name: 'Red del dispositivo',
    detail: online ? 'Conectado' : 'Sin conexión (ixi 4k sigue funcionando en local)',
    status: online ? 'operational' : 'unavailable',
  });

  // 3) Almacenamiento local (donde viven ajustes, reportes y auditoría)
  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      const usedMb = ((est.usage ?? 0) / (1024 * 1024)).toFixed(1);
      const quotaMb = ((est.quota ?? 0) / (1024 * 1024)).toFixed(0);
      checks.push({
        id: 'storage',
        name: 'Almacenamiento local',
        detail: `${usedMb} MB usados${quotaMb !== '0' ? ` de ~${quotaMb} MB` : ''}`,
        status: 'operational',
      });
    } else {
      checks.push({
        id: 'storage',
        name: 'Almacenamiento local',
        detail: 'API de cuota no disponible en este entorno',
        status: 'unavailable',
      });
    }
  } catch {
    checks.push({
      id: 'storage',
      name: 'Almacenamiento local',
      detail: 'No se pudo estimar el uso',
      status: 'unavailable',
    });
  }

  // 4) Service worker (sólo aplica a la PWA en web)
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      checks.push({
        id: 'sw',
        name: 'Service worker (PWA)',
        detail: reg ? 'Registrado — la app abre sin conexión' : 'Sin registrar en este origen',
        status: reg ? 'operational' : 'unavailable',
      });
    } catch {
      checks.push({
        id: 'sw',
        name: 'Service worker (PWA)',
        detail: 'Estado no disponible',
        status: 'unavailable',
      });
    }
  }

  return { checkedAt: Date.now(), checks };
}
