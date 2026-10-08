/**
 * Servicio de Autenticación de Administrador - ixi 4k
 *
 * FLUJO DE LOGIN (Usuario / Administrador):
 * 1. El usuario introduce correo y contraseña en el login normal.
 * 2. `resolveLoginRole()` pregunta AL BACKEND por el rol de esa cuenta:
 *      - credenciales del administrador configurado → rol "admin" + token
 *        de sesión emitido por el backend (Rust) o por Supabase Auth (JWT);
 *      - cualquier otra cosa → rol "user" (sin token admin).
 * 3. La pantalla de login muestra la selección:
 *      - "Entrar como usuario"  → entrada normal (flujo de cualquier usuario);
 *      - "Entrar como administrador" → SOLO si el backend devolvió rol "admin".
 * 4. Un usuario normal NUNCA ve la opción de administrador.
 *
 * SEGURIDAD:
 * - NO contiene ninguna credencial de administrador: ni contraseña, ni email,
 *   ni hash. El bundle JavaScript que llega al navegador/expuesto en GitHub
 *   no incluye ningún secreto verificable.
 * - El rol ADMIN lo determina SIEMPRE el backend (nunca React, localStorage,
 *   sessionStorage ni el keyring). La sesión nativa es un token opaco que solo
 *   el proceso Rust puede emitir, validar (`verify_admin_session`) y revocar
 *   (`revoke_admin_session`); el hash bcrypt (cost 12) vive en el backend.
 * - Autenticación cifrada vía Supabase Auth (JWT) cuando hay proveedor: el
 *   rol sale del claim emitido por el servidor, no de JavaScript.
 * - Rate Limiting: máximo 5 intentos de login por minuto (anti fuerza bruta),
 *   aplicado tanto localmente como en Rust.
 * - Todo intento fallido se rechaza con mensaje de auditoría.
 * - Las contraseñas jamás se registran ni se devuelven en consola, logs o
 *   respuestas: solo se envían al backend para verificarlas.
 *
 * Configuración de credenciales (FUERA del repositorio):
 *   npm run admin:setup                → ~/.ixi4k/admin_credentials.json (600)
 *   IXI4K_ADMIN_EMAIL / IXI4K_ADMIN_PASSWORD_HASH  → variables de entorno
 *
 * Configuración web (variables de entorno en .env):
 *   VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
 *   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...
 */

const ACCESS_DENIED_MESSAGE =
  'Acceso No Autorizado: Credenciales de Administrador Incorrectas';

/** El backend nativo no tiene configurada ninguna fuente de credenciales */
const ADMIN_NOT_CONFIGURED_MESSAGE =
  'Acceso administrador no disponible en la web: usa la app de escritorio o configura Supabase Auth';

export interface AdminSession {
  accessToken: string;
  refreshToken?: string;
  user: { id: string; email: string; role: string };
  expiresAt: number;
  /**
   * Quién emitió la sesión. `backend` = token opaco generado por el proceso
   * Rust; `supabase` = JWT firmado por Supabase Auth. Si falta, la sesión se
   * considera inválida (no se confía en sesiones auto-generadas).
   */
  provider?: 'backend' | 'supabase';
}

export type AuthErrorCode =
  | 'RATE_LIMITED'
  | 'INVALID_CREDENTIALS'
  | 'NO_ADMIN_ROLE'
  | 'AUTH_NOT_CONFIGURED'
  | 'NETWORK_ERROR'
  | 'TWO_FACTOR_REQUIRED'
  | 'INVALID_2FA_CODE';

export class AuthError extends Error {
  code: AuthErrorCode;
  retryAfter: number;
  /** Token PENDIENTE emitido por el backend cuando exige código 2FA */
  pendingToken?: string;

