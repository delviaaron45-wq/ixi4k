import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle, Circle, RefreshCw, Server, XCircle } from 'lucide-react';
import {
  checkLocalServices,
  type ServiceCheck,
  type ServiceStatus,
} from '@/services/adminServices';

function statusIcon(status: ServiceStatus) {
  if (status === 'operational') return <CheckCircle className="w-4 h-4 text-ixi-success" />;
  if (status === 'error') return <XCircle className="w-4 h-4 text-ixi-danger" />;
  return <Circle className="w-4 h-4 text-ixi-textMuted" />;
}

function statusLabel(status: ServiceStatus): string {
  if (status === 'operational') return 'Operativo';
  if (status === 'error') return 'Con fallo';
  return 'No disponible';
}

/**
 * Estado de los servicios LOCALES de los que depende ixi 4k. La app no
 * tiene servidores propios: aquí se comprueban FFmpeg, el backend nativo,
 * la red del dispositivo, el almacenamiento local y el service worker.
 * Se consulta bajo demanda (sin sondeos permanentes).
 */
export function ServicesStatusCard() {
  const [checks, setChecks] = useState<ServiceCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const report = await checkLocalServices();
      setChecks(report.checks);
      setCheckedAt(report.checkedAt);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runCheck();
  }, [runCheck]);

  return (
    <motion.div
      className="card p-4 sm:p-6 mt-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.75 }}
    >
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <h3 className="font-semibold flex items-center gap-2">
          <Server className="w-5 h-5 text-ixi-cyan" />
          Estado de Servicios (locales)
        </h3>
        <button
          type="button"
          onClick={() => void runCheck()}
          disabled={checking}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ixi-bgCard border border-ixi-border text-xs text-ixi-textMuted hover:text-ixi-cyan hover:border-ixi-cyan/40 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${checking ? 'animate-spin' : ''}`} />
          {checking ? 'Comprobando…' : 'Recomprobar'}
        </button>
      </div>

      <p className="text-xs text-ixi-textMuted mb-4">
        ixi 4k funciona sin servidores propios: estos son los servicios locales de los
        que depende la app en este dispositivo.
      </p>

      {!checks && (
        <p className="text-sm text-ixi-textMuted">Leyendo el estado de los servicios…</p>
      )}

      {checks && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {checks.map((check) => (
            <div
              key={check.id}
              className="flex items-start gap-3 p-3 rounded-xl bg-ixi-bgSecondary/50 border border-white/10"
            >
              <div className="mt-0.5">{statusIcon(check.status)}</div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ixi-text">{check.name}</p>
                <p className="text-xs text-ixi-textMuted break-words">{check.detail}</p>
                <span
                  className={`inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                    check.status === 'operational'
                      ? 'bg-ixi-success/10 text-ixi-success'
                      : check.status === 'error'
                        ? 'bg-ixi-danger/10 text-ixi-danger'
                        : 'bg-ixi-bgCard text-ixi-textMuted'
                  }`}
                >
                  {statusLabel(check.status)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {checkedAt && (
        <p className="text-[11px] text-ixi-textMuted mt-3 text-right">
          Última comprobación: {new Date(checkedAt).toLocaleTimeString('es-ES')}
        </p>
      )}
    </motion.div>
  );
}
