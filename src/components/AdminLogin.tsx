import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Shield, Lock, Mail, Loader2, AlertTriangle, Timer, KeyRound, ArrowLeft } from 'lucide-react';
import { useAdminStore } from '@/store/useAdminStore';
import { getRateLimitState } from '@/services/authService';

interface AdminLoginProps {
  /** Se invoca al cerrar; `success=true` cuando la autenticación fue válida */
  onClose: (success?: boolean) => void;
}

export function AdminLogin({ onClose }: AdminLoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [attemptsLeft, setAttemptsLeft] = useState(5);
  // Paso 2FA: token PENDIENTE emitido por el backend tras validar la contraseña
  const [pending2FA, setPending2FA] = useState<string | null>(null);
  const [twofactorCode, setTwofactorCode] = useState('');

  const { loginAdmin, verifyTwoFactorCode, rateLimit } = useAdminStore();

  // Cuenta atrás del bloqueo por rate limiting
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          setAttemptsLeft(getRateLimitState().remaining);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [countdown]);

  useEffect(() => {
    setAttemptsLeft(rateLimit.remaining);
    if (rateLimit.locked && rateLimit.retryAfter > 0) {
      setCountdown(rateLimit.retryAfter);
    }
  }, [rateLimit]);

  const isLocked = countdown > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLocked || isLoading) return;

    setError('');
    setIsLoading(true);

    const result = await loginAdmin(email, password);

    if (result.success) {
      // Éxito → cierra el modal y despliega el ixi 4k Admin Panel
      onClose(true);
    } else if (result.code === 'TWO_FACTOR_REQUIRED' && result.pendingToken) {
      // Contraseña correcta → el backend exige el código TOTP (2FA)
      setPending2FA(result.pendingToken);
      setTwofactorCode('');
      setError('');
    } else if (result.code === 'RATE_LIMITED') {
      setError(result.message);
      setCountdown(result.retryAfter || 60);
    } else {
      // Rechazo con el mensaje exacto de auditoría
      setError(result.message || 'Acceso No Autorizado: Credenciales de Administrador Incorrectas');
      setPassword('');
    }

    setIsLoading(false);
    setAttemptsLeft(getRateLimitState().remaining);
  };

  /** Paso 2: intercambia el código TOTP del backend por la sesión real. */
  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading || !pending2FA) return;

    setError('');
    setIsLoading(true);

    const result = await verifyTwoFactorCode(email, pending2FA, twofactorCode);

    if (result.success) {
      onClose(true);
    } else if (result.code === 'TWO_FACTOR_REQUIRED') {
      // Caducó el paso 2FA → hay que volver a empezar con la contraseña
      setPending2FA(null);
      setTwofactorCode('');
      setError(result.message);
      setPassword('');
    } else {
      setError(result.message || 'Código de verificación no válido');
      setTwofactorCode('');
    }

    setIsLoading(false);
  };

  const backToPassword = () => {
    setPending2FA(null);
    setTwofactorCode('');
    setError('');
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={() => onClose(false)}
    >
      <motion.div
        className="w-[calc(100%-2rem)] max-w-md p-6 sm:p-8 card-glow relative overflow-hidden"
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Neon error glow effect */}
        {error && (
          <motion.div
            className="absolute inset-0 pointer-events-none"
            initial={{ boxShadow: '0 0 0 rgba(239,68,68,0)' }}
            animate={{
              boxShadow: [
                '0 0 0 rgba(239,68,68,0)',
                '0 0 30px rgba(239,68,68,0.5)',
                '0 0 0 rgba(239,68,68,0)',
              ],
            }}
            transition={{ duration: 0.6 }}
          />
        )}

        <div className="text-center mb-8">
          <motion.div
            className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-ixi-violet to-ixi-cyan flex items-center justify-center"
            animate={{ scale: error ? [1, 1.1, 1] : 1 }}
            transition={{ duration: 0.3 }}
          >
            <Shield className="w-8 h-8 text-white" />
          </motion.div>
          <h2 className="text-2xl font-bold neon-text">Panel de Administrador</h2>
          <p className="text-sm text-ixi-textMuted mt-2">
            Autenticación cifrada JWT — Acceso restringido
          </p>
        </div>

        <form
          onSubmit={pending2FA ? handleTwoFactorSubmit : handleSubmit}
          className="space-y-4"
        >
          {/* Neon error message */}
          {error && (
            <motion.div
              className="p-4 rounded-xl border-2 border-ixi-danger bg-ixi-danger/10 text-center"
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10 }}
            >
              <div className="flex items-center justify-center gap-2 mb-1">
                <AlertTriangle className="w-5 h-5 text-ixi-danger" />
                <span className="font-bold text-ixi-danger tracking-wide">{error}</span>
              </div>
              {isLocked ? (
                <div className="flex items-center justify-center gap-1 text-xs text-ixi-warning">
                  <Timer className="w-3.5 h-3.5" />
                  Bloqueado durante {countdown}s — Ataque de fuerza bruta bloqueado
                </div>
              ) : (
                <p className="text-xs text-ixi-danger/70">
                  Intento registrado en auditoría de seguridad (IP + dispositivo)
                </p>
              )}
              <motion.span
                className="block text-lg font-black text-ixi-danger mt-1"
                animate={{
                  opacity: [1, 0.3, 1],
                  textShadow: [
                    '0 0 8px rgba(239,68,68,0.8)',
                    '0 0 2px rgba(239,68,68,0.3)',
                    '0 0 8px rgba(239,68,68,0.8)',
                  ],
                }}
                transition={{ duration: 1, repeat: 2 }}
              >
                ✕ ACCESO NO AUTORIZADO ✕
              </motion.span>
            </motion.div>
          )}

          {/* Campos de credenciales (ocultos durante el paso 2FA) */}
          {!pending2FA && (
          <>
          <div>
            <label className="block text-sm font-medium text-ixi-text mb-2">
              Correo de Administrador
            </label>
            <div className="relative">
              <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ixi-textMuted" />
              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError('');
                }}
                className="input-field pl-12"
                placeholder="admin@ixi4k.com"
                required
                disabled={isLoading || isLocked}
                autoComplete="username"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-ixi-text mb-2">
              Contraseña cifrada
            </label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ixi-textMuted" />
              <input
                type="password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError('');
                }}
                className={`input-field pl-12 ${error ? 'border-ixi-danger focus:border-ixi-danger focus:ring-ixi-danger/20' : ''}`}
                placeholder="••••••••••••"
                required
                disabled={isLoading || isLocked}
                autoComplete="current-password"
                minLength={8}
              />
            </div>
          </div>

          {/* Rate limit indicator */}
          <div className="flex items-center justify-between text-xs px-1">
            <span className="text-ixi-textMuted">
              Intentos restantes:{' '}
              <span className={attemptsLeft <= 2 ? 'text-ixi-danger font-bold' : 'text-ixi-cyan'}>
                {attemptsLeft}/5
              </span>
              <span className="text-ixi-textMuted"> por minuto</span>
            </span>
            {isLocked && (
              <span className="text-ixi-warning flex items-center gap-1">
                <Timer className="w-3 h-3" /> {countdown}s
              </span>
            )}
          </div>
          </>
          )}

          {/* Paso 2FA: código TOTP de 6 dígitos de la app autenticadora */}
          {pending2FA && (
            <>
              <div className="p-4 rounded-xl border-2 border-ixi-cyan/40 bg-ixi-cyan/5 text-center">
                <KeyRound className="w-6 h-6 mx-auto mb-2 text-ixi-cyan" />
                <p className="text-sm text-ixi-text font-semibold">
                  Verificación en dos pasos (2FA)
                </p>
                <p className="text-xs text-ixi-textMuted mt-1">
                  Contraseña correcta. Introduce el código de 6 dígitos de tu app
                  autenticadora para completar el acceso.
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-ixi-text mb-2">
                  Código de verificación
                </label>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  value={twofactorCode}
                  onChange={(e) => {
                    setTwofactorCode(e.target.value.replace(/\D/g, ''));
                    if (error) setError('');
                  }}
                  className={`input-field w-full text-center font-mono text-xl tracking-[0.5em] ${
                    error ? 'border-ixi-danger focus:border-ixi-danger' : ''
                  }`}
                  placeholder="000000"
                  required
                  disabled={isLoading}
                  autoFocus
                />
              </div>
            </>
          )}

          <motion.button
            type="submit"
            disabled={
              isLoading ||
              isLocked ||
              (pending2FA ? twofactorCode.length !== 6 : !email || !password)
            }
            className="btn-primary w-full py-3 disabled:opacity-50"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            {isLoading ? (
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>{pending2FA ? 'Verificando código…' : 'Verificando firma JWT...'}</span>
              </div>
            ) : isLocked ? (
              `Bloqueado — espera ${countdown}s`
            ) : pending2FA ? (
              'Verificar código'
            ) : (
              'Desbloquear Panel Admin'
            )}
          </motion.button>

          {pending2FA && !isLoading && (
            <button
              type="button"
              onClick={backToPassword}
              className="w-full text-sm text-ixi-textMuted hover:text-ixi-cyan transition-colors flex items-center justify-center gap-1"
            >
              <ArrowLeft className="w-4 h-4" />
              Volver a la contraseña
            </button>
          )}
        </form>

        <p className="text-xs text-ixi-textMuted text-center mt-6 leading-relaxed">
          {import.meta.env.MODE === 'development' && !import.meta.env.VITE_SUPABASE_URL ? (
            <>
              ⚠️ Modo desarrollo sin Supabase Auth — configura{' '}
              <span className="text-ixi-cyan font-mono">VITE_SUPABASE_URL</span> para JWT real
            </>
          ) : (
            <>
              🔐 Sesión cifrada en el gestor de credenciales del sistema — Cada intento queda
              registrado
            </>
          )}
        </p>
      </motion.div>
    </motion.div>
  );
}