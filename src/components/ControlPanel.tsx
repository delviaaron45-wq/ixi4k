import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, Palette, Gauge, Smartphone, Cpu } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { ProcessingOptions } from '@/store/useAppStore';

/** La app de escritorio (Tauri) tiene el motor IA local; la web, no. */
const isTauriEnv =
  typeof window !== 'undefined' &&
  ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

/** Espejo TS de `AiCapability` (serde camelCase) de ai_superres.rs. */
interface AiCapabilityView {
  available: boolean;
  installed: boolean;
  canInstall: boolean;
  reason: string | null;
  backend: string;
  gpuName: string | null;
  vramMb: number | null;
  ramFreeMb: number;
  diskFreeMb: number;
  engineVersion: string;
}

interface ToggleProps {
  enabled: boolean;
  onChange: () => void;
  label: string;
  description: string;
  icon: React.ReactNode;
}

function Toggle({ enabled, onChange, label, description, icon }: ToggleProps) {
  return (
    <motion.div
      className={`p-4 rounded-xl border transition-all cursor-pointer ${
        enabled
          ? 'bg-ixi-cyan/5 border-ixi-cyan/30 shadow-glow-cyan-sm'
          : 'bg-ixi-bgSecondary/50 border-ixi-border hover:border-ixi-cyan/20'
      }`}
      onClick={onChange}
      role="button"
      tabIndex={0}
      aria-pressed={enabled}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onChange();
        }
      }}
      whileHover={{ scale: 1.02 }}
      whileTap={{ scale: 0.98 }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
          enabled ? 'bg-ixi-cyan/20' : 'bg-ixi-bgCard'
        }`}>
          {icon}
        </div>
        <div className={`toggle-switch ${enabled ? 'bg-ixi-cyan' : 'bg-ixi-border'}`}>
          <div className={`toggle-thumb ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </div>
      </div>
      <h4 className={`font-semibold mb-1 ${enabled ? 'text-ixi-cyan' : 'text-ixi-text'}`}>
        {label}
      </h4>
      <p className="text-xs text-ixi-textMuted">{description}</p>
    </motion.div>
  );
}