  constructor(code: AuthErrorCode, message: string, retryAfter = 0, pendingToken?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.retryAfter = retryAfter;
    this.pendingToken = pendingToken;
  }
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ---------------------------------------------------------------------------
// Rate Limiting: 5 intentos como máximo por ventana de 60 segundos
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;
let attemptTimestamps: number[] = [];

export interface RateLimitState {
  used: number;
  remaining: number;
  locked: boolean;
  retryAfter: number;
}

export function getRateLimitState(): RateLimitState {
  const now = Date.now();
  attemptTimestamps = attemptTimestamps.filter((t) => now - t < WINDOW_MS);
  const used = attemptTimestamps.length;
  const locked = used >= MAX_ATTEMPTS;
  const retryAfter = locked
    ? Math.ceil((WINDOW_MS - (now - attemptTimestamps[0])) / 1000)
    : 0;
  return {
    used,
    remaining: Math.max(0, MAX_ATTEMPTS - used),
    locked,
    retryAfter,
  };
}

function recordLocalAttempt(): void {
  attemptTimestamps.push(Date.now());
  if (attemptTimestamps.length > 50) attemptTimestamps = attemptTimestamps.slice(-50);
}

// ---------------------------------------------------------------------------
// Rate Limiting nativo (capa 2, implementada en Rust/Tauri)
// ---------------------------------------------------------------------------
const isTauri = (): boolean =>
  typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

async function nativeRateCheck(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<number>('record_login_attempt');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('RATE_LIMITED')) {
      const seconds = Number(msg.split(':')[1]) || 60;
      throw new AuthError('RATE_LIMITED', 'Demasiados intentos de acceso', seconds);
    }
  }
}

// ---------------------------------------------------------------------------
// JWT helpers (la verificación real de firma la realiza Supabase/RLS;
// aquí solo se decodifican claims para la UI)
// ---------------------------------------------------------------------------
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function hasAdminClaim(session: AdminSession): boolean {
  const payload = decodeJwtPayload(session.accessToken);
  if (!payload) return false;
  const role =
    (payload['role'] as string | undefined) ??
    ((payload['app_metadata'] as { role?: string } | undefined)?.role) ??
    ((payload['user_metadata'] as { role?: string } | undefined)?.role);
  return role === 'admin' || role === 'service_role';
}

/**
 * Valida la sesión de administrador — SIEMPRE con ayuda del backend.
 *
 * - Sesión `supabase`: caducidad + claim de rol emitido por el servidor.
 * - Sesión `backend`: se envía el token al proceso Rust, que comprueba que lo
 *   emitió él y que no ha caducado. Un token inventado o copiado del navegador
 *   (localStorage, keyring, URL…) es rechazado.
 * - Cualquier otra sesión (sin `provider`, antigua o alterada) → inválida.
 */
export async function validateAdminSession(session: AdminSession | null): Promise<boolean> {
  if (!session || !session.accessToken) return false;
  if (session.expiresAt <= Date.now() + 5_000) return false;

  if (session.provider === 'supabase') return hasAdminClaim(session);

  if (session.provider !== 'backend' || !isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('verify_admin_session', { token: session.accessToken });
  } catch {
    return false;
  }
}

/** Revoca en el backend la sesión nativa (logout del administrador). */
export async function revokeAdminSession(session: AdminSession): Promise<void> {
  if (session.provider !== 'backend' || !isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('revoke_admin_session', { token: session.accessToken });
  } catch {
    // Sin backend: la sesión local se elimina igualmente (ver useAdminStore)
  }
}

// ---------------------------------------------------------------------------
// Resolución de rol en el BACKEND (login normal de ixi 4k)
// ---------------------------------------------------------------------------

/** Respuesta del comando nativo `login_with_role` (rol asignado por Rust). */
interface LoginResultPayload {
  role: string;
  token?: string | null;
  expiresAt?: number | null;
  /**
   * `true` cuando el backend exige el código TOTP (2FA) ANTES de conceder la
   * sesión: `token` es entonces un token PENDIENTE (caduca en minutos).
   */
  twoFactorRequired?: boolean;
}

export interface LoginOutcome {
  /** Rol decidido por el backend. `admin` solo con credenciales de admin. */
  role: 'admin' | 'user';
  /** Sesión emitida por el backend — presente únicamente cuando role=admin */
  session?: AdminSession;
  /**
   * El backend confirmó credenciales de admin pero exige el código 2FA:
   * `pendingToken` intercambia el código por la sesión real.
   */
  twoFactor?: { pendingToken: string };
}

/** Construye la sesión admin a partir del TOKEN que emitió el backend. */
function buildBackendSession(
  email: string,
  token: string,
  expiresAt?: number | null
): AdminSession {
  const expSeconds =
    expiresAt && expiresAt > 0 ? expiresAt : Math.floor(Date.now() / 1000) + 3600;
  return {
    accessToken: token,
    user: { id: 'admin_master', email, role: 'admin' },
    expiresAt: expSeconds * 1000,
    provider: 'backend',
  };
}

