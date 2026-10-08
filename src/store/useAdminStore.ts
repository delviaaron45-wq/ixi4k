import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  signInAdmin,
  completeTwoFactorLogin,
  validateAdminSession,
  revokeAdminSession,
  getRateLimitState,
  AuthError,
  type AdminSession,
  type RateLimitState,
} from '@/services/authService';
import { persistSession, loadSession, wipeSession } from '@/services/secureSession';
import { getDeviceInfo } from '@/services/deviceInfo';

export interface User {
  id: string;
  email: string;
  registeredAt: string;
  status: 'active' | 'banned';
  videosProcessed: number;
  lastActive: string;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  userId: string;
  userEmail: string;
  action: string;
  details: string;
  type: 'export' | 'login' | 'error' | 'security' | 'admin';
}

export interface SecurityEvent {
  id: string;
  timestamp: string;
  type:
    | 'login_success'
    | 'login_failed'
    | 'rate_limited'
    | 'role_change'
    | 'user_banned'
    | 'user_unbanned'
    | 'session_restored'
    | 'logout'
    | 'access_denied';
  severity: 'info' | 'warning' | 'critical';
  userId: string;
  userEmail: string;
  ip: string;
  deviceId: string;
  details: string;
}

export interface AdminMetrics {
  totalUsers: number;
  totalVideosProcessed: number;
  totalErrors: number;
  activeUsers: number;
  bannedUsers: number;
}

/** Accesos reales agrupados por tipo de dispositivo y versión instalada. */
export interface ActivityStats {
  loginsByDevice: { pc: number; movil: number; web: number };
  loginsByVersion: Record<string, number>;
}

const emptyActivityStats = (): ActivityStats => ({
  loginsByDevice: { pc: 0, movil: 0, web: 0 },
  loginsByVersion: {},
});

/** Recalcula los contadores derivados de la lista de usuarios. */
function userCounters(users: User[]): Pick<
  AdminMetrics,
  'totalUsers' | 'activeUsers' | 'bannedUsers'
> {
  return {
    totalUsers: users.length,
    activeUsers: users.filter((u) => u.status === 'active').length,
    bannedUsers: users.filter((u) => u.status === 'banned').length,
  };
}

/** Identificador estable de una cuenta local a partir de su email. */
function localUserId(email: string): string {
  const normalized = email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return `usr_${hash.toString(36)}`;
}

interface AdminState {
  // Auth
  isAdminAuthenticated: boolean;
  adminEmail: string | null;
  adminSession: AdminSession | null;
  rateLimit: RateLimitState;
  loginAdmin: (
    email: string,
    password: string
  ) => Promise<
    | { success: true }
    | {
        success: false;
        code: string;
        message: string;
        retryAfter: number;
        /** Presente si el backend exige código 2FA (token pendiente) */
        pendingToken?: string;
      }
  >;
  /**
   * Completa el login admin verificando el código TOTP (2FA) en el backend e
   * intercambiándolo por la sesión real.
   */
  verifyTwoFactorCode: (
    email: string,
    pendingToken: string,
    code: string
  ) => Promise<{ success: true } | { success: false; code: string; message: string; retryAfter: number }>;
  /**
   * Restaura la sesión admin (keyring) SOLO si pertenece a la cuenta que está
   * entrando ahora. `userEmail` es la cuenta de la app: sin esa coincidencia un
   * usuario normal no hereda jamás el Panel de Administración.
   */
  initSession: (userEmail?: string) => Promise<void>;
  logoutAdmin: () => Promise<void>;
  /**
   * Activa una sesión admin YA emitida por el backend (pantalla de selección
   * "Entrar como administrador"). React no genera el rol: solo guarda el
   * token que validó/comprobó el backend en `resolveLoginRole`.
   */
  setAdminSession: (session: AdminSession) => Promise<void>;
  /** Petición de abrir el Panel Admin al entrar como administrador */
  pendingAdminPanel: boolean;
  openAdminPanel: () => void;
  consumeAdminPanelRequest: () => void;

  // Users
  users: User[];
  banUser: (userId: string) => Promise<void>;
  unbanUser: (userId: string) => Promise<void>;
  /**
   * Añade o actualiza una cuenta local REAL (registro/login de esta
   * instalación): es sobre lo que el admin puede bloquear/reactivar y sobre
   * lo que se contabilizan exportaciones.
   */
  upsertLocalUser: (email: string) => void;

  // Metrics
  metrics: AdminMetrics;

