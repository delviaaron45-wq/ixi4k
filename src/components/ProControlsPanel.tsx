import { motion } from 'framer-motion';
import { Sparkles, Monitor, Gauge, Zap, Download, Gem, Film, Wand2, Smartphone, Info, Loader2, Cpu } from 'lucide-react';
import { useState, useEffect, type CSSProperties } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { buildRenderSettings, upscaleNote, type PresetFilters } from '@/lib/qualityPipeline';
import { useAiEngine } from '@/services/aiEngineService';
import {
  detectDeviceTier,
  detectPlatform,
  isMobilePlatform,
  isTouchDevice,
  availableResolutions,
  availableFps,
  availableBitrates,
  tierLabel,
  useIsNativeRuntime,
  type DeviceTier,
} from '@/services/platformService';

interface ProControlsPanelProps {
  onFilterChange?: (filters: VideoFilters) => void;
  onExport?: () => void;
  /** 'all' = escritorio completo | 'filters' = presets+sliders | 'quality' = resolución/FPS/bitrate */
  section?: 'all' | 'filters' | 'quality';
}

export interface VideoFilters {
  sharpness: number;
  contrast: number;
  saturation: number;
  brightness: number;
  noiseReduction: number;
  clarity: number;
  exposure: number;
  shadows: number;
  highlights: number;
}

interface Preset {
  id: string;
  name: string;
  icon: React.ReactNode;
  /** Descripción breve que diferencia el estilo (4K limpio vs cine viral) */
  desc: string;
  /** Valores de slider (lo que se muestra en los controles) */
  filters: VideoFilters;
  /** Cadenas EXACTAS que manda el motor FFmpeg (espejo de PresetFilters) */
  pf: PresetFilters;
  /** Fase 3 · mapa de tonos Möbius (evita blancos quemados) */
  mobius?: boolean;
  /** Conversión HDR/Dolby Vision → BT.709 (si la fuente ES HDR) */
  hdrConvert?: boolean;
  /** FPS objetivo que pide el preset (si el dispositivo lo permite) */
  fps?: number;
}

/**
 * Los 5 perfiles de 1 clic (estilo Topaz Video AI). Cada uno define sus
 * cadenas EXACTAS de FFmpeg —hqdn3d, eq+gamma, colorbalance, unsharp doble
 * pasada, CAS— que el motor aplica sin aproximaciones; los sliders reflejan
 * los valores equivalentes por si el usuario quiere retocarlos.
 */
