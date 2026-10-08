import { useRef, useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { Play, Pause } from 'lucide-react';
import { useAppStore, type VideoFile } from '@/store/useAppStore';
import type { VideoFilters } from './ProControlsPanel';
import { createQualityRenderer, type QualityRenderer } from '@/lib/qualityShader';
import {
  resolutionDims,
  shaderParamsFromQuality,
  type ExportQuality,
  type PresetFilters,
  type QualityExtras,
  type ShaderParams,
} from '@/lib/qualityPipeline';

interface BeforeAfterSliderProps {
  video: VideoFile;
  filters?: VideoFilters;
}

/** Lado largo máximo del canvas de la vista previa (mantiene la barra WebGL ligera). */
const MAX_CANVAS_LONG = 1600;

/**
 * Mismos atributos que usa createQualityRenderer: la PRIMERA llamada a
 * getContext() es la que fija el contexto del canvas, así que debe coincidir.
 */
const WEBGL_ATTRS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false, // false = el navegador puede optimizar mejor el buffer
  premultipliedAlpha: false,
};

/** requestVideoFrameCallback puede no estar en lib.dom: acceso defensivo. */
interface RvfcVideo {
  requestVideoFrameCallback?(callback: (now: number, metadata: { mediaTime: number }) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
}

const asRvfc = (video: HTMLVideoElement): RvfcVideo => video as unknown as RvfcVideo;

export function BeforeAfterSlider({ video, filters }: BeforeAfterSliderProps) {
  const originalVideoRef = useRef<HTMLVideoElement>(null);
  const processedVideoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // --- Renderizador WebGL del lado procesado ------------------------------
  const rendererRef = useRef<QualityRenderer | null>(null);
  const pendingDrawRef = useRef<number | null>(null);
  const lastDrawTimeRef = useRef(-1);
  const lastDrawParamsRef = useRef<ShaderParams | null>(null);
  /** Cambia la `key` del <canvas> para obtener un nodo nuevo cuando el
   *  contexto WebGL anterior fue liberado (StrictMode / cambio de vídeo). */
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  /** true → vista previa WebGL real · false → fallback CSS clásico */
  const [webglActive, setWebglActive] = useState(true);
  /** Versión en ref de `webglActive` para usarla dentro de callbacks estables. */
  const webglActiveRef = useRef(true);
  useEffect(() => {
    webglActiveRef.current = webglActive;
  }, [webglActive]);

  // --- Ajustes: el store es la fuente de verdad de la exportación y la
  //     prop `filters` (parcial) se aplica encima, ganando si existe. ------
  const exportSettings = useAppStore((s) => s.exportSettings);
  const resolution = useAppStore((s) => s.exportSettings.resolution);
  const tiktokPreset = useAppStore((s) => s.processingOptions.tiktokPreset);
  // Ausente en storage antiguo = activado (misma lectura que el motor)
  const antiDuplicate = useAppStore(
    (s) => s.processingOptions.antiDuplicate ?? true
  );

  const [sourceDims, setSourceDims] = useState<{ w: number; h: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sliderPosition, setSliderPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const quality = useMemo<
    ExportQuality & {
      antiDuplicate: boolean;
      aeEdit: boolean;
      mobius: boolean;
      presetFilters: PresetFilters | null;
    }
  >(() => {
    // Defensive: `exportSettings` y `VideoFilters` se están ampliando en paralelo.
    const store = exportSettings as Partial<ExportQuality> & {
      aeEdit?: boolean;
      mobius?: boolean;
      presetFilters?: PresetFilters | null;
    };
    const f = filters as (VideoFilters & Partial<QualityExtras>) | undefined;
    return {
      sharpness: f?.sharpness ?? store.sharpness ?? 100,
      contrast: f?.contrast ?? store.contrast ?? 1.15,
      saturation: f?.saturation ?? store.saturation ?? 1.1,
      brightness: f?.brightness ?? store.brightness ?? 1.0,
      noiseReduction: f?.noiseReduction ?? store.noiseReduction ?? 0,
      clarity: f?.clarity ?? store.clarity ?? 0,
      exposure: f?.exposure ?? store.exposure ?? 0,
      shadows: f?.shadows ?? store.shadows ?? 0,
      highlights: f?.highlights ?? store.highlights ?? 0,
      antiDuplicate,
      aeEdit: store.aeEdit === true,
      mobius: store.mobius === true,
      presetFilters: store.presetFilters ?? null,
    };
  }, [exportSettings, filters, antiDuplicate]);

  // Ratio de escalado honesto — misma fórmula que el export FFmpeg (reduce
  // la nitidez CAS al ampliar mucho).
  const ratio = useMemo(() => {
    if (!sourceDims) return 1;
    const srcLong = Math.max(sourceDims.w, sourceDims.h);
    if (srcLong <= 0) return 1;
    const dims = resolutionDims(resolution, sourceDims.w, sourceDims.h, tiktokPreset);
    return Math.max(1, Math.max(dims.width, dims.height) / srcLong);
  }, [sourceDims, resolution, tiktokPreset]);

  const params = useMemo(() => shaderParamsFromQuality(quality, ratio), [quality, ratio]);
  const paramsRef = useRef<ShaderParams>(params);

  // -------------------------------------------------------------------------
  // Dibujo: renderiza el fotograma ACTUAL del vídeo original (lado izquierdo)
  // con la cadena completa de ixi 4k → antes/después real y perfecto sync.
  // -------------------------------------------------------------------------
  const drawFrame = useCallback((force: boolean) => {
    const renderer = rendererRef.current;
    const source = originalVideoRef.current;
    if (!renderer || !source || source.readyState < 2) return;
    if (!source.videoWidth || !source.videoHeight) return;

    // Tamaño intrínseco: natural del vídeo con lado largo ≤ 1600px.
    const longSide = Math.max(source.videoWidth, source.videoHeight);
    const scale = longSide > MAX_CANVAS_LONG ? MAX_CANVAS_LONG / longSide : 1;
    const w = Math.max(2, Math.round(source.videoWidth * scale));
    const h = Math.max(2, Math.round(source.videoHeight * scale));
    if (renderer.canvas.width !== w || renderer.canvas.height !== h) {
      renderer.resize(w, h);
    }

    // Solo se redibuja si cambió el fotograma o los parámetros.
    const t = source.currentTime;
    if (!force && t === lastDrawTimeRef.current && lastDrawParamsRef.current === paramsRef.current) {
      return;
    }
    try {
      renderer.draw(source);
    } catch {
      return;
    }
    lastDrawTimeRef.current = t;
    lastDrawParamsRef.current = paramsRef.current;
  }, []);

  /** Dibujo único diferido (coalescido): tras load/seek o cambio de ajustes. */
  const scheduleDraw = useCallback(() => {
    if (pendingDrawRef.current !== null) return;
    pendingDrawRef.current = requestAnimationFrame(() => {
      pendingDrawRef.current = null;
      drawFrame(true);
    });
  }, [drawFrame]);

  // -------------------------------------------------------------------------
  // Ciclo de vida del renderizador (se recrea al cambiar de vídeo o de epoch)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // getContext() devuelve SIEMPRE el mismo contexto para un elemento y
    // dispose() lo libera (loseContext). Si ya está perdido (remount de
    // StrictMode o cambio de vídeo) necesitamos un <canvas> nuevo: forzamos
    // el remontaje vía `key` y este efecto se vuelve a ejecutar.
    const probe = canvas.getContext('webgl', WEBGL_ATTRS);
    if (probe && probe.isContextLost()) {
      setCanvasEpoch((n) => n + 1);
      return;
    }

    let created: QualityRenderer | null = null;
    try {
      created = createQualityRenderer(canvas, paramsRef.current);
    } catch {
      created = null;
    }
    if (!created) {
      // Sin WebGL → fallback: vídeo procesado con el filtro CSS clásico.
      rendererRef.current = null;
      setWebglActive(false);
      return;
    }
    const renderer = created;
    rendererRef.current = renderer;
    setWebglActive(true);

    const videoEl = originalVideoRef.current;
    const useRvfc =
      !!videoEl &&
      'requestVideoFrameCallback' in HTMLVideoElement.prototype &&
      typeof asRvfc(videoEl).requestVideoFrameCallback === 'function';

    let looping = false;
    let loopHandle: number | null = null;

    function cancelLoop() {
      if (loopHandle === null) return;
      if (useRvfc && videoEl) asRvfc(videoEl).cancelVideoFrameCallback?.(loopHandle);
      else cancelAnimationFrame(loopHandle);
      loopHandle = null;
    }

    function tick() {
      loopHandle = null;
      drawFrame(false);
      scheduleLoop();
    }

    function scheduleLoop() {
      if (!looping || loopHandle !== null || !videoEl) return;
      if (useRvfc) {
        loopHandle = asRvfc(videoEl).requestVideoFrameCallback!(tick);
      } else {
        loopHandle = requestAnimationFrame(tick);
      }
    }

    function startLoop() {
      if (looping) return;
      looping = true;
      scheduleLoop();
    }

    function stopLoop() {
      looping = false;
      cancelLoop();
      drawFrame(true); // deja pintado el último fotograma presentado
    }

    const onPlay = () => startLoop();
    const onPause = () => stopLoop();
    const onMediaReady = () => scheduleDraw();

    videoEl?.addEventListener('play', onPlay);
    videoEl?.addEventListener('pause', onPause);
    videoEl?.addEventListener('ended', onPause);
    videoEl?.addEventListener('seeked', onMediaReady);
    videoEl?.addEventListener('loadeddata', onMediaReady);

    // Remount con el vídeo ya cargado o en marcha (p.ej. StrictMode):
    if (videoEl && !videoEl.paused) startLoop();
    if (!videoEl || videoEl.readyState >= 2) scheduleDraw();

    return () => {
      looping = false;
      cancelLoop();
      if (pendingDrawRef.current !== null) {
        cancelAnimationFrame(pendingDrawRef.current);
        pendingDrawRef.current = null;
      }
      videoEl?.removeEventListener('play', onPlay);
      videoEl?.removeEventListener('pause', onPause);
      videoEl?.removeEventListener('ended', onPause);
      videoEl?.removeEventListener('seeked', onMediaReady);
      videoEl?.removeEventListener('loadeddata', onMediaReady);
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer.dispose();
    };
  }, [video.id, video.previewUrl, canvasEpoch, drawFrame, scheduleDraw]);

