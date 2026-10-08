/**
 * browserExport — motor REAL de exportación en el navegador / PWA (sin Tauri).
 *
 * La app exporta en escritorio con FFmpeg nativo (src-tauri/src/render.rs).
 * En móviles/PWA no hay Tauri, así que aquí se reproduce la MISMA cadena de
 * calidad usando:
 *
 *   1. <video> + seeking          → decodificación de fotogramas de origen
 *   2. qualityShader (WebGL)      → cadena denoise → exposición → curva tonal
 *                                   → eq → claridad → CAS  (idéntica a FFmpeg)
 *   3. WebCodecs VideoEncoder     → codificación H.264 (acelerada por el SO)
 *   4. mp4-muxer                  → contenedor MP4 con fast-start
 *
 * Limitaciones honestas (se reflejan en `result.note`):
 *   - No se interpolan fotogramas: los FPS de salida nunca superan los de origen.
 *   - No existe el micro-zoom "anti-duplicado" del pipeline nativo.
 *   - El audio se intenta codificar en AAC; si no es posible, se exporta mudo.
 */

// mp4-muxer se carga bajo demanda (lazy) para no inflar el bundle inicial.
// Target no está exportado, así que usamos el tipo concreto directamente.
type MuxerOptions = import('mp4-muxer').MuxerOptions<import('mp4-muxer').ArrayBufferTarget>;
import type { RenderSettings } from './qualityPipeline';
import { resolutionDims, tierCaps, shaderParamsFromQuality } from './qualityPipeline';
import { createQualityRenderer, type QualityRenderer } from './qualityShader';

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export interface BrowserExportProgress {
  percent: number; // 0..100
  frame: number;
  totalFrames: number;
  fps: number; // velocidad de procesado (fotogramas/s reales)
  etaSeconds: number;
  speed: string; // p. ej. "2.35x"
  targetWidth: number;
  targetHeight: number;
  acceleration: string; // p. ej. "WebCodecs"
  label: string; // fase en español
}

export interface BrowserExportResult {
  blob: Blob;
  fileName: string; // termina en .mp4
  width: number;
  height: number;
  durationSec: number;
  frameCount: number;
  fps: number; // fps reales de salida
  acceleration: string;
  note?: string; // limitación honesta (p. ej. "sin interpolación", "sin audio")
}

export interface BrowserExportParams {
  file: File | Blob;
  fileName: string;
  settings: RenderSettings;
  source: { width: number; height: number; fps: number; durationSec: number };
  onProgress: (p: BrowserExportProgress) => void;
  signal?: { aborted: boolean };
}

/** ¿Puede este navegador exportar de verdad (WebCodecs + WebGL)? */
export function isBrowserExportSupported(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') return false;
  try {
    return !!document.createElement('canvas').getContext('webgl');
  } catch {
    return false;
  }
}

/**
 * FPS de salida reales de la exportación en navegador. Exportado para que la UI
 * muestre EXACTAMENTE los mismos valores que se van a codificar: nunca por
 * encima del origen (sin duplicar fotogramas) ni del tope de la gama.
 */
export function browserOutputFps(
  settings: RenderSettings,
  sourceFps: number
): { srcFps: number; reqFps: number; outFps: number } {
  const caps = tierCaps(settings.deviceTier, settings.platform);
  const srcFps = Number.isFinite(sourceFps) && sourceFps >= 1 ? Math.round(sourceFps) : 0;
  const reqFps =
    Number.isFinite(settings.fps) && settings.fps >= 1
      ? Math.round(settings.fps)
      : srcFps > 0
        ? srcFps
        : 30;
  // Con interpolación activa la salida puede superar el origen (mezcla temporal);
  // sin ella, NUNCA por encima del origen (estrictamente sin duplicar).
  const maxAllowed = settings.interpolate
    ? caps.maxFps
    : Math.min(caps.maxFps, srcFps > 0 ? srcFps : caps.maxFps);
  const outFps = Math.max(1, Math.min(reqFps, maxAllowed));
  return { srcFps, reqFps, outFps };
}

// ---------------------------------------------------------------------------
// Constantes internas
// ---------------------------------------------------------------------------