/**
 * Etiqueta del dispositivo actual para el registro de sesiones activas:
 * SOLO describe el entorno (SO · tipo de app), sin identificadores.
 */
export function currentDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Dispositivo desconocido';
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const os = /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iPod/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'sistema desconocido';
  const kind = isTauri() ? (mobile ? 'app móvil' : 'app escritorio') : 'navegador web';
  return `${os} · ${kind}`;
}

/**
 * Determina el rol de la cuenta que intenta entrar. Solo el backend puede
 * responder `admin`: React nunca decide el rol.
 *
 * - App de escritorio (Tauri): comando `login_with_role` (bcrypt en Rust).
 * - Web con Supabase Auth: claim de rol del JWT emitido por el servidor.
 * - Web sin backend: siempre `user` (imposible obtener rol admin en un
 *   navegador sin servidor que lo verifique).
 *
 * Lanza AuthError solo por rate limiting. Nuestra consola recibe la
 * contraseña exclusivamente para reenviarla al backend.
 */
export async function resolveLoginRole(email: string, password: string): Promise<LoginOutcome> {
  const normalized = email.trim().toLowerCase();

  // 1) Backend nativo (app de escritorio)
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<LoginResultPayload>('login_with_role', {
        email: normalized,
        password,
        device: currentDeviceLabel(),
      });
      if (result.role === 'admin' && result.token) {
        // 2FA activo → credenciales correctas pero SIN sesión todavía
        if (result.twoFactorRequired === true) {
          return {
            role: 'admin',
            twoFactor: { pendingToken: result.token },
          };
        }
        return {
          role: 'admin',
          session: buildBackendSession(normalized, result.token, result.expiresAt),
        };
      }
      return { role: 'user' };
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      if (msg.includes('RATE_LIMITED')) {
        const seconds = Number(msg.split(':')[1]) || 60;
        throw new AuthError('RATE_LIMITED', 'Demasiados intentos de acceso', seconds);
      }
      // Sin secretos configurados u otro fallo → nunca rol admin
      return { role: 'user' };
    }
  }

  // 2) Web con Supabase Auth: el rol lo emite el servidor en el JWT
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const session = await supabasePasswordLogin(email, password);
      return { role: 'admin', session };
    } catch {
      // Sin rol admin, credenciales no válidas o red caída → usuario normal
      // (el login normal de ixi 4k sigue funcionando igual que siempre)
      return { role: 'user' };
    }
  }

  // 3) Web sin backend configurado → nunca puede haber rol administrador
  return { role: 'user' };
}

// ---------------------------------------------------------------------------
// Login de administrador (uso del Panel Admin)
//
// El navegador NUNCA compara contraseñas: envía las credenciales al comando
// nativo `login_with_role` (Rust), que hace bcrypt::verify contra el hash
// almacenado en ~/.ixi4k/admin_credentials.json o en variables de entorno del
// proceso, y emite —solo entonces— un token de sesión que es el que viaja de
// vuelta. Sin backend y sin proveedor → acceso denegado.
// ---------------------------------------------------------------------------
export async function signInAdmin(email: string, password: string): Promise<AdminSession> {
  // Capa 1: rate limiting local
  const local = getRateLimitState();
  if (local.locked) {
    throw new AuthError('RATE_LIMITED', 'Demasiados intentos de acceso', local.retryAfter);
  }
  recordLocalAttempt();

  // Capa 2: rate limiting nativo (Rust)
  await nativeRateCheck();

  // 1) Backend nativo (app de escritorio): verificación bcrypt + token de sesión
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<LoginResultPayload>('login_with_role', {
        email: email.trim().toLowerCase(),
        password,
        device: currentDeviceLabel(),
      });
      if (result.role === 'admin' && result.token) {
        // 2FA activo → el backend exige el código TOTP ANTES de la sesión
        if (result.twoFactorRequired === true) {
          throw new AuthError(
            'TWO_FACTOR_REQUIRED',
            'Se requiere el código de verificación (2FA) para completar el acceso',
            0,
            result.token
          );
        }
        return buildBackendSession(email.trim().toLowerCase(), result.token, result.expiresAt);
      }
      throw new AuthError('INVALID_CREDENTIALS', ACCESS_DENIED_MESSAGE);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      if (msg.includes('ADMIN_NOT_CONFIGURED')) {
        // Sin secretos configurados en el backend → error explícito (no se
        // intenta ningún otro método que pueda exponer credenciales)
        throw new AuthError('AUTH_NOT_CONFIGURED', ADMIN_NOT_CONFIGURED_MESSAGE);
      }
      if (msg.includes('RATE_LIMITED')) {
        const seconds = Number(msg.split(':')[1]) || 60;
        throw new AuthError('RATE_LIMITED', 'Demasiados intentos de acceso', seconds);
      }
      // Cualquier otro fallo → se continúa con el proveedor (si existe)
    }
  }

  // 2) Proveedor de autenticación (Supabase Auth) si está configurado
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    return supabasePasswordLogin(email, password);
  }

  // 3) Web sin proveedor de autenticación → no existe ningún método seguro
  //    de verificación en el navegador (no se lleva ningún secreto al bundle)
  if (!isTauri()) {
    throw new AuthError('AUTH_NOT_CONFIGURED', ADMIN_NOT_CONFIGURED_MESSAGE);
  }

  // 4) Credenciales incorrectas → rechazo de auditoría
  throw new AuthError('INVALID_CREDENTIALS', ACCESS_DENIED_MESSAGE);
}