  // Parámetros en vivo: se aplican al mover cualquier slider, también en pausa.
  useEffect(() => {
    paramsRef.current = params;
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setParams(params);
    scheduleDraw();
  }, [params, scheduleDraw]);

  // --- Reproducción del lado procesado -------------------------------------
  // WebGL activo → el canvas dibuja el lado procesado: el <video> oculto queda
  // en pausa para no decodificar el archivo dos veces en paralelo (carga que en
  // móviles reales roba ancho de banda al decodificador y hace perder fotogramas).
  // Fallback CSS (sin WebGL) → el procesado queda CLAVADO al original: misma
  // posición y mismo estado, de modo que nunca se adelante, nunca se quede
  // corto y nunca "termine antes" que el original.
  useEffect(() => {
    const original = originalVideoRef.current;
    const processed = processedVideoRef.current;
    if (!original || !processed) return;

    if (webglActive) {
      processed.pause();
      return;
    }

    const lock = () => {
      if (original.ended || Math.abs(processed.currentTime - original.currentTime) > 0.2) {
        try {
          processed.currentTime = original.currentTime;
        } catch {
          /* noop */
        }
      }
      if (!original.paused && processed.paused) processed.play().catch(() => {});
      if (original.paused && !processed.paused) processed.pause();
    };

    original.addEventListener('timeupdate', lock);
    original.addEventListener('play', lock);
    original.addEventListener('pause', lock);
    original.addEventListener('ended', lock);
    lock();
    return () => {
      original.removeEventListener('timeupdate', lock);
      original.removeEventListener('play', lock);
      original.removeEventListener('pause', lock);
      original.removeEventListener('ended', lock);
    };
  }, [webglActive, video.id]);