/** Códec H.264 por orden de preferencia (nivel/compatibilidad → bitdepth 8). */
function codecOrder(outW: number, outH: number, outFps: number): string[] {
  // Si la configuración es "pesada" (más de 4K60 o >4K en general) priorizamos
  // level 5.2 y 6.0 para que el navegador codifique 4K120 o >4K sin error de nivel.
  const heavy = outW * outH * outFps > 3840 * 2160 * 60 + 1_000_000; // >4K60 approx.
  const base: string[] = [
    'avc1.640034', // High 5.2 → permite 4K120/8K(limitado)
    'avc1.640033', // High 5.1 → compatible clásica
    'avc1.64002A', // High 4.1
    'avc1.640028', // High 4.0
    'avc1.420028', // High 4.1 (profiles varían)
    'avc1.42001F', // Main 4.0 (MPEG-4)
  ];
  return heavy ? base : ['avc1.640033', 'avc1.640034', ...base.slice(2)];
}
const VIDEO_CODECS: string[] = codecOrder(0, 0, 0); // valor placeholder; se rellena por llamada

/** Duración máxima para la que se intenta audio (memoria en el teléfono). */
const MAX_AUDIO_DURATION_SEC = 180;

/** Fotogramas por bloque de audio al codificar AAC. */
const AUDIO_BLOCK_FRAMES = 4096;

/** Tope del backpressure de codificación (evita saturar móviles). */
const MAX_ENCODE_QUEUE = 4;

// En el navegador limitamos la resolución máxima a 4K (3840 píxeles de lado largo)
// porque WebCodecs H.264 no soporta 8K por restricciones de nivel de codificación.
// La app de escritorio (Tauri/FFmpeg) sí puede exportar 8K reales.
const WEB_MAX_LONG_SIDE = 3840;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

/**
 * Salta el <video> a `t` segundos esperando el evento 'seeked'.
 * Si el navegador no dispara 'seeked' en 5 s se continúa igualmente.
 */
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    // Si ya estamos en ese instante el navegador no volverá a disparar 'seeked'.
    if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 5000);
    video.addEventListener('seeked', done);
    try {
      video.currentTime = t;
    } catch {
      done();
    }
  });
}

// ---------------------------------------------------------------------------
// Pista de audio (intentada, nunca fatal)
// ---------------------------------------------------------------------------

interface AudioTrack {
  chunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[];
  sampleRate: number;
  numberOfChannels: number;
}

/**
 * Decodifica el audio del archivo y lo codifica en AAC (mp4a.40.2).
 * Devuelve `null` si no hay audio o si cualquier paso falla: la exportación
 * DEBE seguir adelante en ese caso.
 */
