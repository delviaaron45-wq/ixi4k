import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Gestor de versiones del Panel Admin — ixi 4k
 *
 * Historial REAL de versiones publicadas por el administrador, con notas de
 * la versión y la marca de "actualización crítica". No hay historial
 * inventado: sólo la versión instalada (inyectada desde package.json) y las
 * que el administrador registre manualmente.
 */

export interface VersionEntry {
  id: string;
  version: string;
  releasedAt: string;
  notes: string;
  critical: boolean;
}

interface VersionState {
  versions: VersionEntry[];
  addVersion: (version: string, notes: string, critical?: boolean) => void;
  updateNotes: (id: string, notes: string) => void;
  toggleCritical: (id: string) => void;
  deleteVersion: (id: string) => void;
}

/** Versión real de esta instalación (define de Vite desde package.json). */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

function seedInstalledVersion(): VersionEntry[] {
  return [
    {
      id: `ver_${APP_VERSION.replace(/[^a-zA-Z0-9]/g, '_')}`,
      version: APP_VERSION,
      releasedAt: new Date().toISOString(),
      notes: 'Versión instalada actualmente en este dispositivo.',
      critical: false,
    },
  ];
}

export const useVersionStore = create<VersionState>()(
  persist(
    (set, get) => ({
      versions: seedInstalledVersion(),

      addVersion: (version, notes, critical = false) => {
        const clean = version.trim();
        if (!clean) return;
        const exists = get().versions.some(
          (v) => v.version.trim().toLowerCase() === clean.toLowerCase()
        );
        if (exists) return;
        const entry: VersionEntry = {
          id: `ver_${Date.now()}`,
          version: clean,
          releasedAt: new Date().toISOString(),
          notes: notes.trim(),
          critical,
        };
        set((state) => ({ versions: [entry, ...state.versions] }));
      },

      updateNotes: (id, notes) => {
        set((state) => ({
          versions: state.versions.map((v) =>
            v.id === id ? { ...v, notes } : v
          ),
        }));
      },

      toggleCritical: (id) => {
        set((state) => ({
          versions: state.versions.map((v) =>
            v.id === id ? { ...v, critical: !v.critical } : v
          ),
        }));
      },

      deleteVersion: (id) => {
        set((state) => ({
          versions: state.versions.filter((v) => v.id !== id),
        }));
      },
    }),
    {
      name: 'ixi-4k-versions-storage',
      partialize: (state) => ({ versions: state.versions }),
      version: 1,
    }
  )
);