  // Sync videos
  const syncVideos = useCallback((action: 'play' | 'pause' | 'seek', time?: number) => {
    const original = originalVideoRef.current;
    const processed = processedVideoRef.current;
    
    if (!original || !processed) return;
    
    if (action === 'play') {
      original.play().catch(() => {});
      if (webglActiveRef.current) {
        // Con WebGL activo el lado procesado lo dibuja el canvas: el <video>
        // oculto NO se reproduce (evita decodificar el archivo dos veces en
        // paralelo, lo que en móviles resta ancho de banda al decodificador y
        // provoca fotogramas perdidos en la preview visible).
        processed.pause();
      } else {
        // Fallback CSS: el lado procesado debe arrancar EXACTAMENTE donde
        // está el original para no mostrar fotogramas futuros ni quedarse
        // corto respecto al original.
        try {
          processed.currentTime = original.currentTime;
        } catch {
          /* noop */
        }
        processed.play().catch(() => {});
      }
      setIsPlaying(true);
    } else if (action === 'pause') {
      original.pause();
      processed.pause();
      setIsPlaying(false);
    } else if (action === 'seek' && time !== undefined) {
      original.currentTime = time;
      processed.currentTime = time;
    }
  }, []);

  const togglePlay = () => {
    if (isPlaying) {
      syncVideos('pause');
    } else {
      syncVideos('play');
    }
  };

