import { useCallback, useEffect, useRef, useState } from 'react';
import { isNativeRuntime } from '@/services/platformService';

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
 * Sólo tiene sentido en la app de escritorio (Tauri). En la web —publicada o
 * `npm run dev`— el hook NO invoca nada ni simula capacidades: degrada en
 * silencio (cap = null) y el UI muestra el estado honesto «sólo escritorio».
 *
 * Protecciones (bug real corregido: "Cannot read properties of undefined
 * (reading 'invoke')" al llamar a Tauri desde un navegador):
 *   1. `isNativeRuntime()` exige el objeto puente DEFINIDO y con `invoke`
 *      como función (Tauri v2 `__TAURI_INTERNALS__.invoke`, v1
 *      `__TAURI__.ipc.invoke`) antes de importar/usar la API.
 *   2. Comprobación adicional `typeof invoke === 'function'` tras el import.
 *   3. Todo dentro de try/catch: cualquier fallo se captura, se muestra como
 *      aviso y NUNCA rompe la interfaz.
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
    // Fuera del contenedor nativo: no se invoca NADA (sin error, sin simulación)
    if (!enabled || !isNativeRuntime()) return;
    try {
      const mod = await import('@tauri-apps/api/core');
      if (typeof mod?.invoke !== 'function') return;
      const c = await mod.invoke<AiCapabilityView>('ai_status');
      if (alive.current) setCap(c);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install = useCallback(async () => {
    if (!enabled || installing || !isNativeRuntime()) return;
    setInstalling(true);
    setError(null);
    setProgress(0);
    let unlisten: (() => void) | undefined;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      if (typeof listen === 'function') {
        const u = await listen<{ percent: number }>('ai-install-progress', (e) => {
          if (alive.current) {
            setProgress(Math.max(0, Math.min(100, e.payload?.percent ?? 0)));
          }
        });
        unlisten = u;
      }
      const mod = await import('@tauri-apps/api/core');
      if (typeof mod?.invoke !== 'function') {
        if (alive.current) {
          setError('Puente nativo no disponible: instala la app de escritorio.');
        }
        return;
      }
      await mod.invoke('ai_install_engine');
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