async function encodeAudioTrack(file: Blob, durationSec: number): Promise<AudioTrack | null> {
  if (durationSec > MAX_AUDIO_DURATION_SEC) return null;
  if (typeof AudioEncoder !== 'function' || typeof AudioContext !== 'function') return null;

  let ctx: AudioContext | null = null;
  try {
    const raw = await file.arrayBuffer();
    ctx = new AudioContext();
    // decodeAudioData "consume" el buffer: pasamos una copia.
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    if (!decoded || decoded.length <= 0 || decoded.numberOfChannels < 1) return null;

    const sampleRate = decoded.sampleRate;
    const numberOfChannels = decoded.numberOfChannels;
    const config: AudioEncoderConfig = {
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels,
      bitrate: 192_000,
    };
    const support = await AudioEncoder.isConfigSupported(config);
    if (!support.supported) return null;

    const chunks: AudioTrack['chunks'] = [];
    const state: { error: DOMException | null } = { error: null };
    const encoder = new AudioEncoder({
      output: (chunk, meta) => chunks.push({ chunk, meta }),
      error: (e) => {
        state.error = e;
      },
    });
    encoder.configure(config);

    const total = Math.floor(decoded.length);
    const planes: Float32Array[] = [];
    for (let c = 0; c < numberOfChannels; c++) planes.push(decoded.getChannelData(c));

    // Bloques de 4096 muestras con layout planar (f32-planar).
    for (let off = 0; off < total; off += AUDIO_BLOCK_FRAMES) {
      const frames = Math.min(AUDIO_BLOCK_FRAMES, total - off);
      const data = new Float32Array(frames * numberOfChannels);
      for (let c = 0; c < numberOfChannels; c++) {
        data.set(planes[c].subarray(off, off + frames), c * frames);
      }
      const audioData = new AudioData({
        data,
        format: 'f32-planar',
        numberOfChannels,
        numberOfFrames: frames,
        sampleRate,
        timestamp: Math.round((off / sampleRate) * 1e6),
      });
      encoder.encode(audioData);
      audioData.close();
    }

    await encoder.flush();
    encoder.close();

    if (state.error || chunks.length === 0) return null;
    // mp4-muxer necesita el AudioSpecificConfig (description) para montar el avcC/esds.
    if (!chunks[0].meta?.decoderConfig?.description) return null;
    return { chunks, sampleRate, numberOfChannels };
  } catch {
    return null;
  } finally {
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        /* noop */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Codificador de vídeo
// ---------------------------------------------------------------------------

interface EncoderPick {
  encoder: VideoEncoder;
  hardware: boolean;
  codec: string;
}

/**
 * Prueba la lista de códecs H.264 y devuelve el primero codificable.
 *  - Primero se pide `hardwareAcceleration: 'prefer-hardware'` (aceleración del SO).
 *  - Si no, se reintenta sin esa propiedad (CPU).
 *  - `latencyMode: 'quality'` solo se añade si el navegador lo admite.
 * Devuelve `null` si ningún códec es utilizable.
 */
async function createVideoEncoder(
  opts: { width: number; height: number; bitrate: number; framerate: number },
  output: EncodedVideoChunkOutputCallback,
  onError: (e: DOMException) => void
): Promise<EncoderPick | null> {
  for (const codec of VIDEO_CODECS) {
    const base: VideoEncoderConfig = {
      codec,
      width: opts.width,
      height: opts.height,
      bitrate: opts.bitrate,
      framerate: opts.framerate,
      avc: { format: 'avc' },
    };

    let config: VideoEncoderConfig = { ...base, hardwareAcceleration: 'prefer-hardware' };
    let hardware = false;
    let encoder: VideoEncoder | null = null;

    try {
      const hwSupport = await VideoEncoder.isConfigSupported(config);
      if (hwSupport.supported) {
        hardware = true;
      } else {
        // Sin aceleración por hardware: probamos con la configuración base.
        config = { ...base };
        const cpuSupport = await VideoEncoder.isConfigSupported(config);
        if (!cpuSupport.supported) continue;
      }

      // latencyMode 'quality' solo si está soportado (si no, lo omitimos).
      const withLatency: VideoEncoderConfig = { ...config, latencyMode: 'quality' };
      const latencySupport = await VideoEncoder.isConfigSupported(withLatency);
      if (latencySupport.supported) config = withLatency;

      encoder = new VideoEncoder({ output, error: onError });
      encoder.configure(config);
      return { encoder, hardware, codec };
    } catch {
      if (encoder) {
        try {
          encoder.close();
        } catch {
          /* noop */
        }
      }
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exportación
// ---------------------------------------------------------------------------

export async function exportVideoBrowser(params: BrowserExportParams): Promise<BrowserExportResult> {
  const { file, fileName, settings, source, onProgress, signal } = params;

  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') {
    throw new Error('WebCodecs no disponible: este navegador no puede codificar vídeo.');
  }
  if (signal?.aborted) throw new Error('Exportación cancelada');

  const caps = tierCaps(settings.deviceTier, settings.platform);

  // Notas honestas de la exportación (se llenan durante el cálculo de dims/fps)
  const notes: string[] = [];

  // --- 1) Tamaño objetivo: resolución pedida + tope del tier de dispositivo ---
  const dims = resolutionDims(settings.resolution, source.width, source.height, settings.tiktokPreset);
  let outW = dims.width;
  let outH = dims.height;
  const longSide = Math.max(outW, outH);
  // 1) Tope del tier de dispositivo (FFmpeg desktop o WebCodecs móvil/desktop).
  if (longSide > caps.maxLongSide) {
    const scale = caps.maxLongSide / longSide;
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }
  // 2) Tope del navegador: WebCodecs H.264 no soporta >4K.
  const webLongSide = Math.max(outW, outH);
  if (webLongSide > WEB_MAX_LONG_SIDE) {
    const ws = WEB_MAX_LONG_SIDE / webLongSide;
    outW = Math.round(outW * ws);
    outH = Math.round(outH * ws);
    notes.push(
      'Salida limitada a 4K en el navegador (WebCodecs H.264 no admite 8K): se exporta a ' +
        `${outW}×${outH}. La app de escritorio exporta 8K reales.`
    );
  }
  // y ambos lados siempre PARES (requisito de H.264).
  outW = Math.max(2, outW - (outW % 2));
  outH = Math.max(2, outH - (outH % 2));

  // --- 2) FPS de salida: NUNCA por encima del origen (sin duplicar fotogramas) ---
  const { reqFps, outFps } = browserOutputFps(settings, source.fps);

  const srcFpsR = source.fps > 0 ? Math.round(source.fps) : 0;
  const interpolating =
    settings.interpolate === true && srcFpsR > 0 && outFps > srcFpsR;
  if (interpolating) {
    notes.push(
      `Interpolación ${outFps} FPS desde ${srcFpsR} FPS de origen: reconstrucción por mezcla temporal (no crea detalle nuevo de la cámara)`
    );
  } else if (outFps < reqFps) {
    notes.push(`FPS ajustados a ${outFps} (origen ${source.fps}) — sin duplicar fotogramas`);
  }

  const srcLongSide = Math.max(source.width || 0, source.height || 0);
  const ratio = srcLongSide > 0 ? Math.max(outW, outH) / srcLongSide : 1;

  const bitrate =
    settings.bitrateMbps > 0 ? Math.round(settings.bitrateMbps * 1_000_000) : 8_000_000;

  // --- Progreso ---
  const prog = { totalFrames: 1, acceleration: 'WebCodecs' };
  let loopStartedAt = performance.now();
  let lastEmitAt = 0;
  const emit = (frame: number, label: string, force = false, done = false) => {
    const now = performance.now();
    if (!force && now - lastEmitAt < 150) return;
    lastEmitAt = now;
    const elapsed = Math.max(0.001, (now - loopStartedAt) / 1000);
    const processingFps = frame > 0 ? frame / elapsed : 0;
    const remaining = Math.max(0, prog.totalFrames - frame);
    onProgress({
      percent: done ? 100 : Math.min(99, Math.round((frame / prog.totalFrames) * 100)),
      frame,
      totalFrames: prog.totalFrames,
      fps: Math.round(processingFps * 100) / 100,
      etaSeconds: processingFps > 0 ? Math.round(remaining / processingFps) : 0,
      speed: `${(processingFps / outFps).toFixed(2)}x`,
      targetWidth: outW,
      targetHeight: outH,
      acceleration: prog.acceleration,
      label,
    });
  };

  emit(0, 'Analizando vídeo...', true);

  // --- Recursos a liberar siempre ---
  let objectUrl = '';
  let video: HTMLVideoElement | null = null;
  let renderer: QualityRenderer | null = null;
  let encoder: VideoEncoder | null = null;
  const encErr: { encoder: DOMException | null; mux: unknown } = { encoder: null, mux: null };

  try {
    // --- 3) Renderizador WebGL con la MISMA cadena que la exportación nativa ---
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const r = createQualityRenderer(canvas, shaderParamsFromQuality(settings, ratio));
    if (!r) {
      throw new Error('WebGL no disponible: no se puede procesar el vídeo en este navegador.');
    }
    renderer = r;
    r.resize(outW, outH);

    // --- 4) Vídeo fuente: se decodifica por SEEKING (frame a frame) ---
    const vid = document.createElement('video');
    video = vid;
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = 'auto';
    objectUrl = URL.createObjectURL(file);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(msg));
      };
      const timer = setTimeout(
        () => fail(`Tiempo de espera agotado al leer "${fileName}".`),
        20000
      );
      vid.addEventListener('loadedmetadata', ok, { once: true });
      vid.addEventListener(
        'error',
        () => fail(`"${fileName}" no es un vídeo reproducible en este navegador.`),
        { once: true }
      );
      vid.src = objectUrl;
      vid.load();
    });

    if (!vid.videoWidth || !vid.videoHeight) {
      throw new Error(`"${fileName}" no es un vídeo reproducible en este navegador.`);
    }

    const duration =
      Number.isFinite(vid.duration) && vid.duration > 0
        ? vid.duration
        : Number.isFinite(source.durationSec) && source.durationSec > 0
          ? source.durationSec
          : 0;
    if (!(duration > 0)) throw new Error('No se pudo determinar la duración del vídeo.');

    prog.totalFrames = Math.max(1, Math.ceil(duration * outFps));
    emit(0, 'Analizando vídeo...', true);

    // --- 8) Audio: se intenta; si falla, exportamos sin audio (nunca aborta) ---
    const audioTrack = await encodeAudioTrack(file, duration);
    if (!audioTrack) notes.push('sin audio');
    if (signal?.aborted) throw new Error('Exportación cancelada');

    // --- 7) Muxer MP4 (fast-start en memoria, listo para subir) ---
    // Carga lazy de mp4-muxer: no se descarga hasta la primera exportación web
    const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
    const target = new ArrayBufferTarget();
    const muxerOptions: MuxerOptions = {
      target,
      video: { codec: 'avc', width: outW, height: outH, frameRate: outFps },
      fastStart: 'in-memory',
    };
    if (audioTrack) {
      muxerOptions.audio = {
        codec: 'aac',
        sampleRate: audioTrack.sampleRate,
        numberOfChannels: audioTrack.numberOfChannels,
      };
    }
    const muxer = new Muxer(muxerOptions);

    if (audioTrack) {
      try {
        for (const c of audioTrack.chunks) muxer.addAudioChunk(c.chunk, c.meta);
      } catch {
        // El audio jamás debe tumbar la exportación.
        notes.push('sin audio');
      }
    }

    // --- 5) Codificador H.264 por WebCodecs ---
    const pick = await createVideoEncoder(
      { width: outW, height: outH, bitrate, framerate: outFps },
      (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (e) {
          encErr.mux = e;
        }
      },
      (e) => {
        encErr.encoder = e;
      }
    );
    if (!pick) {
      throw new Error(
        'Este navegador no admite la codificación H.264 (WebCodecs sin códec compatible).'
      );
    }
    const enc = pick.encoder;
    encoder = enc;
    // Informamos con honestidad lo que el navegador ha declarado soportar.
    prog.acceleration = pick.hardware ? 'WebCodecs (HW del sistema)' : 'WebCodecs (CPU)';

    // --- Bucle de fotogramas ---
    emit(0, 'Procesando filtros ixi 4k...', true);
    loopStartedAt = performance.now();
    lastEmitAt = 0;

    const keyInterval = Math.max(1, Math.round(outFps * 2)); // GOP ≈ 2 s
    const frameDurationUs = Math.round(1e6 / outFps);
    let processed = 0;

    // --- Preparación de mezcla temporal (interpolación real) ---
    // Cuando la fuente tiene menos FPS que la salida, se reconstruyen los
    // fotogramas intermedios por mezcla lineal (temporal blending).
    const needsBlend =
      settings.interpolate === true && srcFpsR > 0 && outFps > srcFpsR;
    let blendCanvas: HTMLCanvasElement | null = null;
    let blendCtx: CanvasRenderingContext2D | null = null;
    let outCanvas: HTMLCanvasElement | null = null;
    let octx: CanvasRenderingContext2D | null = null;
    let glK = -1; // índice del frame que tiene el renderer GL canvas actual
    let baseK = -1; // índice del frame "base" que tiene blendCanvas (al 100%)
    if (needsBlend) {
      blendCanvas = document.createElement('canvas');
      blendCanvas.width = outW;
      blendCanvas.height = outH;
      blendCtx = blendCanvas.getContext('2d');
      if (!blendCtx) {
        throw new Error('No se pudo crear el lienzo de interpolación temporal.');
      }
      outCanvas = document.createElement('canvas');
      outCanvas.width = outW;
      outCanvas.height = outH;
      octx = outCanvas.getContext('2d');
      if (!octx) {
        throw new Error('No se pudo crear el lienzo de salida para interpolación.');
      }
    }

    for (let i = 0; i < prog.totalFrames; i++) {
      if (signal?.aborted) throw new Error('Exportación cancelada');
      if (encErr.encoder) {
        throw new Error(`Error del codificador WebCodecs: ${encErr.encoder.message}`);
      }
      if (encErr.mux) throw new Error(`Error al generar el MP4: ${errorMessage(encErr.mux)}`);

      const t = i / outFps;
      if (t >= duration) break;

      let frameSource: HTMLCanvasElement;
      if (needsBlend) {
        // Mezcla temporal: reconstrucción de fotogramas intermedios
        const fp = t * source.fps;
        const k = Math.floor(fp + 1e-6);
        const frac = fp - k;

        // Cargar frame k al blendCanvas si no está ya
        if (k !== baseK) {
          await seekTo(vid, k / source.fps);
          r.draw(vid);
          blendCtx!.globalAlpha = 1;
          blendCtx!.drawImage(canvas, 0, 0);
          baseK = k;
          glK = k;
        }

        if (frac < 1e-4) {
          // Solo el frame k (sin mezcla)
          frameSource = blendCanvas!;
        } else {
          // Frame k+1 con peso frac
          const tNext = (k + 1) / source.fps;
          if (tNext < duration - 1e-3 && glK !== k + 1) {
            await seekTo(vid, Math.min(tNext, duration - 1e-3));
            r.draw(vid);
            glK = k + 1;
          }
          // Mezcla: base al 100% + siguiente con peso frac
          octx!.globalAlpha = 1;
          octx!.drawImage(blendCanvas!, 0, 0);
          octx!.globalAlpha = frac;
          octx!.drawImage(canvas, 0, 0);
          octx!.globalAlpha = 1;
          frameSource = outCanvas!;
        }
      } else {
        // Sin interpolación: comportamiento original
        await seekTo(vid, t);
        if (signal?.aborted) throw new Error('Exportación cancelada');
        r.draw(vid);
        frameSource = canvas;
      }

      // Cadena de calidad completa (denoise → exposición → curva → eq → claridad → CAS)
      const frame = new VideoFrame(frameSource, {
        timestamp: Math.round(t * 1e6),
        duration: frameDurationUs,
      });

      // Backpressure: si el codificador se acumula, esperamos (evita sobrecarga en móviles).
      // En vez de polling con sleep(4), usamos un promise que se resuelve cuando
      // el codificador notifica que hay espacio (mucho menos consumo de CPU).
      while (enc.encodeQueueSize > MAX_ENCODE_QUEUE) {
        if (signal?.aborted) {
          frame.close();
          throw new Error('Exportación cancelada');
        }
        if (encErr.encoder || encErr.mux) break;
        await new Promise<void>((resolve) => {
          const check = () => {
            if (enc.encodeQueueSize <= MAX_ENCODE_QUEUE) resolve();
            else setTimeout(check, 16); // 16ms ≈ 1 frame, sin busy-wait agresivo
          };
          check();
        });
      }

      enc.encode(frame, { keyFrame: i % keyInterval === 0 });
      frame.close();

      processed++;
      emit(processed, 'Procesando filtros ixi 4k...');
    }

    // --- 9) Fases finales ---
    emit(processed, 'Codificando H.264 (WebCodecs)...', true);
    await enc.flush();
    if (encErr.encoder) {
      throw new Error(`Error del codificador WebCodecs: ${encErr.encoder.message}`);
    }
    if (signal?.aborted) throw new Error('Exportación cancelada');

    emit(processed, 'Optimizando archivo MP4...', true);
    muxer.finalize(); // fastStart 'in-memory' → MP4 listo para subir

    const blob = new Blob([target.buffer], { type: 'video/mp4' });

    const dot = fileName.lastIndexOf('.');
    const base = dot > 0 ? fileName.slice(0, dot) : fileName;
    const cleanBase = base.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'ixi4k_export';

    emit(processed, '¡Completado!', true, true);

    return {
      blob,
      fileName: `${cleanBase}.mp4`,
      width: outW,
      height: outH,
      durationSec: Math.round((processed / outFps) * 100) / 100,
      frameCount: processed,
      fps: outFps,
      acceleration: prog.acceleration,
      ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
    };
  } finally {
    // --- 12) Limpieza de memoria siempre, tanto en éxito como en error ---
    if (encoder) {
      try {
        encoder.close();
      } catch {
        /* noop */
      }
    }
    if (renderer) {
      try {
        renderer.dispose();
      } catch {
        /* noop */
      }
    }
    if (video) {
      try {
        video.pause();
        video.src = '';
        video.load();
      } catch {
        /* noop */
      }
    }
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* noop */
      }
    }
  }
}
