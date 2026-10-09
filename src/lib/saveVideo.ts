/**
 * Guardado del vídeo exportado en el dispositivo.
 *
 * · Móvil (Web Share API nivel 2): la ÚNICA forma real de que un vídeo
 *   termine en la galería/Fotos desde un navegador es compartir el archivo
 *   (`navigator.share` con `files`) y que el usuario elija «Guardar en
 *   Fotos/Galería» en la hoja del sistema. iOS Safari 15+, Android Chrome,
 *   Samsung Internet y PWA instaladas lo soportan. No requiere permisos de
 *   almacenamiento: el propio SO gestiona el guardado.
 * · Escritorio o navegador sin soporte: descarga clásica por `<a download>`.
 *
 * Nota: `navigator.share` exige gesto del usuario en algunas plataformas;
 * tras un export largo el intento automático puede devolver `NotAllowedError`,
 * por eso la interfaz ofrece además un botón «Guardar en galería» que repite
 * la operación con un gesto real del usuario.
 */

export type SaveOutcome = 'shared' | 'downloaded' | 'cancelled' | 'error';

/** ¿Este dispositivo/navegador puede llevar el vídeo a la galería vía Share? */
export function canSaveToGallery(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Runtime check: en navegadores antiguos estas funciones no existen aunque
  // la librería DOM de TypeScript las declare
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') {
    return false;
  }
  try {
    const probe = new File([new Blob()], 'probe.mp4', { type: 'video/mp4' });
    return navigator.canShare({ files: [probe] }) === true;
  } catch {
    return false;
  }
}

/** Descarga clásica (`<a download>`) — fallback universal (escritorio). */
export function downloadVideoBlob(blob: Blob, filename: string): SaveOutcome {
  try {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'downloaded';
  } catch {
    return 'error';
  }
}

/**
 * Guarda el vídeo en el dispositivo: en móvil abre la hoja de compartir del
 * sistema («Guardar en Fotos/Galería»); sin soporte o si el sistema bloquea
 * el share (falta de gesto), cae a la descarga clásica.
 *
 * Devuelve un resultado VERAZ para que la UI confirme lo que pasó de verdad:
 *   · 'shared'      → el usuario completó la hoja (donde eligió, se guardó)
 *   · 'downloaded'  → descarga clásica iniciada
 *   · 'cancelled'   → el usuario canceló la hoja (NO es un error)
 *   · 'error'       → ni share ni descarga fueron posibles
 */
export async function saveVideoToGallery(blob: Blob, filename: string): Promise<SaveOutcome> {
  if (canSaveToGallery()) {
    try {
      const file = new File([blob], filename, { type: blob.type || 'video/mp4' });
      await navigator.share({
        files: [file],
        title: filename,
        text: 'Vídeo exportado con ixi 4k',
      });
      return 'shared';
    } catch (e) {
      // Cancelación del usuario: no es un error, simplemente no guardó
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
      // NotAllowedError (sin gesto del usuario) u otro fallo → respaldo
    }
  }
  return downloadVideoBlob(blob, filename);
}
