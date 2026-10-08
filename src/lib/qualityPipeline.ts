/**
 * qualityPipeline — contrato único entre:
 *   1) El motor nativo FFmpeg (src-tauri/src/render.rs)
 *   2) La vista previa Before/After (WebGL, src/lib/qualityShader.ts)
 *   3) La exportación en navegador/PWA (WebCodecs, src/lib/browserExport.ts)
 *
 * TODAS las fórmulas de este archivo deben coincidir EXACTAMENTE con las de
 * render.rs (están numeradas con las mismas constantes). Si se cambia una,
 * se cambia en ambos lados.
 */

import type { DeviceTier } from '@/services/platformService';

export type { DeviceTier };

// ---------------------------------------------------------------------------
// Ajustes de render — espejo camelCase de `RenderSettings` (Rust)
// ---------------------------------------------------------------------------
export interface RenderSettings {
  // --- existentes ---
  width: number;
  height: number;
  fps: number;
  crf: number;
  bitrateMbps: number;
  /** 0..200 (%) — porcentaje, NO multiplicador 0..2 */
  sharpness: number;
  contrast: number;
  saturation: number;
  /** 0.5..1.5 multiplicador visual (Rust lo convierte a eq=brightness aditivo) */
  brightness: number;
  lanczos: boolean;
  antiDuplicate: boolean;
  // --- nuevos ---
  /** Etiqueta de resolución: '1080p' | '2K' | '4K UHD' */
  resolution: string;
  /** 0..100 (%) fuerza de reducción de ruido */
  noiseReduction: number;
  /** 0..100 (%) claridad (contraste local, radio grande) */
  clarity: number;
  /** -50..50 → ±0.5 paradas de exposición (factor 2^(e/100)) */
  exposure: number;
  /** 0..100 (%) recuperación de sombras */
  shadows: number;
  /** 0..100 (%) recuperación de luces */
  highlights: number;
  /** Interpolación real de fotogramas al subir FPS (nunca duplica) */
  interpolate: boolean;
  /** Filtro AE «AE Edit»: grading cinematográfico REAL (espejo de render.rs) */
  aeEdit: boolean;
  /** Mapa de tonos Möbius (rodilla de altas luces — preset «Cine Pro Dark») */
  mobius: boolean;
  /** Conversión HDR/Dolby Vision → BT.709 (solo se aplica si la fuente ES HDR) */
  hdrConvert: boolean;
  /** Cadenas EXACTAS del preset activo (null = mandan los sliders) */
  presetFilters: PresetFilters | null;
  /** Fuerza objetivo 9:16 (TikTok/Reels) */
  tiktokPreset: boolean;
  deviceTier: DeviceTier;
  /** windows | macos | linux | android | ios | unknown */
  platform: string;
  /** 'auto' (mejor disponible) | 'lanczos' | 'ai' | 'none' */
  upscaleMode: string;
}

/**
 * Etapas CONCRETAS de un preset (espejo camelCase de `PresetFilters` en
 * render.rs). Todos los campos son opcionales: el motor sólo sustituye las
 * etapas que el preset define; el resto sigue viniendo de los sliders.
 */
export interface PresetFilters {
  /** `hqdn3d` exacto: luma_spatial, chroma_spatial, luma_tmp, chroma_tmp */
  denoise?: [number, number, number, number];
  /** `eq` exacto */
  contrast?: number;
  brightness?: number;
  saturation?: number;
  gamma?: number;
  /** `colorbalance` — sombras / medios / luces (R, G, B) */
  cbShadows?: [number, number, number];
  cbMids?: [number, number, number];
  cbHighlights?: [number, number, number];
  /** `unsharp=<m>:<m>:<luma>:<cm>:<cm>:<chroma>` de doble pasada */
  detail?: [number, number, number, number];
  /** `cas` exacto (si no, se deriva del slider de nitidez) */
  cas?: number;
}

