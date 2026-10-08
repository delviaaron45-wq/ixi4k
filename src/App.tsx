import { lazy, Suspense } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useAppStore } from '@/store/useAppStore';
import { useAdminStore } from '@/store/useAdminStore';
import { useMaintenanceStore } from '@/store/useMaintenanceStore';
import { GlobalRipple } from '@/components/GlobalRipple';
import { AuthScreen } from '@/screens/AuthScreen';
import { Dashboard } from '@/screens/Dashboard';

// Solo se descarga si el modo mantenimiento está activo (fuera del bundle inicial)
const MaintenanceScreen = lazy(() =>
  import('@/components/MaintenanceScreen').then((m) => ({ default: m.MaintenanceScreen }))
);

function AppContent() {
  const isAuthenticated = useAppStore((s) => s.isAuthenticated);
  const isAdminAuthenticated = useAdminStore((s) => s.isAdminAuthenticated);
  const maintenanceMode = useMaintenanceStore((s) => s.maintenanceMode);

  // 1) Modo Mantenimiento ACTIVO → bloquea a todo usuario normal
  //    (oculta el Dashboard de edición y deshabilita importación/exportación)
  if (maintenanceMode && !isAdminAuthenticated) {
    return (
      <Suspense key="maintenance" fallback={null}>
        <MaintenanceScreen key="maintenance" />
      </Suspense>
    );
  }

  // 2) Excepción de Administrador → acceso completo incluso en mantenimiento
  if (isAdminAuthenticated) {
    return <Dashboard key="dashboard" />;
  }

  // 3) Flujo normal
  return (
    <AnimatePresence mode="wait">
      {isAuthenticated ? (
        <Dashboard key="dashboard" />
      ) : (
        <AuthScreen key="auth" />
      )}
    </AnimatePresence>
  );
}

export default function App() {
  return (
    <>
      <GlobalRipple />
      <AppContent />
    </>
  );
}