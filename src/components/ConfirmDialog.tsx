import { useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Loader2, Lock, X } from 'lucide-react';
import { verifyAdminPassword } from '@/services/adminServices';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * Acción crítica: exige re-escribir la contraseña del administrador. La
   * verificación ocurre SIEMPRE en el backend (nunca en el frontend).
   */
  requirePassword?: boolean;
  /** Email de la cuenta admin (necesario con `requirePassword`) */
  adminEmail?: string;
  /** Contenido adicional (p. ej. campo de código 2FA) */
  children?: React.ReactNode;
  /**
   * Acción a ejecutar. Devuelve `false` para mantener el diálogo abierto
   * (validación fallida por el componente padre).
   */
  onConfirm: () => Promise<boolean | void> | boolean | void;
  onCancel: () => void;
}

/**
 * Diálogo reutilizable de confirmación para acciones críticas del Panel
 * Admin. Mismo lenguaje visual que el resto de modales de ixi 4k.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  danger = true,
  requirePassword = false,
  adminEmail,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  if (!open) return null;

  const handleConfirm = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (requirePassword) {
        if (!password) {
          setError('Introduce tu contraseña para continuar');
          setBusy(false);
          return;
        }
        const ok = await verifyAdminPassword(adminEmail ?? '', password);
        if (!ok) {
          setError('Contraseña incorrecta');
          setBusy(false);
          return;
        }
        setPassword('');
      }
      const result = await onConfirm();
      if (result === false) {
        setBusy(false);
        return;
      }
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La acción falló');
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  const handleCancel = () => {
    if (busy) return;
    setPassword('');
    setError('');
    onCancel();
  };

  return (
    <motion.div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={handleCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <motion.div
        className="w-full max-w-md card-glow p-6 relative overflow-hidden"
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleCancel}
          className="absolute top-3 right-3 p-1.5 rounded-lg text-ixi-textMuted hover:text-ixi-text transition-colors"
          aria-label="Cerrar"
          disabled={busy}
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-start gap-3 mb-4">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
              danger ? 'bg-ixi-danger/15 text-ixi-danger' : 'bg-ixi-cyan/15 text-ixi-cyan'
            }`}
          >
            {requirePassword ? <Lock className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
          </div>
          <div>
            <h3 className="font-bold text-ixi-text">{title}</h3>
            <p className="text-sm text-ixi-textMuted mt-1">{message}</p>
          </div>
        </div>

        {children}

        {requirePassword && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-ixi-textMuted mb-1.5">
              Contraseña del administrador
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError('');
              }}
              className="input-field"
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleConfirm();
              }}
            />
          </div>
        )}

        {error && (
          <p className="text-xs text-ixi-danger mb-3 text-center" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={handleCancel}
            disabled={busy}
            className="flex-1 py-2.5 rounded-xl bg-ixi-bgCard border border-ixi-border text-ixi-textMuted text-sm font-medium hover:text-ixi-text transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={busy || (requirePassword && !password)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-all disabled:opacity-50 ${
              danger
                ? 'bg-ixi-danger hover:bg-ixi-danger/80'
                : 'bg-gradient-to-r from-ixi-violet to-ixi-cyan'
            }`}
          >
            {busy ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Procesando…
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