export function ControlPanel() {
  const processingOptions = useAppStore((s) => s.processingOptions);
  const toggleOption = useAppStore((s) => s.toggleOption);

  // --- Motor IA local (sólo escritorio) -----------------------------------
  const [aiCap, setAiCap] = useState<AiCapabilityView | null>(null);
  const [aiInstalling, setAiInstalling] = useState(false);
  const [aiProgress, setAiProgress] = useState(0);
  const [aiError, setAiError] = useState<string | null>(null);

  const refreshAi = async () => {
    if (!isTauriEnv) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setAiCap(await invoke<AiCapabilityView>('ai_status'));
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void refreshAi();
  }, []);

  const installAiEngine = async () => {
    if (aiInstalling) return;
    setAiInstalling(true);
    setAiError(null);
    setAiProgress(0);
    let unlisten: (() => void) | undefined;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const u = await listen<{ percent: number }>('ai-install-progress', (e) =>
        setAiProgress(Math.max(0, Math.min(100, e.payload?.percent ?? 0)))
      );
      unlisten = u;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('ai_install_engine');
      await refreshAi();
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setAiInstalling(false);
    }
  };

  const options: {
    key: keyof ProcessingOptions;
    label: string;
    description: string;
    icon: React.ReactNode;
  }[] = [
    ...(isTauriEnv
      ? [
          {
            key: 'aiUpscale' as keyof ProcessingOptions,
            label: 'IA · Super-resolución neuronal',
            description: aiCap?.installed
              ? 'Red neuronal Real-ESRGAN en tu GPU: síntesis real de detalle (mejora medible antes/después).'
              : 'Red neuronal Real-ESRGAN en tu GPU. Instala el motor (45 MB, una vez) para activarla.',
            icon: <Cpu className="w-5 h-5 text-ixi-cyan" />,
          },
        ]
      : []),
    {
      key: 'superResolution',
      label: 'Super-Resolución ixi 4k',
      description: 'Filtro Unsharp Mask + Nitidez profunda',
      icon: <Sparkles className="w-5 h-5 text-ixi-cyan" />,
    },
    {
      key: 'colorCorrection',
      label: 'Corrección de Color Cinemático',
      description: 'Contraste 1.15, Saturación 1.1',
      icon: <Palette className="w-5 h-5 text-ixi-violet" />,
    },
    {
      key: 'interpolate60fps',
      label: 'Interpolación de fotogramas',
      description: 'Hasta 120 FPS según la gama del dispositivo (la fuente con menos FPS se reconstruye)',
      icon: <Gauge className="w-5 h-5 text-ixi-cyan" />,
    },
    {
      key: 'tiktokPreset',
      label: 'Preset Optimizado TikTok',
      description: '1080x1920 9:16, H.264, 15 Mbps, AAC 320kbps',
      icon: <Smartphone className="w-5 h-5 text-ixi-violet" />,
    },
  ];

  return (
    <motion.div
      className="space-y-4"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Controles de Procesamiento</h3>
        <span className="text-xs text-ixi-textMuted">
          {options.filter((o) => processingOptions[o.key]).length}/{options.length} activos
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {options.map((option, index) => (
          <motion.div
            key={option.key}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 + index * 0.1 }}
          >
            <Toggle
              enabled={!!processingOptions[option.key]}
              onChange={() => toggleOption(option.key)}
              label={option.label}
              description={option.description}
              icon={option.icon}
            />
          </motion.div>
        ))}
      </div>

      {isTauriEnv ? (
        <div className="p-4 rounded-xl border bg-ixi-bgSecondary/50 border-ixi-border space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <Cpu className="w-4 h-4 text-ixi-cyan shrink-0" />
              <span className="text-sm font-medium">Motor de IA local</span>
              <span className="text-xs text-ixi-textMuted truncate">
                {aiCap
                  ? aiCap.installed
                    ? `Instalado · ${aiCap.gpuName ?? 'GPU'}${aiCap.vramMb ? ` · ${Math.round(aiCap.vramMb / 1024)} GB` : ''} · v${aiCap.engineVersion}`
                    : aiCap.canInstall
                      ? `Sin instalar · ${aiCap.gpuName ?? 'GPU detectada'}`
                      : `No disponible: ${aiCap.reason ?? 'requisitos no cumplidos'}`
                  : 'Comprobando capacidades…'}
              </span>
            </div>
            {aiCap && !aiCap.installed && aiCap.canInstall && (
              <button
                onClick={() => void installAiEngine()}
                disabled={aiInstalling}
                className="btn-primary text-sm disabled:opacity-50"
              >
                {aiInstalling
                  ? `Instalando… ${aiProgress}%`
                  : 'Instalar motor (45 MB, una vez)'}
              </button>
            )}
          </div>
          {aiInstalling && (
            <div
              className="h-1.5 rounded-full bg-ixi-border overflow-hidden"
              role="progressbar"
              aria-valuenow={aiProgress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <motion.div
                className="h-full bg-ixi-cyan"
                initial={{ width: 0 }}
                animate={{ width: `${aiProgress}%` }}
                transition={{ duration: 0.2 }}
              />
            </div>
          )}
          {aiError && <p className="text-xs text-ixi-danger">{aiError}</p>}
          <p className="text-xs text-ixi-textMuted">
            0 € · licencia MIT · se ejecuta en tu equipo (Vulkan), sin subir el vídeo a ningún servidor. Sin motor o sin GPU compatible, el export sigue funcionando con Lanczos y lo indica en el plan.
          </p>
        </div>
      ) : (
        <div className="p-4 rounded-xl border bg-ixi-bgSecondary/50 border-ixi-border">
          <p className="text-xs text-ixi-textMuted">
            La super-resolución IA (Real-ESRGAN) está disponible en la app de escritorio (gratis). La versión web exporta en tu navegador con el pipeline clásico.
          </p>
        </div>
      )}
    </motion.div>
  );
}