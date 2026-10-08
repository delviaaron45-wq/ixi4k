import { motion } from 'framer-motion';
import { Sparkles, Palette, Gauge, Smartphone } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { ProcessingOptions } from '@/store/useAppStore';

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

  const options: {
    key: keyof ProcessingOptions;
    label: string;
    description: string;
    icon: React.ReactNode;
  }[] = [
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
    </motion.div>
  );
}