/**
 * Intercambia el token PENDIENTE por la sesión admin real verificando el
 * código TOTP (2FA). La verificación ocurre SIEMPRE en el backend (Rust):
 * el frontend sólo transporta el código introducido por el administrador.
 */
export async function completeTwoFactorLogin(
  email: string,
  pendingToken: string,
  code: string
): Promise<AdminSession> {
  if (!isTauri()) {
    throw new AuthError('AUTH_NOT_CONFIGURED', ADMIN_NOT_CONFIGURED_MESSAGE);
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke<LoginResultPayload>('two_factor_verify_login', {
      token: pendingToken,
      code: code.trim(),
      device: currentDeviceLabel(),
    });
    if (result.role === 'admin' && result.token) {
      return buildBackendSession(email.trim().toLowerCase(), result.token, result.expiresAt);
    }
    throw new AuthError('INVALID_2FA_CODE', 'Código de verificación no válido');
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
    if (msg.includes('INVALID_CODE')) {
      throw new AuthError('INVALID_2FA_CODE', 'Código de verificación no válido');
    }
    if (msg.includes('SESSION_EXPIRED')) {
      throw new AuthError(
        'TWO_FACTOR_REQUIRED',
        'La verificación caducó: vuelve a iniciar sesión con tu contraseña'
      );
    }
    if (msg.includes('RATE_LIMITED')) {
      const seconds = Number(msg.split(':')[1]) || 60;
      throw new AuthError('RATE_LIMITED', 'Demasiados intentos de código', seconds);
    }
    throw new AuthError('INVALID_2FA_CODE', 'No se pudo verificar el código (2FA)');
  }
}

async function supabasePasswordLogin(email: string, password: string): Promise<AdminSession> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY as string,
      },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'No se pudo contactar con el servidor de autenticación');
  }

  if (!res.ok) {
    throw new AuthError('INVALID_CREDENTIALS', ACCESS_DENIED_MESSAGE);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    user?: { id?: string; email?: string };
  };

  const session: AdminSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: {
      id: data.user?.id ?? 'unknown',
      email: data.user?.email ?? email,
      // Provisional: el rol real solo se acepta si lo emitió el servidor
      role: 'user',
    },
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    provider: 'supabase',
  };

  // Verificación de rol Admin: sale del claim del JWT emitido por Supabase
  // (complementa las políticas RLS del servidor). Si no está → sin panel.
  if (!hasAdminClaim(session)) {
    throw new AuthError(
      'NO_ADMIN_ROLE',
      'Acceso No Autorizado: La cuenta no dispone de rol Admin'
    );
  }
  session.user.role = 'admin';

  return session;
}

/**
 * (Eliminado) `buildLocalAdminSession` generaba un JWT con rol "admin" desde
 * React. Eso permitiría fabricar una sesión admin manipulando el navegador,
 * por lo que el rol y el token los emite ahora únicamente el backend.
 */