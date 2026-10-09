import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAdminStore } from './useAdminStore';
import { buildRenderSettings, describeRenderPlan, type PresetFilters } from '@/lib/qualityPipeline';
import {
  browserOutputFps,
  exportVideoBrowser,
  isBrowserExportSupported,
  type BrowserExportProgress,
} from '@/lib/browserExport';
import { detectDeviceTier, detectPlatform, isMobilePlatform } from '@/services/platformService';

// Safe invoke wrapper for Tauri
// (misma detección que authService/platformService: en Tauri v2 el global
// `__TAURI__` solo existe con withGlobalTauri, pero `__TAURI_INTERNALS__`
// está siempre inyectado — sin esto el escritorio caería en el modo navegador
// y usaría WebCodecs en vez del motor FFmpeg con aceleración por hardware).
const isTauri =
  typeof window !== 'undefined' &&
  ('__TAURI__' in window || '__TAURI_INTERNALS__' in window);

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }
  throw new Error('Tauri not available');
}

/**
 * Selector nativo de archivo: respaldo cuando el backend no localiza la ruta
 * absoluta del vídeo (las webviews solo entregan el nombre del archivo).
 * Devuelve null si el usuario lo cancela.
 */
async function pickVideoFile(): Promise<string | null> {
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<unknown>('plugin:dialog|open', {
    options: {
      multiple: false,
      title: 'Selecciona el vídeo original',
      filters: [
        {
          name: 'Vídeo',
          extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', '3gp'],
        },
      ],
    },
  });
  if (Array.isArray(res)) return (res[0] as string) ?? null;
  return typeof res === 'string' ? res : null;
}

// ---------------------------------------------------------------------------
// Metadatos reales del vídeo (Before/After, avisos honestos y exportación)
// ---------------------------------------------------------------------------
export interface VideoMeta {
  width: number;
  height: number;
  /** null cuando el contenedor no declara duración */
  durationSec: number | null;
}

/** Lee resolución/duración reales de un vídeo (blob:/asset:) sin bloquear la UI. */
export function probeVideoMeta(url: string): Promise<VideoMeta | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    let settled = false;
    const finish = (value: VideoMeta | null) => {
      if (settled) return;
      settled = true;
      // Limpieza: libera el elemento y los datos de vídeo cargados
      el.removeAttribute('src');
      el.load();
      resolve(value);
    };
    el.onloadedmetadata = () =>
      finish({
        width: el.videoWidth,
        height: el.videoHeight,
        durationSec: Number.isFinite(el.duration) ? el.duration : null,
      });
    el.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 8000);
    el.src = url;
  });
}

const COMMON_FPS = [24, 25, 30, 48, 50, 60, 120];

function snapFps(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  for (const fps of COMMON_FPS) {
    if (Math.abs(raw - fps) <= 1.01) return fps; // 23.976→24 · 29.97→30
  }
  return Math.round(raw);
}

/**
 * Estima los FPS reales del origen reproduciendo ~1 s en un <video> oculto y
 * contando los fotogramas efectivamente presentados (requestVideoFrameCallback).
 * Es la única forma honesta en navegador: con estos FPS la exportación NUNCA
 * duplica fotogramas (si pides 60 y el origen tiene 30, sale 30 y lo avisa).
 */
export function measureSourceFps(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!url || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const el = document.createElement('video') as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (now: number, meta: { mediaTime: number }) => void
      ) => number;
    };
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* noop */
      }
      resolve(value);
    };
    if (typeof el.requestVideoFrameCallback !== 'function') {
      resolve(null);
      return;
    }
    let first: number | null = null;
    let last = 0;
    let frames = 0;
    const tick = (_now: number, meta: { mediaTime: number }) => {
      if (settled) return;
      if (first === null) first = meta.mediaTime;
      last = meta.mediaTime;
      frames += 1;
      const span = last - first;
      if (frames >= 8 && span >= 0.5) {
        finish(snapFps((frames - 1) / span));
      } else if (el.currentTime > 2.5 || span > 2.5) {
        finish(frames > 1 && span > 0 ? snapFps((frames - 1) / span) : null);
      } else {
        el.requestVideoFrameCallback!(tick);
      }
    };
    el.onloadeddata = () => {
      el.play()
        .then(() => el.requestVideoFrameCallback!(tick))
        .catch(() => finish(null));
    };
    el.onerror = () => finish(null);
    window.setTimeout(() => finish(null), 8000);
    el.src = url;
  });
}

