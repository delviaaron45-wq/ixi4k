import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, VideoOff, Download, Sparkles, Shield } from 'lucide-react';
import { useMaintenanceStore } from '@/store/useMaintenanceStore';
import { AdminLogin } from '@/components/AdminLogin';

export function MaintenanceScreen() {
  const { maintenanceMessage } = useMaintenanceStore();
  const [showAdminLogin, setShowAdminLogin] = useState(false);

  return (
    <motion.div
      className="min-h-screen w-full relative overflow-hidden flex flex-col items-center justify-center px-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Fondo neón rojo (Pro Dark Theme) */}
      <div className="absolute inset-0" aria-hidden="true">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-ixi-cyan/10 rounded-full blur-3xl animate-float" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-ixi-violet/10 rounded-full blur-3xl animate-float" style={{ animationDelay: '-1.5s' }} />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,#0B0B0E_85%)]" />
        {/* Rejilla sutil */}
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              'linear-gradient(#FF1E42 1px, transparent 1px), linear-gradient(90deg, #FF1E42 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
      </div>

      <div className="relative z-10 max-w-xl w-full text-center">
        {/* Engranaje animado */}
        <div className="relative w-40 h-40 mx-auto mb-10">
          <motion.div
            className="absolute inset-0 rounded-full border-2 border-dashed border-ixi-cyan/40"
            animate={{ rotate: 360 }}
            transition={{ duration: 30, repeat: Infinity, ease: 'linear' }}
          />
          <motion.div
            className="absolute inset-4 rounded-full bg-gradient-to-br from-ixi-cyan/15 to-ixi-violet/15 border border-ixi-cyan/40 flex items-center justify-center shadow-glow-cyan"
            animate={{ boxShadow: [
              '0 0 20px rgba(34,211,238,0.3)',
              '0 0 45px rgba(139,92,246,0.4)',
              '0 0 20px rgba(34,211,238,0.3)',
            ] }}
            transition={{ duration: 3, repeat: Infinity }}
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ duration: 6, repeat: Infinity, ease: 'linear' }}
            >
              <Settings className="w-16 h-16 text-ixi-cyan" strokeWidth={1.2} />
            </motion.div>
          </motion.div>
          {/* Engranaje pequeño secundario */}
          <motion.div
            className="absolute -right-2 bottom-2 w-12 h-12 rounded-full bg-ixi-violet/20 border border-ixi-violet/50 flex items-center justify-center"
            animate={{ rotate: -360 }}
            transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
          >
            <Settings className="w-6 h-6 text-ixi-violet" strokeWidth={1.5} />
          </motion.div>
        </div>

        {/* Título */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <span className="inline-block px-4 py-1.5 rounded-full bg-ixi-warning/10 border border-ixi-warning/40 text-ixi-warning text-xs font-bold uppercase tracking-widest mb-5">
            ⚙ Sistema en mantenimiento
          </span>
          <h1 className="text-5xl sm:text-6xl font-black tracking-tight mb-4">
            <span className="neon-text">ixi 4k</span>
          </h1>
          <h2 className="text-2xl font-bold text-ixi-text mb-6">Modo Mantenimiento</h2>
        </motion.div>

        {/* Mensaje personalizado */}
        <motion.div
          className="glass-panel p-6 mb-8"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
        >
          <p className="text-lg text-ixi-text leading-relaxed">{maintenanceMessage}</p>
          <div className="mt-4 h-1 rounded-full bg-ixi-bgSecondary overflow-hidden">
            <motion.div
              className="h-full w-1/3 bg-gradient-to-r from-ixi-cyan to-ixi-violet"
              animate={{ x: ['-100%', '300%'] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </div>
        </motion.div>

        {/* Funciones deshabilitadas */}
        <motion.div
          className="flex flex-wrap items-center justify-center gap-3 mb-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
        >
          {[
            { icon: <VideoOff className="w-4 h-4" />, label: 'Importación de vídeos' },
            { icon: <Download className="w-4 h-4" />, label: 'Exportación 4K' },
            { icon: <Sparkles className="w-4 h-4" />, label: 'Renderizado ixi 4k' },
          ].map((item) => (
            <span
              key={item.label}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-ixi-bgCard/80 border border-ixi-border text-xs text-ixi-textMuted line-through opacity-70"
            >
              {item.icon}
              {item.label} — deshabilitado
            </span>
          ))}
        </motion.div>

        {/* Enlace discreto de acceso admin */}
        <motion.button
          onClick={() => setShowAdminLogin(true)}
          className="text-xs text-ixi-textMuted/50 hover:text-ixi-cyan transition-all duration-300 flex items-center gap-1.5 mx-auto group"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
        >
          <Shield className="w-3 h-3 group-hover:scale-110 transition-transform" />
          <span className="group-hover:tracking-wider transition-all">
            Acceso Exclusivo Administrador
          </span>
        </motion.button>
      </div>

      {/* Modal de acceso admin */}
      <AnimatePresence>
        {showAdminLogin && (
          <AdminLogin
            onClose={(success) => {
              setShowAdminLogin(false);
              // Éxito → el App muestra el Dashboard con acceso completo al Admin Panel
              void success;
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}