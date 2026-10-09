/**
 * Servicio multiplataforma - ixi 4k
 * Detección de OS (Windows/macOS/Linux/Android/iOS), tipo de dispositivo
 * y gama (tier) para adaptar resoluciones y evitar sobrecalentamiento.
 */

import { useState, useEffect } from 'react';

export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown';
export type DeviceTier = 'high' | 'medium' | 'low';

const isTauri = (): boolean =>
  typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

/**
 * ¿Estamos dentro del contenedor nativo (Tauri) CON el puente IPC utilizable?
 *
 * A diferencia de `useIsDesktop()` (que sólo mide el ancho de ventana y
 * devuelve true también en un navegador de escritorio), esta función exige
 * que el objeto puente esté definido y exponga `invoke` como función:
 *   · Tauri v2: `window.__TAURI_INTERNALS__.invoke` (siempre inyectado en la app)
 *   · Tauri v1: `window.__TAURI__.ipc.invoke`
 * Fuera del contenedor (web publicada, `npm run dev`, etc.) devuelve false y
 * NINGÚN código debe invocar comandos nativos.
 */
export function isNativeRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
    __TAURI__?: { ipc?: { invoke?: unknown } };
  };
  const internals = w.__TAURI_INTERNALS__;
  if (internals && typeof internals.invoke === 'function') return true;
  const legacy = w.__TAURI__;
  if (legacy && legacy.ipc && typeof legacy.ipc.invoke === 'function') return true;
  return false;
}

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

export function isMobilePlatform(): boolean {
  const p = detectPlatform();
  return p === 'android' || p === 'ios';
}

export function isTouchDevice(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || navigator.maxTouchPoints > 0)
  );
}

/**
 * Gama del dispositivo:
 *  - low:    móvil con ≤3GB RAM o ≤4 núcleos → limita a 1080p/30fps/15Mbps
 *  - medium: móvil gama media o PC modesta   → hasta 2K/60fps/30Mbps
 *  - high:   PC potente o móvil gama alta     → 4K UHD completo
 */
export function detectDeviceTier(): DeviceTier {
  if (typeof navigator === 'undefined') return 'high';
  const mem =
    'deviceMemory' in navigator
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = isMobilePlatform() || (isTouchDevice() && window.innerWidth < 1024);

  if (mobile) {
    if ((mem !== undefined && mem <= 3) || cores <= 4) return 'low';
    if (mem !== undefined && mem <= 6) return 'medium';
    return 'high';
  }
  if ((mem !== undefined && mem <= 4) || cores <= 4) return 'medium';
  return 'high';
}

/**
 * Nombre real de la GPU NVIDIA (nvidia-smi, sólo escritorio con backend).
 * Devuelve null si no hay backend, no hay GPU NVIDIA o falla la consulta:
 * la UI sólo pinta el chip "RTX ACTIVE" con un modelo RTX verificado.
 */
export async function detectGpuName(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const name = await invoke<string>('get_gpu_name');
    const trimmed = typeof name === 'string' ? name.trim() : '';
    return trimmed || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Adaptaciones por gama de dispositivo
// ---------------------------------------------------------------------------
export interface ResolutionOption {
  label: string;
  value: string;
}

const ALL_RESOLUTIONS: ResolutionOption[] = [
  { label: '1080p', value: '1080p' },
  { label: '2K', value: '2K' },
  { label: '4K UHD', value: '4K UHD' },
  { label: '8K UHD', value: '8K UHD' },
];

/**
 * Niveles superiores (8K / 120 FPS / 100-200 Mbps): sólo en PC de gama alta.
 * En móvil la gama máxima se queda en 4K / 60 FPS / 50 Mbps (lo que un
 * teléfono puede codificar de forma fiable con WebCodecs sin sobrecalentarse).
 */
export function availableResolutions(
  tier: DeviceTier,
  isMobile = false
): ResolutionOption[] {
  switch (tier) {
    case 'low':
      return ALL_RESOLUTIONS.slice(0, 1); // Solo 1080p
    case 'medium':
      return ALL_RESOLUTIONS.slice(0, 2); // 1080p + 2K
    default:
      return isMobile ? ALL_RESOLUTIONS.slice(0, 3) : ALL_RESOLUTIONS;
  }
}

export function availableFps(tier: DeviceTier, isMobile = false): number[] {
  if (tier === 'low') return [30];
  if (tier === 'medium') return [30, 60];
  return isMobile ? [30, 60] : [30, 60, 120];
}

export interface BitrateOption {
  label: string;
  value: number;
  crf: number;
}

export const ALL_BITRATES: BitrateOption[] = [
  { label: 'Equilibrado 15 Mbps', value: 15, crf: 20 },
  { label: 'Pro 30 Mbps', value: 30, crf: 16 },
  { label: 'Modo Bestia 50 Mbps', value: 50, crf: 14 },
  { label: 'Ultra 100 Mbps', value: 100, crf: 12 },
  { label: 'Ultra 200 Mbps', value: 200, crf: 10 },
];

export function availableBitrates(tier: DeviceTier, isMobile = false): BitrateOption[] {
  switch (tier) {
    case 'low':
      return ALL_BITRATES.slice(0, 1);
    case 'medium':
      return ALL_BITRATES.slice(0, 2);
    default:
      return isMobile ? ALL_BITRATES.slice(0, 3) : ALL_BITRATES;
  }
}

export function tierLabel(tier: DeviceTier): string {
  if (tier === 'low') return 'Gama baja';
  if (tier === 'medium') return 'Gama media';
  return 'Alto rendimiento';
}

export function exportDirectoryLabel(): string {
  const p = detectPlatform();
  if (p === 'android') return 'Galería / Downloads';
  if (p === 'ios') return 'Fotos';
  return 'Descargas';
}

// ---------------------------------------------------------------------------
// Hooks React
// ---------------------------------------------------------------------------
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : true
  );

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isDesktop;
}

/** true sólo dentro de la app nativa (Tauri) con puente IPC utilizable. */
export function useIsNativeRuntime(): boolean {
  const [native, setNative] = useState(isNativeRuntime);
  useEffect(() => {
    setNative(isNativeRuntime());
  }, []);
  return native;
}

export interface PlatformState {
  platform: Platform;
  tier: DeviceTier;
  isMobile: boolean;
  isTauriEnv: boolean;
}

export function usePlatform(): PlatformState {
  const [state, setState] = useState<PlatformState>(() => ({
    platform: detectPlatform(),
    tier: detectDeviceTier(),
    isMobile: isMobilePlatform() || (isTouchDevice() && window.innerWidth < 1024),
    isTauriEnv: isTauri(),
  }));

  useEffect(() => {
    const handler = () =>
      setState({
        platform: detectPlatform(),
        tier: detectDeviceTier(),
        isMobile: isMobilePlatform() || (isTouchDevice() && window.innerWidth < 1024),
        isTauriEnv: isTauri(),
      });
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return state;
}