import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bug, Send, X, FileText, CheckCircle } from 'lucide-react';
import { useReportStore } from '@/store/useReportStore';
import { useAppStore } from '@/store/useAppStore';
import { usePlatform, detectPlatform, detectDeviceTier, tierLabel } from '@/services/platformService';

interface ReportModalProps {
  onClose: () => void;
}

const categories = [
  { value: 'render_error', label: 'Fallo de Renderizado 4K' },
  { value: 'audio_sync', label: 'Audio desincronizado' },
  { value: 'preview_issue', label: 'Problema con la Vista Previa' },
  { value: 'suggestion', label: 'Sugerencia / Otro' },
] as const;

export function ReportModal({ onClose }: ReportModalProps) {
  const [category, setCategory] = useState<typeof categories[number]['value']>('render_error');
  const [message, setMessage] = useState('');
  const [hasLogs, setHasLogs] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  
  const { addReport } = useReportStore();
  const user = useAppStore((s) => s.user);
  const exportSettings = useAppStore((s) => s.exportSettings);
  const exportMeta = useAppStore((s) => s.exportMeta);
  const currentVideo = useAppStore((s) => s.currentVideo);
  const processingOptions = useAppStore((s) => s.processingOptions);
  const { isTauriEnv } = usePlatform();

  // El modal no se cierra a mitad de un envío (evita perder el reporte)
  const isOpenRef = useRef(true);
  const requestClose = () => {
    if (isSubmitting) return;
    isOpenRef.current = false;
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;

    setIsSubmitting(true);
    try {
      // Guardado REAL en el inbox de reportes (persistente, visible para el admin)
      addReport({
        userId: user?.email?.split('@')[0] || 'anonymous',
        userEmail: user?.email || 'anonymous@ixi4k.com',
        category,
        message: message.trim(),
        hasLogs,
        logs: hasLogs ? generateRealLogs() : undefined,
      });
      setIsSuccess(true);
      // Auto-cierre sólo si el usuario no lo cerró ya él mismo
      setTimeout(() => {
        if (isOpenRef.current) onClose();
      }, 2000);
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Informe técnico TÉCNICO y veraz: únicamente datos que la app conoce
   * de verdad (nada de versiones, GPUs o memorias inventadas).
   */
  const generateRealLogs = () => {
    const lines: string[] = [];
    lines.push(`[${new Date().toISOString()}] ixi 4k — informe técnico real`);
    lines.push(
      `[Entorno] ${detectPlatform()} · ${tierLabel(detectDeviceTier())} · ${
        isTauriEnv ? 'Tauri (escritorio)' : 'navegador/PWA'
      }`
    );
    lines.push(`[Navegador] ${navigator.userAgent}`);
    if (currentVideo) {
      const dims =
        currentVideo.width && currentVideo.height
          ? ` · ${currentVideo.width}×${currentVideo.height}`
          : '';
      lines.push(
        `[Origen] ${currentVideo.name} · ${currentVideo.type} · ${(currentVideo.size / 1048576).toFixed(2)} MB${dims}`
      );
    } else {
      lines.push('[Origen] sin vídeo importado');
    }
    lines.push(
      `[Ajustes] ${exportSettings.resolution} · ${exportSettings.fps} FPS · CRF ${exportSettings.crf} · ${exportSettings.bitrate} Mbps`
    );
    lines.push(
      `[Mejoras] nitidez ${exportSettings.sharpness} · contraste ${exportSettings.contrast} · ruido ${exportSettings.noiseReduction}% · claridad ${exportSettings.clarity}%`
    );
    lines.push(
      `[Anti-Shadowban] firma anti-duplicado ${
        processingOptions.antiDuplicate === false ? 'desactivada' : 'activada'
      } · preset TikTok ${processingOptions.tiktokPreset ? 'activado' : 'desactivado'}`
    );
    if (exportMeta) {
      const avisos = exportMeta.notes.length ? ` · avisos: ${exportMeta.notes.join('; ')}` : '';
      lines.push(
        `[Última exportación] ${exportMeta.sourceWidth}×${exportMeta.sourceHeight} → ${exportMeta.targetWidth}×${exportMeta.targetHeight} · ${exportMeta.acceleration} · ${exportMeta.interpolation}${avisos}`
      );
      if (exportMeta.command) lines.push(`[Comando] ${exportMeta.command}`);
    } else {
      lines.push('[Última exportación] ninguna en esta sesión');
    }
    return lines.join('\n');
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={requestClose}
    >
      <motion.div
        className="w-full max-w-lg card-glow"
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        {isSuccess ? (
          <div className="p-6 sm:p-8 text-center">
            <motion.div
              className="w-16 h-16 mx-auto mb-4 rounded-full bg-ixi-success/20 flex items-center justify-center"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 200 }}
            >
              <CheckCircle className="w-8 h-8 text-ixi-success" />
            </motion.div>
            <h3 className="text-xl font-bold text-ixi-success mb-2">¡Reporte Enviado!</h3>
            <p className="text-sm text-ixi-textMuted">
              Gracias por tu feedback. Revisaremos tu reporte pronto.
            </p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/10">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-ixi-danger/20 flex items-center justify-center">
                  <Bug className="w-5 h-5 text-ixi-danger" />
                </div>
                <div>
                  <h3 className="font-semibold">Reportar Problema</h3>
                  <p className="text-xs text-ixi-textMuted">Feedback y soporte técnico</p>
                </div>
              </div>
              <button
                onClick={requestClose}
                disabled={isSubmitting}
                className="p-2 rounded-lg hover:bg-ixi-bgSecondary text-ixi-textMuted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Cerrar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-ixi-text mb-2">
                  Categoría
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as typeof category)}
                  className="input-field"
                  disabled={isSubmitting}
                >
                  {categories.map((cat) => (
                    <option key={cat.value} value={cat.value}>
                      {cat.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Message */}
              <div>
                <label className="block text-sm font-medium text-ixi-text mb-2">
                  Descripción del problema
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="input-field min-h-[120px] resize-none"
                  placeholder="Describe el problema que estás experimentando con el mayor detalle posible..."
                  required
                  disabled={isSubmitting}
                />
              </div>

              {/* Attach logs */}
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasLogs}
                    onChange={(e) => setHasLogs(e.target.checked)}
                    className="w-5 h-5 rounded border-ixi-border bg-ixi-bgSecondary text-ixi-cyan focus:ring-ixi-cyan focus:ring-offset-0"
                    disabled={isSubmitting}
                  />
                  <div className="flex items-center gap-2">
                    <FileText className="w-4 h-4 text-ixi-textMuted" />
                    <span className="text-sm text-ixi-text">
                      Adjuntar informe técnico de FFmpeg / Logs del sistema
                    </span>
                  </div>
                </label>
              </div>

              {/* Submit */}
              <motion.button
                type="submit"
                disabled={isSubmitting || !message.trim()}
                className="btn-primary w-full py-3 disabled:opacity-50 disabled:cursor-not-allowed"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                {isSubmitting ? (
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-ixi-bg/30 border-t-ixi-bg rounded-full animate-spin" />
                    <span>Enviando...</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2">
                    <Send className="w-4 h-4" />
                    <span>Enviar Reporte</span>
                  </div>
                )}
              </motion.button>
            </form>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}