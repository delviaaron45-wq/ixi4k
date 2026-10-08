import { motion } from 'framer-motion';
import { Server, Wrench, ShieldCheck, Radio } from 'lucide-react';
import { useMaintenanceStore, DEFAULT_MAINTENANCE_MESSAGE } from '@/store/useMaintenanceStore';
import { useAdminStore } from '@/store/useAdminStore';

export function MaintenanceControl() {
  const {
    maintenanceMode,
    maintenanceMessage,
    lastUpdated,
    setMaintenanceMode,
    setMaintenanceMessage,
  } = useMaintenanceStore();
  const { addAuditLog, adminEmail } = useAdminStore();

  const handleToggle = () => {
    const next = !maintenanceMode;
    setMaintenanceMode(next);
    addAuditLog({
      userId: 'admin_master',
      userEmail: adminEmail || 'admin@ixi4k.com',
      action: next ? 'Modo Mantenimiento ACTIVADO' : 'Modo Mantenimiento DESACTIVADO',
      details: next
        ? `Los usuarios quedan bloqueados. Mensaje: "${maintenanceMessage}"`
        : 'Acceso completo restaurado para todos los usuarios',
      type: 'admin',
    });
  };

  return (
    <motion.div
      className={`card p-6 mb-6 border-2 transition-colors ${
        maintenanceMode
          ? 'border-ixi-warning/60 bg-ixi-warning/5 shadow-glow-violet-sm'
          : 'border-ixi-success/40 bg-ixi-bgCard'
      }`}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 }}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center ${
              maintenanceMode ? 'bg-ixi-warning/20' : 'bg-ixi-success/15'
            }`}
          >
            <Server
              className={`w-6 h-6 ${maintenanceMode ? 'text-ixi-warning' : 'text-ixi-success'}`}
            />
          </div>
          <div>
            <h3 className="text-lg font-bold flex items-center gap-2">
              Estado del Sistema
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase ${
                  maintenanceMode
                    ? 'bg-ixi-warning/15 text-ixi-warning'
                    : 'bg-ixi-success/15 text-ixi-success'
                }`}
              >
                <Radio className="w-3 h-3 animate-pulse" />
                {maintenanceMode ? 'Mantenimiento' : 'Operativo'}
              </span>
            </h3>
            <p className="text-xs text-ixi-textMuted">
              Control maestro de acceso a la aplicación
              {lastUpdated && ` • Actualizado ${new Date(lastUpdated).toLocaleString('es-ES')}`}
            </p>
          </div>
        </div>

        {/* Toggle principal */}
        <div className="flex items-center gap-3">
          <span
            className={`text-sm font-semibold ${
              maintenanceMode ? 'text-ixi-warning' : 'text-ixi-textMuted'
            }`}
          >
            Activar Modo Mantenimiento
          </span>
          <button
            role="switch"
            aria-checked={maintenanceMode}
            aria-label="Activar Modo Mantenimiento"
            onClick={handleToggle}
            className={`toggle-switch ${maintenanceMode ? 'bg-ixi-warning' : 'bg-ixi-border'}`}
          >
            <motion.span
              className="toggle-thumb"
              animate={{ x: maintenanceMode ? 22 : 4 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            />
          </button>
        </div>
      </div>

      {/* Mensaje de mantenimiento */}
      <div className="space-y-2">
        <label
          htmlFor="maintenance-message"
          className="text-sm font-medium flex items-center gap-2 text-ixi-text"
        >
          <Wrench className="w-4 h-4 text-ixi-cyan" />
          Mensaje de Mantenimiento Personalizado
        </label>
        <textarea
          id="maintenance-message"
          value={maintenanceMessage}
          onChange={(e) => setMaintenanceMessage(e.target.value)}
          className="input-field min-h-[80px] resize-none"
          placeholder={DEFAULT_MAINTENANCE_MESSAGE}
          maxLength={300}
        />
        <div className="flex items-center justify-between text-xs text-ixi-textMuted">
          <span>
            Se muestra en la pantalla de bloqueo •{" "}
            {maintenanceMessage.length}/300 caracteres
          </span>
          <button
            onClick={() => setMaintenanceMessage(DEFAULT_MAINTENANCE_MESSAGE)}
            className="text-ixi-cyan hover:text-ixi-violet transition-colors"
          >
            Restaurar mensaje por defecto
          </button>
        </div>
      </div>

      {/* Info de excepción admin */}
      <div className="mt-4 p-3 rounded-xl bg-ixi-bgSecondary/60 border border-white/10 flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 text-ixi-cyan mt-0.5 flex-shrink-0" />
        <p className="text-xs text-ixi-textMuted leading-relaxed">
          Cuando está <span className="text-ixi-warning font-semibold">ACTIVO</span>: los usuarios
          normales ven la pantalla de bloqueo neón y no pueden importar ni exportar vídeos. Tu
          cuenta de administrador{" "}
          <span className="text-ixi-cyan font-semibold">con sesión iniciada</span> conserva el
          acceso completo al Panel Admin para desactivarlo.
        </p>
      </div>

      {/* Vista previa del mensaje */}
      {maintenanceMode && (
        <motion.div
          className="mt-4 p-4 rounded-xl border border-dashed border-ixi-warning/50 bg-ixi-bg/60"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
        >
          <p className="text-[10px] uppercase tracking-wider text-ixi-warning mb-1.5 font-bold">
            Vista previa — lo que verán los usuarios
          </p>
          <p className="text-sm text-ixi-text italic">"{maintenanceMessage}"</p>
        </motion.div>
      )}
    </motion.div>
  );
}