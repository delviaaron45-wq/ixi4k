import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ReportPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Report {
  id: string;
  userId: string;
  userEmail: string;
  category: 'render_error' | 'audio_sync' | 'preview_issue' | 'suggestion' | 'other';
  message: string;
  hasLogs: boolean;
  logs?: string;
  status: 'pending' | 'resolved';
  /** Prioridad gestionada por el administrador (los previos no la traen) */
  priority?: ReportPriority;
  createdAt: string;
  updatedAt: string;
}

interface ReportState {
  reports: Report[];
  addReport: (report: Omit<Report, 'id' | 'createdAt' | 'updatedAt' | 'status'>) => void;
  resolveReport: (reportId: string) => void;
  deleteReport: (reportId: string) => void;
  setReportPriority: (reportId: string, priority: ReportPriority) => void;
  /** Siempre derivado de `reports` — correcto tras recargar o restaurar */
  getPendingCount: () => number;
}

// Sin datos de ejemplo: el inbox sólo contiene reportes REALES enviados por
// usuarios de este dispositivo (y se migran los sembrados por versiones viejas).
export const useReportStore = create<ReportState>()(
  persist(
    (set, get) => ({
      reports: [],

      addReport: (report) => {
        const newReport: Report = {
          ...report,
          id: `rpt_${Date.now()}`,
          status: 'pending',
          priority: report.priority ?? 'medium',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        set(state => ({
          reports: [newReport, ...state.reports],
        }));

        // Almacenamiento local persistente (visible en el Panel Admin)
        console.log('[Reportes] Guardado local:', newReport.id);
      },

      resolveReport: (reportId) => {
        set(state => {
          const target = state.reports.find(r => r.id === reportId);
          if (!target || target.status !== 'pending') return state;
          return {
            reports: state.reports.map(r =>
              r.id === reportId
                ? { ...r, status: 'resolved' as const, updatedAt: new Date().toISOString() }
                : r
            ),
          };
        });

        const report = get().reports.find(r => r.id === reportId);
        if (report) {
          console.log('[Reportes] Marcado como resuelto:', reportId);
        }
      },

      deleteReport: (reportId) => {
        set(state => ({
          reports: state.reports.filter(r => r.id !== reportId),
        }));
        console.log('[Reportes] Eliminado:', reportId);
      },

      setReportPriority: (reportId, priority) => {
        set(state => ({
          reports: state.reports.map(r =>
            r.id === reportId
              ? { ...r, priority, updatedAt: new Date().toISOString() }
              : r
          ),
        }));
      },

      getPendingCount: () => get().reports.filter(r => r.status === 'pending').length,
    }),
    {
      name: 'ixi-4k-reports-storage',
      partialize: (state) => ({
        reports: state.reports,
      }),
      // v1: se eliminan los reportes de demostración sembrados en versiones
      // antiguas: el inbox pasa a contener sólo envíos reales.
      version: 1,
      migrate: (persisted) => {
        const p = persisted as { reports?: Report[] } | undefined;
        const legacyIds = new Set(['rpt_001', 'rpt_002', 'rpt_003']);
        return { reports: (p?.reports ?? []).filter(r => !legacyIds.has(r.id)) };
      },
    }
  )
);

// Helper to get category label
export function getCategoryLabel(category: Report['category']): string {
  const labels: Record<Report['category'], string> = {
    render_error: 'Fallo de Renderizado 4K',
    audio_sync: 'Audio desincronizado',
    preview_issue: 'Problema con la Vista Previa',
    suggestion: 'Sugerencia / Otro',
    other: 'Otro',
  };
  return labels[category];
}

// Helper to get category color
export function getCategoryColor(category: Report['category']): string {
  const colors: Record<Report['category'], string> = {
    render_error: 'text-ixi-danger bg-ixi-danger/10',
    audio_sync: 'text-ixi-warning bg-ixi-warning/10',
    preview_issue: 'text-ixi-cyan bg-ixi-cyan/10',
    suggestion: 'text-ixi-violet bg-ixi-violet/10',
    other: 'text-ixi-textMuted bg-ixi-bgSecondary',
  };
  return colors[category];
}

/** Prioridad efectiva (los reportes antiguos sin campo son "media"). */
export function getReportPriority(report: Report): ReportPriority {
  return report.priority ?? 'medium';
}

export function getPriorityLabel(priority: ReportPriority): string {
  const labels: Record<ReportPriority, string> = {
    low: 'Baja',
    medium: 'Media',
    high: 'Alta',
    urgent: 'Urgente',
  };
  return labels[priority];
}

export function getPriorityColor(priority: ReportPriority): string {
  const colors: Record<ReportPriority, string> = {
    low: 'text-ixi-textMuted bg-ixi-bgSecondary',
    medium: 'text-ixi-cyan bg-ixi-cyan/10',
    high: 'text-ixi-warning bg-ixi-warning/10',
    urgent: 'text-ixi-danger bg-ixi-danger/10',
  };
  return colors[priority];
}

export const REPORT_PRIORITIES: ReportPriority[] = ['low', 'medium', 'high', 'urgent'];