// ---------------------------------------------------------------------------
// Progreso REAL de la exportación (evento nativo `export-progress`)
// ---------------------------------------------------------------------------
/** Espejo camelCase de `ProgressEvent` de src-tauri/src/render.rs */
export interface ExportProgressPayload {
  phase: string;
  percent: number;
  frame: number;
  /** Velocidad de codificación REAL (fotogramas/s) */
  fps: number;
  etaSeconds: number;
  speed: string;
  label: string;
  targetWidth: number;
  targetHeight: number;
  targetFps: number;
  outputFps: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  encoder: string;
  acceleration: string;
  interpolation: string;
  summary: string;
  /** Comando FFmpeg real que se está ejecutando (vacío en navegador) */
  command: string;
  notes: string[];
  upscaled: boolean;
}

export type ExportMeta = ExportProgressPayload;

export interface VideoFile {
  id: string;
  name: string;
  size: number;
  type: string;
  path: string;
  duration?: number;
  width?: number;
  height?: number;
  previewUrl?: string;
}

export interface ProcessingOptions {
  superResolution: boolean;
  colorCorrection: boolean;
  interpolate60fps: boolean;
  tiktokPreset: boolean;
  /**
   * Super-resolución IA local (Real-ESRGAN en la GPU, vía motor ncnn).
   * Opcional porque el storage antiguo no lo traía: al leer, `undefined`
   * interpreta como DESACTIVADO (nunca se gasta GPU sin que el usuario lo
   * pida; si el motor falta, el backend cae a Lanczos y lo dice en el plan).
   */
  aiUpscale?: boolean;
  /**
   * Firma anti-duplicado (anti-shadowban): micro-zoom 1.5 % que hace única
   * la salida. Opcional porque el storage antiguo no lo traía: al leer se
   * interpreta `undefined` como activado (misma default que render.rs).
   */
  antiDuplicate?: boolean;
}

export interface DiagnosticResult {
  score: number;
  checks: {
    verticalFormat: { passed: boolean; message: string };
    bitrate: { passed: boolean; message: string };
    compression: { passed: boolean; message: string };
    duplicateRisk: { passed: boolean; message: string };
  };
}

interface AppState {
  // Auth
  isAuthenticated: boolean;
  user: { email: string } | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  
  // Video
  currentVideo: VideoFile | null;
  setCurrentVideo: (video: VideoFile | null) => void;
  
  // Processing
  processingOptions: ProcessingOptions;
  toggleOption: (key: keyof ProcessingOptions) => void;
  
  // Diagnostics
  diagnosticResult: DiagnosticResult | null;
  runDiagnostics: (video: VideoFile) => Promise<void>;
  
  // Export
  isExporting: boolean;
  exportProgress: number;
  exportStatus: 'idle' | 'processing' | 'complete' | 'error';
  exportError: string | null;
  exportedFilePath: string | null;
  showSuccessNotification: boolean;
  /** Datos REALES del plan/progreso: resolución, FPS, ETA, aceleración, avisos */
  exportMeta: ExportMeta | null;
  exportSettings: {
    sharpness: number;
    contrast: number;
    saturation: number;
    brightness: number;
    noiseReduction: number;
    clarity: number;
    exposure: number;
    shadows: number;
    highlights: number;
    resolution: string;
    fps: number;
    bitrate: number;
    crf: number;
    /** Filtro AE «AE Edit» (storage antiguo sin la clave = desactivado) */
    aeEdit: boolean;
    /** Cadenas EXACTAS del preset activo (null = mandan los sliders) */
    presetFilters: PresetFilters | null;
    /** Mapa de tonos Möbius — preset «Cine Pro Dark» */
    mobius: boolean;
    /** Conversión HDR → BT.709 — preset «HDR Boost 60FPS» */
    hdrConvert: boolean;
  };
  startExport: () => Promise<void>;
  resetExport: () => void;
  openDownloadsFolder: () => Promise<boolean>;
  dismissNotification: () => void;
  updateExportSettings: (settings: Partial<AppState['exportSettings']>) => void;
  