// ---------------------------------------------------------------------------
// Constantes compartidas con render.rs
// ---------------------------------------------------------------------------
export const CFG = {
  /** hqdn3d: luma_spatial = 6.0 * t (perfil base 25 % = 1.5:1.5:4:4) */
  denoiseLumaSpatial: 6.0,
  denoiseChromaSpatial: 6.0,
  denoiseLumaTmp: 16.0,
  denoiseChromaTmp: 16.0,
  /** Porcentaje del slider que reproduce exactamente hqdn3d=1.5:1.5:4:4 */
  denoiseBasePercent: 25,
  /** curva tonal: y15 = 0.15 + 0.12 * sombras */
  curveShadowGain: 0.12,
  curveHighlightGain: 0.12,
  /** eq=brightness = (ui - 1) * 0.4  (±0.2 en escala FFmpeg) */
  brightnessScale: 0.4,
  /** unsharp 13x13 = 0.35 * claridad */
  clarityMax: 0.35,
  /** CAS base = (nitidez/100) * 0.40 */
  casPerSharpness: 0.4,
  /** Tope duro de CAS: los presets piden hasta 0.70 (Topaz Natural) */
  casMax: 0.7,
  /** atenuación de nitidez al escalar mucho: 1 / (1 + 0.35*(r-1)) */
  casUpscaleFalloff: 0.35,
  casUpscaleMin: 0.55,
} as const;

// ---------------------------------------------------------------------------
// AE Edit — «Filtro AE» (espejo EXACTO de las constantes AE_* de render.rs)
// Grading cinematográfico premium aplicado de verdad durante el procesado:
// sombras frías azul/cian, luces cálidas, contraste elevado, negros profundos
// con detalle, saturación ligeramente reducida, detalle suave, bloom de luces
// y viñeta muy sutil.
// ---------------------------------------------------------------------------
export const AE_EDIT = {
  /** saturación efectiva = saturación del usuario × 0.94 (ligeramente menor) */
  saturationMult: 0.94,
  /**
   * Curva S en dominio 0..1 — mismos puntos que el lutyuv de render.rs:
   * (0,0.015) (0.18,0.14) (0.5,0.47) (0.82,0.86) (1,1)
   * → negros profundos SIN aplastar el detalle, medios más oscuros (grading
   *   oscuro), altas luces con punch.
   */
  curve: [
    [0, 0.015],
    [0.1804, 0.14],
    [0.502, 0.47],
    [0.8196, 0.86],
    [1, 1],
  ] as Array<[number, number]>,
  /** split toning — espejo de colorbalance (R,G,B) en sombras/medios/luces */
  shadowShift: [-0.05, 0.02, 0.05] as [number, number, number],
  midShift: [0.02, -0.01, -0.01] as [number, number, number],
  highShift: [0.05, 0.01, -0.04] as [number, number, number],
  /** detalle suave fijo (cantidad del unsharp 5×5) */
  detail: 0.18,
  /** viñeta muy sutil — ángulo del filtro vignette de FFmpeg */
  vignetteAngle: 0.22,
  /** bloom de luces: umbral (0..1), ganancia y opacidad del screen */
  bloomThreshold: 0.5686, // 145/255
  bloomGain: 1.6,
  bloomOpacity: 0.14,
} as const;

// ---------------------------------------------------------------------------
// Extensiones de ajustes (presets) — se mantienen en el store de la app
// ---------------------------------------------------------------------------
export interface QualityExtras {
  noiseReduction: number;
  clarity: number;
  exposure: number;
  shadows: number;
  highlights: number;
}

export interface QualityCore {
  sharpness: number;
  contrast: number;
  saturation: number;
  brightness: number;
}

export type ExportQuality = QualityCore & QualityExtras;

export const NEUTRAL_EXTRAS: QualityExtras = {
  noiseReduction: 0,
  clarity: 0,
  exposure: 0,
  shadows: 0,
  highlights: 0,
};

// ---------------------------------------------------------------------------
// Fórmulas compartidas (idénticas a render.rs)
// ---------------------------------------------------------------------------

/** Reducción de ruido → parámetros hqdn3d. null si no aplica. */
export function denoiseLevels(noiseReduction: number): {
  lumaSpatial: number;
  chromaSpatial: number;
  lumaTmp: number;
  chromaTmp: number;
} | null {
  const nr = clamp(noiseReduction, 0, 100);
  if (nr <= 0) return null;
  const t = nr / 100;
  return {
    lumaSpatial: round(CFG.denoiseLumaSpatial * t, 2),
    chromaSpatial: round(CFG.denoiseChromaSpatial * t, 2),
    lumaTmp: round(CFG.denoiseLumaTmp * t, 2),
    chromaTmp: round(CFG.denoiseChromaTmp * t, 2),
  };
}

/** Exposición (-50..50) → factor multiplicativo (2^(e/100), ±0.5 paradas). */
export function exposureFactor(exposure: number): number {
  return Math.pow(2, clamp(exposure, -50, 50) / 100);
}

