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

import { persistSession } from './secureSession';

const ACCESS_DENIED_MESSAGE =
  'Acceso No Autorizado: Credenciales de Administrador Incorrectas';

/**
 * Web (navegador): no hay ningún proveedor de autenticación configurado.
 * NO es una limitación de plataforma — el acceso web se habilita añadiendo
 * las variables de Supabase Auth (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
 */
const WEB_AUTH_NOT_CONFIGURED_MESSAGE =
  'Autenticación no configurada en el servidor: añade VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (Supabase Auth) para habilitar el acceso de administrador en la web';

/** App de escritorio sin credenciales de administrador configuradas. */
const NATIVE_AUTH_NOT_CONFIGURED_MESSAGE =
  'Autenticación no configurada: ejecuta «npm run admin:setup» para crear las credenciales de administrador';

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
// Rate Limiting: 5 intentos fallidos como máximo por ventana de 60 segundos
//
// Los intentos se persisten en `sessionStorage` (por pestaña): recargar la
// página NO reinicia el contador, por lo que el bloqueo anti fuerza bruta
// sobrevive a un F5. Al cerrar la pestaña el contador desaparece.
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;
const RATE_STORAGE_KEY = 'ixi4k_auth_rate_limit';

function readAttempts(): number[] {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(RATE_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number' && n > 0);
  } catch {
    return [];
  }
}

function writeAttempts(list: number[]): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(RATE_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Sin sessionStorage: el contador sigue en memoria durante la sesión
  }
}

let attemptTimestamps: number[] = readAttempts();

function pruneAttempts(): number[] {
  const now = Date.now();
  attemptTimestamps = attemptTimestamps.filter((t) => now - t < WINDOW_MS);
  return attemptTimestamps;
}

export interface RateLimitState {
  used: number;
  remaining: number;
  locked: boolean;
  retryAfter: number;
}

export function getRateLimitState(): RateLimitState {
  const pruned = pruneAttempts();
  const now = Date.now();
  const used = pruned.length;
  const locked = used >= MAX_ATTEMPTS;
  const retryAfter = locked
    ? Math.ceil((WINDOW_MS - (now - pruned[0])) / 1000)
    : 0;
  return {
    used,
    remaining: Math.max(0, MAX_ATTEMPTS - used),
    locked,
    retryAfter: Math.max(0, retryAfter),
  };
}

/** Lanza el error de bloqueo si la ventana de rate limiting está activa. */
function assertNotRateLimited(): void {
  const state = getRateLimitState();
  if (state.locked) {
    throw new AuthError('RATE_LIMITED', 'Demasiados intentos de acceso', state.retryAfter);
  }
}

/** Registra un intento FALLIDO (compartido entre todos los puntos de login). */
function recordFailedAttempt(): void {
  pruneAttempts();
  attemptTimestamps.push(Date.now());
  if (attemptTimestamps.length > 50) attemptTimestamps = attemptTimestamps.slice(-50);
  writeAttempts(attemptTimestamps);
}

/** Un acceso correcto reinicia la ventana: solo se penalizan los fallos. */
function clearFailedAttempts(): void {
  attemptTimestamps = [];
  writeAttempts(attemptTimestamps);
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

/**
 * Lee el rol del payload del JWT (SOLO lectura informativa para la UI).
 *
 * ATENCIÓN: decodificar el payload NO verifica la firma, por lo que este
 * dato es manipulable desde el navegador. Las decisiones de seguridad (rol
 * admin, apertura del panel, RLS) se toman SIEMPRE con respuestas del
 * servidor: endpoint de login, `GET /auth/v1/user` y políticas RLS.
 */
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
 * - Sesión `supabase`: se renueva el token si caducó (refresh token) y se
 *   verifica contra el SERVIDOR de Supabase (`GET /auth/v1/user`): quien
 *   responde es el servidor validando la firma del JWT, nunca el navegador.
 *   El rol admin se lee de la respuesta del servidor (app_metadata), que es
 *   imposible de manipular desde el cliente.
 * - Sesión `backend`: se envía el token al proceso Rust, que comprueba que lo
 *   emitió él y que no ha caducado. Un token inventado o copiado del navegador
 *   (localStorage, keyring, URL…) es rechazado.
 * - Cualquier otra sesión (sin `provider`, antigua o alterada) → inválida.
 */
export async function validateAdminSession(session: AdminSession | null): Promise<boolean> {
  if (!session || !session.accessToken) return false;

  if (session.provider === 'supabase') return validateSupabaseSessionWithServer(session);

  if (session.expiresAt <= Date.now() + 5_000) return false;
  if (session.provider !== 'backend' || !isTauri()) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('verify_admin_session', { token: session.accessToken });
  } catch {
    return false;
  }
}