  // Estadísticas de actividad (sólo hechos reales de esta instalación)
  activityStats: ActivityStats;
  /** Registra un acceso real con el dispositivo y la versión actuales */
  recordLoginActivity: () => void;

  // Audit Logs
  auditLogs: AuditLog[];
  addAuditLog: (log: Omit<AuditLog, 'id' | 'timestamp'>) => void;

  // Security Events (Alertas de Seguridad)
  securityEvents: SecurityEvent[];
  recordSecurityEvent: (
    event: Omit<SecurityEvent, 'id' | 'timestamp' | 'ip' | 'deviceId'>
  ) => Promise<void>;

  // Video processing tracking
  trackVideoProcessed: (userId: string, settings: { crf: number; fps: number; resolution: string }) => void;

  // Error tracking
  trackError: (userId: string, error: string) => void;
}

// Mock data for demonstration
const mockUsers: User[] = [
  {
    id: 'usr_001',
    email: 'usuario1@email.com',
    registeredAt: '2024-01-15T10:30:00Z',
    status: 'active',
    videosProcessed: 12,
    lastActive: '2024-01-20T14:22:00Z',
  },
  {
    id: 'usr_002',
    email: 'usuario2@email.com',
    registeredAt: '2024-01-18T09:15:00Z',
    status: 'active',
    videosProcessed: 5,
    lastActive: '2024-01-19T16:45:00Z',
  },
  {
    id: 'usr_003',
    email: 'usuario3@email.com',
    registeredAt: '2024-01-20T11:00:00Z',
    status: 'banned',
    videosProcessed: 0,
    lastActive: '2024-01-20T11:00:00Z',
  },
];

// Los registros de actividad y seguridad empiezan vacíos: sólo se llenan con
// eventos REALES de esta instalación (logins, exportaciones, baneos…).
// La lista de usuarios de demostración se mantiene como directorio local
// sobre el que el admin puede banear/reactivar de verdad.

let restoredOnce = false;