const presets: Preset[] = [
  {
    id: 'topaz',
    name: '4K Topaz Natural',
    icon: <Gem className="w-4 h-4" />,
    desc: 'Fidelidad máxima: limpia y enfoca sin alterar el color original',
    filters: {
      sharpness: 175, // CAS 0.70 exacto
      contrast: 1.0,
      saturation: 1.0,
      brightness: 1.0,
      noiseReduction: 25, // hqdn3d 1.5 (luma) como en el perfil base
      clarity: 0,
      exposure: 0,
      shadows: 0,
      highlights: 0,
    },
    pf: {
      denoise: [1.5, 1.2, 4, 3],
      contrast: 1.0,
      brightness: 0.0,
      saturation: 1.0,
      detail: [5, 0.8, 3, 0.4],
      cas: 0.7,
    },
  },
  {
    id: 'aePro',
    name: 'AE Edit Pro',
    icon: <Wand2 className="w-4 h-4" />,
    desc: 'Estilo viral After Effects: Teal & Orange cinematográfico',
    filters: {
      sharpness: 163, // CAS 0.65
      contrast: 1.12,
      saturation: 1.1,
      brightness: 0.95, // eq brightness -0.02
      noiseReduction: 20, // hqdn3d 1.2 (luma)
      clarity: 0,
      exposure: 0,
      shadows: 0,
      highlights: 0,
    },
    pf: {
      denoise: [1.2, 1.2, 3, 3],
      contrast: 1.12,
      brightness: -0.02,
      saturation: 1.1,
      gamma: 0.95,
      cbShadows: [-0.05, 0.02, 0.08],
      cbMids: [0.05, 0.0, -0.04],
      cas: 0.65,
    },
  },
  {
    id: 'cineDark',
    name: 'Cine Pro Dark',
    icon: <Film className="w-4 h-4" />,
    desc: 'Contraste profundo y sombras limpias (sin blancos quemados)',
    filters: {
      sharpness: 138, // CAS 0.55
      contrast: 1.18,
      saturation: 0.95,
      brightness: 0.925, // eq brightness -0.03
      noiseReduction: 30, // hqdn3d 1.8 (luma)
      clarity: 0,
      exposure: 0,
      shadows: 0,
      highlights: 0,
    },
    pf: {
      denoise: [1.8, 1.5, 4, 3],
      contrast: 1.18,
      brightness: -0.03,
      saturation: 0.95,
      gamma: 0.92,
      cas: 0.55,
    },
    mobius: true,
  },
  {
    id: 'hdr60',
    name: 'HDR Boost 60FPS',
    icon: <Zap className="w-4 h-4" />,
    desc: 'Expansión de rango dinámico y fluidez a 60 FPS',
    filters: {
      sharpness: 125, // CAS 0.50
      contrast: 1.1,
      saturation: 1.15,
      brightness: 1.025, // eq brightness +0.01
      noiseReduction: 17, // ≈ hqdn3d 1.0 (el perfil exacto manda)
      clarity: 0,
      exposure: 0,
      shadows: 0,
      highlights: 0,
    },
    pf: {
      denoise: [1.0, 1.0, 2, 2],
      contrast: 1.1,
      brightness: 0.01,
      saturation: 1.15,
      gamma: 1.02,
      detail: [3, 0.6, 3, 0.3],
      cas: 0.5,
    },
    hdrConvert: true,
    fps: 60,
  },
  {
    id: 'neon',
    name: 'Neón Cyberpunk',
    icon: <Sparkles className="w-4 h-4" />,
    desc: 'Neones urbanos con gran impacto visual',
    filters: {
      sharpness: 150, // CAS 0.60
      contrast: 1.15,
      saturation: 1.25,
      brightness: 1.0,
      noiseReduction: 20, // hqdn3d 1.2 (luma)
      clarity: 0,
      exposure: 0,
      shadows: 0,
      highlights: 0,
    },
    pf: {
      denoise: [1.2, 1.2, 3, 3],
      contrast: 1.15,
      brightness: 0.0,
      saturation: 1.25,
      gamma: 0.94,
      cbShadows: [-0.08, 0.04, 0.12],
      cas: 0.6,
    },
  },
];

/** Porcentaje de relleno (0–100) para la barra de progreso Rojo Neón. */
function fillPct(value: number, min: number, max: number): number {
  return max > min ? ((value - min) / (max - min)) * 100 : 0;
}

/** Slider fino reutilizable (barra de progreso Rojo Neón + tirador con borde brillante). */
function FineSlider({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-2">
        <span className="text-ixi-textMuted">{label}</span>
        <span className="text-ixi-cyan font-mono">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="range-neon"
        style={{ '--fill': `${fillPct(value, min, max)}%` } as CSSProperties}
      />
    </div>
  );
}

