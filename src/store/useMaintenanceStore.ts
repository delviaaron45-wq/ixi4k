import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const DEFAULT_MAINTENANCE_MESSAGE =
  'Ajustando servidores para máxima calidad 4K. Volveremos pronto.';

interface MaintenanceState {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  lastUpdated: string | null;
  setMaintenanceMode: (active: boolean) => void;
  setMaintenanceMessage: (message: string) => void;
}

/**
 * Sincronización con backend (Supabase/Firebase).
 * Tabla sugerida: app_settings(key, value, updated_at)
 *   { key: 'maintenance', value: { active, message, updatedBy } }
 */
async function syncToBackend(payload: {
  active: boolean;
  message: string;
  updatedBy: string;
}): Promise<void> {
  // En producción:
  // await supabase.from('app_settings')
  //   .upsert({ key: 'maintenance', value: payload, updated_at: new Date().toISOString() })
  console.info('[Maintenance] Estado sincronizado con backend:', payload);
}

export const useMaintenanceStore = create<MaintenanceState>()(
  persist(
    (set, get) => ({
      maintenanceMode: false,
      maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
      lastUpdated: null,

      setMaintenanceMode: (active) => {
        set({ maintenanceMode: active, lastUpdated: new Date().toISOString() });
        void syncToBackend({
          active,
          message: get().maintenanceMessage,
          updatedBy: 'admin_master',
        });
      },

      setMaintenanceMessage: (message) => {
        set({ maintenanceMessage: message, lastUpdated: new Date().toISOString() });
        void syncToBackend({
          active: get().maintenanceMode,
          message,
          updatedBy: 'admin_master',
        });
      },
    }),
    {
      name: 'ixi4k-maintenance-storage',
      partialize: (state) => ({
        maintenanceMode: state.maintenanceMode,
        maintenanceMessage: state.maintenanceMessage,
        lastUpdated: state.lastUpdated,
      }),
    }
  )
);