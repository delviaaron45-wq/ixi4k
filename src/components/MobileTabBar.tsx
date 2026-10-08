import { motion } from 'framer-motion';
import { Eye, Monitor, Sparkles, Shield } from 'lucide-react';

export type MobileTab = 'preview' | 'quality' | 'filters' | 'admin';

interface MobileTabBarProps {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
  pendingReports?: number;
}

const tabs: Array<{
  id: MobileTab;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: 'preview', label: 'Vista Previa', icon: <Eye className="w-5 h-5" /> },
  { id: 'quality', label: 'Ajustes 4K', icon: <Monitor className="w-5 h-5" /> },
  { id: 'filters', label: 'Filtros', icon: <Sparkles className="w-5 h-5" /> },
  { id: 'admin', label: 'Admin', icon: <Shield className="w-5 h-5" /> },
];

/**
 * Tab Bar inferior táctil (solo móvil) — navegación vertical fluida.
 * Los iconos crecen ligeramente al estar activos (feedback táctil 60fps).
 */
export function MobileTabBar({ active, onChange, pendingReports = 0 }: MobileTabBarProps) {
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 lg:hidden bg-ixi-bgSecondary/95 backdrop-blur-xl border-t border-white/10"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="grid grid-cols-4">
        {tabs.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={`relative flex flex-col items-center justify-center gap-1 py-2.5 px-1 transition-colors touch-manipulation ${
                isActive ? 'text-ixi-cyan' : 'text-ixi-textMuted'
              }`}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
            >
              {isActive && (
                <motion.div
                  layoutId="tabbar-indicator"
                  className="absolute top-0 left-3 right-3 h-0.5 rounded-full bg-gradient-to-r from-ixi-cyan to-ixi-violet shadow-glow-cyan-sm"
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
              <motion.span
                animate={{ scale: isActive ? 1.12 : 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                className="relative"
              >
                {tab.icon}
                {tab.id === 'admin' && pendingReports > 0 && (
                  <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-ixi-danger text-white text-[9px] font-bold flex items-center justify-center">
                    {pendingReports}
                  </span>
                )}
              </motion.span>
              <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