/**
 * Curva tonal sombras/luces → puntos de control de lutyuv.
 * (0.15, y15) sube sombras · (0.85, y85) recupera luces · anclados a (0,0),(0.5,0.5),(1,1).
 * null cuando no hay ajuste (identidad → no se inserta filtro).
 */
export function toneCurve(shadows: number, highlights: number): { y15: number; y85: number } | null {
  const sh = clamp(shadows, 0, 100) / 100;
  const hi = clamp(highlights, 0, 100) / 100;
  if (sh <= 0 && hi <= 0) return null;
  const y15 = clamp(0.15 + CFG.curveShadowGain * sh, 0.15, 0.45);
  const y85 = clamp(0.85 - CFG.curveHighlightGain * hi, 0.55, 0.85);
  return { y15: round(y15, 4), y85: round(y85, 4) };
}

/**
 * Segmentos de la curva para lutyuv (valor 0..255) — mismos límites en GLSL:
 * [0,38) [38,128) [128,217) [217,255]
 */
export function toneCurveSegments(y15: number, y85: number) {
  const a = 38;
  const b = 128;
  const c = 217;
  const p15 = y15 * 255;
  const p85 = y85 * 255;
  return {
    a,
    b,
    c,
    k1: round(p15 / a, 4),
    b2: round(p15, 4),
    k2: round((127.5 - p15) / (b - a), 4),
    b3: 127.5,
    k3: round((p85 - 127.5) / (c - b), 4),
    b4: round(p85, 4),
    k4: round((255 - p85) / (255 - c), 4),
  };
}

/** Brillo visual (0.5..1.5) → eq=brightness aditivo FFmpeg. */
export function brightnessAdd(brightness: number): number {
  return round((clamp(brightness, 0.5, 1.5) - 1.0) * CFG.brightnessScale, 4);
}

/** Claridad (0..100) → cantidad unsharp 13x13 (contraste local). */
export function clarityAmount(clarity: number): number {
  return round(CFG.clarityMax * (clamp(clarity, 0, 100) / 100), 4);
}

/**
 * Nitidez (0..200) → fuerza CAS, atenuada si se escala mucho
 * (evita sobreenfoque/halos artificiales al ampliar).
 */
export function casAmount(sharpness: number, upscaleRatio = 1): number {
  const base = (clamp(sharpness, 0, 200) / 100) * CFG.casPerSharpness;
  const r = Math.max(1, upscaleRatio);
  const mult =
    r > 1
      ? clamp(1 / (1 + CFG.casUpscaleFalloff * (r - 1)), CFG.casUpscaleMin, 1)
      : 1;
  return round(clamp(base * mult, 0, CFG.casMax), 4);
}

// ---------------------------------------------------------------------------
// Resolución objetivo
// ---------------------------------------------------------------------------
export const RESOLUTION_DIMS: Record<string, { portrait: [number, number]; landscape: [number, number] }> = {
  '1080p': { portrait: [1080, 1920], landscape: [1920, 1080] },
  '2K': { portrait: [1440, 2560], landscape: [2560, 1440] },
  '4K UHD': { portrait: [2160, 3840], landscape: [3840, 2160] },
  '8K UHD': { portrait: [4320, 7680], landscape: [7680, 4320] },
};

/**
 * Dimensiones de salida:
 *  - preset TikTok/Reels → siempre 9:16 (portrait)
 *  - si no, se respeta la orientación del origen (apaisado → 3840×2160)
 */
export function resolutionDims(
  resolution: string,
  sourceWidth: number,
  sourceHeight: number,
  tiktokPreset: boolean
): { width: number; height: number } {
  const dims = RESOLUTION_DIMS[resolution] || RESOLUTION_DIMS['4K UHD'];
  const usePortrait = tiktokPreset || sourceHeight >= sourceWidth;
  const [w, h] = usePortrait ? dims.portrait : dims.landscape;
  return { width: w, height: h };
}

// ---------------------------------------------------------------------------
// Adaptación al hardware
// ---------------------------------------------------------------------------
export interface TierCaps {
  maxLongSide: number;
  maxFps: number;
  x264Preset: string;
  threads: number; // 0 = automático
  filterThreads: number; // 0 = automático
  audioKbps: number;
  allowMci: boolean;
  mciMaxPixels: number;
  mciMaxDurationSec: number;
  denoiseMax: number;
}