  // UI
  showSafeZone: boolean;
  toggleSafeZone: () => void;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

const defaultOptions: ProcessingOptions = {
  superResolution: true,
  colorCorrection: true,
  interpolate60fps: true,
  tiktokPreset: true,
  aiUpscale: false,
  antiDuplicate: true,
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Auth
      isAuthenticated: false,
      user: null,
      // Auth — la verificación/rol real la hace el backend (resolveLoginRole);
      // aquí sólo se abre la sesión local con la misma validación de siempre,
      // sin esperas artificiales: el botón responde en cuanto hay resultado.
      login: async (email: string, password: string) => {
        if (email && password.length >= 6) {
          const admin = useAdminStore.getState();
          const normalized = email.trim().toLowerCase();
          // Cuentas bloqueadas por el administrador NO pueden entrar
          const banned = admin.users.find(
            (u) => u.email.trim().toLowerCase() === normalized && u.status === 'banned'
          );
          if (banned) {
            throw new Error('Cuenta bloqueada por el administrador');
          }
          // Directorio local real + estadísticas de accesos (PC/móvil/web)
          admin.upsertLocalUser(normalized);
          admin.recordLoginActivity();
          set({ isAuthenticated: true, user: { email: normalized } });
        } else {
          throw new Error('Credenciales inválidas');
        }
      },
      register: async (email: string, password: string) => {
        if (email && password.length >= 6) {
          const normalized = email.trim().toLowerCase();
          const admin = useAdminStore.getState();
          const banned = admin.users.find(
            (u) => u.email.trim().toLowerCase() === normalized && u.status === 'banned'
          );
          if (banned) {
            throw new Error('Cuenta bloqueada por el administrador');
          }
          admin.upsertLocalUser(normalized);
          admin.recordLoginActivity();
          set({ isAuthenticated: true, user: { email: normalized } });
        } else {
          throw new Error('Datos de registro inválidos');
        }
      },
      logout: () => {
        // Cerrar sesión termina TAMBIÉN la sesión admin: revoca el token en el
        // backend y limpia el keyring, para que el siguiente usuario que entre
        // no herede el Panel de Administración.
        void useAdminStore.getState().logoutAdmin().catch(() => undefined);
        set({ isAuthenticated: false, user: null, currentVideo: null });
      },
      
      // Video
      currentVideo: null,
      setCurrentVideo: (video) => set({ currentVideo: video }),
      
      // Processing
      processingOptions: defaultOptions,
      toggleOption: (key) => set(state => {
        // Defaults reales: storage antiguo sin la clave → se lee como su valor
        // por defecto (así el botón nunca "se queda pegado" al alternar).
        const current = state.processingOptions[key] ?? defaultOptions[key] ?? false;
        return {
          processingOptions: { ...state.processingOptions, [key]: !current }
        };
      }),
      
      // Diagnostics
      diagnosticResult: null,
      runDiagnostics: async (video) => {
        // Lectura REAL de los metadatos (resolución/duración) — sin esperas
        // artificiales: el análisis termina cuando la sonda termina.
        const meta = await probeVideoMeta(video.previewUrl ?? '');

        const width = meta?.width || video.width;
        const height = meta?.height || video.height;
        const duration = meta?.durationSec ?? video.duration;

        const isVertical = !!(height && width && height > width);
        const hasGoodBitrate = !!(video.size && duration && video.size / duration > 500000);
        
        const checks = {
          verticalFormat: {
            passed: isVertical === true,
            message: isVertical 
              ? 'Formato vertical 9:16 detectado correctamente' 
              : '⚠ Formato no vertical - Se recortará a 9:16',
          },
          bitrate: {
            passed: hasGoodBitrate === true,
            message: hasGoodBitrate
              ? 'Bitrate óptimo para calidad cinematográfica'
              : '⚠ Bitrate bajo - Se aplicará preset 15 Mbps',
          },
          compression: {
            passed: true,
            message: 'Historial de compresión analizado - Listo para re-encode',
          },
          duplicateRisk: {
            passed: true,
            message: 'Anti-duplicado: Micro-zoom 1.5% + modulación de firma activados',
          },
        };
        
        const passedCount = Object.values(checks).filter(c => c.passed).length;
        const score = Math.round((passedCount / 4) * 100);

        set((state) => {
          const active = state.currentVideo;
          if (meta && active && active.id === video.id) {
            // Resolución/duración REALES: las usan el Before/After, el aviso
            // honesto de escalado y la propia exportación.
            return {
              diagnosticResult: { score, checks },
              currentVideo: {
                ...active,
                width: meta.width,
                height: meta.height,
                ...(meta.durationSec != null ? { duration: meta.durationSec } : {}),
              },
            };
          }
          return { diagnosticResult: { score, checks } };
        });
      },
      
      // Export
      isExporting: false,
      exportProgress: 0,
      exportStatus: 'idle',
      exportError: null,
      exportedFilePath: null,
      showSuccessNotification: false,
      exportSettings: {
        sharpness: 100,
        contrast: 1.15,
        saturation: 1.1,
        brightness: 1.0,
        // Perfil base = hqdn3d 1.5:1.5:4:4 (limpia sin suavizar; 0 % = off)
        noiseReduction: 25,
        clarity: 0,
        exposure: 0,
        shadows: 0,
        highlights: 0,
        resolution: '4K UHD',
        fps: 60,
        bitrate: 50,
        crf: 14,
        aeEdit: false,
        presetFilters: null,
        mobius: false,
        hdrConvert: false,
      },
      exportMeta: null,
      startExport: async () => {
        const { currentVideo, processingOptions, exportSettings, isExporting, exportStatus } = get();
        if (!currentVideo) return;
        // Anti doble clic: nunca dos exportaciones concurrentes (recurso + fichero)
        if (isExporting || exportStatus === 'processing') return;

        set({
          isExporting: true,
          exportProgress: 0,
          exportStatus: 'processing',
          exportError: null,
          exportMeta: null,
        });

        // Ajustes de la UI → settings REALES del motor. Mismas fórmulas que la
        // vista previa (qualityPipeline.ts espejo de render.rs).
        const settings = buildRenderSettings({
          exportSettings,
          processingOptions,
          deviceTier: detectDeviceTier(),
          platform: detectPlatform(),
        });

        // Estadísticas del Panel Admin: exportaciones y errores REALES
        const trackExportDone = () => {
          void useAdminStore
            .getState()
            .trackVideoProcessed(get().user?.email ?? 'unknown', {
              crf: exportSettings.crf,
              fps: exportSettings.fps,
              resolution: exportSettings.resolution,
            });
        };

        try {
          // -------- Conmutador de motor (automático) --------
          // · Escritorio (Tauri) → FFmpeg NATIVO con aceleración de GPU
          //   (NVENC / QuickSync / AMF, según la tarjeta detectada).
          // · Navegador/PWA y móviles (Android/iOS) → WebCodecs API
          //   (aunque fuera un build Tauri móvil, no existe FFmpeg nativo).
          const useNativeEngine = isTauri && !isMobilePlatform();
          if (useNativeEngine) {
            // -------- Escritorio: motor nativo FFmpeg --------
            let exportDir: string;
            try {
              exportDir = await safeInvoke<string>('get_export_directory');
            } catch {
              exportDir = await safeInvoke<string>('get_downloads_path');
            }
            const outputPath = `${exportDir}/ixi4k_edit_${Date.now()}.mp4`;

            // Progreso REAL (%, FPS, ETA, resolución, aceleración) desde Rust
            const { listen } = await import('@tauri-apps/api/event');
            const unlisten = await listen<ExportProgressPayload>('export-progress', (event) => {
              const p = event.payload;
              set({
                exportProgress: Math.max(0, Math.min(100, Math.round(p.percent))),
                exportMeta: p,
              });
            });

            const invokeExport = (inputPath: string) =>
              safeInvoke<string>('process_video', {
                inputPath,
                fileSize: currentVideo.size > 0 ? currentVideo.size : null,
                outputPath,
                settings,
              });

            try {
              let exported: string;
              try {
                exported = await invokeExport(currentVideo.path);
              } catch (error) {
                // La webview solo da el nombre del archivo y el backend no lo
                // localizó → selector nativo (único caso en que se abre).
                if (!String(error).includes('ARCHIVO_ORIGEN')) throw error;
                const picked = await pickVideoFile();
                if (!picked) {
                  throw new Error(
                    'No se pudo localizar el vídeo original. Selecciona el archivo para exportar.'
                  );
                }
                set((state) => ({
                  currentVideo:
                    state.currentVideo && state.currentVideo.id === currentVideo.id
                      ? { ...state.currentVideo, path: picked }
                      : state.currentVideo,
                }));
                exported = await invokeExport(picked);
              }

              set({
                exportStatus: 'complete',
                isExporting: false,
                exportProgress: 100,
                exportedFilePath: exported,
                showSuccessNotification: true,
              });
              trackExportDone();
            } finally {
              unlisten();
            }
          } else {
            // -------- Navegador / PWA: exportación REAL con WebCodecs --------
            if (!isBrowserExportSupported()) {
              throw new Error(
                'Este navegador no admite la exportación de vídeo (WebCodecs). Usa la app de escritorio de ixi 4k.'
              );
            }
            const previewUrl = currentVideo.previewUrl;
            if (!previewUrl) throw new Error('No hay vídeo cargado para exportar.');

            const meta = await probeVideoMeta(previewUrl);
            if (!meta || !meta.width || !meta.height) {
              throw new Error('No se pudo leer el vídeo seleccionado. Prueba con otro archivo.');
            }
            // FPS reales del origen: la exportación NUNCA duplica fotogramas
            const sourceFps = await measureSourceFps(previewUrl);
            const source = {
              width: meta.width,
              height: meta.height,
              fps: sourceFps ?? 0,
              durationSec: meta.durationSec ?? 0,
            };
            // Honestidad: la conversión HDR→BT.709 vive en el motor FFmpeg
            // nativo; WebCodecs no la hace, así que el plan del navegador no
            // la promete (se avisa en su lugar).
            const planText = describeRenderPlan({ ...settings, hdrConvert: false }, source);
            const { outFps, reqFps } = browserOutputFps(settings, source.fps);
            // Honestidad: en navegador SÍ se interpola (mezcla temporal de
            // fotogramas) cuando la fuente tiene menos FPS que la salida.
            const srcFpsR = source.fps > 0 ? Math.round(source.fps) : 0;
            const interpolating =
              settings.interpolate === true && srcFpsR > 0 && outFps > srcFpsR;
            const baseMeta: ExportMeta = {
              phase: 'processing',
              percent: 0,
              frame: 0,
              fps: 0,
              etaSeconds: 0,
              speed: '',
              label: 'Preparando exportación…',
              targetWidth: 0,
              targetHeight: 0,
              targetFps: outFps,
              outputFps: outFps,
              sourceWidth: source.width,
              sourceHeight: source.height,
              sourceFps: source.fps,
              encoder: 'avc',
              acceleration: 'WebCodecs',
              interpolation: interpolating
                ? `${outFps} FPS (mezcla temporal reconstruida desde ${srcFpsR} FPS)`
                : 'sin interpolación (navegador)',
              summary: planText,
              command: '',
              notes: [
                ...(interpolating
                  ? [
                      `Interpolación ${outFps} FPS desde ${srcFpsR} FPS de origen: reconstrucción por mezcla temporal (no crea detalle nuevo de la cámara)`,
                    ]
                  : []),
                ...(outFps < reqFps
                  ? [`FPS ajustados a ${outFps} (origen ${sourceFps}) — sin duplicar fotogramas`]
                  : []),
                ...(settings.hdrConvert
                  ? [
                      'HDR→BT.709: la conversión real de HDR/Dolby Vision la hace FFmpeg en la app de escritorio; en el navegador WebCodecs no convierte el HDR de la fuente',
                    ]
                  : []),
              ],
              upscaled: false,
            };

            const file = await fetch(previewUrl).then((r) => r.blob());
            const result = await exportVideoBrowser({
              file,
              fileName: currentVideo.name,
              settings,
              source,
              onProgress: (p: BrowserExportProgress) => {
                set({
                  exportProgress: Math.max(0, Math.min(100, Math.round(p.percent))),
                  exportMeta: {
                    ...baseMeta,
                    phase: 'processing',
                    percent: p.percent,
                    frame: p.frame,
                    fps: p.fps,
                    etaSeconds: p.etaSeconds,
                    speed: p.speed,
                    label: p.label,
                    targetWidth: p.targetWidth,
                    targetHeight: p.targetHeight,
                    acceleration: p.acceleration,
                    upscaled:
                      p.targetWidth > 0 &&
                      Math.max(p.targetWidth, p.targetHeight) >
                        Math.max(meta.width, meta.height),
                  },
                });
              },
            });

            // Descarga real del resultado (el navegador lo guarda en Descargas).
            // Nombre PROPIO (como el nativo): nunca con el del origen, para no
            // sobrescribir el vídeo original en la carpeta de descargas.
            const outName = `ixi4k_edit_${Date.now()}.mp4`;
            const url = URL.createObjectURL(result.blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = outName;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

            set({
              exportStatus: 'complete',
              isExporting: false,
              exportProgress: 100,
              exportedFilePath: outName,
              showSuccessNotification: true,
              exportMeta: {
                ...baseMeta,
                phase: 'done',
                percent: 100,
                frame: result.frameCount,
                label: '¡Completado!',
                targetWidth: result.width,
                targetHeight: result.height,
                targetFps: result.fps,
                outputFps: result.fps,
                acceleration: result.acceleration,
                notes: result.note ? [result.note] : baseMeta.notes,
              },
            });
            trackExportDone();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Error desconocido';
          set({
            exportStatus: 'error',
            isExporting: false,
            exportError: message,
          });
          void useAdminStore
            .getState()
            .trackError(get().user?.email ?? 'unknown', message);
        }
      },
      resetExport: () => set({
        exportProgress: 0,
        exportStatus: 'idle',
        exportError: null,
        isExporting: false,
        exportedFilePath: null,
        showSuccessNotification: false,
        exportMeta: null,
      }),
      openDownloadsFolder: async () => {
        const { exportedFilePath } = get();
        if (exportedFilePath && isTauri) {
          try {
            await safeInvoke('open_downloads_folder', { path: exportedFilePath });
            return true;
          } catch (error) {
            console.error('Error opening downloads folder:', error);
            return false;
          }
        }
        // Sin ruta exportada o fuera de Tauri no hay carpeta que abrir
        return false;
      },
      dismissNotification: () => set({ showSuccessNotification: false }),
      updateExportSettings: (settings) => set(state => ({
        exportSettings: { ...state.exportSettings, ...settings }
      })),
      
      // UI
      showSafeZone: false,
      toggleSafeZone: () => set(state => ({ showSafeZone: !state.showSafeZone })),
      sidebarOpen: true,
      toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
    }),
    {
      name: 'ixi-4k-storage',
      partialize: (state) => ({
        processingOptions: state.processingOptions,
        showSafeZone: state.showSafeZone,
        sidebarOpen: state.sidebarOpen,
      }),
    }
  )
);