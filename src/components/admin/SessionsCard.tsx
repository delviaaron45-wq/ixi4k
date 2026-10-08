import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  LogOut,
  Monitor,
  RefreshCw,
  Smartphone,
  Timer,
  WifiOff,
} from 'lucide-react';
import {
  listAdminSessions,
  revokeAdminSessionById,
  revokeOtherAdminSessions,
  type AdminSessionView,
} from '@/services/adminServices';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAdminStore } from '@/store/useAdminStore';

function deviceIcon(device: string) {
  return /android|ios|móvil|movil|iphone|ipad/i.test(device) ? (
    <Smartphone className="w-4 h-4 text-ixi-violet" />
  ) : (
    <Monitor className="w-4 h-4 text-ixi-cyan" />
  );
}

function ago(seconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return 'hace unos segundos';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}

/**
 * Sesiones y dispositivos con acceso admin activo: visibilidad y cierre
 * remoto. Los tokens nunca salen del backend; sólo se listan metadatos.
 */
export function SessionsCard() {
  const adminSession = useAdminStore((s) => s.adminSession);
  const adminEmail = useAdminStore((s) => s.adminEmail);
  const addAuditLog = useAdminStore((s) => s.addAuditLog);
  const logoutAdmin = useAdminStore((s) => s.logoutAdmin);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [sessions, setSessions] = useState<AdminSessionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<AdminSessionView | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [notice, setNotice] = useState('');

  const token = adminSession?.accessToken;

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const result = await listAdminSessions(token);
      setAvailable(result.available);
      setReason(result.reason);
      setSessions(result.sessions);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logAudit = (action: string, details: string) => {
    addAuditLog({
      userId: 'admin_master',
      userEmail: adminEmail ?? 'admin',
      action,
      details,
      type: 'security',
    });
  };

  const revokeOne = async () => {
    if (!token || !pendingRevoke) return false;
    setLoading(true);
    try {
      await revokeAdminSessionById(token, pendingRevoke.id);
      logAudit(
        'Sesión cerrada remotamente',
        `Sesión ${pendingRevoke.device} (${pendingRevoke.hostname}) cerrada desde el panel`
      );
      setNotice(
        pendingRevoke.current
          ? 'La sesión actual se ha cerrado: vuelve a iniciar sesión.'
          : 'Sesión cerrada remotamente.'
      );
      if (pendingRevoke.current) {
        setPendingRevoke(null);
        await logoutAdmin();
        return true;
      }
      setPendingRevoke(null);
      await refresh();
      return true;
    } catch {
      setNotice('No se pudo cerrar la sesión (puede que ya no exista).');
      setPendingRevoke(null);
      await refresh();
      return false;
    } finally {
      setLoading(false);
    }
  };

  const revokeOthers = async () => {
    if (!token) return false;
    setLoading(true);
    try {
      const count = await revokeOtherAdminSessions(token);
      logAudit('Sesiones cerradas', `Se cerraron ${count} sesión(es) distintas a la actual`);
      setNotice(`${count} sesión(es) cerrada(s).`);
      setConfirmOthers(false);
      await refresh();
      return true;
    } catch {
      setNotice('No se pudieron cerrar las sesiones.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const othersCount = sessions.filter((s) => !s.current).length;

  return (
    <motion.div
      className="card p-4 sm:p-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25 }}
    >
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className="font-semibold flex items-center gap-2">
          <Monitor className="w-5 h-5 text-ixi-cyan" />
          Sesiones y Dispositivos Activos
        </h3>
        <div className="flex items-center gap-2">
          {othersCount > 0 && (
            <button
              type="button"
              onClick={() => setConfirmOthers(true)}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-ixi-danger/10 text-ixi-danger text-xs font-medium hover:bg-ixi-danger/20 transition-colors disabled:opacity-50"
            >
              Cerrar las demás
            </button>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="p-1.5 rounded-lg bg-ixi-bgCard border border-ixi-border text-ixi-textMuted hover:text-ixi-cyan transition-colors disabled:opacity-50"
            title="Actualizar lista"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <p className="text-xs text-ixi-textMuted mb-4">
        Cada acceso del administrador queda registrado con su dispositivo. Puedes cerrar
        cualquier sesión a distancia; los tokens nunca abandonan el backend.
      </p>

      {notice && (
        <div className="mb-3 p-3 rounded-xl bg-ixi-cyan/10 border border-ixi-cyan/30 text-xs text-ixi-cyan">
          {notice}
        </div>
      )}

      {available === null && <p className="text-sm text-ixi-textMuted">Cargando sesiones…</p>}

      {available === false && (
        <div className="p-3 rounded-xl bg-ixi-bgSecondary/50 border border-white/10 text-xs text-ixi-textMuted flex items-start gap-2">
          <WifiOff className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{reason ?? 'La gestión de sesiones no está disponible en este entorno.'}</span>
        </div>
      )}

      {available && sessions.length === 0 && (
        <p className="text-sm text-ixi-textMuted">No hay sesiones activas registradas.</p>
      )}

      {available && sessions.length > 0 && (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`flex items-center gap-3 p-3 rounded-xl border ${
                s.current
                  ? 'bg-ixi-cyan/5 border-ixi-cyan/30'
                  : 'bg-ixi-bgSecondary/40 border-white/10'
              }`}
            >
              {deviceIcon(s.device)}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-ixi-text truncate">{s.device}</p>
                  {s.current && (
                    <span className="px-1.5 py-0.5 rounded bg-ixi-cyan/15 text-ixi-cyan text-[10px] font-bold uppercase">
                      Este dispositivo
                    </span>
                  )}
                </div>
                <p className="text-xs text-ixi-textMuted truncate">
                  {s.hostname} · IP {s.ip}
                </p>
                <p className="text-[11px] text-ixi-textMuted flex items-center gap-1 mt-0.5">
                  <Timer className="w-3 h-3" />
                  Activa {ago(s.lastSeen)} · creada {ago(s.createdAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setNotice('');
                  setPendingRevoke(s);
                }}
                disabled={loading}
                className="p-2 rounded-lg bg-ixi-danger/10 text-ixi-danger hover:bg-ixi-danger/20 transition-colors disabled:opacity-50"
                title={s.current ? 'Cerrar esta sesión (saldrás)' : 'Cerrar esta sesión'}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingRevoke}
        title={pendingRevoke?.current ? 'Cerrar la sesión actual' : 'Cerrar sesión remotamente'}
        message={
          pendingRevoke?.current
            ? 'Cerrarás TU sesión actual y saldrás del panel. Necesitarás contraseña (y 2FA si está activo) para volver a entrar.'
            : `Se cerrará la sesión de "${pendingRevoke?.device}" (${pendingRevoke?.hostname}). El dispositivo tendrá que volver a iniciar sesión.`
        }
        confirmLabel="Cerrar sesión"
        danger
        requirePassword
        adminEmail={adminEmail ?? ''}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={revokeOne}
      />

      <ConfirmDialog
        open={confirmOthers}
        title="Cerrar todas las demás sesiones"
        message={`Se cerrarán ${othersCount} sesión(es) activa(s) distinta de la actual. Esos dispositivos deberán volver a iniciar sesión.`}
        confirmLabel="Cerrar las demás"
        danger
        requirePassword
        adminEmail={adminEmail ?? ''}
        onCancel={() => setConfirmOthers(false)}
        onConfirm={revokeOthers}
      />
    </motion.div>
  );
}
