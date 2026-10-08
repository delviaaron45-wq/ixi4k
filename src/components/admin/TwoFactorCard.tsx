import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check,
  ClipboardCopy,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldOff,
} from 'lucide-react';
import {
  disableTwoFactor,
  enableTwoFactor,
  getTwoFactorStatus,
  setupTwoFactor,
  type TwoFactorSetupInfo,
} from '@/services/adminServices';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAdminStore } from '@/store/useAdminStore';

/**
 * Gestión del 2FA (TOTP) de la cuenta de administrador.
 *
 * El secreto lo genera y verifica el backend (Rust); esta tarjeta sólo lo
 * muestra DURANTE la configuración inicial para registrarlo en la app
 * autenticadora, y a partir de ahí transporta los códigos que introduce el
 * administrador.
 */
export function TwoFactorCard() {
  const adminSession = useAdminStore((s) => s.adminSession);
  const adminEmail = useAdminStore((s) => s.adminEmail);
  const addAuditLog = useAdminStore((s) => s.addAuditLog);

  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | undefined>();
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [setupInfo, setSetupInfo] = useState<TwoFactorSetupInfo | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState<'secret' | 'uri' | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const token = adminSession?.accessToken;

  const refresh = useCallback(async () => {
    const status = await getTwoFactorStatus();
    setAvailable(status.available);
    setReason(status.reason);
    setEnabled(status.enabled);
    setConfigured(status.configured && !status.enabled);
    if (status.enabled) setSetupInfo(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = async (text: string, which: 'secret' | 'uri') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('No se pudo copiar: selecciona y copia manualmente');
    }
  };

  const handleSetup = async () => {
    if (!token || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const info = await setupTwoFactor(token);
      setSetupInfo(info);
      setConfigured(true);
      addAuditLog({
        userId: 'admin_master',
        userEmail: adminEmail ?? 'admin',
        action: '2FA — secreto generado',
        details: 'Se generó el secreto TOTP pendiente de activación',
        type: 'security',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleEnable = async () => {
    if (!token || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await enableTwoFactor(token, code);
      setEnabled(true);
      setSetupInfo(null);
      setCode('');
      setNotice('2FA activado: el próximo login pedirá el código de tu app autenticadora.');
      addAuditLog({
        userId: 'admin_master',
        userEmail: adminEmail ?? 'admin',
        action: '2FA activado',
        details: 'Segundo factor activado para la cuenta de administrador',
        type: 'security',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('INVALID_CODE') ? 'Código no válido' : msg);
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!token || busy) return false;
    setBusy(true);
    setError('');
    try {
      await disableTwoFactor(token, code);
      setEnabled(false);
      setConfigured(false);
      setCode('');
      setNotice('2FA desactivado. Puedes volver a activarlo cuando quieras.');
      setConfirmDisable(false);
      addAuditLog({
        userId: 'admin_master',
        userEmail: adminEmail ?? 'admin',
        action: '2FA desactivado',
        details: 'Segundo factor desactivado para la cuenta de administrador',
        type: 'security',
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.includes('INVALID_CODE') ? 'Código no válido' : msg);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      className="card p-4 sm:p-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
    >
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h3 className="font-semibold flex items-center gap-2">
          {enabled ? (
            <ShieldCheck className="w-5 h-5 text-ixi-success" />
          ) : (
            <ShieldOff className="w-5 h-5 text-ixi-textMuted" />
          )}
          Segundo Factor (2FA)
        </h3>
        <span
          className={`px-2 py-1 rounded-full text-xs font-bold ${
            enabled
              ? 'bg-ixi-success/10 text-ixi-success'
              : 'bg-ixi-bgCard text-ixi-textMuted border border-ixi-border'
          }`}
        >
          {enabled ? 'ACTIVO' : 'INACTIVO'}
        </span>
      </div>

      <p className="text-xs text-ixi-textMuted mb-4">
        Verificación TOTP (RFC 6238) gestionada por el backend: el código lo genera tu app
        autenticadora (Google Authenticator, Authy…) y lo valida el proceso de escritorio.
      </p>

      {available === null && <p className="text-sm text-ixi-textMuted">Consultando estado…</p>}

      {available === false && (
        <div className="p-3 rounded-xl bg-ixi-bgSecondary/50 border border-white/10 text-xs text-ixi-textMuted">
          {reason ?? 'El 2FA no está disponible en este entorno.'}
        </div>
      )}

      {available && (
        <>
          {notice && (
            <div className="mb-3 p-3 rounded-xl bg-ixi-success/10 border border-ixi-success/30 text-xs text-ixi-success">
              {notice}
            </div>
          )}
          {error && (
            <div className="mb-3 p-3 rounded-xl bg-ixi-danger/10 border border-ixi-danger/30 text-xs text-ixi-danger">
              {error}
            </div>
          )}

          {!enabled && !setupInfo && (
            <button
              type="button"
              onClick={() => void handleSetup()}
              disabled={busy || !token}
              className="btn-primary py-2.5 px-4 text-sm disabled:opacity-50"
            >
              {busy ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Generando…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <KeyRound className="w-4 h-4" /> Configurar 2FA
                </span>
              )}
            </button>
          )}

          {configured && setupInfo && (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-ixi-bgSecondary/60 border border-ixi-cyan/30">
                <p className="text-xs text-ixi-textMuted mb-2">
                  1. Añade este secreto a tu app autenticadora (o usa el enlace otpauth):
                </p>
                <div className="flex items-center gap-2 mb-2">
                  <code className="flex-1 text-xs font-mono text-ixi-cyan break-all select-all">
                    {setupInfo.secret}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(setupInfo.secret, 'secret')}
                    className="p-1.5 rounded-lg bg-ixi-bgCard border border-ixi-border hover:border-ixi-cyan/50 transition-colors"
                    title="Copiar secreto"
                  >
                    {copied === 'secret' ? (
                      <Check className="w-3.5 h-3.5 text-ixi-success" />
                    ) : (
                      <ClipboardCopy className="w-3.5 h-3.5 text-ixi-textMuted" />
                    )}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-[10px] font-mono text-ixi-textMuted break-all">
                    {setupInfo.otpauthUri}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(setupInfo.otpauthUri, 'uri')}
                    className="p-1.5 rounded-lg bg-ixi-bgCard border border-ixi-border hover:border-ixi-cyan/50 transition-colors"
                    title="Copiar enlace otpauth"
                  >
                    {copied === 'uri' ? (
                      <Check className="w-3.5 h-3.5 text-ixi-success" />
                    ) : (
                      <ClipboardCopy className="w-3.5 h-3.5 text-ixi-textMuted" />
                    )}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-ixi-textMuted mb-1.5">
                  2. Escribe el código de 6 dígitos para activarlo
                </label>
                <div className="flex gap-2">
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.replace(/\D/g, ''));
                      if (error) setError('');
                    }}
                    className="input-field flex-1 text-center font-mono tracking-[0.4em]"
                    placeholder="000000"
                    disabled={busy}
                  />
                  <button
                    type="button"
                    onClick={() => void handleEnable()}
                    disabled={busy || code.length !== 6}
                    className="btn-primary px-4 text-sm disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Activar'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {enabled && (
            <div className="space-y-3">
              <div className="p-3 rounded-xl bg-ixi-success/5 border border-ixi-success/25 text-xs text-ixi-textMuted">
                El login de administrador exige además el código de tu app autenticadora.
                Tienes 5 intentos por acceso antes de que caduque la verificación.
              </div>
              <button
                type="button"
                onClick={() => {
                  setCode('');
                  setError('');
                  setConfirmDisable(true);
                }}
                className="px-4 py-2.5 rounded-xl bg-ixi-danger/10 text-ixi-danger text-sm font-medium hover:bg-ixi-danger/20 transition-colors"
              >
                Desactivar 2FA
              </button>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmDisable}
        title="Desactivar el segundo factor"
        message={
          'Se pedirá la contraseña de administrador y un código vigente de tu app ' +
          'autenticadora. El próximo acceso sólo requerirá la contraseña.'
        }
        confirmLabel="Desactivar 2FA"
        danger
        requirePassword
        adminEmail={adminEmail ?? ''}
        onCancel={() => {
          setConfirmDisable(false);
          setError('');
          setCode('');
        }}
        onConfirm={handleDisable}
      >
        <div className="mb-4">
          <label className="block text-xs font-medium text-ixi-textMuted mb-1.5">
            Código actual de la app autenticadora
          </label>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="input-field text-center font-mono tracking-[0.4em]"
            placeholder="000000"
            disabled={busy}
          />
          {error && <p className="text-xs text-ixi-danger mt-1.5">{error}</p>}
        </div>
      </ConfirmDialog>
    </motion.div>
  );
}
