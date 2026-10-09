import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download, CheckCircle, AlertCircle, Loader2, FolderOpen, X, Terminal, Info, Share2 } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { buildRenderSettings, describeRenderPlan, upscaleNote } from '@/lib/qualityPipeline';
import { canSaveToGallery, saveVideoToGallery } from '@/lib/saveVideo';
import { usePlatform } from '@/services/platformService';

/** ETA legible ("42s" / "3m 05s") — nunca inventado: sale del progreso real. */
function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

function Cell({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={`rounded-lg bg-ixi-bgSecondary/60 border border-white/10 px-2 py-1.5 min-w-0 ${
        wide ? 'col-span-2' : ''
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-ixi-textMuted">{label}</div>
      <div className="text-xs font-mono text-ixi-text truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

export function ExportButton() {
  // Selectores individuales: evita re-renderizar ante cambios ajenos al export
  const isExporting = useAppStore((s) => s.isExporting);
  const exportProgress = useAppStore((s) => s.exportProgress);
  const exportStatus = useAppStore((s) => s.exportStatus);
  const exportError = useAppStore((s) => s.exportError);
  const startExport = useAppStore((s) => s.startExport);
  const resetExport = useAppStore((s) => s.resetExport);
  const currentVideo = useAppStore((s) => s.currentVideo);
  const exportedFilePath = useAppStore((s) => s.exportedFilePath);
  const showSuccessNotification = useAppStore((s) => s.showSuccessNotification);
  const exportedBlob = useAppStore((s) => s.exportedBlob);
  const webSaveOutcome = useAppStore((s) => s.webSaveOutcome);
  const openDownloadsFolder = useAppStore((s) => s.openDownloadsFolder);
  const dismissNotification = useAppStore((s) => s.dismissNotification);
  const exportMeta = useAppStore((s) => s.exportMeta);
  const exportSettings = useAppStore((s) => s.exportSettings);
  const processingOptions = useAppStore((s) => s.processingOptions);
  const { isTauriEnv, platform, tier } = usePlatform();

  // Plan honesto calculado con las MISMAS fórmulas que el motor de exportación.
  // useMemo: solo se recalcula cuando cambian los ajustes o el vídeo.
  const planSettings = useMemo(
    () =>
      buildRenderSettings({
        exportSettings,
        processingOptions,
        deviceTier: tier,
        platform,
      }),
    [exportSettings, processingOptions, tier, platform]
  );
  const sourceInfo = useMemo(
    () =>
      currentVideo?.width && currentVideo?.height
        ? { width: currentVideo.width, height: currentVideo.height, fps: 0 }
        : null,
    [currentVideo]
  );
  const planSummary = useMemo(
    () => (currentVideo ? describeRenderPlan(planSettings, sourceInfo) : ''),
    [currentVideo, planSettings, sourceInfo]
  );
  const planNote = useMemo(
    () => (currentVideo ? upscaleNote(planSettings, sourceInfo) : null),
    [currentVideo, planSettings, sourceInfo]
  );

  const meta = exportMeta;
  const originText = meta
    ? `${meta.sourceWidth}×${meta.sourceHeight}${
        meta.sourceFps > 0 ? ` · ${Math.round(meta.sourceFps)} fps` : ''
      }`
    : '—';
  const outputText = meta
    ? `${meta.targetWidth}×${meta.targetHeight}${
        meta.outputFps > 0 ? ` · ${Math.round(meta.outputFps)} fps` : ''
      }`
    : '—';
  const speedText = meta
    ? `${meta.fps > 0 ? Math.round(meta.fps) : '—'} fps${meta.speed ? ` · ${meta.speed}` : ''}`
    : '—';

  const handleExport = () => {
    if (exportStatus === 'complete') {
      setFolderState('idle');
      resetExport();
    } else {
      startExport();
    }
  };

  // "Abrir carpeta" con estado real: abriendo → éxito (se puede reintentar) o error
  const [folderState, setFolderState] = useState<'idle' | 'opening' | 'error'>('idle');
  const handleOpenFolder = async () => {
    if (folderState === 'opening') return;
    setFolderState('opening');
    const ok = await openDownloadsFolder();
    setFolderState(ok ? 'idle' : 'error');
  };

  // "Guardar en galería" (Web Share API, sólo en dispositivos que la soportan):
  // abre la hoja del sistema para que el usuario elija «Guardar en Fotos».
  // Estado real: guardando → ✓ guardado / cancelado / error (siempre reintentable).
  const [galleryState, setGalleryState] = useState<
    'idle' | 'saving' | 'saved' | 'cancelled' | 'error'
  >('idle');
  const canGallery = !!exportedBlob && canSaveToGallery();
  const handleSaveGallery = async () => {
    if (!exportedBlob || galleryState === 'saving') return;
    setGalleryState('saving');
    const name = exportedFilePath?.split(/[\\/]/).pop() || `ixi4k_edit_${Date.now()}.mp4`;
    const out = await saveVideoToGallery(exportedBlob, name);
    setGalleryState(out === 'shared' || out === 'downloaded' ? 'saved' : out);
  };
  // Éxito real de guardado: share completado en el export o por el botón
  const gallerySaved = webSaveOutcome === 'shared' || galleryState === 'saved';

  return (
    <motion.div
      className="space-y-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.4 }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Exportar</h3>
        {exportStatus === 'complete' && (
          <span className="text-xs text-ixi-success flex items-center gap-1">
            <CheckCircle className="w-4 h-4" />
            Completado
          </span>
        )}
      </div>

      <div className="card-glow p-6">
        {exportStatus === 'idle' && (
          <div className="text-center">
            <p className="text-sm text-ixi-textMuted mb-4">
              {planSummary || 'Tu vídeo será procesado con la cadena de calidad de ixi 4k'}
            </p>
            <motion.button
              onClick={handleExport}
              disabled={!currentVideo || isExporting}
              className="btn-primary w-full py-4 text-lg disabled:opacity-50 disabled:cursor-not-allowed"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <div className="flex items-center justify-center gap-3">
                <Download className="w-5 h-5" />
                <span>Exportar Vídeo Optimizado</span>
              </div>
            </motion.button>
          </div>
        )}

        {exportStatus === 'processing' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ixi-textMuted">{meta?.label || 'Procesando…'}</span>
              <span className="font-mono text-ixi-cyan">{exportProgress}%</span>
            </div>
            <div className="h-2 bg-ixi-bgSecondary rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-ixi-cyan to-ixi-violet rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${exportProgress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>

            {/* Datos REALES del motor (no simulados) */}
            <div className="grid grid-cols-2 gap-2">
              <Cell label="Origen" value={originText} />
              <Cell label="Salida" value={outputText} />
              <Cell label="Velocidad" value={speedText} />
              <Cell label="Restante" value={meta ? formatEta(meta.etaSeconds) : '—'} />
              <Cell label="Aceleración" value={meta?.acceleration || '—'} />
              <Cell label="Interpolación" value={meta?.interpolation || '—'} />
            </div>

            <div className="flex items-start gap-2 text-xs text-ixi-textMuted">
              <Loader2 className="w-4 h-4 animate-spin shrink-0 mt-0.5" />
              <span>{meta?.summary || 'Preparando el plan de render…'}</span>
            </div>

            {(meta?.notes.length ?? 0) > 0 && (
              <ul className="space-y-1">
                {meta?.notes.map((note) => (
                  <li
                    key={note}
                    className="text-[11px] text-ixi-warning flex items-start gap-1.5"
                  >
                    <Info className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {exportStatus === 'complete' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-ixi-success/20 flex items-center justify-center">
              <CheckCircle className="w-8 h-8 text-ixi-success" />
            </div>
            <h4 className="font-semibold text-ixi-success mb-2">¡Exportación completada!</h4>
            <p className="text-sm text-ixi-textMuted mb-2">
              {meta ? `${meta.targetWidth}×${meta.targetHeight} · ${meta.acceleration}` : ''}
            </p>
            <p className="text-xs text-ixi-textMuted mb-4">
              {isTauriEnv
                ? 'Tu vídeo está optimizado y listo para TikTok'
                : 'Descargado en tu carpeta de descargas (listo para TikTok)'}
            </p>
            {/* Limitaciones honestas del resultado: siguen visibles al terminar
                (p. ej. fps ajustados al origen o ausencia de audio en navegador) */}
            {(meta?.notes.length ?? 0) > 0 && (
              <ul className="space-y-1 mb-4 text-left">
                {meta?.notes.map((note) => (
                  <li
                    key={note}
                    className="text-[11px] text-ixi-warning flex items-start gap-1.5"
                  >
                    <Info className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-3">
              {isTauriEnv && (
                <button
                  onClick={handleOpenFolder}
                  disabled={folderState === 'opening'}
                  className="btn-primary flex-1 disabled:opacity-60 disabled:cursor-wait"
                >
                  <div className="flex items-center justify-center gap-2">
                    {folderState === 'opening' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FolderOpen className="w-4 h-4" />
                    )}
                    {folderState === 'opening' ? 'Abriendo…' : 'Abrir carpeta de Descargas'}
                  </div>
                </button>
              )}
              <button
                onClick={resetExport}
                className={`btn-ghost ${isTauriEnv ? 'flex-1' : 'w-full'}`}
              >
                Nuevo vídeo
              </button>
            </div>
            {folderState === 'error' && (
              <p role="alert" className="mt-2 text-xs text-ixi-danger text-center">
                No se pudo abrir la carpeta desde la app. Búscala en tu carpeta de Descargas.
              </p>
            )}
          </motion.div>
        )}

        {exportStatus === 'error' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-ixi-danger/20 flex items-center justify-center">
              <AlertCircle className="w-8 h-8 text-ixi-danger" />
            </div>
            <h4 className="font-semibold text-ixi-danger mb-2">Error en la exportación</h4>
            <p className="text-sm text-ixi-textMuted mb-4">{exportError}</p>
            <button onClick={handleExport} className="btn-primary">
              Reintentar
            </button>
          </motion.div>
        )}
      </div>

      {/* Plan real (mismas fórmulas que el motor) + comando FFmpeg si ya corre */}
      <div className="p-4 rounded-xl bg-ixi-bgSecondary/50 border border-white/10">
        <p className="text-xs text-ixi-textMuted mb-1">Plan de exportación:</p>
        <p className="text-xs text-ixi-text break-words">
          {planSummary || '—'}
          {!isTauriEnv && ' · motor WebCodecs (navegador)'}
        </p>
        {planNote && (
          <p className="mt-2 text-[11px] leading-snug text-ixi-warning flex items-start gap-1.5">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            <span>{planNote}</span>
          </p>
        )}
        {meta?.command ? (
          <>
            <p className="mt-3 text-xs text-ixi-textMuted mb-1 flex items-center gap-1.5">
              <Terminal className="w-3 h-3" />
              Comando FFmpeg en ejecución:
            </p>
            <code className="block text-[11px] text-ixi-cyan font-mono break-all max-h-28 overflow-y-auto">
              {meta.command}
            </code>
          </>
        ) : (
          isTauriEnv && (
            <p className="mt-3 text-[11px] text-ixi-textMuted">
              El comando FFmpeg real se muestra al iniciar la exportación.
            </p>
          )
        )}
      </div>

      {/* Success Notification */}
      <AnimatePresence>
        {showSuccessNotification && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-6 right-6 z-50"
          >
            <div className="card p-4 flex items-center gap-4 max-w-sm shadow-glow-cyan">
              <div className="w-12 h-12 rounded-full bg-ixi-success/20 flex items-center justify-center flex-shrink-0">
                <CheckCircle className="w-6 h-6 text-ixi-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ixi-success mb-1">¡Vídeo IXi 4k guardado!</p>
                <p className="text-xs text-ixi-textMuted truncate">
                  {exportedFilePath?.split(/[\\/]/).pop() || 'Archivo guardado en Descargas'}
                </p>
                {/* Confirmación VERAZ de lo que pasó de verdad (share/descarga) */}
                {gallerySaved ? (
                  <p className="text-[11px] text-ixi-success mt-1 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> Guardado donde elegiste (p. ej. Fotos)
                  </p>
                ) : canGallery ? (
                  <p className="text-[11px] text-ixi-cyan mt-1">
                    {galleryState === 'cancelled'
                      ? 'Guardado cancelado — pulsa «Guardar en galería» cuando quieras'
                      : galleryState === 'error'
                        ? 'No se pudo guardar — vuelve a pulsar el botón'
                        : 'Pulsa «Guardar en galería» para añadirlo a Fotos'}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {canGallery && (
                  <button
                    onClick={handleSaveGallery}
                    disabled={galleryState === 'saving'}
                    aria-label="Guardar en la galería"
                    title="Guardar en la galería (Fotos)"
                    className={`p-2 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-wait ${
                      galleryState === 'error'
                        ? 'bg-ixi-danger/10 hover:bg-ixi-danger/20 text-ixi-danger'
                        : gallerySaved
                          ? 'bg-ixi-success/10 hover:bg-ixi-success/20 text-ixi-success'
                          : 'bg-ixi-cyan/10 hover:bg-ixi-cyan/20 text-ixi-cyan'
                    }`}
                  >
                    {galleryState === 'saving' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : gallerySaved ? (
                      <CheckCircle className="w-4 h-4" />
                    ) : (
                      <Share2 className="w-4 h-4" />
                    )}
                  </button>
                )}
                {isTauriEnv && (
                  <button
                    onClick={handleOpenFolder}
                    disabled={folderState === 'opening'}
                    aria-label="Abrir carpeta de Descargas"
                    title="Abrir carpeta de Descargas"
                    className={`p-2 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-wait ${
                      folderState === 'error'
                        ? 'bg-ixi-danger/10 hover:bg-ixi-danger/20 text-ixi-danger'
                        : 'bg-ixi-cyan/10 hover:bg-ixi-cyan/20 text-ixi-cyan'
                    }`}
                  >
                    {folderState === 'opening' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FolderOpen className="w-4 h-4" />
                    )}
                  </button>
                )}
                <button
                  onClick={dismissNotification}
                  className="p-2 rounded-lg hover:bg-ixi-bgSecondary text-ixi-textMuted transition-colors"
                  title="Cerrar notificación"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