/**
 * Verificación server-side de una sesión Supabase:
 *  1. Si el access token caducó (o está a punto de), se renueva con el
 *     refresh token y la sesión renovada se guarda (persistSession).
 *  2. Se consulta `GET /auth/v1/user` con el token: el servidor Supabase
 *     valida la firma del JWT y devuelve el usuario real con su rol.
 *  3. Solo devuelve `true` si el servidor indica rol admin.
 */
async function validateSupabaseSessionWithServer(session: AdminSession): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;

  // 1) Renovación silenciosa si el access token ya caducó
  if (session.expiresAt <= Date.now() + 30_000) {
    const renewed = await renewSupabaseSession(session);
    if (!renewed) return false;
  }

  // 2) Verificación en el servidor (firma del JWT validada por Supabase)
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.accessToken}`,
      },
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;

  // 3) El rol sale de la RESPUESTA DEL SERVIDOR, no de un payload del cliente
  try {
    const user = (await res.json()) as {
      app_metadata?: { role?: string };
      user_metadata?: { role?: string };
    };
    const role = user.app_metadata?.role ?? user.user_metadata?.role;
    return role === 'admin';
  } catch {
    return false;
  }
}

/**
 * Renueva el access token de una sesión Supabase con su refresh token y
 * persiste la sesión resultante. Devuelve `false` si Supabase la rechaza
 * (sesión revocada, refresh caducado o red caída → hay que volver a entrar).
 */
async function renewSupabaseSession(session: AdminSession): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !session.refreshToken) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) return false;

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    // Se actualiza EN EL MISMO objeto: el store conserva la referencia viva
    session.accessToken = data.access_token;
    if (data.refresh_token) session.refreshToken = data.refresh_token;
    session.expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    await persistSession(session);
    return true;
  } catch {
    return false;
  }
}

/** Revoca la sesión de administrador en el backend que la emitió. */
export async function revokeAdminSession(session: AdminSession): Promise<void> {
  // Supabase Auth: cierre de sesión en el SERVIDOR (invalida el refresh token
  // para que la sesión no pueda reanimarse desde otro dispositivo).
  if (session.provider === 'supabase') {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.accessToken}`,
        },
      });
    } catch {
      // Sin red: el token caduca por su propia expiración (corta)
    }
    return;
  }

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

  // 2) Web con Supabase Auth: el rol lo decide el SERVIDOR en su respuesta
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    // Ventana anti fuerza bruta compartida con el Panel Admin: mientras dure
    // el bloqueo no se resuelve el rol admin (el login normal no se ve afectado)
    if (getRateLimitState().locked) return { role: 'user' };
    try {
      const session = await supabasePasswordLogin(email, password);
      clearFailedAttempts();
      return { role: 'admin', session };
    } catch (err) {
      // Credenciales inválidas → intento fallido (así la pantalla de login
      // normal NO elude el rate limiting del Panel Admin). Una cuenta válida
      // sin rol admin no penaliza: es un usuario legítimo.
      if (err instanceof AuthError && err.code === 'INVALID_CREDENTIALS') {
        recordFailedAttempt();
      }
      // Sin rol admin o red caída → usuario normal
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
  // Capa 1: rate limiting local (compartido con la pantalla de login normal;
  // persistido en sessionStorage, por lo que un recargado NO reinicia el contador)
  assertNotRateLimited();

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
        clearFailedAttempts();
        return buildBackendSession(email.trim().toLowerCase(), result.token, result.expiresAt);
      }
      throw new AuthError('INVALID_CREDENTIALS', ACCESS_DENIED_MESSAGE);
    } catch (err) {
      if (err instanceof AuthError) {
        if (err.code === 'INVALID_CREDENTIALS') recordFailedAttempt();
        throw err;
      }
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      if (msg.includes('ADMIN_NOT_CONFIGURED')) {
        // Sin secretos configurados en el backend → error explícito (no se
        // intenta ningún otro método que pueda exponer credenciales)
        throw new AuthError('AUTH_NOT_CONFIGURED', NATIVE_AUTH_NOT_CONFIGURED_MESSAGE);
      }
      if (msg.includes('RATE_LIMITED')) {
        const seconds = Number(msg.split(':')[1]) || 60;
        throw new AuthError('RATE_LIMITED', 'Demasiados intentos de acceso', seconds);
      }
      recordFailedAttempt();
      // Cualquier otro fallo → se continúa con el proveedor (si existe)
    }
  }

  // 2) Proveedor de autenticación (Supabase Auth) si está configurado.
  //    El navegador envía las credenciales al SERVIDOR de Supabase: allí se
  //    verifican y solo un usuario con rol admin recibe un JWT válido.
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      const session = await supabasePasswordLogin(email, password);
      clearFailedAttempts();
      return session;
    } catch (err) {
      // Solo los fallos de credenciales cuentan como intento fallido:
      // una cuenta válida sin rol admin no está siendo atacada.
      if (
        err instanceof AuthError &&
        (err.code === 'INVALID_CREDENTIALS' || err.code === 'NO_ADMIN_ROLE')
      ) {
        recordFailedAttempt();
      }
      throw err;
    }
  }

  // 3) Web sin proveedor de autenticación → no existe ningún método seguro
  //    de verificación en el navegador (no se lleva ningún secreto al bundle)
  if (!isTauri()) {
    throw new AuthError('AUTH_NOT_CONFIGURED', WEB_AUTH_NOT_CONFIGURED_MESSAGE);
  }

  // 4) Credenciales incorrectas → rechazo de auditoría
  recordFailedAttempt();
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
    throw new AuthError(
      'AUTH_NOT_CONFIGURED',
      'Verificación en dos pasos (2FA) no disponible en la web: vuelve a iniciar sesión con tu contraseña'
    );
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
    user?: {
      id?: string;
      email?: string;
      app_metadata?: { role?: string };
      user_metadata?: { role?: string };
    };
  };

  // Verificación de rol Admin EN EL SERVIDOR: el rol viaja dentro de la
  // respuesta del endpoint de token (app_metadata), que solo Supabase puede
  // generar — el navegador nunca decide el rol. Sin rol admin → sin panel.
  const serverRole = data.user?.app_metadata?.role ?? data.user?.user_metadata?.role;
  if (serverRole !== 'admin') {
    throw new AuthError(
      'NO_ADMIN_ROLE',
      'Acceso No Autorizado: La cuenta no dispone de rol Admin'
    );
  }

  const session: AdminSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: {
      id: data.user?.id ?? 'unknown',
      email: data.user?.email ?? email,
      role: 'admin',
    },
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    provider: 'supabase',
  };

  return session;
}

/**
 * (Eliminado) `buildLocalAdminSession` generaba un JWT con rol "admin" desde
 * React. Eso permitiría fabricar una sesión admin manipulando el navegador,
 * por lo que el rol y el token los emite ahora únicamente el backend.
 */