import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mail, Lock, Eye, EyeOff, Loader2, Shield, User, ArrowLeft, KeyRound } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useAdminStore } from '@/store/useAdminStore';
import { resolveLoginRole, completeTwoFactorLogin, type AdminSession } from '@/services/authService';

export function AuthScreen() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Pantalla de selección de rol (tras validar en el backend)
  // 'form'      → correo + contraseña
  // 'select'    → "Entrar como usuario" / "Entrar como administrador"
  // 'twofactor' → código TOTP exigido por el backend (2FA) para el rol admin
  const [phase, setPhase] = useState<'form' | 'select' | 'twofactor'>('form');
  const [canUseAdmin, setCanUseAdmin] = useState(false);
  const [pendingAdminSession, setPendingAdminSession] = useState<AdminSession | null>(null);
  // Token PENDIENTE emitido por el backend cuando exige el código 2FA
  const [pendingTwoFactor, setPendingTwoFactor] = useState<string | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [isSelecting, setIsSelecting] = useState(false);
  // La contraseña solo vive aquí, en memoria, hasta elegir opción; nunca se
  // guarda, se registra en consola ni se envía a ningún otro sitio que no sea
  // el backend que la verifica.
  const pendingPassword = useRef('');

  const login = useAppStore((s) => s.login);
  const register = useAppStore((s) => s.register);
  const setAdminSession = useAdminStore((s) => s.setAdminSession);
  const logoutAdmin = useAdminStore((s) => s.logoutAdmin);

  const resetSelection = () => {
    pendingPassword.current = '';
    setPendingAdminSession(null);
    setCanUseAdmin(false);
    setPendingTwoFactor(null);
    setTwoFactorCode('');
    setPhase('form');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      if (isLogin) {
        // El rol (usuario / administrador) lo decide el BACKEND
        const outcome = await resolveLoginRole(email, password);
        setCanUseAdmin(outcome.role === 'admin');
        setPendingAdminSession(outcome.session ?? null);
        setPendingTwoFactor(outcome.twoFactor?.pendingToken ?? null);
        setTwoFactorCode('');
        pendingPassword.current = password;
        setPhase('select');
      } else {
        // Registro = siempre cuenta normal: nunca hereda una sesión admin
        try {
          await logoutAdmin();
        } catch {
          // No había sesión admin (o no hay backend): seguimos con el registro
        }
        await register(email, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de autenticación');
    } finally {
      setIsLoading(false);
    }
  };

  /** Entrar como usuario: idéntico al login de cualquier otro usuario. */
  const enterAsUser = async () => {
    if (isSelecting) return;
    setError('');
    setIsSelecting(true);
    try {
      // Es un login normal: además se revoca/purga cualquier sesión admin que
      // quede de una visita anterior para que NO se herede el Panel Admin.
      try {
        await logoutAdmin();
      } catch {
        // No había sesión admin (o no hay backend): seguimos con el login
      }
      await login(email, pendingPassword.current);
      resetSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de autenticación');
    } finally {
      setIsSelecting(false);
    }
  };

  /** Entrar como administrador: usa el token emitido por el backend. */
  const enterAsAdmin = async () => {
    if (isSelecting) return;
    setError('');
    // 2FA activo → el backend aún no ha dado la sesión: pedir el código TOTP
    if (!pendingAdminSession && pendingTwoFactor) {
      setTwoFactorCode('');
      setPhase('twofactor');
      return;
    }
    if (!pendingAdminSession) return;
    setIsSelecting(true);
    try {
      // 1) Sesión admin (token que ya emitió/validó el backend)
      await setAdminSession(pendingAdminSession);
      // 2) Sesión de usuario normal (como cualquier otro login)
      await login(email, pendingPassword.current);
      resetSelection();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de autenticación');
    } finally {
      setIsSelecting(false);
    }
  };

  /**
   * Paso 2FA: intercambia el código TOTP por la sesión admin REAL. La
   * verificación ocurre en el backend (Rust); aquí sólo transportamos el
   * código introducido por el administrador.
   */
  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSelecting || !pendingTwoFactor) return;
    setError('');
    setIsSelecting(true);
    try {
      const session = await completeTwoFactorLogin(email, pendingTwoFactor, twoFactorCode);
      await setAdminSession(session);
      await login(email, pendingPassword.current);
      resetSelection();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Código de verificación no válido';
      setError(message);
      // Token caducado → hay que volver a empezar con la contraseña
      if (message.toLowerCase().includes('caduc')) {
        resetSelection();
      } else {
        setTwoFactorCode('');
      }
    } finally {
      setIsSelecting(false);
    }
  };

  const backToForm = () => {
    setPassword('');
    setError('');
    resetSelection();
  };

  return (
    <motion.div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Background decorative elements */}
      <div className="absolute inset-0" aria-hidden="true">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-ixi-cyan/10 rounded-full blur-3xl animate-float" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-ixi-violet/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '-1.5s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] border border-ixi-cyan/10 rounded-full blur-3xl" />
      </div>

      <motion.div
        className="relative w-full max-w-md z-10"
        initial={{ y: 30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
      >
        {/* Logo */}
        <motion.div
          className="flex justify-center mb-10"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.3, type: 'spring', stiffness: 200 }}
        >
          <div className="relative">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-ixi-cyan to-ixi-violet flex items-center justify-center shadow-glow-cyan shadow-glow-violet">
              <span className="text-3xl font-black text-ixi-bg tracking-tight">ixi</span>
            </div>
            <motion.div
              className="absolute -bottom-2 right-0 w-6 h-6 rounded-full bg-ixi-cyan border-4 border-ixi-bg flex items-center justify-center"
              animate={{ scale: [1, 1.1, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <span className="text-xs font-bold text-ixi-bg">4k</span>
            </motion.div>
          </div>
        </motion.div>

        <motion.div
          className="text-center mb-10"
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4 }}
        >
          <h1 className="text-4xl font-bold tracking-tight mb-2">
            <span className="neon-text">ixi 4k</span> Studio
          </h1>
          <p className="text-ixi-textMuted">
            {phase === 'select'
              ? 'Elige cómo quieres entrar'
              : phase === 'twofactor'
                ? 'Introduce el código de tu app autenticadora'
                : isLogin
                  ? 'Inicia sesión para crear edits cinematográficos'
                  : 'Crea tu cuenta y comienza a potenciar tus vídeos'}
          </p>
        </motion.div>

        {/* Selección de rol: la opción de administrador solo aparece si el
            backend ha confirmado que esas credenciales son de administrador */}
        <AnimatePresence mode="wait">
          {phase === 'select' && (
            <motion.div
              key="select"
              className="card-glow p-6 sm:p-8 space-y-5"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              {error && (
                <motion.div
                  className="p-4 rounded-xl bg-ixi-danger/10 border border-ixi-danger/30 text-ixi-danger text-sm flex items-center gap-2"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                >
                  <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {error}
                </motion.div>
              )}

              <div className="text-center space-y-2">
                <div className="mx-auto w-12 h-12 rounded-xl bg-gradient-to-br from-ixi-cyan to-ixi-violet flex items-center justify-center shadow-glow-cyan">
                  <User className="w-6 h-6 text-ixi-bg" />
                </div>
                <h2 className="text-lg font-bold text-ixi-text">¿Cómo quieres entrar?</h2>
                <p className="text-sm text-ixi-textMuted break-all">{email}</p>
              </div>

              <motion.button
                type="button"
                onClick={enterAsUser}
                disabled={isSelecting}
                className="btn-primary w-full py-4 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <User className="w-5 h-5" />
                Entrar como usuario
              </motion.button>

              {/* Solo visible cuando el BACKEND devuelve rol admin */}
              {canUseAdmin && (pendingAdminSession || pendingTwoFactor) && (
                <motion.button
                  type="button"
                  onClick={enterAsAdmin}
                  disabled={isSelecting}
                  className="relative w-full py-4 rounded-xl font-semibold text-white bg-gradient-to-r from-ixi-violet to-ixi-cyan/80 flex items-center justify-center gap-2 shadow-glow-violet disabled:opacity-50 disabled:cursor-not-allowed"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  <Shield className="w-5 h-5" />
                  Entrar como administrador
                </motion.button>
              )}

              {isSelecting && (
                <div className="flex items-center justify-center gap-2 text-sm text-ixi-textMuted">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Entrando...
                </div>
              )}

              <button
                type="button"
                onClick={backToForm}
                disabled={isSelecting}
                className="relative w-full text-sm text-ixi-textMuted hover:text-ixi-cyan transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
              >
                <ArrowLeft className="w-4 h-4" />
                Volver
              </button>
            </motion.div>
          )}

          {/* Paso 2FA: código TOTP exigido por el backend para el rol admin */}
          {phase === 'twofactor' && (
            <motion.form
              key="twofactor"
              onSubmit={handleTwoFactorSubmit}
              className="card-glow p-6 sm:p-8 space-y-5"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              {error && (
                <motion.div
                  className="p-4 rounded-xl bg-ixi-danger/10 border border-ixi-danger/30 text-ixi-danger text-sm flex items-center gap-2"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                >
                  <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {error}
                </motion.div>
              )}

              <div className="text-center space-y-2">
                <div className="mx-auto w-12 h-12 rounded-xl bg-gradient-to-br from-ixi-cyan to-ixi-violet flex items-center justify-center shadow-glow-cyan">
                  <KeyRound className="w-6 h-6 text-ixi-bg" />
                </div>
                <h2 className="text-lg font-bold text-ixi-text">
                  Verificación en dos pasos (2FA)
                </h2>
                <p className="text-sm text-ixi-textMuted break-all">
                  Contraseña correcta. Introduce el código de 6 dígitos de tu app
                  autenticadora para completar el acceso de administrador.
                </p>
              </div>

              <div>
                <label
                  htmlFor="twofactor-code"
                  className="block text-sm font-medium text-ixi-text mb-2 text-center"
                >
                  Código de verificación
                </label>
                <input
                  id="twofactor-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  value={twoFactorCode}
                  onChange={(e) => {
                    setTwoFactorCode(e.target.value.replace(/\D/g, ''));
                    if (error) setError('');
                  }}
                  className="input-field w-full text-center font-mono text-xl tracking-[0.5em]"
                  placeholder="000000"
                  required
                  disabled={isSelecting}
                  autoFocus
                />
              </div>

              <motion.button
                type="submit"
                disabled={isSelecting || twoFactorCode.length !== 6}
                className="btn-primary w-full py-4 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                {isSelecting ? (
                  <div className="flex items-center justify-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Verificando código...</span>
                  </div>
                ) : (
                  'Verificar y entrar'
                )}
              </motion.button>

              <button
                type="button"
                onClick={backToForm}
                disabled={isSelecting}
                className="relative w-full text-sm text-ixi-textMuted hover:text-ixi-cyan transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
              >
                <ArrowLeft className="w-4 h-4" />
                Volver
              </button>
            </motion.form>
          )}

          {/* Form */}
          {phase === 'form' && (
            <motion.form
              key={isLogin ? 'login' : 'register'}
              onSubmit={handleSubmit}
              className="card-glow p-6 sm:p-8 space-y-6"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              {error && (
                <motion.div
                  className="p-4 rounded-xl bg-ixi-danger/10 border border-ixi-danger/30 text-ixi-danger text-sm flex items-center gap-2"
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                >
                  <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {error}
                </motion.div>
              )}

              <div className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-sm font-medium text-ixi-text mb-2">
                    Correo electrónico
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ixi-textMuted" aria-hidden="true" />
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="input-field pl-12"
                      placeholder="tu@email.com"
                      required
                      autoComplete="email"
                      disabled={isLoading}
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="password" className="block text-sm font-medium text-ixi-text mb-2">
                    Contraseña
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-ixi-textMuted" aria-hidden="true" />
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="input-field pl-12 pr-12"
                      placeholder="••••••••"
                      required
                      autoComplete={isLogin ? 'current-password' : 'new-password'}
                      disabled={isLoading}
                      minLength={6}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-4 top-1/2 -translate-y-1/2 text-ixi-textMuted hover:text-ixi-cyan transition-colors"
                      aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </div>

              <motion.button
                type="submit"
                disabled={isLoading}
                className="btn-primary w-full py-4 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                {isLoading ? (
                  <div className="flex items-center justify-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>{isLogin ? 'Iniciando sesión...' : 'Creando cuenta...'}</span>
                  </div>
                ) : (
                  isLogin ? 'Iniciar Sesión' : 'Crear Cuenta'
                )}
              </motion.button>
            </motion.form>
          )}
        </AnimatePresence>

        {/* Toggle mode */}
        {phase === 'form' && (
          <motion.div
            className="text-center mt-8"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.5 }}
          >
            <p className="text-ixi-textMuted">
              {isLogin ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?'}{' '}
              <button
                onClick={() => {
                  setIsLogin(!isLogin);
                  setError('');
                }}
                className="text-ixi-cyan font-semibold hover:text-ixi-violet transition-colors"
              >
                {isLogin ? 'Regístrate' : 'Inicia sesión'}
              </button>
            </p>
          </motion.div>
        )}

        {/* Features preview */}
        <motion.div
          className="mt-10 grid grid-cols-3 gap-4 text-center"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.6 }}
        >
          <div className="p-4 rounded-xl bg-ixi-bgSecondary/50 border border-white/10">
            <div className="w-10 h-10 mx-auto mb-2 rounded-lg bg-ixi-cyan/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-ixi-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <p className="text-xs text-ixi-textMuted">4k Cinemático</p>
          </div>
          <div className="p-4 rounded-xl bg-ixi-bgSecondary/50 border border-white/10">
            <div className="w-10 h-10 mx-auto mb-2 rounded-lg bg-ixi-violet/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-ixi-violet" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <p className="text-xs text-ixi-textMuted">Optimizado TikTok</p>
          </div>
          <div className="p-4 rounded-xl bg-ixi-bgSecondary/50 border border-white/10">
            <div className="w-10 h-10 mx-auto mb-2 rounded-lg bg-ixi-success/20 flex items-center justify-center">
              <svg className="w-5 h-5 text-ixi-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-xs text-ixi-textMuted">Anti Shadowban</p>
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}