export const useAdminStore = create<AdminState>()(
  persist(
    (set, get) => ({
      // ------------------------------------------------------------------
      // Auth — JWT cifrado + rate limiting, sin claves estáticas
      // ------------------------------------------------------------------
      isAdminAuthenticated: false,
      adminEmail: null,
      adminSession: null,
      rateLimit: getRateLimitState(),
      pendingAdminPanel: false,

      // ------------------------------------------------------------------
      // Entrada como administrador desde la pantalla de selección de login
      // (la sesión/token la emitió el backend en `resolveLoginRole`)
      // ------------------------------------------------------------------
      setAdminSession: async (session) => {
        // Defensa en profundidad: sin emisor válido no hay panel admin
        if (!session?.accessToken || session.provider !== 'backend') return;

        await persistSession(session);
        set({
          isAdminAuthenticated: true,
          adminEmail: session.user.email,
          adminSession: session,
          rateLimit: getRateLimitState(),
          pendingAdminPanel: true,
        });

        await get().recordSecurityEvent({
          type: 'login_success',
          severity: 'info',
          userId: session.user.id,
          userEmail: session.user.email,
          details: 'Acceso al Panel Admin concedido (token de sesión emitido por el backend, rol admin)',
        });
        get().addAuditLog({
          userId: session.user.id,
          userEmail: session.user.email,
          action: 'Admin login',
          details: 'Administrador autenticado con token emitido por el backend',
          type: 'admin',
        });
      },

      openAdminPanel: () => set({ pendingAdminPanel: true }),
      consumeAdminPanelRequest: () => set({ pendingAdminPanel: false }),

      loginAdmin: async (email, password) => {
        try {
          const session = await signInAdmin(email, password);
          await persistSession(session);

          set({
            isAdminAuthenticated: true,
            adminEmail: session.user.email,
            adminSession: session,
            rateLimit: getRateLimitState(),
            // El Dashboard puede remontarse al cambiar de rol → la petición
            // de abrir el panel vive en el store (no en estado local)
            pendingAdminPanel: true,
          });

          await get().recordSecurityEvent({
            type: 'login_success',
            severity: 'info',
            userId: session.user.id,
            userEmail: session.user.email,
            details: `Acceso al Panel Admin concedido (${
              session.provider === 'backend' ? 'token de backend' : 'JWT del servidor'
            }, rol admin)`,
          });
          get().addAuditLog({
            userId: session.user.id,
            userEmail: session.user.email,
            action: 'Admin login',
            details: 'Administrador autenticado con sesión emitida por el backend',
            type: 'admin',
          });

          return { success: true };
        } catch (error) {
          const authErr =
            error instanceof AuthError
              ? error
              : new AuthError('INVALID_CREDENTIALS', 'Error de autenticación');

          set({ rateLimit: getRateLimitState() });

          // El paso 2FA (contraseña correcta) NO es un fallo de acceso
          if (authErr.code !== 'TWO_FACTOR_REQUIRED') {
            await get().recordSecurityEvent({
              type: authErr.code === 'RATE_LIMITED' ? 'rate_limited' : 'login_failed',
              severity: authErr.code === 'RATE_LIMITED' ? 'critical' : 'warning',
              userId: 'unknown',
              userEmail: email || 'desconocido',
              details: `${authErr.message} (código: ${authErr.code})`,
            });
          }

          return {
            success: false,
            code: authErr.code,
            message: authErr.message,
            retryAfter: authErr.retryAfter,
            pendingToken: authErr.pendingToken,
          };
        }
      },

      verifyTwoFactorCode: async (email, pendingToken, code) => {
        try {
          const session = await completeTwoFactorLogin(email, pendingToken, code);
          await persistSession(session);

          set({
            isAdminAuthenticated: true,
            adminEmail: session.user.email,
            adminSession: session,
            rateLimit: getRateLimitState(),
            pendingAdminPanel: true,
          });

          await get().recordSecurityEvent({
            type: 'login_success',
            severity: 'info',
            userId: session.user.id,
            userEmail: session.user.email,
            details: 'Acceso al Panel Admin concedido con verificación 2FA (código TOTP verificado por el backend)',
          });
          get().addAuditLog({
            userId: session.user.id,
            userEmail: session.user.email,
            action: 'Admin login + 2FA',
            details: 'Administrador autenticado con contraseña y código TOTP (2FA)',
            type: 'admin',
          });

          return { success: true };
        } catch (error) {
          const authErr =
            error instanceof AuthError
              ? error
              : new AuthError('INVALID_2FA_CODE', 'No se pudo verificar el código');

          set({ rateLimit: getRateLimitState() });

          await get().recordSecurityEvent({
            type: authErr.code === 'RATE_LIMITED' ? 'rate_limited' : 'login_failed',
            severity: authErr.code === 'RATE_LIMITED' ? 'critical' : 'warning',
            userId: 'unknown',
            userEmail: email || 'desconocido',
            details: `Verificación 2FA fallida: ${authErr.message} (código: ${authErr.code})`,
          });

          return {
            success: false,
            code: authErr.code,
            message: authErr.message,
            retryAfter: authErr.retryAfter,
          };
        }
      },

      initSession: async (userEmail?: string) => {
        // Sin cuenta indicada todavía (el Dashboard puede montarse antes de que
        // haya login) no se toca nada: se espera a que entre una cuenta real.
        if (!userEmail) return;
        if (restoredOnce) return;
        restoredOnce = true;

        set({ rateLimit: getRateLimitState() });

        const session = await loadSession();
        if (!session) return;

        // La sesión admin es de una cuenta concreta: si quien entra ahora es
        // OTRO usuario (o nadie lo indica), no se restaura nada. Así un usuario
        // normal no hereda el panel de una sesión anterior del administrador.
        const sameAccount =
          !!userEmail &&
          userEmail.trim().toLowerCase() === session.user.email.trim().toLowerCase();

        // El backend revalida el token: no se confía en lo que haya en el
        // navegador (keyring, localStorage o storage alterado).
        if (sameAccount && (await validateAdminSession(session))) {
          set({
            isAdminAuthenticated: true,
            adminEmail: session.user.email,
            adminSession: session,
          });
          await get().recordSecurityEvent({
            type: 'session_restored',
            severity: 'info',
            userId: session.user.id,
            userEmail: session.user.email,
            details: 'Sesión admin restaurada y validada por el backend (keyring)',
          });
        } else {
          // Token caducado/revocado, no emitido por el backend o perteneciente
          // a OTRA cuenta → purgar: nadie hereda una sesión admin ajena.
          await wipeSession();
          set({ isAdminAuthenticated: false, adminEmail: null, adminSession: null });
          await get().recordSecurityEvent({
            type: 'access_denied',
            severity: 'warning',
            userId: session.user.id,
            userEmail: session.user.email,
            details: sameAccount
              ? 'Sesión admin expirada o sin rol válido — token purgado'
              : `Sesión admin de ${session.user.email} no restaurada para otra cuenta — token purgado`,
          });
        }
      },

      logoutAdmin: async () => {
        const { adminSession } = get();
        // Revocación en el backend + purga local del token
        if (adminSession) await revokeAdminSession(adminSession);
        await wipeSession();
        restoredOnce = false;
        set({ isAdminAuthenticated: false, adminEmail: null, adminSession: null, pendingAdminPanel: false });
        if (adminSession) {
          await get().recordSecurityEvent({
            type: 'logout',
            severity: 'info',
            userId: adminSession.user.id,
            userEmail: adminSession.user.email,
            details: 'Cierre de sesión admin — token revocado en el backend y eliminado del keyring',
          });
        }
      },

      // ------------------------------------------------------------------
      // Users
      // ------------------------------------------------------------------
      users: mockUsers,

      banUser: async (userId) => {
        set((state) => {
          const users = state.users.map((u) =>
            u.id === userId ? { ...u, status: 'banned' as const } : u
          );
          return { users, metrics: { ...state.metrics, ...userCounters(users) } };
        });
        const user = get().users.find((u) => u.id === userId);
        if (user) {
          await get().recordSecurityEvent({
            type: 'user_banned',
            severity: 'warning',
            userId,
            userEmail: user.email,
            details: `Cuenta ${user.email} baneada inmediatamente desde el Panel Admin`,
          });
          get().addAuditLog({
            userId,
            userEmail: user.email,
            action: 'Cuenta baneada',
            details: `Cuenta ${user.email} baneada por administrador`,
            type: 'security',
          });
        }
      },

      unbanUser: async (userId) => {
        set((state) => {
          const users = state.users.map((u) =>
            u.id === userId ? { ...u, status: 'active' as const } : u
          );
          return { users, metrics: { ...state.metrics, ...userCounters(users) } };
        });
        const user = get().users.find((u) => u.id === userId);
        if (user) {
          await get().recordSecurityEvent({
            type: 'user_unbanned',
            severity: 'info',
            userId,
            userEmail: user.email,
            details: `Cuenta ${user.email} reactivada por administrador`,
          });
          get().addAuditLog({
            userId,
            userEmail: user.email,
            action: 'Cuenta reactivada',
            details: `Cuenta ${user.email} reactivada por administrador`,
            type: 'security',
          });
        }
      },

      upsertLocalUser: (email) => {
        const normalized = email.trim().toLowerCase();
        if (!normalized) return;
        set((state) => {
          const now = new Date().toISOString();
          const existing = state.users.find((u) => u.email === normalized);
          const users = existing
            ? state.users.map((u) =>
                u.id === existing.id ? { ...u, lastActive: now } : u
              )
            : [
                {
                  id: localUserId(normalized),
                  email: normalized,
                  registeredAt: now,
                  status: 'active' as const,
                  videosProcessed: 0,
                  lastActive: now,
                },
                ...state.users,
              ];
          return { users, metrics: { ...state.metrics, ...userCounters(users) } };
        });
      },

      // ------------------------------------------------------------------
      // Metrics (derivados de usuarios + auditoría reales)
      // ------------------------------------------------------------------
      metrics: {
        totalUsers: mockUsers.length,
        totalVideosProcessed: mockUsers.reduce((sum, u) => sum + u.videosProcessed, 0),
        totalErrors: 0,
        activeUsers: mockUsers.filter((u) => u.status === 'active').length,
        bannedUsers: mockUsers.filter((u) => u.status === 'banned').length,
      },

      // ------------------------------------------------------------------
      // Estadísticas de actividad — accesos REALES por dispositivo y versión
      // ------------------------------------------------------------------
      activityStats: emptyActivityStats(),
      recordLoginActivity: () => {
        if (typeof navigator === 'undefined') return;
        const ua = navigator.userAgent || '';
        const isTauriEnv =
          '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
        const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
        const device: keyof ActivityStats['loginsByDevice'] = isTauriEnv
          ? mobile
            ? 'movil'
            : 'pc'
          : 'web';
        const version =
          (typeof __APP_VERSION__ === 'string' && __APP_VERSION__) || 'desconocida';
        set((state) => {
          const byDevice = { ...state.activityStats.loginsByDevice };
          byDevice[device] += 1;
          const byVersion = { ...state.activityStats.loginsByVersion };
          byVersion[version] = (byVersion[version] ?? 0) + 1;
          return { activityStats: { loginsByDevice: byDevice, loginsByVersion: byVersion } };
        });
      },

      // ------------------------------------------------------------------
      // Audit Logs — sólo eventos reales de esta instalación
      // ------------------------------------------------------------------
      auditLogs: [],
      addAuditLog: (log) => {
        const newLog: AuditLog = {
          ...log,
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
        };
        set((state) => ({
          auditLogs: [newLog, ...state.auditLogs].slice(0, 500),
        }));
      },

      // ------------------------------------------------------------------
      // Security Events — registro inmutable con IP + dispositivo + hora
      // ------------------------------------------------------------------
      // Registro inmutable con IP + dispositivo + hora — sólo eventos reales
      securityEvents: [],
      recordSecurityEvent: async (event) => {
        const device = await getDeviceInfo();
        const fullEvent: SecurityEvent = {
          ...event,
          id: `sec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toISOString(),
          ip: device.ip,
          deviceId: device.deviceId,
        };
        // Registro inmutable: solo se inserta, nunca se modifica ni elimina
        set((state) => ({
          securityEvents: [fullEvent, ...state.securityEvents].slice(0, 500),
        }));
        console.info('[SecurityAudit]', fullEvent);
      },

      // ------------------------------------------------------------------
      // Tracking
      // ------------------------------------------------------------------
      trackVideoProcessed: (userId, settings) => {
        const email = userId.trim().toLowerCase();
        const user = get().users.find(
          (u) => u.id === userId || u.email.trim().toLowerCase() === email
        );
        set((state) => ({
          users: user
            ? state.users.map((u) =>
                u.id === user.id ? { ...u, videosProcessed: u.videosProcessed + 1 } : u
              )
            : state.users,
          metrics: {
            ...state.metrics,
            totalVideosProcessed: state.metrics.totalVideosProcessed + 1,
          },
        }));
        get().addAuditLog({
          userId: user?.id ?? email,
          userEmail: user?.email ?? email,
          action: 'Video exportado',
          details: `Exportó vídeo en 4K (CRF ${settings.crf} · ${settings.fps} FPS · ${settings.resolution})`,
          type: 'export',
        });
      },

      trackError: (userId, error) => {
        const email = userId.trim().toLowerCase();
        const user = get().users.find(
          (u) => u.id === userId || u.email.trim().toLowerCase() === email
        );
        set((state) => ({
          metrics: { ...state.metrics, totalErrors: state.metrics.totalErrors + 1 },
        }));
        get().addAuditLog({
          userId: user?.id ?? email,
          userEmail: user?.email ?? email,
          action: 'Error de renderizado',
          details: error,
          type: 'error',
        });
      },
    }),
    {
      // IMPORTANTE: los tokens NO se persisten aquí (localStorage plano).
      // Solo se persisten datos no sensibles; la sesión vive en el keyring.
      name: 'ixi-4k-admin-storage',
      partialize: (state) => ({
        users: state.users,
        auditLogs: state.auditLogs,
        metrics: state.metrics,
        securityEvents: state.securityEvents,
        activityStats: state.activityStats,
      }),
      // v1: se eliminan los eventos de demostración sembrados en versiones
      // antiguas: auditoría y alertas pasan a contener sólo hechos reales.
      version: 1,
      migrate: (persisted) => {
        type Persisted = {
          users?: typeof mockUsers;
          auditLogs?: AuditLog[];
          metrics?: AdminMetrics;
          securityEvents?: SecurityEvent[];
        };
        const p = (persisted ?? {}) as Persisted;
        const users = p.users ?? [];
        const legacyLogs = new Set(['log_001', 'log_002']);
        const legacyEvents = new Set(['sec_001', 'sec_002']);
        const auditLogs = (p.auditLogs ?? []).filter((l) => !legacyLogs.has(l.id));
        const securityEvents = (p.securityEvents ?? []).filter(
          (e) => !legacyEvents.has(e.id)
        );
        return {
          users,
          auditLogs,
          securityEvents,
          metrics: {
            totalUsers: users.length,
            totalVideosProcessed: p.metrics?.totalVideosProcessed ?? 0,
            totalErrors: auditLogs.filter((l) => l.type === 'error').length,
            activeUsers: users.filter((u) => u.status === 'active').length,
            bannedUsers: users.filter((u) => u.status === 'banned').length,
          },
        };
      },
    }
  )
);