export function ProControlsPanel({ onFilterChange, onExport, section = 'all' }: ProControlsPanelProps) {
  // Selectores: panel estable durante la exportación (sin re-render por tick)
  const exportSettings = useAppStore((s) => s.exportSettings);
  const updateExportSettings = useAppStore((s) => s.updateExportSettings);
  const toggleOption = useAppStore((s) => s.toggleOption);
  const processingOptions = useAppStore((s) => s.processingOptions);
  const currentVideo = useAppStore((s) => s.currentVideo);
  const isExporting = useAppStore((s) => s.isExporting);
  // Mejora IA (Real-ESRGAN): sólo la app nativa (Tauri) tiene el motor local.
  // OJO: NO se usa useIsDesktop() aquí porque mide el ancho de ventana y
  // devuelve true también en un navegador de escritorio, lo que hacía que la
  // web intentara invocar a Tauri y fallara con "Cannot read properties of
  // undefined (reading 'invoke')".
  const isNativeApp = useIsNativeRuntime();
  const aiOn = processingOptions.aiUpscale ?? false;
  const aiEngine = useAiEngine(isNativeApp);
  const [tier] = useState<DeviceTier>(() => detectDeviceTier());
  const [platform] = useState(() => detectPlatform());
  // Móvil real (UA) o ventana táctil estrecha: tope honesto 4K/60/50.
  const [isMobile] = useState(
    () => isMobilePlatform() || (isTouchDevice() && window.innerWidth < 1024)
  );
  const resolutions = availableResolutions(tier, isMobile);
  const fpsOptions = availableFps(tier, isMobile);
  const bitrateOptions = availableBitrates(tier, isMobile);
  const [filters, setFilters] = useState<VideoFilters>({
    sharpness: exportSettings.sharpness,
    contrast: exportSettings.contrast,
    saturation: exportSettings.saturation,
    brightness: exportSettings.brightness,
    noiseReduction: exportSettings.noiseReduction,
    clarity: exportSettings.clarity,
    exposure: exportSettings.exposure,
    shadows: exportSettings.shadows,
    highlights: exportSettings.highlights,
  });
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // Aviso honesto: la salida no crea detalle que la fuente no tiene
  const planNote = currentVideo?.width
    ? upscaleNote(
        buildRenderSettings({
          exportSettings,
          processingOptions,
          deviceTier: tier,
          platform,
        }),
        { width: currentVideo.width, height: currentVideo.height ?? 0, fps: 0 }
      )
    : null;

  // Sync with store
  useEffect(() => {
    setFilters({
      sharpness: exportSettings.sharpness,
      contrast: exportSettings.contrast,
      saturation: exportSettings.saturation,
      brightness: exportSettings.brightness,
      noiseReduction: exportSettings.noiseReduction,
      clarity: exportSettings.clarity,
      exposure: exportSettings.exposure,
      shadows: exportSettings.shadows,
      highlights: exportSettings.highlights,
    });
  }, [exportSettings]);

  // Adaptar resolución/FPS/bitrate a la gama del dispositivo
  // (evita sobrecalentamiento y falta de RAM en móviles gama media/baja)
  useEffect(() => {
    const allowedRes = availableResolutions(tier, isMobile);
    const allowedFps = availableFps(tier, isMobile);
    const allowedBr = availableBitrates(tier, isMobile);

    const patch: Partial<typeof exportSettings> = {};
    if (!allowedRes.some((r) => r.value === exportSettings.resolution)) {
      patch.resolution = allowedRes[allowedRes.length - 1].value;
    }
    if (!allowedFps.includes(exportSettings.fps)) {
      patch.fps = allowedFps[allowedFps.length - 1];
    }
    if (!allowedBr.some((b) => b.value === exportSettings.bitrate)) {
      const fallback = allowedBr[allowedBr.length - 1];
      patch.bitrate = fallback.value;
      patch.crf = fallback.crf;
    }
    if (Object.keys(patch).length > 0) {
      updateExportSettings(patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tier, isMobile]);

  const updateFilter = (key: keyof VideoFilters, value: number) => {
    const newFilters = { ...filters, [key]: value };
    setFilters(newFilters);
    setActivePreset(null);
    // Mover cualquier slider desactiva el preset: vuelven a mandar los
    // sliders (las cadenas exactas del perfil y sus flags mueren con él).
    updateExportSettings({
      [key]: value,
      presetFilters: null,
      mobius: false,
      hdrConvert: false,
    });
    onFilterChange?.(newFilters);
  };

  const applyPreset = (preset: Preset) => {
    setFilters(preset.filters);
    setActivePreset(preset.id);
    const patch: Partial<typeof exportSettings> = {
      ...preset.filters,
      // Cadena EXACTA que aplicará el motor FFmpeg (y sus flags de Fase 3)
      presetFilters: preset.pf,
      mobius: preset.mobius === true,
      hdrConvert: preset.hdrConvert === true,
    };
    if (preset.fps) {
      // «HDR Boost 60FPS» pide 60 FPS; si el dispositivo no lo permite,
      // se respeta el techo real de la gama (sin inventar capacidad).
      const fpsList = availableFps(tier, isMobile);
      patch.fps = fpsList.includes(preset.fps)
        ? preset.fps
        : fpsList[fpsList.length - 1];
    }
    // Un preset de calidad sin corrección de color NO se aplicaría en el
    // motor (las cadenas se neutralizan): lo aseguramos aquí.
    const colorOn = processingOptions.colorCorrection ?? true;
    if (!colorOn) toggleOption('colorCorrection');
    updateExportSettings(patch);
    onFilterChange?.(preset.filters);
  };

  const handleResolutionChange = (res: string) => {
    updateExportSettings({ resolution: res });
  };

  const handleFpsChange = (fpsValue: number) => {
    updateExportSettings({ fps: fpsValue });
  };

  const handleBitrateChange = (bitrateValue: number, crfValue: number) => {
    updateExportSettings({ bitrate: bitrateValue, crf: crfValue });
  };

  // Filtro AE «AE Edit» — se aplica DE VERDAD en el motor (FFmpeg en PC,
  // WebGL/WebCodecs en móvil y web): qualityPipeline.ts espejo de render.rs.
  const aeEdit = exportSettings.aeEdit === true;
  const toggleAeEdit = () => updateExportSettings({ aeEdit: !aeEdit });

  return (
    <motion.div
      className="h-full flex flex-col"
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header */}
      <div className="p-4 border-b border-white/10">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-bold text-lg neon-text">ixi 4k Pro Controls</h3>
          {tier !== 'high' && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-ixi-cyan/10 border border-ixi-cyan/30 text-[10px] font-medium text-ixi-cyan">
              <Smartphone className="w-3 h-3" />
              {tierLabel(tier)}
            </span>
          )}
        </div>
        <p className="text-xs text-ixi-textMuted">
          {tier === 'high'
            ? 'Ajustes en tiempo real'
            : `Ajustes adaptados a tu dispositivo para evitar sobrecalentamiento`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* ---- Sección: Filtros (presets + sliders) ---- */}
        {(section === 'all' || section === 'filters') && (
        <>
        {/* Presets — ancla de navegación "Mejoras" de la sidebar */}
        <div id="mejoras">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-ixi-cyan" />
            Presets de 1 Clic
          </h4>
          <div className="grid grid-cols-1 gap-2">
            {presets.map((preset) => (
              <motion.button
                key={preset.id}
                onClick={() => applyPreset(preset)}
                title={preset.desc}
                className={`p-3 rounded-xl border text-left transition-all ${
                  activePreset === preset.id
                    ? 'bg-ixi-cyan/10 border-ixi-cyan/50 shadow-glow-cyan-sm'
                    : 'bg-ixi-bgSecondary/50 border-ixi-border hover:border-ixi-cyan/30'
                }`}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    activePreset === preset.id ? 'bg-ixi-cyan/20' : 'bg-ixi-bgCard'
                  }`}>
                    {preset.icon}
                  </div>
                  <div className="min-w-0">
                    <div className={`text-sm font-medium ${
                      activePreset === preset.id ? 'text-ixi-cyan' : 'text-ixi-text'
                    }`}>
                      {preset.name}
                    </div>
                    <div className="text-[11px] leading-tight text-ixi-textMuted truncate">
                      {preset.desc}
                    </div>
                  </div>
                </div>
              </motion.button>
            ))}
          </div>
        </div>

        {/* Sliders */}
        <div className="space-y-4">
          <h4 className="text-sm font-semibold flex items-center gap-2">
            <Gauge className="w-4 h-4 text-ixi-violet" />
            Ajustes Finos
          </h4>

          {/* Sharpness */}
          <div>
            <div className="flex justify-between text-xs mb-2">
              <span className="text-ixi-textMuted">Nitidez / Sharpness (CAS + Unsharp Mask)</span>
              <span className="text-ixi-cyan font-mono">{filters.sharpness}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={200}
              value={filters.sharpness}
              onChange={(e) => updateFilter('sharpness', Number(e.target.value))}
              className="range-neon"
              style={{ '--fill': `${fillPct(filters.sharpness, 0, 200)}%` } as CSSProperties}
            />
          </div>

          {/* Contrast */}
          <div>
            <div className="flex justify-between text-xs mb-2">
              <span className="text-ixi-textMuted">Contraste Cinemático</span>
              <span className="text-ixi-cyan font-mono">{filters.contrast.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={0.8}
              max={1.5}
              step={0.01}
              value={filters.contrast}
              onChange={(e) => updateFilter('contrast', Number(e.target.value))}
              className="range-neon"
              style={{ '--fill': `${fillPct(filters.contrast, 0.8, 1.5)}%` } as CSSProperties}
            />
          </div>

          {/* Saturation */}
          <div>
            <div className="flex justify-between text-xs mb-2">
              <span className="text-ixi-textMuted">Saturación & Intensidad de Color</span>
              <span className="text-ixi-cyan font-mono">{filters.saturation.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={0.8}
              max={1.6}
              step={0.01}
              value={filters.saturation}
              onChange={(e) => updateFilter('saturation', Number(e.target.value))}
              className="range-neon"
              style={{ '--fill': `${fillPct(filters.saturation, 0.8, 1.6)}%` } as CSSProperties}
            />
          </div>

          {/* Brightness */}
          <div>
            <div className="flex justify-between text-xs mb-2">
              <span className="text-ixi-textMuted">Brillo</span>
              <span className="text-ixi-cyan font-mono">{filters.brightness.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={filters.brightness}
              onChange={(e) => updateFilter('brightness', Number(e.target.value))}
              className="range-neon"
              style={{ '--fill': `${fillPct(filters.brightness, 0.5, 1.5)}%` } as CSSProperties}
            />
          </div>

          {/* Reducción de ruido (hqdn3d) */}
          <FineSlider
            label="Reducción de Ruido"
            value={filters.noiseReduction}
            display={`${Math.round(filters.noiseReduction)}%`}
            min={0}
            max={100}
            onChange={(v) => updateFilter('noiseReduction', v)}
          />

          {/* Claridad / contraste local (unsharp 13x13) */}
          <FineSlider
            label="Claridad / Detalle"
            value={filters.clarity}
            display={`${Math.round(filters.clarity)}%`}
            min={0}
            max={100}
            onChange={(v) => updateFilter('clarity', v)}
          />

          {/* Exposición (±0.5 paradas) */}
          <FineSlider
            label="Exposición"
            value={filters.exposure}
            display={`${filters.exposure > 0 ? '+' : ''}${Math.round(filters.exposure)}`}
            min={-50}
            max={50}
            onChange={(v) => updateFilter('exposure', v)}
          />

          {/* Sombras */}
          <FineSlider
            label="Sombras"
            value={filters.shadows}
            display={`${Math.round(filters.shadows)}%`}
            min={0}
            max={100}
            onChange={(v) => updateFilter('shadows', v)}
          />

          {/* Luces altas */}
          <FineSlider
            label="Luces Altas"
            value={filters.highlights}
            display={`${Math.round(filters.highlights)}%`}
            min={0}
            max={100}
            onChange={(v) => updateFilter('highlights', v)}
          />
        </div>
        </>
        )}

        {/* ---- Sección: Calidad 4K (resolución + FPS + bitrate) ---- */}
        {(section === 'all' || section === 'quality') && (
        <>
        {/* Resolution */}
        <div>
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Monitor className="w-4 h-4 text-ixi-cyan" />
            Resolución
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {resolutions.map((res) => (
              <button
                key={res.value}
                onClick={() => handleResolutionChange(res.value)}
                className={`p-2 rounded-lg text-xs font-medium transition-all ${
                  exportSettings.resolution === res.value
                    ? 'bg-ixi-cyan/20 text-ixi-cyan border border-ixi-cyan/50'
                    : 'bg-ixi-bgSecondary/50 text-ixi-textMuted border border-ixi-border hover:border-ixi-cyan/30'
                }`}
              >
                {res.label}
              </button>
            ))}
          </div>
          {planNote && (
            <p className="mt-2 text-[11px] leading-snug text-ixi-textMuted flex items-start gap-1.5 rounded-lg border border-white/10 bg-ixi-bgSecondary/40 p-2">
              <Info className="w-3 h-3 mt-0.5 shrink-0 text-ixi-warning" />
              <span>{planNote}</span>
            </p>
          )}
        </div>

        {/* FPS */}
        <div>
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Gauge className="w-4 h-4 text-ixi-violet" />
            Fotogramas
          </h4>
          <div className="grid grid-cols-3 gap-2">
            {fpsOptions.map((fpsOption) => (
              <button
                key={fpsOption}
                onClick={() => handleFpsChange(fpsOption)}
                className={`p-2 rounded-lg text-xs font-medium transition-all ${
                  exportSettings.fps === fpsOption
                    ? 'bg-ixi-violet/20 text-ixi-violet border border-ixi-violet/50'
                    : 'bg-ixi-bgSecondary/50 text-ixi-textMuted border border-ixi-border hover:border-ixi-violet/30'
                }`}
              >
                {fpsOption} FPS
              </button>
            ))}
          </div>
        </div>

        {/* Filtro AE — debajo de 4K y 60 FPS */}
        <div>
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Film className="w-4 h-4 text-ixi-violet" />
            Filtro AE
          </h4>
          <button
            type="button"
            onClick={toggleAeEdit}
            aria-pressed={aeEdit}
            data-testid="ae-edit-toggle"
            className={`w-full p-3 rounded-xl border text-left transition-all ${
              aeEdit
                ? 'bg-ixi-cyan/10 border-ixi-cyan/50 shadow-glow-cyan-sm'
                : 'bg-ixi-bgSecondary/50 border-ixi-border hover:border-ixi-cyan/30'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-sm font-medium flex items-center gap-2 ${
                  aeEdit ? 'text-ixi-cyan' : 'text-ixi-text'
                }`}
              >
                <Wand2 className="w-4 h-4" />
                AE Edit
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full border font-semibold ${
                  aeEdit
                    ? 'border-ixi-cyan/40 bg-ixi-cyan/10 text-ixi-cyan'
                    : 'border-white/10 text-ixi-textMuted'
                }`}
              >
                {aeEdit ? 'ACTIVO' : 'OFF'}
              </span>
            </div>
            <p className="text-[11px] text-ixi-textMuted mt-1.5 leading-snug">
              Grading cinematográfico premium: sombras azul/cian, luces cálidas,
              contraste elevado, bloom y viñeta sutil. Se aplica de verdad al
              exportar (PC y móvil).
            </p>
          </button>
        </div>

        {/* Mejora IA — super-resolución neuronal local (Real-ESRGAN) */}
        <div>
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Cpu className="w-4 h-4 text-ixi-cyan" />
            Mejora IA
          </h4>
          <button
            type="button"
            onClick={() => isNativeApp && toggleOption('aiUpscale')}
            aria-pressed={aiOn}
            aria-disabled={!isNativeApp}
            data-testid="ai-upscale-toggle"
            className={`w-full p-3 rounded-xl border text-left transition-all ${
              !isNativeApp
                ? 'bg-ixi-bgSecondary/30 border-ixi-border opacity-80 cursor-not-allowed'
                : aiOn
                  ? 'bg-ixi-cyan/10 border-ixi-cyan/50 shadow-glow-cyan-sm'
                  : 'bg-ixi-bgSecondary/50 border-ixi-border hover:border-ixi-cyan/30'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-sm font-medium flex items-center gap-2 ${
                  aiOn && isNativeApp ? 'text-ixi-cyan' : 'text-ixi-text'
                }`}
              >
                <Cpu className="w-4 h-4" />
                Super-resolución neuronal
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full border font-semibold ${
                  !isNativeApp
                    ? 'border-white/10 text-ixi-textMuted'
                    : aiOn
                      ? 'border-ixi-cyan/40 bg-ixi-cyan/10 text-ixi-cyan'
                      : 'border-white/10 text-ixi-textMuted'
                }`}
              >
                {!isNativeApp ? 'ESCRITORIO' : aiOn ? 'ACTIVO' : 'OFF'}
              </span>
            </div>
            <p className="text-[11px] text-ixi-textMuted mt-1.5 leading-snug">
              {isNativeApp
                ? 'Red neuronal Real-ESRGAN en tu GPU: síntesis de detalle de verdad (mejora antes/después medida). 0 €, licencia MIT, sin subir el vídeo a ningún servidor. Si el motor no está instalado, el export sigue con Lanczos y lo indica en el plan.'
                : 'La super-resolución neuronal está en la app de escritorio (gratis). La web exporta en tu navegador con el pipeline clásico: aquí no se simula IA.'}
            </p>
          </button>

          {isNativeApp && (
            <div className="mt-2 p-3 rounded-xl border bg-ixi-bgSecondary/40 border-ixi-border space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-[11px] text-ixi-textMuted">
                  {aiEngine.cap
                    ? aiEngine.cap.installed
                      ? `Motor instalado · ${aiEngine.cap.gpuName ?? 'GPU'}${aiEngine.cap.vramMb ? ` · ${Math.round(aiEngine.cap.vramMb / 1024)} GB` : ''} · v${aiEngine.cap.engineVersion}`
                      : aiEngine.cap.canInstall
                        ? `Motor sin instalar · ${aiEngine.cap.gpuName ?? 'GPU detectada'} · 45 MB (una vez)`
                        : `No disponible: ${aiEngine.cap.reason ?? 'requisitos no cumplidos'}`
                    : 'Comprobando el motor de IA…'}
                </span>
                {aiEngine.cap && !aiEngine.cap.installed && aiEngine.cap.canInstall && (
                  <button
                    type="button"
                    onClick={() => void aiEngine.install()}
                    disabled={aiEngine.installing}
                    className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50"
                  >
                    {aiEngine.installing ? `Instalando… ${aiEngine.progress}%` : 'Instalar motor'}
                  </button>
                )}
              </div>
              {aiEngine.installing && (
                <div
                  className="h-1.5 rounded-full bg-ixi-border overflow-hidden"
                  role="progressbar"
                  aria-valuenow={aiEngine.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <motion.div
                    className="h-full bg-ixi-cyan"
                    initial={{ width: 0 }}
                    animate={{ width: `${aiEngine.progress}%` }}
                    transition={{ duration: 0.2 }}
                  />
                </div>
              )}
              {aiEngine.error && <p className="text-[11px] text-ixi-danger">{aiEngine.error}</p>}
            </div>
          )}
        </div>

        {/* Bitrate */}
        <div>
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Zap className="w-4 h-4 text-ixi-cyan" />
            Calidad de Bitrate
          </h4>
          <div className="space-y-2">
            {bitrateOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => handleBitrateChange(option.value, option.crf)}
                className={`w-full p-3 rounded-lg text-left text-xs font-medium transition-all ${
                  exportSettings.bitrate === option.value
                    ? 'bg-ixi-cyan/10 text-ixi-cyan border border-ixi-cyan/50'
                    : 'bg-ixi-bgSecondary/50 text-ixi-textMuted border border-ixi-border hover:border-ixi-cyan/30'
                }`}
              >
                <div>{option.label}</div>
                <div className="text-[10px] text-ixi-textMuted mt-1">CRF {option.crf}</div>
              </button>
            ))}
          </div>
        </div>
        </>
        )}
      </div>

      {/* Export Button — bloqueado mientras hay una exportación en marcha
          (evita dos motores concurrentes; el store también tiene guard) */}
      {section !== 'filters' && (
      <div className="p-4 border-t border-white/10">
        <motion.button
          onClick={onExport}
          disabled={isExporting || !currentVideo}
          className="btn-primary w-full py-4 text-lg relative overflow-hidden group disabled:opacity-50 disabled:cursor-not-allowed"
          whileHover={{ scale: isExporting ? 1 : 1.02 }}
          whileTap={{ scale: isExporting ? 1 : 0.98 }}
        >
          <div className="flex items-center justify-center gap-3">
            {isExporting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Exportando…</span>
              </>
            ) : (
              <>
                <Download className="w-5 h-5" />
                <span>Exportar en {exportSettings.resolution}</span>
              </>
            )}
          </div>
          {/* Ripple effect */}
          <motion.div
            className="absolute inset-0 bg-gradient-to-r from-ixi-cyan/0 via-ixi-cyan/30 to-ixi-cyan/0"
            initial={{ x: '-100%' }}
            whileHover={{ x: '100%' }}
            transition={{ duration: 0.6 }}
          />
        </motion.button>
      </div>
      )}
    </motion.div>
  );
}