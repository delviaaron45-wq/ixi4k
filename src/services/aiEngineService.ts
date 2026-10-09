import { useCallback, useEffect, useRef, useState } from 'react';

/** Espejo TS de `AiCapability` (serde camelCase) de ai_superres.rs. */
export interface AiCapabilityView {
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

/**
 * Estado del motor IA local (Real-ESRGAN ncnn/vulkan).
 *
 * Sólo tiene sentido en la app de escritorio (Tauri). En la web se pasa
 * `enabled = false` y el hook NO invoca nada ni simula capacidades: el UI
 * muestra el estado honesto «no disponible en el navegador».
 */
export function useAiEngine(enabled: boolean) {
  const [cap, setCap] = useState<AiCapabilityView | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const c = await invoke<AiCapabilityView>('ai_status');
      if (alive.current) setCap(c);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async () => {
    if (!enabled || installing) return;
    setInstalling(true);
    setError(null);
    setProgress(0);
    let unlisten: (() => void) | undefined;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const u = await listen<{ percent: number }>('ai-install-progress', (e) => {
        if (alive.current) {
          setProgress(Math.max(0, Math.min(100, e.payload?.percent ?? 0)));
        }
      });
      unlisten = u;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('ai_install_engine');
      await refresh();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      if (alive.current) setInstalling(false);
    }
  }, [enabled, installing, refresh]);

  return { cap, installing, progress, error, install, refresh };
}