export function tierCaps(tier: DeviceTier, platform: string): TierCaps {
  const mobile = platform === 'android' || platform === 'ios';
  let caps: TierCaps;
  switch (tier) {
    case 'low':
      caps = {
        maxLongSide: 1920,
        maxFps: 30,
        x264Preset: 'fast',
        threads: 4,
        filterThreads: 2,
        audioKbps: 128,
        allowMci: false,
        mciMaxPixels: 0,
        mciMaxDurationSec: 0,
        denoiseMax: 100,
      };
      break;
    case 'medium':
      caps = {
        maxLongSide: 2560,
        maxFps: 60,
        x264Preset: 'medium',
        threads: 8,
        filterThreads: 4,
        audioKbps: 192,
        allowMci: false,
        mciMaxPixels: 0,
        mciMaxDurationSec: 0,
        denoiseMax: 100,
      };
      break;
    default:
      caps = {
        maxLongSide: 7680,
        maxFps: 120,
        x264Preset: 'slow',
        threads: 0,
        filterThreads: 0,
        audioKbps: 320,
        allowMci: true,
        mciMaxPixels: 2_200_000, // ≤1080p aprox.
        mciMaxDurationSec: 120,
        denoiseMax: 100,
      };
  }
  if (mobile) {
    // Móvil: menos hilos y filtros más ligeros → evita sobrecalentamiento.
    // Techo real de teléfono: 4K / 60 FPS (ni 8K ni 120: el codificador del
    // dispositivo no lo soporta de forma fiable).
    caps = {
      ...caps,
      maxLongSide: Math.min(caps.maxLongSide, 3840),
      maxFps: Math.min(caps.maxFps, 60),
      threads: Math.min(caps.threads || 4, 4),
      filterThreads: Math.min(caps.filterThreads || 2, 2),
      x264Preset: caps.x264Preset === 'slow' ? 'medium' : caps.x264Preset,
      allowMci: false,
    };
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Construcción de RenderSettings a partir de la UI
// ---------------------------------------------------------------------------
export interface BuildRenderSettingsInput {
  exportSettings: ExportQuality & {
    resolution: string;
    fps: number;
    bitrate: number;
    crf: number;
    /** Filtro AE «AE Edit» (ausente en storage antiguo = desactivado) */
    aeEdit?: boolean;
    /** Cadenas exactas del preset activo (ausente = mandan los sliders) */
    presetFilters?: PresetFilters | null;
    /** Mapa de tonos Möbius (preset «Cine Pro Dark») */
    mobius?: boolean;
    /** Conversión HDR → BT.709 (preset «HDR Boost 60FPS») */
    hdrConvert?: boolean;
  };
  processingOptions: {
    superResolution: boolean;
    colorCorrection: boolean;
    interpolate60fps: boolean;
    tiktokPreset: boolean;
    /** Firma anti-duplicado (anti-shadowban). Ausente = activada (como Rust). */
    antiDuplicate?: boolean;
  };
  deviceTier: DeviceTier;
  platform: string;
}

export function buildRenderSettings(input: BuildRenderSettingsInput): RenderSettings {
  const { exportSettings, processingOptions, deviceTier, platform } = input;
  const color = processingOptions.colorCorrection;
  const dims = { width: 1080, height: 1920 }; // el backend recalcula con la orientación real

  return {
    width: dims.width,
    height: dims.height,
    fps: exportSettings.fps,
    crf: exportSettings.crf,
    bitrateMbps: exportSettings.bitrate,
    sharpness: color ? exportSettings.sharpness : 100,
    contrast: color ? exportSettings.contrast : 1.0,
    saturation: color ? exportSettings.saturation : 1.0,
    brightness: color ? exportSettings.brightness : 1.0,
    lanczos: true,
    antiDuplicate: processingOptions.antiDuplicate ?? true,
    resolution: exportSettings.resolution,
    noiseReduction: color ? exportSettings.noiseReduction : 0,
    clarity: color ? exportSettings.clarity : 0,
    exposure: color ? exportSettings.exposure : 0,
    shadows: color ? exportSettings.shadows : 0,
    highlights: color ? exportSettings.highlights : 0,
    interpolate: processingOptions.interpolate60fps,
    aeEdit: exportSettings.aeEdit === true,
    // Cadenas exactas del preset y su luz: solo con corrección de color activa
    presetFilters: color ? exportSettings.presetFilters ?? null : null,
    mobius: color && exportSettings.mobius === true,
    hdrConvert: exportSettings.hdrConvert === true,
    tiktokPreset: processingOptions.tiktokPreset,
    deviceTier,
    platform,
    upscaleMode: processingOptions.superResolution ? 'auto' : 'lanczos',
  };
}

// ---------------------------------------------------------------------------
// Descripción honesta del plan de render (para la UI)
// ---------------------------------------------------------------------------
export interface SourceInfoLike {
  width: number;
  height: number;
  fps: number;
  durationSec?: number;
}

export function upscaleRatio(settings: RenderSettings, source?: SourceInfoLike | null): number {
  if (!source || !source.width || !source.height) return 1;
  const target = resolutionDims(
    settings.resolution,
    source.width,
    source.height,
    settings.tiktokPreset
  );
  const srcLong = Math.max(source.width, source.height);
  const dstLong = Math.max(target.width, target.height);
  return srcLong > 0 ? dstLong / srcLong : 1;
}

/**
 * Texto corto y VERAZ de la cadena que se va a aplicar (sin inventar detalle
 * que la fuente no tiene).
 */
export function describeRenderPlan(
  settings: RenderSettings,
  source?: SourceInfoLike | null
): string {
  const dims = resolutionDims(
    settings.resolution,
    source?.width ?? 1080,
    source?.height ?? 1920,
    settings.tiktokPreset
  );
  const pf = settings.presetFilters ?? undefined;
  const parts: string[] = [];
  if (pf?.denoise) {
    const [l, c, lt, ct] = pf.denoise;
    parts.push(`denoise ${l}:${c}:${lt}:${ct}`);
  } else if (settings.noiseReduction > 0) {
    parts.push(`denoise ${Math.round(settings.noiseReduction)}%`);
  }
  if (settings.exposure !== 0) parts.push(`exposición ${settings.exposure > 0 ? '+' : ''}${settings.exposure}`);
  if (settings.shadows > 0 || settings.highlights > 0)
    parts.push(`sombras/luces ${Math.round(settings.shadows)}/${Math.round(settings.highlights)}`);
  const contrast = pf?.contrast ?? settings.contrast;
  parts.push(`contraste ${contrast.toFixed(2)}x`);
  // Espejo de render.rs: con AE Edit la saturación efectiva es ×0.94
  const satBase = pf?.saturation ?? settings.saturation;
  const sat = clamp(
    settings.aeEdit ? satBase * AE_EDIT.saturationMult : satBase,
    0.8,
    1.6
  );
  parts.push(`color ${sat.toFixed(2)}x`);
  if (pf?.gamma !== undefined && Math.abs(pf.gamma - 1) > 0.001) {
    parts.push(`gamma ${pf.gamma.toFixed(2)}x`);
  }
  if (pf && (pf.cbShadows || pf.cbMids || pf.cbHighlights)) parts.push('colorbalance');
  if (pf?.detail) parts.push('unsharp doble pasada');
  if (settings.clarity > 0) parts.push(`claridad ${Math.round(settings.clarity)}%`);
  if (settings.aeEdit) parts.push('AE Edit');
  if (settings.mobius) parts.push('mapa de tonos Möbius');
  if (settings.hdrConvert) parts.push('HDR→BT.709');
  const ratio = upscaleRatio(settings, source);
  parts.push(
    ratio > 1.01
      ? `escala ${source ? `${source.width}×${source.height}` : 'origen'} → ${dims.width}×${dims.height}`
      : `escala ${dims.width}×${dims.height}`
  );
  if (pf?.cas !== undefined) {
    parts.push(`nitidez CAS ${pf.cas.toFixed(2)}`);
  } else if (settings.sharpness > 0) {
    parts.push(`nitidez CAS ${Math.round(settings.sharpness)}%`);
  }
  if (settings.interpolate) {
    const srcFps = source && source.fps > 0 ? Math.round(source.fps) : 0;
    if (srcFps > 0 && settings.fps > srcFps) {
      // Honestidad: llegar a N FPS desde una fuente con menos ES reconstrucción.
      parts.push(
        `interpolación ${settings.fps} FPS desde ${srcFps} FPS de origen (reconstrucción)`
      );
    } else {
      parts.push(`interpolación ${settings.fps} FPS`);
    }
  }
  if (settings.antiDuplicate) parts.push('anti-duplicado');
  return parts.join(' · ');
}

/** Aviso honesto cuando la salida supera la resolución real del origen. */
export function upscaleNote(
  settings: RenderSettings,
  source?: SourceInfoLike | null
): string | null {
  const ratio = upscaleRatio(settings, source);
  if (!source || ratio <= 1.01) return null;
  return `La fuente es ${source.width}×${source.height}: se escala a ${Math.round(ratio * 100)}% con reinterpolación de detalle (no crea información real de la cámara).`;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
export function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

export function round(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------------
// Uniforms compartidos para WebGL (vista previa + exportación en navegador)
// ---------------------------------------------------------------------------
export interface ShaderParams {
  /** 0..1 mezcla de difuminado (denoise) */
  denoise: number;
  /** factor de exposición multiplicativo */
  exposure: number;
  /** curva tonal o null */
  tone: { y15: number; y85: number } | null;
  /** eq */
  contrast: number;
  saturation: number;
  brightnessAdd: number;
  /** eq=gamma del preset (1 = sin gamma; aplica pow(y, 1/gamma)) */
  gamma?: number;
  /** colorbalance del preset (split toning) en R,G,B — [0,0,0] = sin filtro */
  cbShadows?: [number, number, number];
  cbMids?: [number, number, number];
  cbHighlights?: [number, number, number];
  /** Unsharp Mask doble pasada del preset: [luma, croma] — [0,0] = sin filtro */
  detail?: [number, number];
  /** claridad (contraste local) 0..0.35 */
  clarity: number;
  /** CAS 0..0.70 */
  cas: number;
  /**
   * Firma anti-duplicado (espejo del scale 1.015 + crop de render.rs):
   * 1.015 = micro-zoom central del 1.5 % que hace única la salida.
   * Ausente o 1 = sin firma.
   */
  zoom?: number;
  /** 0 | 1 — Filtro AE «AE Edit» activo (espejo de render.rs paso 6b) */
  ae?: number;
  /** 0 | 1 — mapa de tonos Möbius + tope de luma 235 (Fase 3) */
  mobius?: number;
}

export function shaderParamsFromQuality(
  q: QualityCore &
    Partial<QualityExtras> & {
      antiDuplicate?: boolean;
      aeEdit?: boolean;
      mobius?: boolean;
      presetFilters?: PresetFilters | null;
    },
  ratio = 1
): ShaderParams {
  const extras: QualityExtras = { ...NEUTRAL_EXTRAS, ...(q as QualityExtras) };
  const ae = q.aeEdit === true;
  const pf = q.presetFilters ?? undefined;
  const satBase = pf?.saturation ?? q.saturation;
  return {
    // Espejo exacto: perfil del preset (luma spatial × 0.1) o slider (NR% × 0.6)
    denoise: pf?.denoise
      ? clamp(pf.denoise[0] * 0.1, 0, 1)
      : clamp(extras.noiseReduction / 100, 0, 1) * 0.6,
    exposure: exposureFactor(extras.exposure),
    tone: toneCurve(extras.shadows, extras.highlights),
    contrast: clamp(pf?.contrast ?? q.contrast, 0.8, 1.5),
    // Espejo de render.rs: con AE Edit la saturación efectiva es ×0.94
    saturation: clamp(ae ? satBase * AE_EDIT.saturationMult : satBase, 0.8, 1.6),
    brightnessAdd:
      pf?.brightness !== undefined ? round(clamp(pf.brightness, -0.5, 0.5), 4) : brightnessAdd(q.brightness),
    gamma: pf?.gamma ?? 1,
    cbShadows: pf?.cbShadows ?? [0, 0, 0],
    cbMids: pf?.cbMids ?? [0, 0, 0],
    cbHighlights: pf?.cbHighlights ?? [0, 0, 0],
    detail: pf?.detail ? [pf.detail[1], pf.detail[3]] : [0, 0],
    clarity: clarityAmount(extras.clarity),
    cas:
      pf?.cas !== undefined
        ? round(clamp(pf.cas, 0, CFG.casMax), 4)
        : casAmount(q.sharpness, ratio),
    zoom: q.antiDuplicate === false ? 1 : 1.015,
    ae: ae ? 1 : 0,
    mobius: q.mobius === true ? 1 : 0,
  };
}

export function shaderParams(settings: RenderSettings, ratio = 1): ShaderParams {
  return shaderParamsFromQuality(settings, ratio);
}
