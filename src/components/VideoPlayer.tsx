import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { motion } from 'framer-motion';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Eye, EyeOff } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { VideoFile } from '@/store/useAppStore';

interface VideoPlayerProps {
  video: VideoFile;
}

export function VideoPlayer({ video }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const showSafeZone = useAppStore((s) => s.showSafeZone);
  const toggleSafeZone = useAppStore((s) => s.toggleSafeZone);

  // Estado real de pantalla completa (Desktop/Android) — iOS Safari no expone
  // fullscreen para contenedores, así que ahí se usa el fullscreen nativo del vídeo.
  useEffect(() => {
    const onChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen(!!(document.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange as EventListener);
    };
  }, []);

  const toggleFullscreen = async () => {
    const doc = document as Document & {
      webkitExitFullscreen?: () => Promise<void> | void;
      webkitFullscreenElement?: Element | null;
    };
    const active = document.fullscreenElement || doc.webkitFullscreenElement;
    if (active) {
      try {
        const exit = document.exitFullscreen?.bind(document) ?? doc.webkitExitFullscreen?.bind(doc);
        await exit?.();
      } catch {
        /* el navegador decide; el estado se sincroniza vía fullscreenchange */
      }
      return;
    }
    const el = wrapperRef.current;
    if (el) {
      const elAny = el as HTMLDivElement & { webkitRequestFullscreen?: () => void };
      const req =
        el.requestFullscreen?.bind(el) ?? elAny.webkitRequestFullscreen?.bind(elAny);
      if (req) {
        try {
          await req();
          return;
        } catch {
          /* p. ej. iOS Safari: el <video> abajo tiene su propio fullscreen */
        }
      }
    }
    // Alternativa móvil compatible: pantalla completa nativa del reproductor
    const v = videoRef.current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;
    try {
      v?.webkitEnterFullscreen?.();
    } catch {
      /* dispositivo sin soporte: la acción queda sin efecto sin romper nada */
    }
  };

  const togglePlay = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const toggleMute = () => {
    if (videoRef.current) {
      videoRef.current.muted = !isMuted;
      setIsMuted(!isMuted);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setProgress(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
    }
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div
      ref={wrapperRef}
      className="relative rounded-2xl overflow-hidden bg-black aspect-video"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
    >
      <video
        ref={videoRef}
        src={video.previewUrl}
        className="w-full h-full object-contain"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
        playsInline
      />

      {/* Safe Zone Overlay */}
      {showSafeZone && (
        <motion.div
          className="absolute inset-0 pointer-events-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* TikTok Safe Zone Template */}
          <div className="absolute inset-0 border-2 border-dashed border-ixi-cyan/30 rounded-lg m-4">
            {/* Top safe zone */}
            <div className="absolute top-0 left-0 right-0 h-[15%] bg-ixi-cyan/5 border-b border-ixi-cyan/20 flex items-center justify-center">
              <span className="text-xs text-ixi-cyan/60 font-medium">ZONA SEGURA SUPERIOR</span>
            </div>
            {/* Bottom safe zone */}
            <div className="absolute bottom-0 left-0 right-0 h-[25%] bg-ixi-cyan/5 border-t border-ixi-cyan/20 flex items-center justify-center">
              <span className="text-xs text-ixi-cyan/60 font-medium">ZONA SEGURA INFERIOR</span>
            </div>
            {/* Right side - TikTok buttons */}
            <div className="absolute right-2 top-1/2 -translate-y-1/2 flex flex-col gap-4">
              <div className="w-10 h-10 rounded-full bg-ixi-bg/80 border border-ixi-cyan/30 flex items-center justify-center">
                <span className="text-ixi-cyan text-lg">♥</span>
              </div>
              <div className="w-10 h-10 rounded-full bg-ixi-bg/80 border border-ixi-cyan/30 flex items-center justify-center">
                <span className="text-ixi-cyan text-lg">💬</span>
              </div>
              <div className="w-10 h-10 rounded-full bg-ixi-bg/80 border border-ixi-cyan/30 flex items-center justify-center">
                <span className="text-ixi-cyan text-lg">↗</span>
              </div>
            </div>
            {/* Center safe zone indicator */}
            <div className="absolute top-[15%] left-0 right-0 bottom-[25%] border border-ixi-violet/20 rounded">
              <div className="absolute top-2 left-2 text-xs text-ixi-violet/40">ÁREA SEGURA CENTRAL</div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Controls overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
        {/* Progress bar */}
        <div className="mb-3">
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={progress}
            onChange={(e) => {
              if (videoRef.current) {
                videoRef.current.currentTime = Number(e.target.value);
              }
            }}
            className="range-neon h-1"
            style={{ '--fill': `${duration ? (progress / duration) * 100 : 0}%` } as CSSProperties}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={togglePlay}
              className="w-10 h-10 rounded-full bg-ixi-cyan/20 hover:bg-ixi-cyan/30 flex items-center justify-center transition-colors"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 text-ixi-cyan" />
              ) : (
                <Play className="w-5 h-5 text-ixi-cyan ml-0.5" />
              )}
            </button>
            <button
              onClick={toggleMute}
              className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
            >
              {isMuted ? (
                <VolumeX className="w-5 h-5 text-white" />
              ) : (
                <Volume2 className="w-5 h-5 text-white" />
              )}
            </button>
            <span className="text-sm text-white/80 font-mono">
              {formatTime(progress)} / {formatTime(duration)}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={toggleSafeZone}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                showSafeZone
                  ? 'bg-ixi-cyan/20 text-ixi-cyan border border-ixi-cyan/30'
                  : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              {showSafeZone ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
              Safe Zone
            </button>
            <button
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
              title={isFullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}
              className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
            >
              {isFullscreen ? (
                <Minimize className="w-5 h-5 text-white" />
              ) : (
                <Maximize className="w-5 h-5 text-white" />
              )}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}