import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAdminStore } from './useAdminStore';
import { useReportStore } from './useReportStore';
import { useAppStore } from './useAppStore';
import { useMaintenanceStore } from './useMaintenanceStore';
import { useVersionStore } from './useVersionStore';
import { useSubscriptionStore } from './useSubscriptionStore';

/**
 * Copias de seguridad locales — ixi 4k
 *
 * Snapshots de las claves de almacenamiento gestionadas por la app, para
 * RECUPERAR el estado antes de operaciones destructivas (restaurar, purgar…)
 * o ante un error. Todo vive en el localStorage de este dispositivo.
 */

export interface BackupEntry {
  id: string;
  label: string;
  createdAt: string;
  sizeKB: number;
  /** Valor CRUDO de cada clave de localStorage incluida en la copia */
  stores: Record<string, string>;
}

interface BackupState {
  backups: BackupEntry[];
  /** Crea una copia; devuelve `null` si no hay espacio o no hay datos */
  createBackup: (label: string) => BackupEntry | null;
  /** Copia automática con motivo (p. ej. "antes de restaurar") */
  autoBackup: (reason: string) => BackupEntry | null;
  /** Restaura una copia: primero guarda el estado actual (copia automática) */
  restoreBackup: (id: string) => { ok: boolean; reason?: string };
  deleteBackup: (id: string) => void;
  /** Descarga todas las copias como JSON */
  exportToFile: () => void;
  /** Importa copias desde un JSON exportado previamente */
  importFromFile: (file: File) => Promise<{ ok: boolean; reason?: string }>;
}

/** Claves de localStorage cuyo contenido respalda o restaura la app. */
export const BACKUP_KEYS = [
  'ixi-4k-admin-storage',
  'ixi-4k-reports-storage',
  'ixi-4k-storage',
  'ixi4k-maintenance-storage',
  'ixi-4k-versions-storage',
  'ixi-4k-subs-storage',
] as const;

/** Se conservan como máximo estas copias (más antiguas se descartan). */
const MAX_BACKUPS = 6;
/** Límite por copia para no desbordar el localStorage (~5 MB). */
const MAX_BACKUP_BYTES = 1_500_000;

function snapshotStores(): Record<string, string> | null {
  if (typeof localStorage === 'undefined') return null;
  const stores: Record<string, string> = {};
  let total = 0;
  for (const key of BACKUP_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    total += raw.length;
    if (total > MAX_BACKUP_BYTES) return null; // demasiado grande
    stores[key] = raw;
  }
  return Object.keys(stores).length > 0 ? stores : null;
}

function parsePersisted(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (parsed && typeof parsed === 'object' && parsed.state && typeof parsed.state === 'object') {
      return parsed.state;
    }
    return null;
  } catch {
    return null;
  }
}

/** Aplica al estado EN MEMORIA lo contenido en una copia. */
function applyStoresToState(stores: Record<string, string>): void {
  const apply: Record<string, (state: Record<string, unknown>) => void> = {
    'ixi-4k-admin-storage': (s) => useAdminStore.setState(s),
    'ixi-4k-reports-storage': (s) => useReportStore.setState(s),
    'ixi-4k-storage': (s) => useAppStore.setState(s),
    'ixi4k-maintenance-storage': (s) => useMaintenanceStore.setState(s),
    'ixi-4k-versions-storage': (s) => useVersionStore.setState(s),
    'ixi-4k-subs-storage': (s) => useSubscriptionStore.setState(s),
  };
  for (const [key, raw] of Object.entries(stores)) {
    const target = apply[key];
    if (!target) continue;
    const state = parsePersisted(raw);
    if (state) target(state);
  }
}

export const useBackupStore = create<BackupState>()(
  persist(
    (set, get) => ({
      backups: [],

      createBackup: (label) => {
        const stores = snapshotStores();
        if (!stores) return null;
        const rawSize = Object.values(stores).reduce((sum, v) => sum + v.length, 0);
        const entry: BackupEntry = {
          id: `bkp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          label: label.trim() || `Copia ${new Date().toLocaleString('es-ES')}`,
          createdAt: new Date().toISOString(),
          sizeKB: Math.max(1, Math.round(rawSize / 1024)),
          stores,
        };
        set((state) => {
          // Ordenadas de más reciente a más antigua; se conservan las N últimas
          const next = [entry, ...state.backups].slice(0, MAX_BACKUPS);
          return { backups: next };
        });
        return entry;
      },

      autoBackup: (reason) => get().createBackup(`Automática — ${reason}`),

      restoreBackup: (id) => {
        const target = get().backups.find((b) => b.id === id);
        if (!target) return { ok: false, reason: 'Copia no encontrada' };

        // 1) Salvaguarda del estado ACTUAL antes de sobrescribirlo
        get().autoBackup('antes de restaurar');

        // 2) Vuelca la copia a localStorage (persistencia)
        try {
          for (const [key, raw] of Object.entries(target.stores)) {
            localStorage.setItem(key, raw);
          }
        } catch {
          return { ok: false, reason: 'Sin espacio en el almacenamiento local' };
        }

        // 3) Y al estado en memoria (sin recargar la app)
        applyStoresToState(target.stores);
        return { ok: true };
      },

      deleteBackup: (id) => {
        set((state) => ({ backups: state.backups.filter((b) => b.id !== id) }));
      },

      exportToFile: () => {
        const payload = {
          app: 'ixi-4k',
          kind: 'backups',
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          backups: get().backups,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], {
          type: 'application/json',
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `ixi4k_copias_${Date.now()}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      },

      importFromFile: async (file) => {
        try {
          const text = await file.text();
          const parsed = JSON.parse(text) as {
            app?: string;
            kind?: string;
            backups?: BackupEntry[];
          };
          if (parsed?.app !== 'ixi-4k' || !Array.isArray(parsed.backups)) {
            return { ok: false, reason: 'El archivo no es una copia de ixi 4k' };
          }
          const valid = parsed.backups.filter(
            (b) =>
              b &&
              typeof b.id === 'string' &&
              typeof b.label === 'string' &&
              b.stores &&
              typeof b.stores === 'object'
          );
          if (valid.length === 0) return { ok: false, reason: 'Sin copias válidas en el archivo' };

          const existing = new Set(get().backups.map((b) => b.id));
          const incoming = valid.filter((b) => !existing.has(b.id));
          if (incoming.length === 0) {
            return { ok: false, reason: 'Las copias del archivo ya están importadas' };
          }
          set((state) => ({
            backups: [...incoming, ...state.backups].slice(0, MAX_BACKUPS),
          }));
          return { ok: true };
        } catch {
          return { ok: false, reason: 'Archivo JSON no válido' };
        }
      },
    }),
    {
      name: 'ixi-4k-backups-storage',
      partialize: (state) => ({ backups: state.backups }),
      version: 1,
    }
  )
);
