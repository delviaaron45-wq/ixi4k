import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Archive,
  ArchiveRestore,
  Download,
  HardDriveDownload,
  Loader2,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useBackupStore, type BackupEntry } from '@/store/useBackupStore';
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
 * Copias de seguridad locales y recuperación. Se crean automáticamente antes
 * de operaciones destructivas (restaurar, eliminar versiones/cupones) y
 * pueden exportarse/importarse como JSON.
 */
export function BackupManager() {
  const backups = useBackupStore((s) => s.backups);
  const createBackup = useBackupStore((s) => s.createBackup);
  const restoreBackup = useBackupStore((s) => s.restoreBackup);
  const deleteBackup = useBackupStore((s) => s.deleteBackup);
  const exportToFile = useBackupStore((s) => s.exportToFile);
  const importFromFile = useBackupStore((s) => s.importFromFile);
  const addAuditLog = useAdminStore((s) => s.addAuditLog);
  const adminEmail = useAdminStore((s) => s.adminEmail);

  const [label, setLabel] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<BackupEntry | null>(null);
  const [deleting, setDeleting] = useState<BackupEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const audit = (action: string, details: string) => {
    addAuditLog({
      userId: 'admin_master',
      userEmail: adminEmail ?? 'admin',
      action,
      details,
      type: 'admin',
    });
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    const entry = createBackup(label || `Copia manual ${new Date().toLocaleString('es-ES')}`);
    if (!entry) {
      setError('No hay datos que copiar o la copia supera el espacio disponible');
      return;
    }
    audit('Copia de seguridad creada', `"${entry.label}" (${entry.sizeKB} KB)`);
    setNotice(`Copia "${entry.label}" creada.`);
    setLabel('');
  };

  const handleRestore = () => {
    if (!restoring) return false;
    setBusy(true);
    try {
      const result = restoreBackup(restoring.id);
      if (!result.ok) {
        setError(result.reason ?? 'No se pudo restaurar la copia');
        setRestoring(null);
        return false;
      }
      audit(
        'Copia restaurada',
        `"${restoring.label}" restaurada (con salvaguarda automática del estado previo)`
      );
      setNotice(`Copia "${restoring.label}" restaurada. Los datos mostrados ya están actualizados.`);
      setRestoring(null);
      return true;
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = () => {
    if (!deleting) return false;
    deleteBackup(deleting.id);
    audit('Copia eliminada', `"${deleting.label}" eliminada`);
    setDeleting(null);
    return true;
  };

  const handleImport = async (file: File) => {
    setError('');
    setNotice('');
    const result = await importFromFile(file);
    if (!result.ok) {
      setError(result.reason ?? 'No se pudo importar el archivo');
      return;
    }
    audit('Copias importadas', `Archivo ${file.name} importado`);
    setNotice('Copias importadas correctamente.');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div className="p-4 rounded-xl bg-ixi-cyan/5 border border-ixi-cyan/25">
        <p className="text-xs text-ixi-textMuted leading-relaxed">
          Las copias guardan los datos locales de la app (usuarios, auditoría, reportes,
          ajustes, versiones y suscripciones) en este dispositivo. Se crean automáticamente{' '}
          <strong className="text-ixi-text">antes de operaciones destructivas</strong> y puedes
          restaurarlas o exportarlas a un archivo JSON.
        </p>
      </div>

      {notice && (
        <div className="p-3 rounded-xl bg-ixi-success/10 border border-ixi-success/30 text-xs text-ixi-success">
          {notice}
        </div>
      )}
      {error && (
        <div className="p-3 rounded-xl bg-ixi-danger/10 border border-ixi-danger/30 text-xs text-ixi-danger">
          {error}
        </div>
      )}

      {/* Crear + importar/exportar */}
      <div className="card p-4 sm:p-6 space-y-3">
        <h3 className="font-semibold flex items-center gap-2">
          <Archive className="w-5 h-5 text-ixi-cyan" />
          Crear copia de seguridad
        </h3>
        <form onSubmit={handleCreate} className="flex gap-2 flex-col sm:flex-row">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="input-field flex-1"
            placeholder="Nombre de la copia (opcional)"
            aria-label="Nombre de la copia"
          />
          <button type="submit" className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
            <Plus className="w-4 h-4" /> Crear copia
          </button>
        </form>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={exportToFile}
            disabled={backups.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ixi-bgCard border border-ixi-border text-xs text-ixi-textMuted hover:text-ixi-cyan hover:border-ixi-cyan/40 transition-colors disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> Exportar a JSON
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ixi-bgCard border border-ixi-border text-xs text-ixi-textMuted hover:text-ixi-cyan hover:border-ixi-cyan/40 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" /> Importar JSON
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImport(file);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {/* Listado */}
      <div className="card overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between gap-2">
          <h3 className="font-semibold flex items-center gap-2">
            <HardDriveDownload className="w-5 h-5 text-ixi-violet" />
            Copias disponibles
          </h3>
          <span className="text-xs text-ixi-textMuted">{backups.length}/6</span>
        </div>

        {backups.length === 0 ? (
          <div className="p-10 text-center">
            <Archive className="w-10 h-10 mx-auto mb-2 text-ixi-textMuted opacity-50" />
            <p className="text-sm text-ixi-textMuted">
              Sin copias todavía — se crearán automáticamente antes de operaciones destructivas
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/10">
            {backups.map((b) => (
              <div key={b.id} className="p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ixi-text truncate">{b.label}</p>
                  <p className="text-[11px] text-ixi-textMuted">
                    {formatDate(b.createdAt)} · {b.sizeKB} KB ·{' '}
                    {Object.keys(b.stores).length} conjuntos de datos
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setNotice('');
                      setError('');
                      setRestoring(b);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ixi-cyan/10 text-ixi-cyan text-xs font-medium hover:bg-ixi-cyan/20 transition-colors"
                  >
                    <ArchiveRestore className="w-3.5 h-3.5" /> Restaurar
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleting(b)}
                    className="p-1.5 rounded-lg bg-ixi-danger/10 text-ixi-danger hover:bg-ixi-danger/20 transition-colors"
                    title="Eliminar copia"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!restoring}
        title="Restaurar esta copia"
        message={`Se sustituirán los datos actuales por los de "${restoring?.label}" (${formatDate(restoring?.createdAt ?? '')}). Antes se guardará una copia automática del estado actual.`}
        confirmLabel="Restaurar"
        danger
        requirePassword
        adminEmail={adminEmail ?? ''}
        onCancel={() => setRestoring(null)}
        onConfirm={handleRestore}
      >
        {busy && (
          <p className="text-xs text-ixi-textMuted mb-3 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Restaurando…
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleting}
        title="Eliminar copia"
        message={`Se eliminará la copia "${deleting?.label}" de forma permanente.`}
        confirmLabel="Eliminar"
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
      />
    </motion.div>
  );
}
