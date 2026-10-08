import { useState } from 'react';
import { motion } from 'framer-motion';
import { Calendar, GitBranch, Loader2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useVersionStore, APP_VERSION, type VersionEntry } from '@/store/useVersionStore';
import { useBackupStore } from '@/store/useBackupStore';
import { useAdminStore } from '@/store/useAdminStore';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Historial de versiones: notas de cada versión y marca de "actualización
 * crítica". La lista sólo contiene la versión instalada (real) y las que el
 * administrador registra; no hay historial inventado.
 */
export function VersionManager() {
  const versions = useVersionStore((s) => s.versions);
  const addVersion = useVersionStore((s) => s.addVersion);
  const updateNotes = useVersionStore((s) => s.updateNotes);
  const toggleCritical = useVersionStore((s) => s.toggleCritical);
  const deleteVersion = useVersionStore((s) => s.deleteVersion);
  const autoBackup = useBackupStore((s) => s.autoBackup);
  const addAuditLog = useAdminStore((s) => s.addAuditLog);
  const adminEmail = useAdminStore((s) => s.adminEmail);

  const [newVersion, setNewVersion] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newCritical, setNewCritical] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState('');
  const [deleting, setDeleting] = useState<VersionEntry | null>(null);

  const audit = (action: string, details: string) => {
    addAuditLog({
      userId: 'admin_master',
      userEmail: adminEmail ?? 'admin',
      action,
      details,
      type: 'admin',
    });
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!newVersion.trim()) {
      setError('Indica el número de versión');
      return;
    }
    const exists = versions.some(
      (v) => v.version.trim().toLowerCase() === newVersion.trim().toLowerCase()
    );
    if (exists) {
      setError('Esa versión ya está en el historial');
      return;
    }
    setBusy(true);
    try {
      addVersion(newVersion, newNotes, newCritical);
      audit(
        'Versión registrada',
        `Versión ${newVersion.trim()} añadida al historial${newCritical ? ' (marcada como CRÍTICA)' : ''}`
      );
      setNewVersion('');
      setNewNotes('');
      setNewCritical(false);
    } finally {
      setBusy(false);
    }
  };

  const handleToggleCritical = (v: VersionEntry) => {
    toggleCritical(v.id);
    audit(
      'Prioridad de actualización',
      `Versión ${v.version} ${v.critical ? 'ya no es crítica' : 'marcada como actualización CRÍTICA'}`
    );
  };

  const handleSaveNotes = (v: VersionEntry) => {
    updateNotes(v.id, editNotes);
    audit('Notas de versión editadas', `Notas actualizadas de la versión ${v.version}`);
    setEditingId(null);
  };

  const handleDelete = async () => {
    if (!deleting) return false;
    setBusy(true);
    try {
      // Salvaguarda automática antes de una operación destructiva
      autoBackup(`Antes de eliminar la versión ${deleting.version}`);
      deleteVersion(deleting.id);
      audit('Versión eliminada', `Versión ${deleting.version} eliminada del historial (con copia previa)`);
      setDeleting(null);
      return true;
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* Versión instalada */}
      <div className="card p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-ixi-cyan/15 flex items-center justify-center">
              <GitBranch className="w-5 h-5 text-ixi-cyan" />
            </div>
            <div>
              <p className="text-sm text-ixi-textMuted">Versión instalada</p>
              <p className="text-xl font-bold text-ixi-cyan">{APP_VERSION}</p>
            </div>
          </div>
          <span className="text-xs text-ixi-textMuted">
            Fuente: package.json · compilación local
          </span>
        </div>
      </div>

      {/* Alta de versión */}
      <form onSubmit={handleAdd} className="card p-4 sm:p-6 space-y-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Plus className="w-5 h-5 text-ixi-violet" />
          Registrar una versión
        </h3>
        {error && (
          <p className="text-xs text-ixi-danger" role="alert">
            {error}
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            value={newVersion}
            onChange={(e) => setNewVersion(e.target.value)}
            className="input-field"
            placeholder="Versión (p. ej. 1.2.0)"
            disabled={busy}
          />
          <input
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            className="input-field sm:col-span-2"
            placeholder="Notas de la versión (novedades, correcciones…)"
            disabled={busy}
          />
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-ixi-textMuted cursor-pointer">
            <input
              type="checkbox"
              checked={newCritical}
              onChange={(e) => setNewCritical(e.target.checked)}
              className="w-4 h-4 accent-ixi-danger"
              disabled={busy}
            />
            Marcar como actualización crítica
          </label>
          <button
            type="submit"
            disabled={busy || !newVersion.trim()}
            className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Añadir al historial'}
          </button>
        </div>
      </form>

      {/* Historial */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-white/10">
          <h3 className="font-semibold flex items-center gap-2">
            <Calendar className="w-5 h-5 text-ixi-cyan" />
            Historial de versiones
          </h3>
        </div>
        {versions.length === 0 ? (
          <div className="p-10 text-center text-sm text-ixi-textMuted">
            Sin versiones registradas todavía
          </div>
        ) : (
          <div className="divide-y divide-white/10">
            {versions.map((v) => (
              <div key={v.id} className="p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono font-bold text-ixi-text">{v.version}</span>
                      {v.version === APP_VERSION && (
                        <span className="px-1.5 py-0.5 rounded bg-ixi-cyan/15 text-ixi-cyan text-[10px] font-bold uppercase">
                          Instalada
                        </span>
                      )}
                      {v.critical && (
                        <span className="px-1.5 py-0.5 rounded bg-ixi-danger/15 text-ixi-danger text-[10px] font-bold uppercase">
                          Crítica
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-ixi-textMuted mt-0.5">
                      Publicada {formatDate(v.releasedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleToggleCritical(v)}
                      className={`p-1.5 rounded-lg border transition-colors ${
                        v.critical
                          ? 'bg-ixi-danger/15 border-ixi-danger/40 text-ixi-danger'
                          : 'bg-ixi-bgCard border-ixi-border text-ixi-textMuted hover:text-ixi-danger'
                      }`}
                      title={
                        v.critical
                          ? 'Quitar marca de actualización crítica'
                          : 'Marcar como actualización crítica'
                      }
                    >
                      <Star className={`w-3.5 h-3.5 ${v.critical ? 'fill-current' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(editingId === v.id ? null : v.id);
                        setEditNotes(v.notes);
                      }}
                      className="p-1.5 rounded-lg bg-ixi-bgCard border border-ixi-border text-ixi-textMuted hover:text-ixi-cyan transition-colors"
                      title="Editar notas"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(v)}
                      className="p-1.5 rounded-lg bg-ixi-danger/10 border border-ixi-danger/30 text-ixi-danger hover:bg-ixi-danger/20 transition-colors"
                      title="Eliminar del historial"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {editingId === v.id ? (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      className="input-field min-h-20 resize-y"
                      placeholder="Notas de la versión"
                      rows={3}
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1.5 rounded-lg text-xs text-ixi-textMuted hover:text-ixi-text"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveNotes(v)}
                        className="px-3 py-1.5 rounded-lg bg-ixi-cyan/10 text-ixi-cyan text-xs font-medium hover:bg-ixi-cyan/20"
                      >
                        Guardar
                      </button>
                    </div>
                  </div>
                ) : (
                  v.notes && (
                    <p className="text-sm text-ixi-textMuted mt-2 whitespace-pre-wrap">
                      {v.notes}
                    </p>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleting}
        title="Eliminar versión del historial"
        message={`Se eliminará la versión ${deleting?.version} del historial. Se guardará una copia de seguridad automática antes.`}
        confirmLabel="Eliminar"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
      >
        {busy && (
          <p className="text-xs text-ixi-textMuted mb-3 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Guardando copia…
          </p>
        )}
      </ConfirmDialog>
    </motion.div>
  );
}
