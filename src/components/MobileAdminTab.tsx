import { motion } from 'framer-motion';
import { Shield, LogOut, Bug, Wrench, Cpu, Gauge, Smartphone, Mail } from 'lucide-react';
import { useAdminStore } from '@/store/useAdminStore';
import { useReportStore } from '@/store/useReportStore';
import { useMaintenanceStore } from '@/store/useMaintenanceStore';
import { useAppStore } from '@/store/useAppStore';
import {
  detectPlatform,
  detectDeviceTier,
  tierLabel,
  exportDirectoryLabel,
} from '@/services/platformService';

interface MobileAdminTabProps {
  onOpenAdmin: () => void;
  onOpenReport: () => void;
}

const platformLabels: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
  unknown: 'Desconocido',
};

/**
 * Contenido de la pestaña "Admin" en móvil.
 * Acceso completo al Panel Admin (login con credenciales de administrador),
 * inbox de reportes y estado del Modo Mantenimiento — idéntico a escritorio.
 */
export function MobileAdminTab({ onOpenAdmin, onOpenReport }: MobileAdminTabProps) {
  const isAdminAuthenticated = useAdminStore((s) => s.isAdminAuthenticated);
  const adminEmail = useAdminStore((s) => s.adminEmail);
  const logoutAdmin = useAdminStore((s) => s.logoutAdmin);
  const getPendingReportCount = useReportStore((s) => s.getPendingCount);
  const maintenanceMode = useMaintenanceStore((s) => s.maintenanceMode);
  const user = useAppStore((s) => s.user);
  const diagnosticResult = useAppStore((s) => s.diagnosticResult);

  const platform = detectPlatform();
  const tier = detectDeviceTier();
  const pending = getPendingReportCount();

  return (
    <motion.div
      className="space-y-4"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Cuenta actual */}
      <div className="rounded-2xl border border-white/10 bg-ixi-bgCard/70 p-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full bg-gradient-to-br from-ixi-cyan to-ixi-violet flex items-center justify-center shrink-0">
            <span className="text-sm font-bold text-ixi-bg">
              {user?.email?.charAt(0).toUpperCase() || '?'}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5 text-ixi-textMuted shrink-0" />
              {user?.email || 'Invitado'}
            </p>
            <p className="text-xs text-ixi-textMuted">Plan Pro • {platformLabels[platform]}</p>
          </div>
        </div>
      </div>

      {/* Acceso administrador */}
      <div className="rounded-2xl border border-ixi-violet/40 bg-ixi-violet/5 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4 text-ixi-violet" />
          <h4 className="text-sm font-bold">ixi 4k Admin Panel</h4>
          {isAdminAuthenticated && (
            <span className="ml-auto px-2 py-0.5 rounded-full bg-ixi-success/15 border border-ixi-success/40 text-[10px] font-bold text-ixi-success">
              Sesión activa
            </span>
          )}
        </div>

        {isAdminAuthenticated && (
          <p className="text-xs text-ixi-textMuted mb-3 truncate">Sesión: {adminEmail}</p>
        )}

        <div className="space-y-2">
          <motion.button
            onClick={onOpenAdmin}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-ixi-violet to-ixi-cyan text-white text-sm font-bold flex items-center justify-center gap-2"
            whileTap={{ scale: 0.97 }}
          >
            <Shield className="w-4 h-4" />
            {isAdminAuthenticated ? 'Abrir Panel de Control' : 'Iniciar sesión Admin'}
          </motion.button>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={onOpenReport}
              className="py-2.5 rounded-xl bg-ixi-bgCard border border-ixi-border text-xs font-medium text-ixi-textMuted hover:text-ixi-danger hover:border-ixi-danger/40 transition-all flex items-center justify-center gap-1.5"
            >
              <Bug className="w-3.5 h-3.5" />
              Reportar
              {getPendingReportCount() > 0 && (
                <span className="min-w-4 h-4 px-1 rounded-full bg-ixi-danger text-white text-[9px] font-bold flex items-center justify-center">
                  {getPendingReportCount()}
                </span>
              )}
            </button>
            {isAdminAuthenticated && (
              <button
                onClick={() => logoutAdmin()}
                className="py-2.5 rounded-xl bg-ixi-bgCard border border-ixi-border text-xs font-medium text-ixi-textMuted hover:text-ixi-danger hover:border-ixi-danger/40 transition-all flex items-center justify-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                Salir Admin
              </button>
            )}
          </div>
        </div>

        {/* Alertas del panel */}
        {isAdminAuthenticated && (pending > 0 || maintenanceMode) && (
          <div className="mt-3 space-y-2">
            {pending > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-ixi-warning/10 border border-ixi-warning/40 text-xs text-ixi-warning">
                <Bug className="w-3.5 h-3.5 shrink-0" />
                {pending} reporte{pending > 1 ? 's' : ''} pendiente{pending > 1 ? 's' : ''}
              </div>
            )}
            {maintenanceMode && (
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-ixi-warning/15 border border-ixi-warning/50 text-xs font-bold text-ixi-warning"
              >
                <Wrench className="w-3.5 h-3.5 shrink-0" />
                Modo Mantenimiento ACTIVO
              </div>
            )}
          </div>
        )}
      </div>

      {/* Diagnóstico del dispositivo */}
      <div className="rounded-2xl border border-white/10 bg-ixi-bgCard/70 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-4 h-4 text-ixi-cyan" />
          <h4 className="text-sm font-bold">Diagnóstico del dispositivo</h4>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center gap-1.5 text-ixi-textMuted">
            <Smartphone className="w-3.5 h-3.5 text-ixi-cyan" />
            {platformLabels[platform]}
          </div>
          <div className="flex items-center gap-1.5 text-ixi-textMuted">
            <Gauge className="w-3.5 h-3.5 text-ixi-violet" />
            {tierLabel(tier)}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs">
          <span className="text-ixi-textMuted">Destino de exportación</span>
          <span className="text-ixi-cyan font-semibold">{exportDirectoryLabel()}</span>
        </div>
        {diagnosticResult && (
          <div className="mt-2 flex items-center justify-between text-xs">
            <span className="text-ixi-textMuted">Score de Viralidad</span>
            <span
              className={`font-bold ${
                diagnosticResult.score >= 80
                  ? 'text-ixi-success'
                  : diagnosticResult.score >= 50
                    ? 'text-ixi-warning'
                    : 'text-ixi-danger'
              }`}
            >
              {diagnosticResult.score}%
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