  // ---------------------------------------------------------------------------
  // Modo pantalla completa (PC y móvil)
  //   · PC: 100 % con fondo #0B0B0E · salir con ESC (nativo), F o doble clic
  //   · Móvil: lienzo vertical 9:16 al 100 % (oculta los paneles de ajustes,
  //     que viven FUERA de este contenedor) manteniendo los gestos táctiles
  //     de comparación.
  //   · Si el navegador no admite fullscreen de elementos (iOS Safari
  //     antiguo), se usa un overlay fijo como alternativa honesta.
  // ---------------------------------------------------------------------------
  const shellRef = useRef<HTMLDivElement>(null);
  const [fsMode, setFsMode] = useState<'off' | 'native' | 'fallback'>('off');
  const [fsPortrait, setFsPortrait] = useState(false);
  const isFs = fsMode !== 'off';

  const toggleFullscreen = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    if (fsMode !== 'off') {
      // Alternativa sin API nativa → cerrar el overlay
      setFsMode('off');
      return;
    }
    // Móvil (táctil y estrecho) → lienzo vertical 9:16
    setFsPortrait(
      (navigator.maxTouchPoints ?? 0) > 0 &&
        window.matchMedia('(pointer: coarse)').matches &&
        window.innerWidth < 820
    );
    const req = el.requestFullscreen?.bind(el);
    if (req) {
      Promise.resolve(req())
        .then(() => setFsMode('native'))
        .catch(() => setFsMode('fallback'));
    } else {
      setFsMode('fallback');
    }
  }, [fsMode]);

  // ESC (nativo del navegador) y cambios de estado → sincronizar el botón
  useEffect(() => {
    const onFsChange = () => {
      setFsMode((m) => {
        if (m === 'native' && document.fullscreenElement !== shellRef.current) return 'off';
        if (m === 'off' && document.fullscreenElement === shellRef.current) return 'native';
        return m;
      });
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, []);

  // Handle keyboard
  useEffect(() => {
    const isEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && containerRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        togglePlay();
        return;
      }
      // F (o ⌘/Ctrl+F desactivado) → alterna pantalla completa
      if (
        e.key?.toLowerCase() === 'f' &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        !isEditable(e.target)
      ) {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, syncVideos, toggleFullscreen]);

  // ---------------------------------------------------------------------------
  // Arrastre unificado con Pointer Events (ratón + táctil + lápiz)
  // touch-action: pan-y permite scroll vertical pero captura el drag horizontal
  // ---------------------------------------------------------------------------
  const updateSliderFromClientX = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (x / rect.width) * 100));
    setSliderPosition(percentage);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Los controles internos (play, barra de progreso) no mueven el slider
    if ((e.target as HTMLElement).closest('[data-slider-controls]')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    updateSliderFromClientX(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    updateSliderFromClientX(e.clientX);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDragging) {
      setIsDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  };

  const handleTimeUpdate = () => {
    if (originalVideoRef.current) {
      setProgress(originalVideoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    const v = originalVideoRef.current;
    if (!v) return;
    setDuration(v.duration);
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      setSourceDims((prev) =>
        prev && prev.w === v.videoWidth && prev.h === v.videoHeight
          ? prev
          : { w: v.videoWidth, h: v.videoHeight }
      );
    }
    scheduleDraw();
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div
      ref={shellRef}
      className={`relative overflow-hidden select-none ${
        isFs ? 'z-[100] bg-[#0B0B0E]' : 'rounded-2xl bg-black aspect-video'
      } ${fsMode === 'fallback' ? 'fixed inset-0' : ''}`}
      style={
        isFs
          ? { width: '100%', height: '100%', background: '#0B0B0E' }
          : undefined
      }
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
    >
      <div
        ref={containerRef}
        className={`relative cursor-ew-resize ${
          isFs && fsPortrait
            ? 'h-full aspect-[9/16] mx-auto'
            : 'w-full h-full'
        }`}
        style={{ touchAction: 'pan-y' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={() => {
          // Doble clic sale de pantalla completa (ESC y F también)
          if (isFs) toggleFullscreen();
        }}
      >
        {/* Botón de pantalla completa — esquina superior derecha (visible
            también DENTRO del modo pantalla completa, PC y móvil) */}
        <button
          type="button"
          data-slider-controls
          onClick={toggleFullscreen}
          className="absolute top-2 right-2 z-30 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-black/60 hover:bg-black/80 border border-white/20 text-white backdrop-blur-sm flex items-center gap-1"
        >
          {isFs ? '⛶ Salir (ESC)' : '⛶ Pantalla Completa'}
        </button>
        {/* Original Video (Left side) */}
        <div className="absolute inset-0">
          <video
            ref={originalVideoRef}
            src={video.previewUrl}
            className="w-full h-full object-contain"
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={() => setIsPlaying(false)}
            playsInline
            muted
          />
        </div>

        {/* Processed Video (Right side) - clipped */}
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ width: `${100 - sliderPosition}%`, right: 0, left: 'auto' }}
        >
          {/* Geometría alineada 1:1 con el vídeo original: este div abarca la
              tarjeta completa (se ancla al borde izquierdo de la tarjeta, no al
              divisor), de modo que el clip derecho revela exactamente los
              píxeles procesados de la misma zona que se ve a la izquierda. */}
          <div
            className="absolute inset-0"
            style={{
              left: `${(-sliderPosition * 100) / Math.max(100 - sliderPosition, 0.01)}%`,
              width: `${(100 * 100) / Math.max(100 - sliderPosition, 0.01)}%`,
            }}
          >
            {/* Canvas WebGL: la cadena REAL de ixi 4k sobre el fotograma original */}
            <canvas
              ref={canvasRef}
              key={canvasEpoch}
              aria-hidden="true"
              className={`w-full h-full object-contain${webglActive ? '' : ' hidden'}`}
              style={{ width: '100%', height: '100%' }}
            />
            {/* Vídeo procesado: solo línea de tiempo (oculto con WebGL) y
                fallback CSS cuando no hay contexto WebGL */}
            <video
              ref={processedVideoRef}
              src={video.previewUrl}
              className={`h-full object-contain${webglActive ? ' hidden' : ''}`}
              style={{ 
                filter: filters 
                  ? `contrast(${filters.contrast}) saturate(${filters.saturation}) brightness(${filters.brightness})`
                  : 'contrast(1.15) saturate(1.1) brightness(1.05)',
                width: '100%',
                height: '100%',
              }}
              playsInline
              muted
            />
          </div>
        </div>

        {/* Slider Line */}
        <div
          className="absolute top-0 bottom-0 w-[3px] bg-[#FF1E42] shadow-[0_0_14px_rgba(229,9,20,0.95)] z-20 cursor-ew-resize"
          style={{ left: `${sliderPosition}%`, transform: 'translateX(-50%)' }}
        >
          {/* Slider Handle (táctil: cristal oscuro + borde neón rojo) */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/70 backdrop-blur-sm border-2 border-[#FF1E42] shadow-[0_0_18px_rgba(229,9,20,0.7)] flex items-center justify-center">
            <div className="flex items-center gap-0.5">
              <svg className="w-4 h-4 text-[#FF6076]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
              </svg>
              <svg className="w-4 h-4 text-[#FF6076]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>
        </div>

        {/* Labels */}
        <div className="absolute top-2 left-2 sm:top-4 sm:left-4 z-10">
          <span className="px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-black/60 backdrop-blur-sm text-white text-xs sm:text-sm font-medium border border-white/20">
            Original
          </span>
        </div>
        <div className="absolute top-2 right-2 sm:top-4 sm:right-4 z-10">
          <span className="px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg bg-gradient-to-r from-ixi-cyan to-ixi-violet text-white text-xs sm:text-sm font-bold shadow-glow-cyan-sm">
            ixi 4k
          </span>
        </div>

        {/* Play/Pause Button */}
        <div className="absolute inset-0 flex items-center justify-center z-10">
          <motion.button
            data-slider-controls
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white/20 backdrop-blur-sm hover:bg-white/30 flex items-center justify-center transition-colors touch-manipulation"
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
          >
            {isPlaying ? (
              <Pause className="w-7 h-7 sm:w-8 sm:h-8 text-white" />
            ) : (
              <Play className="w-7 h-7 sm:w-8 sm:h-8 text-white ml-1" />
            )}
          </motion.button>
        </div>

        {/* Progress Bar */}
        <div
          data-slider-controls
          className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-3 sm:p-4 z-10"
        >
          <div className="mb-3">
            <input
              type="range"
              min={0}
              max={duration || 100}
              value={progress}
              onChange={(e) => syncVideos('seek', Number(e.target.value))}
              className="range-neon h-1"
              style={{ '--fill': `${duration ? (progress / duration) * 100 : 0}%` } as CSSProperties}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs sm:text-sm text-white/80 font-mono">
              {formatTime(progress)} / {formatTime(duration)}
            </span>
            <span className="text-[10px] sm:text-xs text-white/60">
              Arrastra con el ratón o el dedo para comparar
            </span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
