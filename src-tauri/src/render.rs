//! ============================================================================
//! Motor de render de ixi 4k
//! ============================================================================
//! Planifica y ejecuta FFmpeg con:
//!   · Ajustes de calidad REALES sobre el vídeo exportado (cadena de filtros)
//!   · Escalado de alta calidad hasta 4K (Lanczos + paso intermedio)
//!   · Reducción de ruido, exposición, curva sombras/luces, contraste,
//!     saturación, claridad y nitidez adaptativa CAS (sin sobreenfoque)
//!   · Interpolación REAL de fotogramas (nunca duplicación de frames)
//!   · Aceleración por hardware (NVENC/QSV/AMF/VideoToolbox/MediaCodec)
//!     con sondeo y reserva automática a CPU si no es viable
//!   · Adaptación automática a la gama del dispositivo (PC / móvil)
//!   · Progreso real (%, FPS, ETA, resolución y aceleración) por eventos
//!
//! Todas las fórmulas están espejadas en `src/lib/qualityPipeline.ts`
//! (vista previa Before/After y exportación en navegador). Si se cambia una
//! constante aquí, se cambia allí.
//! ============================================================================

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// ---------------------------------------------------------------------------
// RenderSettings — espejo camelCase de qualityPipeline.ts
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RenderSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub crf: u32,
    pub bitrate_mbps: u32,
    /// 0..200 (porcentaje de nitidez, NO multiplicador 0..2)
    pub sharpness: f64,
    pub contrast: f64,
    pub saturation: f64,
    /// 0.5..1.5 multiplicador visual → eq=brightness aditivo
    pub brightness: f64,
    pub lanczos: bool,
    pub anti_duplicate: bool,
    /// '1080p' | '2K' | '4K UHD'
    pub resolution: String,
    /// 0..100
    pub noise_reduction: f64,
    /// 0..100
    pub clarity: f64,
    /// -50..50 (±0.5 paradas)
    pub exposure: f64,
    /// 0..100
    pub shadows: f64,
    /// 0..100
    pub highlights: f64,
    /// Interpolación real al subir FPS (si false: conserva FPS de origen)
    pub interpolate: bool,
    /// Filtro AE «AE Edit»: grading cinematográfico real (curva S + split
    /// toning + detalle suave + viñeta + bloom). Espejo de qualityPipeline.ts.
    pub ae_edit: bool,
    /// Mapa de tonos Möbius (rodilla de altas luces, preset «Cine Pro Dark»)
    pub mobius: bool,
    /// Conversión HDR/Dolby Vision → BT.709 (solo se aplica si la fuente ES HDR)
    pub hdr_convert: bool,
    /// Objetivo 9:16 TikTok/Reels
    pub tiktok_preset: bool,
    /// 'high' | 'medium' | 'low'
    pub device_tier: String,
    /// 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'
    pub platform: String,
    /// 'auto' | 'lanczos' | 'ai'
    pub upscale_mode: String,
    /// Cadenas EXACTAS del preset activo (Topaz / AE Pro / Cine…). Si existe,
    /// el motor usa estos valores en lugar de derivarlos de los sliders; al
    /// mover cualquier slider la UI la limpia y vuelven a mandar los sliders.
    pub preset_filters: Option<PresetFilters>,
}

/// Etapas concretas de un preset (espejo de `PresetFilters` en qualityPipeline.ts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PresetFilters {
    /// `hqdn3d` exacto: luma_spatial, chroma_spatial, luma_tmp, chroma_tmp
    pub denoise: Option<[f64; 4]>,
    /// `eq` exacto
    pub contrast: Option<f64>,
    pub brightness: Option<f64>,
    pub saturation: Option<f64>,
    pub gamma: Option<f64>,
    /// `colorbalance` — sombras / medios / luces (R, G, B)
    pub cb_shadows: Option<[f64; 3]>,
    pub cb_mids: Option<[f64; 3]>,
    pub cb_highlights: Option<[f64; 3]>,
    /// `unsharp=<m>:<m>:<luma>:<cm>:<cm>:<chroma>` — Unsharp Mask de doble
    /// pasada (p. ej. Topaz 5:5:0.8:3:3:0.4 o HDR 3:3:0.6:3:3:0.3)
    pub detail: Option<[f64; 4]>,
    /// `cas` exacto (si no, se deriva del slider de nitidez)
    pub cas: Option<f64>,
}

impl Default for RenderSettings {
    fn default() -> Self {
        Self {
            width: 2160,
            height: 3840,
            fps: 60,
            crf: 14,
            bitrate_mbps: 50,
            sharpness: 100.0,
            contrast: 1.15,
            saturation: 1.1,
            brightness: 1.0,
            lanczos: true,
            anti_duplicate: true,
            resolution: "4K UHD".into(),
            noise_reduction: DENOISE_BASE_PERCENT,
            clarity: 0.0,
            exposure: 0.0,
            shadows: 0.0,
            highlights: 0.0,
            interpolate: true,
            ae_edit: false,
            mobius: false,
            hdr_convert: false,
            tiktok_preset: true,
            device_tier: "high".into(),
            platform: String::new(),
            upscale_mode: "auto".into(),
            preset_filters: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Constantes compartidas con qualityPipeline.ts (CFG)
// ---------------------------------------------------------------------------
// FASE 1 · Denoise: el PERFIL BASE (nivel estándar 25 %) es exactamente
// `hqdn3d=1.5:1.5:4:4`: limpia grano digital y artefactos ANTES de enfocar
// sin suavizar detalle. El slider escala proporcionalmente (0 % = sin filtro).
const DENOISE_LUMA_SPATIAL: f64 = 6.0;
const DENOISE_CHROMA_SPATIAL: f64 = 6.0;
const DENOISE_LUMA_TMP: f64 = 16.0;
const DENOISE_CHROMA_TMP: f64 = 16.0;
/// Porcentaje que corresponde al perfil base `1.5:1.5:4:4`.
pub const DENOISE_BASE_PERCENT: f64 = 25.0;

// ---------------------------------------------------------------------------
// FASE 3 · Control de luz y metadatos
// ---------------------------------------------------------------------------
/// Rodilla del mapa de tonos Möbius (niveles 0..255): por debajo la imagen no
/// se toca. Ramal superior = transformación de Möbius (bilineal) con
/// asintota: f(x) = k + s·(x−k) / ((x−k) + s). En 8 bits: k=214, s=41 →
/// el blanco (255) cae a 234,5 y la curva nunca aplasta rangos (monótona).
const MOBIUS_KNEE: f64 = 214.0;
const MOBIUS_SPAN: f64 = 41.0;
/// Luminancia máxima (1.0 en rango limitado BT.709): evita luces quemadas.
const LUMA_MAX: f64 = 235.0;
/// GOP fijo de 30 fotogramas (salida H.264 y HEVC).
const GOP_FRAMES: u32 = 30;
/// HDR (PQ/HLG) → BT.709 real: linealiza, aplica `tonemap` de FFmpeg con el
/// algoritmo Möbius y vuelve a BT.709 en 8 bits. Solo si la fuente ES HDR.
const HDR_TO_BT709: &str = "zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=mobius:peak=1,zscale=transfer=bt709:primaries=bt709:matrix=bt709,format=yuv420p";
const CURVE_SHADOW_GAIN: f64 = 0.12;
const CURVE_HIGHLIGHT_GAIN: f64 = 0.12;
const BRIGHTNESS_SCALE: f64 = 0.4;
const CLARITY_MAX: f64 = 0.35;
const CAS_PER_SHARPNESS: f64 = 0.4;
/// Tope duro de CAS: los presets piden hasta 0.70 («4K Topaz Natural»).
const CAS_MAX: f64 = 0.70;
const CAS_UPSCALE_FALLOFF: f64 = 0.35;
const CAS_UPSCALE_MIN: f64 = 0.55;

// --- Filtro AE «AE Edit» — espejo de AE_EDIT (qualityPipeline.ts) ---
/// La saturación efectiva es la del usuario × este factor (ligeramente menor)
const AE_SATURATION_MULT: f64 = 0.94;
/// Curva S en niveles 0..255: (0,3.825) (46,35.7) (128,119.85) (209,219.3) (255,255)
const AE_CURVE_LUT: &str = "clip(if(lt(val,46),3.825+val*0.6929,if(lt(val,128),35.7+(val-46)*1.0262,if(lt(val,209),119.85+(val-128)*1.2278,219.3+(val-209)*0.7761))),0,255)";
/// Split toning: sombras frías azul/cian, medios y luces ligeramente cálidas
const AE_COLORBALANCE: &str = "colorbalance=rs=-0.05:gs=0.02:bs=0.05:rm=0.02:gm=-0.01:bm=-0.01:rh=0.05:gh=0.01:bh=-0.04";
/// Detalle y nitidez mejorados de forma suave (cantidad del unsharp 5×5)
const AE_DETAIL_UNSHARP: f64 = 0.18;
/// Viñeta muy sutil (ángulo del filtro `vignette` de FFmpeg)
const AE_VIGNETTE_ANGLE: f64 = 0.22;
/// Bloom de luces: umbral (0..255) y ganancia de la extracción
const AE_BLOOM_THRESHOLD: f64 = 145.0;
const AE_BLOOM_GAIN: f64 = 1.6;
/// Opacidad del screen al mezclar el glow (SOLO en luma; el croma no se toca)
const AE_BLOOM_OPACITY: f64 = 0.14;
/// Subexposición «premium» del grading AE (eq brightness, tras la viñeta).
/// Importante: va al FINAL del bloque AE, no en el `eq` compartido del paso 5
/// — `colorbalance` realimenta por zonas (sombras/medios/luces) y absorbería
/// casi todo el desplazamiento si se aplicara antes. Así el export AE queda
/// realmente más oscuro que la base. Espejo del paso 4b de qualityShader.ts.
const AE_EXPOSURE_OFFSET: f64 = -0.02;

/// Sigma del `gblur` del bloom: proporcional al lado largo de salida.
fn ae_bloom_sigma(width: u32, height: u32) -> u32 {
    ((width.max(height) as f64 / 320.0).round()).clamp(4.0, 14.0) as u32
}

fn clamp(v: f64, min: f64, max: f64) -> f64 {
    if v.is_finite() {
        v.min(max).max(min)
    } else {
        min
    }
}

/// Nivel H.264 mínimo VÁLIDO para el fotograma y los FPS de salida.
/// Se parte del nivel 5.1 pedido y solo se eleva si el fotograma lo exige
/// (4K60 → 5.2, 8K → 6.x): forzar un nivel por debajo del mínimo produce un
/// stream no conforme que los reproductores rechazan o reproducen a saltos.
fn h264_level(width: u32, height: u32, fps: f64) -> &'static str {
    let mb = (((width + 15) / 16) * ((height + 15) / 16)) as f64;
    let mbps = mb * fps.max(1.0);
    if mb <= 36864.0 && mbps <= 1_084_416.0 {
        "5.1"
    } else if mb <= 36864.0 && mbps <= 2_073_600.0 {
        "5.2"
    } else if mb <= 139264.0 && mbps <= 4_177_920.0 {
        "6.0"
    } else if mb <= 139264.0 && mbps <= 8_355_840.0 {
        "6.1"
    } else {
        "6.2"
    }
}

fn even_up(v: u32) -> u32 {
    (v + 1) & !1
}

/// Primaries de la fuente → valor aceptado por el filtro `colorspace`.
/// Cualquier cosa que el filtro no conozca (vacío, "unknown", "display-p3"…)
/// se declara como bt709: es una identidad COMPROBADA sobre fuentes sin tags
/// (no cambia ni un píxel) y evita el error «Unsupported input primaries»
/// que rompería la exportación.
fn color_std_for_filter(primaries: &str) -> &'static str {
    match primaries {
        "bt470m" => "bt470m",
        "bt470bg" => "bt470bg",
        "smpte170m" => "smpte170m",
        "smpte240m" => "smpte240m",
        "bt2020" => "bt2020",
        _ => "bt709",
    }
}

// ---------------------------------------------------------------------------
// Fórmulas compartidas
// ---------------------------------------------------------------------------

/// Fuerza de `hqdn3d` a partir del porcentaje (0..100). None = sin filtro.
pub fn denoise_levels(noise_reduction: f64) -> Option<(f64, f64, f64, f64)> {
    let nr = clamp(noise_reduction, 0.0, 100.0);
    if nr <= 0.0 {
        return None;
    }
    let t = nr / 100.0;
    Some((
        (DENOISE_LUMA_SPATIAL * t * 100.0).round() / 100.0,
        (DENOISE_CHROMA_SPATIAL * t * 100.0).round() / 100.0,
        (DENOISE_LUMA_TMP * t * 100.0).round() / 100.0,
        (DENOISE_CHROMA_TMP * t * 100.0).round() / 100.0,
    ))
}

/// Exposición (-50..50) → factor 2^(e/100) (±0.5 paradas).
pub fn exposure_factor(exposure: f64) -> f64 {
    2f64.powf(clamp(exposure, -50.0, 50.0) / 100.0)
}

/// Curva tonal sombras/luces → (y15, y85). None = identidad (sin filtro).
pub fn tone_curve(shadows: f64, highlights: f64) -> Option<(f64, f64)> {
    let sh = clamp(shadows, 0.0, 100.0) / 100.0;
    let hi = clamp(highlights, 0.0, 100.0) / 100.0;
    if sh <= 0.0 && hi <= 0.0 {
        return None;
    }
    let y15 = clamp(0.15 + CURVE_SHADOW_GAIN * sh, 0.15, 0.45);
    let y85 = clamp(0.85 - CURVE_HIGHLIGHT_GAIN * hi, 0.55, 0.85);
    let r4 = |v: f64| (v * 10000.0).round() / 10000.0;
    Some((r4(y15), r4(y85)))
}

/// Brillo visual (0.5..1.5) → eq=brightness aditivo FFmpeg (-1..1).
/// OJO: FFmpeg `eq` es ADITIVO: brightness=1.0 deja la imagen blanca.
/// Por eso 1.0 (neutro) mapea a 0.0 aquí.
pub fn brightness_add(brightness: f64) -> f64 {
    let r4 = |v: f64| (v * 10000.0).round() / 10000.0;
    r4((clamp(brightness, 0.5, 1.5) - 1.0) * BRIGHTNESS_SCALE)
}

/// Claridad (0..100) → cantidad `unsharp` de radio grande (contraste local).
pub fn clarity_amount(clarity: f64) -> f64 {
    let v = CLARITY_MAX * (clamp(clarity, 0.0, 100.0) / 100.0);
    (v * 10000.0).round() / 10000.0
}

/// Nitidez (0..200) → fuerza CAS, atenuada al escalar mucho
/// (evita halos y apariencia artificial al ampliar).
pub fn cas_amount(sharpness: f64, upscale_ratio: f64) -> f64 {
    let base = (clamp(sharpness, 0.0, 200.0) / 100.0) * CAS_PER_SHARPNESS;
    let r = if upscale_ratio.is_finite() && upscale_ratio > 1.0 {
        upscale_ratio
    } else {
        1.0
    };
    let mult = if r > 1.0 {
        clamp(
            1.0 / (1.0 + CAS_UPSCALE_FALLOFF * (r - 1.0)),
            CAS_UPSCALE_MIN,
            1.0,
        )
    } else {
        1.0
    };
    let v = clamp(base * mult, 0.0, CAS_MAX);
    (v * 10000.0).round() / 10000.0
}

/// Dimensiones objetivo por etiqueta de resolución + orientación.
/// `tiktok_preset` fuerza 9:16; si no, se respeta la orientación del origen
/// (vídeo apaisado → 3840×2160 en lugar de recortarlo a vertical).
pub fn resolution_dims(resolution: &str, source_w: u32, source_h: u32, tiktok: bool) -> (u32, u32) {
    let (p, l): ((u32, u32), (u32, u32)) = match resolution {
        "1080p" => ((1080, 1920), (1920, 1080)),
        "2K" => ((1440, 2560), (2560, 1440)),
        "8K UHD" => ((4320, 7680), (7680, 4320)),
        _ => ((2160, 3840), (3840, 2160)),
    };
    let portrait = tiktok || source_h >= source_w;
    if portrait {
        p
    } else {
        l
    }
}

// ---------------------------------------------------------------------------
// Adaptación al hardware (gama del dispositivo + plataforma)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone)]
pub struct TierCaps {
    pub max_long_side: u32,
    pub max_fps: u32,
    pub x264_preset: &'static str,
    pub threads: usize,        // 0 = automático
    pub filter_threads: usize, // 0 = automático
    pub audio_kbps: u32,
    pub allow_mci: bool,
    pub mci_max_pixels: u64,
    pub mci_max_duration_sec: f64,
    pub denoise_max: f64,
}

pub fn tier_caps(tier: &str, platform: &str) -> TierCaps {
    let mobile = platform == "android" || platform == "ios";
    let mut caps = match tier {
        "low" => TierCaps {
            max_long_side: 1920,
            max_fps: 30,
            x264_preset: "fast",
            threads: 4,
            filter_threads: 2,
            audio_kbps: 128,
            allow_mci: false,
            mci_max_pixels: 0,
            mci_max_duration_sec: 0.0,
            denoise_max: 70.0,
        },
        "medium" => TierCaps {
            max_long_side: 2560,
            max_fps: 60,
            x264_preset: "medium",
            threads: 8,
            filter_threads: 4,
            audio_kbps: 192,
            allow_mci: false,
            mci_max_pixels: 0,
            mci_max_duration_sec: 0.0,
            denoise_max: 100.0,
        },
        _ => TierCaps {
            max_long_side: 7680,
            max_fps: 120,
            x264_preset: "slow",
            threads: 0,
            filter_threads: 0,
            audio_kbps: 320,
            allow_mci: true,
            mci_max_pixels: 2_200_000,
            mci_max_duration_sec: 120.0,
            denoise_max: 100.0,
        },
    };
    if mobile {
        // Móvil: menos hilos y filtros ligeros → evita sobrecalentamiento,
        // bloqueos y consumo innecesario.
        // Techo real de teléfono: 4K / 60 FPS (ni 8K ni 120: el codificador del
        // dispositivo no lo soporta de forma fiable).
        caps.max_long_side = caps.max_long_side.min(3840);
        caps.max_fps = caps.max_fps.min(60);
        caps.threads = caps.threads.min(4).max(2);
        caps.filter_threads = caps.filter_threads.min(2).max(1);
        if caps.x264_preset == "slow" {
            caps.x264_preset = "medium";
        }
        caps.allow_mci = false;
    }
    caps
}

// ---------------------------------------------------------------------------
// Resolución de la ruta del vídeo de origen
// ---------------------------------------------------------------------------
// Las webviews NO exponen la ruta absoluta del archivo que elige el usuario
// (solo el nombre). Para no fallar, el backend la localiza por nombre + tamaño
// en las carpetas habituales, con presupuesto de tiempo y de entradas leídas.
// Si no es unívoco, devuelve `ARCHIVO_ORIGEN:` y la UI abre el selector
// nativo: nunca se procesa "a ciegas" un archivo que no se ha localizado.
pub const MISSING_SOURCE_PREFIX: &str = "ARCHIVO_ORIGEN";

/// Carpetas habituales de usuario (escritorio, OneDrive y XDG en Linux).
pub fn media_search_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(home) = home {
        for base in [None, Some("OneDrive")] {
            let dir = match base {
                Some(extra) => home.join(extra),
                None => home.clone(),
            };
            for folder in ["Downloads", "Videos", "Desktop", "Documents", "Movies", "Pictures"] {
                roots.push(dir.join(folder));
            }
        }
        // Un nivel más (p. ej. vídeos sueltos en el propio HOME)
        roots.push(home);
    }
    for var in ["XDG_DOWNLOAD_DIR", "XDG_VIDEOS_DIR"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                roots.push(PathBuf::from(v));
            }
        }
    }
    roots
}

/// Presupuesto de búsqueda: la exploración nunca se puede "colgar".
const SEARCH_MAX_ENTRIES: usize = 6_000;
const SEARCH_MAX_MS: u128 = 2_500;

/// Resuelve la ruta real del vídeo de entrada (ver cabecera de esta sección).
pub fn resolve_media_path(
    input: &str,
    file_size: Option<u64>,
    roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Ruta vacía rechazada".to_string());
    }
    if raw.contains('\0') {
        return Err("Carácter nulo detectado en la ruta (inyección)".to_string());
    }
    let path = Path::new(raw);
    for comp in path.components() {
        if matches!(comp, Component::ParentDir) {
            return Err("Path Traversal detectado: se rechazó '..' en la ruta".to_string());
        }
    }

    // Ruta absoluta existente → válida tal cual (caso normal y de pruebas).
    if path.is_absolute() {
        if path.is_file() {
            return path
                .canonicalize()
                .map_err(|e| format!("No se pudo resolver la ruta: {e}"));
        }
        // Si ya no existe, seguimos intentando localizarla por nombre.
    }

    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return Err(format!("{MISSING_SOURCE_PREFIX}: nombre de archivo inválido"));
    };

    let started = Instant::now();
    let mut entries = 0usize;
    let mut found: Vec<PathBuf> = Vec::new();

    'roots: for root in roots {
        if let Some(hit) = scan_dir(root, &name, file_size, &mut entries) {
            found.extend(hit);
        }
        if over_budget(entries, started) {
            break 'roots;
        }
        // …y UN nivel de subdirectorios (p. ej. Videos/2025/clips)
        let Ok(dir) = std::fs::read_dir(root) else { continue };
        for entry in dir.flatten() {
            if over_budget(entries, started) {
                break 'roots;
            }
            let sub_name = entry.file_name().to_string_lossy().to_string();
            if sub_name.starts_with('.') {
                continue;
            }
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(hit) = scan_dir(&entry.path(), &name, file_size, &mut entries) {
                    found.extend(hit);
                }
            }
        }
    }

    found.sort();
    found.dedup();

    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(format!(
            "{MISSING_SOURCE_PREFIX}: no se encontró «{name}» en las carpetas de usuario. \
             Selecciona el vídeo original en el diálogo para continuar."
        )),
        _ => Err(format!(
            "{MISSING_SOURCE_PREFIX}: hay varios archivos llamados «{name}». \
             Selecciona el vídeo original en el diálogo para continuar."
        )),
    }
}

fn over_budget(entries: usize, started: Instant) -> bool {
    entries >= SEARCH_MAX_ENTRIES || started.elapsed().as_millis() > SEARCH_MAX_MS
}

/// Busca `name` (+ tamaño) en `dir` y contabiliza las entradas leídas.
fn scan_dir(
    dir: &Path,
    name: &str,
    file_size: Option<u64>,
    entries: &mut usize,
) -> Option<Vec<PathBuf>> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut hits = Vec::new();
    for entry in rd.flatten() {
        *entries += 1;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if !entry.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            continue;
        }
        if let Some(size) = file_size {
            match entry.metadata() {
                Ok(md) if md.len() == size => {}
                _ => continue,
            }
        }
        hits.push(entry.path());
    }
    Some(hits)
}

// ---------------------------------------------------------------------------
// Fuente
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_sec: f64,
    pub has_audio: bool,
    pub codec: String,
    /// La fuente declara transferencia HDR (PQ smpte2084 / HLG arib-std-b67)
    pub hdr: bool,
    /// Primaries declaradas por la fuente ("" si ffprobe no las declara)
    pub color_primaries: String,
}

fn parse_rate(s: &str) -> f64 {
    let mut parts = s.splitn(2, '/');
    let num: f64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let den: f64 = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1.0);
    if den <= 0.0 || num <= 0.0 {
        0.0
    } else {
        num / den
    }
}

/// Sondea el fichero con ffprobe (resolución, FPS, duración, audio).
pub async fn probe_source(path: &Path) -> Result<SourceInfo, String> {
    let out = Command::new("ffprobe")
        .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .await
        .map_err(|e| format!("No se pudo ejecutar ffprobe: {e}"))?;
    if !out.status.success() {
        return Err("No se pudo leer la información del vídeo".into());
    }
    let json: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|_| "ffprobe devolvió datos inválidos".to_string())?;

    let mut info = SourceInfo {
        width: 0,
        height: 0,
        fps: 0.0,
        duration_sec: 0.0,
        has_audio: false,
        codec: String::new(),
        hdr: false,
        color_primaries: String::new(),
    };
    if let Some(streams) = json.get("streams").and_then(|v| v.as_array()) {
        for st in streams {
            let kind = st.get("codec_type").and_then(|v| v.as_str()).unwrap_or("");
            if kind == "video" && info.width == 0 {
                info.width = st.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                info.height = st.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                info.codec = st
                    .get("codec_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Transferencia HDR: PQ (HDR10/Dolby Vision) o HLG
                let tr = st
                    .get("color_transfer")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                info.hdr = matches!(tr, "smpte2084" | "arib-std-b67");
                info.color_primaries = st
                    .get("color_primaries")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                let avg = st
                    .get("avg_frame_rate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let mut fps = parse_rate(avg);
                if fps <= 0.0 {
                    let r = st.get("r_frame_rate").and_then(|v| v.as_str()).unwrap_or("");
                    fps = parse_rate(r);
                }
                info.fps = fps;
                if let Some(d) = st.get("duration").and_then(|v| v.as_str()) {
                    if let Ok(x) = d.parse::<f64>() {
                        info.duration_sec = info.duration_sec.max(x);
                    }
                }
            } else if kind == "audio" {
                info.has_audio = true;
            }
        }
    }
    if let Some(d) = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse::<f64>().ok())
    {
        if d > 0.0 {
            info.duration_sec = d;
        }
    }
    if info.width == 0 || info.height == 0 {
        return Err("El archivo no contiene una pista de vídeo válida".into());
    }
    if info.fps <= 0.0 {
        info.fps = 30.0;
    }
    Ok(info)
}

// ---------------------------------------------------------------------------
// Aceleración por hardware
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncoderKind {
    Nvenc,
    Qsv,
    Amf,
    VideoToolbox,
    MediaCodec,
    X264,
}

#[derive(Debug, Clone, Copy)]
pub struct EncoderChoice {
    pub kind: EncoderKind,
    pub id: &'static str,
    pub label: &'static str,
    pub hw: bool,
}

const ENC_NVCENC: EncoderChoice = EncoderChoice {
    kind: EncoderKind::Nvenc,
    id: "h264_nvenc",
    label: "NVIDIA NVENC (GPU)",
    hw: true,
};
const ENC_QSV: EncoderChoice = EncoderChoice {
    kind: EncoderKind::Qsv,
    id: "h264_qsv",
    label: "Intel Quick Sync (GPU)",
    hw: true,
};
const ENC_AMF: EncoderChoice = EncoderChoice {
    kind: EncoderKind::Amf,
    id: "h264_amf",
    label: "AMD AMF (GPU)",
    hw: true,
};
const ENC_VIDEOTOOLBOX: EncoderChoice = EncoderChoice {
    kind: EncoderKind::VideoToolbox,
    id: "h264_videotoolbox",
    label: "VideoToolbox (GPU)",
    hw: true,
};
const ENC_MEDIACODEC: EncoderChoice = EncoderChoice {
    kind: EncoderKind::MediaCodec,
    id: "h264_mediacodec",
    label: "MediaCodec (GPU)",
    hw: true,
};
const ENC_X264: EncoderChoice = EncoderChoice {
    kind: EncoderKind::X264,
    id: "libx264",
    label: "CPU (x264)",
    hw: false,
};

// --- Codificadores HEVC (H.265): necesarios para 8K (H.264 no admite >4K) ---
const ENC_HEVC_NVENC: EncoderChoice = EncoderChoice {
    kind: EncoderKind::Nvenc,
    id: "hevc_nvenc",
    label: "NVIDIA NVENC HEVC (GPU)",
    hw: true,
};
const ENC_HEVC_QSV: EncoderChoice = EncoderChoice {
    kind: EncoderKind::Qsv,
    id: "hevc_qsv",
    label: "Intel Quick Sync HEVC (GPU)",
    hw: true,
};
const ENC_HEVC_AMF: EncoderChoice = EncoderChoice {
    kind: EncoderKind::Amf,
    id: "hevc_amf",
    label: "AMD AMF HEVC (GPU)",
    hw: true,
};
const ENC_HEVC_VIDEOTOOLBOX: EncoderChoice = EncoderChoice {
    kind: EncoderKind::VideoToolbox,
    id: "hevc_videotoolbox",
    label: "VideoToolbox HEVC (GPU)",
    hw: true,
};
const ENC_HEVC_MEDIACODEC: EncoderChoice = EncoderChoice {
    kind: EncoderKind::MediaCodec,
    id: "hevc_mediacodec",
    label: "MediaCodec HEVC (GPU)",
    hw: true,
};
const ENC_X265: EncoderChoice = EncoderChoice {
    kind: EncoderKind::X264,
    id: "libx265",
    label: "CPU (x265)",
    hw: false,
};

#[derive(Debug, Clone)]
pub struct HardwareProfile {
    pub encoder: EncoderChoice,
    /// Mejor codificador HEVC disponible (para 8K, donde H.264 no llega).
    /// `None` si FFmpeg no incluye ninguno.
    pub hevc: Option<EncoderChoice>,
    /// Codificadores H.264 declarados por el FFmpeg instalado
    pub available: Vec<String>,
    pub detected_hardware: Vec<&'static str>,
}

impl Default for HardwareProfile {
    fn default() -> Self {
        Self {
            encoder: ENC_X264,
            hevc: None,
            available: vec!["libx264".into()],
            detected_hardware: vec![],
        }
    }
}

/// Argumentos del codificador. Probados ANTES de usarlos (ver `probe_encoder`).
/// NVENC: `-cq` (calidad) + `-b:v/-maxrate/-bufsize` (objetivo de bitrate)
/// medidos empíricamente: honra ambos.
fn encoder_args(choice: &EncoderChoice, crf: u32, bitrate_mbps: u32, caps: &TierCaps) -> Vec<String> {
    // CRF 10/12 para 100/200 Mbps (Ultra); bitrate hasta 400 Mbps.
    let crf = crf.clamp(10, 28);
    let br = bitrate_mbps.clamp(5, 400);
    let mut a: Vec<String> = Vec::new();
    match choice.kind {
        EncoderKind::Nvenc => {
            a.push("-c:v".into());
            a.push(choice.id.into());
            a.push("-preset".into());
            a.push("p5".into());
            a.push("-tune".into());
            a.push("hq".into());
            a.push("-rc".into());
            a.push("vbr".into());
            a.push("-cq".into());
            a.push((crf + 5).clamp(14, 35).to_string());
            a.push("-b:v".into());
            a.push(format!("{br}M"));
            a.push("-maxrate".into());
            a.push(format!("{br}M"));
            a.push("-bufsize".into());
            a.push(format!("{}M", br * 2));
            a.push("-spatial-aq".into());
            a.push("1".into());
        }
        EncoderKind::Qsv => {
            a.push("-c:v".into());
            a.push(choice.id.into());
            a.push("-preset".into());
            a.push("medium".into());
            a.push("-global_quality".into());
            a.push(crf.to_string());
            a.push("-b:v".into());
            a.push(format!("{br}M"));
            a.push("-maxrate".into());
            a.push(format!("{br}M"));
            a.push("-bufsize".into());
            a.push(format!("{}M", br * 2));
        }
        EncoderKind::Amf => {
            // QVBR: objetivo de calidad (más alto = mejor) + bitrate objetivo.
            let level = (40i32 - crf as i32).clamp(5, 30);
            a.push("-c:v".into());
            a.push(choice.id.into());
            a.push("-usage".into());
            a.push("transcoding".into());
            a.push("-rc".into());
            a.push("qvbr".into());
            a.push("-qvbr_quality_level".into());
            a.push(level.to_string());
            a.push("-quality".into());
            a.push("quality".into());
            a.push("-b:v".into());
            a.push(format!("{br}M"));
        }
        EncoderKind::VideoToolbox | EncoderKind::MediaCodec => {
            a.push("-c:v".into());
            a.push(choice.id.into());
            a.push("-b:v".into());
            a.push(format!("{br}M"));
        }
        EncoderKind::X264 => {
            a.push("-c:v".into());
            a.push(choice.id.into());
            a.push("-preset".into());
            a.push(caps.x264_preset.into());
            a.push("-crf".into());
            a.push(crf.to_string());
            a.push("-maxrate".into());
            a.push(format!("{br}M"));
            a.push("-bufsize".into());
            a.push(format!("{}M", br * 2));
            if caps.threads > 0 {
                a.push("-threads".into());
                a.push(caps.threads.to_string());
            }
        }
    }
    // HEVC en MP4: tag hvc1 para máxima compatibilidad (QuickTime/Apple).
    if choice.id.starts_with("hevc") || choice.id == "libx265" {
        a.push("-tag:v".into());
        a.push("hvc1".into());
    }
    a
}

static HW_CACHE: OnceLock<Mutex<Option<HardwareProfile>>> = OnceLock::new();

async fn ffmpeg_lists_encoders() -> Vec<String> {
    let Ok(out) = Command::new("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .await
    else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut v = Vec::new();
    for line in text.lines() {
        if let Some(name) = line.split_whitespace().nth(1) {
            if name.starts_with("h264") || name == "libx264" || name.starts_with("hevc") || name == "libx265" {
                v.push(name.to_string());
            }
        }
    }
    v
}

/// Codificadores de hardware disponibles en la plataforma.
async fn hardware_encoders() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["h264_nvenc", "h264_qsv", "h264_amf", "hevc_nvenc", "hevc_qsv", "hevc_amf"]
    }
    #[cfg(target_os = "macos")]
    {
        vec!["h264_videotoolbox", "hevc_videotoolbox"]
    }
    #[cfg(target_os = "android")]
    {
        vec!["h264_mediacodec", "hevc_mediacodec"]
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "android")))]
    {
        Vec::new()
    }
}

/// Prueba REAL de 4 fotogramas con los argumentos definitivos: si el
/// codificador no puede codificar, se descarta y se prueba el siguiente.
async fn probe_encoder(choice: &EncoderChoice, caps: &TierCaps) -> bool {
    let args = encoder_args(choice, 20, 10, caps);
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error"])
        .args(["-f", "lavfi"])
        .args(["-i", "testsrc2=size=256x144:rate=30:duration=0.2"])
        .args(&args)
        .args(["-f", "null", "-"]);
    match cmd.output().await {
        Ok(o) => o.status.success(),
        Err(_) => false,
    }
}

/// Detecta (una vez) y cachea el mejor codificador disponible.
pub async fn detect_hardware() -> HardwareProfile {
    let cache = HW_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(p) = guard.as_ref() {
            return p.clone();
        }
    }
    let declared = ffmpeg_lists_encoders().await;
    let hw_list = hardware_encoders().await;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let caps = TierCaps {
        max_long_side: 3840,
        max_fps: 60,
        x264_preset: "medium",
        threads: 0,
        filter_threads: 0,
        audio_kbps: 320,
        allow_mci: false,
        mci_max_pixels: 0,
        mci_max_duration_sec: 0.0,
        denoise_max: 100.0,
    };

    let mut chosen = ENC_X264;
    let mut detected: Vec<&'static str> = Vec::new();
    if cores >= 2 && declared.iter().any(|e| e == "libx264") {
        // primero: candidatos de hardware presentes en este FFmpeg.
        // Se prueban en PARALELO con tokio::join! (son independientes entre sí):
        // reduce el tiempo de ~300-900ms secuencial a ~100-300ms paralelo.
        let mut hw_choices: Vec<(&'static str, EncoderChoice)> = Vec::new();
        for name in &hw_list {
            if !declared.iter().any(|d| d == name) {
                continue;
            }
            let choice = match *name {
                "h264_nvenc" => ENC_NVCENC,
                "h264_qsv" => ENC_QSV,
                "h264_amf" => ENC_AMF,
                "h264_videotoolbox" => ENC_VIDEOTOOLBOX,
                "h264_mediacodec" => ENC_MEDIACODEC,
                "hevc_nvenc" => ENC_HEVC_NVENC,
                "hevc_qsv" => ENC_HEVC_QSV,
                "hevc_amf" => ENC_HEVC_AMF,
                "hevc_videotoolbox" => ENC_HEVC_VIDEOTOOLBOX,
                "hevc_mediacodec" => ENC_HEVC_MEDIACODEC,
                _ => continue,
            };
            detected.push(choice.label);
            hw_choices.push((name, choice));
        }
        if !hw_choices.is_empty() {
            // Probar hasta 3 codificadores en paralelo (evita saturar la GPU)
            let chunk_size = 3;
            for chunk in hw_choices.chunks(chunk_size) {
                let mut futures = Vec::new();
                for (_, choice) in chunk {
                    futures.push(probe_encoder(choice, &caps));
                }
                let results = futures::future::join_all(futures).await;
                for (i, ok) in results.iter().enumerate() {
                    if *ok {
                        chosen = chunk[i].1;
                        break;
                    }
                }
                if chosen.hw {
                    break;
                }
            }
        }
        if !chosen.hw && probe_encoder(&ENC_X264, &caps).await {
            chosen = ENC_X264;
        }
    } else {
        detected.push("CPU (x264)");
    }

    // --- Probe HEVC (para 8K, donde H.264 no llega) ---
    let mut hevc_chosen: Option<EncoderChoice> = None;
    {
        let mut hevc_choices: Vec<(&'static str, EncoderChoice)> = Vec::new();
        for name in &hw_list {
            if !declared.iter().any(|d| d == name) {
                continue;
            }
            let choice = match *name {
                "hevc_nvenc" => ENC_HEVC_NVENC,
                "hevc_qsv" => ENC_HEVC_QSV,
                "hevc_amf" => ENC_HEVC_AMF,
                "hevc_videotoolbox" => ENC_HEVC_VIDEOTOOLBOX,
                "hevc_mediacodec" => ENC_HEVC_MEDIACODEC,
                _ => continue,
            };
            hevc_choices.push((name, choice));
        }
        if !hevc_choices.is_empty() {
            let chunk_size = 3;
            for chunk in hevc_choices.chunks(chunk_size) {
                let mut futures = Vec::new();
                for (_, choice) in chunk {
                    futures.push(probe_encoder(choice, &caps));
                }
                let results = futures::future::join_all(futures).await;
                for (i, ok) in results.iter().enumerate() {
                    if *ok {
                        hevc_chosen = Some(chunk[i].1);
                        break;
                    }
                }
                if hevc_chosen.is_some() {
                    break;
                }
            }
        }
        if hevc_chosen.is_none() && declared.iter().any(|e| e == "libx265") {
            if probe_encoder(&ENC_X265, &caps).await {
                hevc_chosen = Some(ENC_X265);
            }
        }
    }

    let profile = HardwareProfile {
        encoder: chosen,
        hevc: hevc_chosen,
        available: declared,
        detected_hardware: detected,
    };
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(profile.clone());
    }
    profile
}

// ---------------------------------------------------------------------------
// Interpolación de fotogramas (REAL, nunca duplicación)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interpolation {
    /// Se conservan los FPS de origen (sin duplicar)
    KeepSource,
    /// `fps=`: normaliza/baja descartando fotogramas (nunca duplica)
    Drop(u32),
    /// `framerate=`: interpolación suave ponderada con detección de cortes
    Smooth(u32),
    /// `minterpolate=`: interpolación compensada por movimiento (real)
    Motion(u32),
}

impl Interpolation {
    pub fn filter(&self) -> Option<String> {
        match *self {
            Interpolation::KeepSource => None,
            Interpolation::Drop(f) => Some(format!("fps={f}")),
            Interpolation::Smooth(f) => Some(format!("framerate=fps={f}:scene=8.2")),
            Interpolation::Motion(f) => Some(format!(
                "minterpolate=fps={f}:mi_mode=mci:mc_mode=aobmc:me_mode=bilat:me=epzs:scd=fdiff:scd_threshold=8"
            )),
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            Interpolation::KeepSource => "FPS de origen (sin duplicar)",
            Interpolation::Drop(_) => "Descarte de FPS (sin duplicar)",
            Interpolation::Smooth(_) => "Interpolación suave",
            Interpolation::Motion(_) => "Interpolación de movimiento",
        }
    }
    /// true si es la interpolación pesada (mci)
    pub fn is_motion(&self) -> bool {
        matches!(self, Interpolation::Motion(_))
    }
}

fn decide_interpolation(
    settings: &RenderSettings,
    caps: &TierCaps,
    source: &SourceInfo,
    target_fps: u32,
    target_pixels: u64,
) -> Interpolation {
    let src = if source.fps > 1.0 { source.fps } else { target_fps as f64 };
    // Bajar o mantener FPS → solo descarte (jamás duplicación)
    if (src - target_fps as f64).abs() < 0.5 || src > target_fps as f64 {
        return Interpolation::Drop(target_fps);
    }
    // Subir FPS
    if !settings.interpolate {
        return Interpolation::KeepSource;
    }
    if caps.allow_mci
        && target_pixels <= caps.mci_max_pixels
        && source.duration_sec <= caps.mci_max_duration_sec
        && target_fps <= 120
    {
        Interpolation::Motion(target_fps)
    } else {
        Interpolation::Smooth(target_fps)
    }
}

// ---------------------------------------------------------------------------
// Registro de super-resolución (preparado para IA real)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Copy)]
pub struct UpscalerBackend {
    pub id: &'static str,
    pub label: &'static str,
    pub is_ai: bool,
}

/// Backends de escalado disponibles. Hoy: Lanczos (clásico).
/// Integrar super-resolución AI = añadir una entrada aquí + su cadena de
/// filtros en `RenderPlan` (el resto del motor no cambia).
pub fn available_upscalers() -> Vec<UpscalerBackend> {
    vec![UpscalerBackend {
        id: "lanczos",
        label: "Lanczos (clásico)",
        is_ai: false,
    }]
}

fn select_upscaler(settings: &RenderSettings, notes: &mut Vec<String>) -> UpscalerBackend {
    let reg = available_upscalers();
    match settings.upscale_mode.as_str() {
        "ai" => {
            if let Some(ai) = reg.iter().find(|b| b.is_ai) {
                *ai
            } else {
                notes.push(
                    "Super-resolución AI no disponible en este dispositivo: se usa Lanczos (mejor alternativa compatible)".into(),
                );
                reg[0]
            }
        }
        _ => {
            // Modo "auto" (toggle ON): honestidad sobre lo que realmente se aplica.
            notes.push(
                "Super-resolución por IA no disponible en este equipo: se usa Lanczos (reinterpolación de detalle — no crea información nueva de la cámara)".into(),
            );
            reg[0]
        }
    }
}

// ---------------------------------------------------------------------------
// Plan de render
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Full,
    NoHwAccel,
    NoHeavyInterpolation,
    CpuEncoder,
    Minimal,
}

#[derive(Debug, Clone)]
pub struct RenderPlan {
    pub source: SourceInfo,
    pub settings: RenderSettings,
    pub target_width: u32,
    pub target_height: u32,
    pub target_fps: u32,
    /// FPS reales de salida (puede ser el de origen si no se interpola)
    pub output_fps: f64,
    pub interpolation: Interpolation,
    pub encoder: EncoderChoice,
    pub caps: TierCaps,
    pub use_hwaccel: bool,
    pub filters: Vec<String>,
    pub min_filters: Vec<String>,
    pub upscaler: UpscalerBackend,
    pub upscaled: bool,
    pub upscale_ratio: f64,
    /// Comando ffmpeg real (se rellena al ejecutar, para mostrarlo en la UI)
    pub command: String,
    pub notes: Vec<String>,
    pub summary: String,
    pub has_audio: bool,
}

fn even_scaled(v: f64) -> u32 {
    let raw = if v < 2.0 || !v.is_finite() { 2u32 } else { v as u32 };
    even_up(raw).max(2)
}

impl RenderPlan {
    fn interpolation_for(&self, variant: Variant) -> Interpolation {
        if variant == Variant::NoHeavyInterpolation && self.interpolation.is_motion() {
            Interpolation::Smooth(self.target_fps)
        } else {
            self.interpolation
        }
    }

    fn encoder_for(&self, variant: Variant) -> EncoderChoice {
        if variant == Variant::CpuEncoder || variant == Variant::Minimal {
            // Si el plan usa HEVC (8K), el fallback CPU es libx265 (H.264 no admite 8K).
            if self.encoder.id.starts_with("hevc") || self.encoder.id == "libx265" {
                ENC_X265
            } else {
                ENC_X264
            }
        } else {
            self.encoder
        }
    }

    fn hwaccel(&self, variant: Variant) -> bool {
        self.use_hwaccel
            && !matches!(variant, Variant::NoHwAccel | Variant::CpuEncoder | Variant::Minimal)
    }

    /// Argumentos COMPLETOS de ffmpeg para una variante de reintento.
    pub fn ffmpeg_args(&self, variant: Variant, input: &Path, output: &Path) -> Vec<String> {
        let mut a: Vec<String> = Vec::new();
        a.push("-hide_banner".into());
        a.push("-nostdin".into());
        a.push("-loglevel".into());
        a.push("error".into());
        a.push("-y".into());
        if self.hwaccel(variant) {
            a.push("-hwaccel".into());
            a.push("auto".into());
        }
        a.push("-i".into());
        a.push(input.to_string_lossy().to_string());

        let enc = self.encoder_for(variant);
        let mut chain: Vec<String> = Vec::new();
        // 1) FPS primero: la interpolación trabaja a resolución de origen
        if let Some(f) = self.interpolation_for(variant).filter() {
            chain.push(f);
        }
        let full_chain = variant != Variant::Minimal;
        if full_chain {
            chain.extend(self.filters.iter().cloned());
        } else {
            chain.extend(self.min_filters.iter().cloned());
        }

        // Bloom del Filtro AE: la cadena ya filtrada se parte, se extraen las
        // luces (umbral 145), se difuminan y se mezclan en `screen` SOLO en la
        // luma (c1/c2 opacity 0 → el croma queda intacto, sin derivas de
        // color). La variante mínima prescinde de él (máxima compatibilidad).
        if self.settings.ae_edit && full_chain {
            let sigma = ae_bloom_sigma(self.target_width, self.target_height);
            // El tope de luma de la Fase 3 (min 235) se extrae de la cadena y
            // se aplica DESPUÉS de la mezcla screen: si quedara antes, el
            // bloom reencendería la imagen por encima del blanco legal y
            // anularía parte del oscurecimiento del grading AE.
            let mut head = chain.clone();
            let cap_pos = head
                .iter()
                .position(|f| f.starts_with("lutyuv=y='min(val,"));
            let cap = match cap_pos {
                Some(i) => format!(",{}", head.remove(i)),
                None => String::new(),
            };
            let graph = format!(
                "[0:v]{chain},split[base][g0];\
                 [g0]lutyuv=y='if(gt(val,{th}),(val-{th})*{gain},0)':u='val':v='val',gblur=sigma={sigma}[glow];\
                 [base][glow]blend=c0_mode=screen:c0_opacity={op}:c1_mode=normal:c1_opacity=0:c2_mode=normal:c2_opacity=0{cap}[vout]",
                chain = head.join(","),
                th = AE_BLOOM_THRESHOLD,
                gain = AE_BLOOM_GAIN,
                sigma = sigma,
                op = AE_BLOOM_OPACITY,
            );
            a.push("-filter_complex".into());
            a.push(graph);
            a.push("-map".into());
            a.push("[vout]".into());
            // Mantiene el audio original aunque la fuente no lo tenga («?»)
            a.push("-map".into());
            a.push("0:a?".into());
        } else {
            a.push("-vf".into());
            a.push(chain.join(","));
        }

        if self.caps.filter_threads > 0 {
            a.push("-filter_threads".into());
            a.push(self.caps.filter_threads.to_string());
        }
        a.extend(encoder_args(&enc, self.settings.crf, self.settings.bitrate_mbps, &self.caps));
        a.push("-pix_fmt".into());
        a.push("yuv420p".into());
        a.push("-movflags".into());
        a.push("+faststart".into());
        // --- FASE 3 · Metadatos BT.709 y GOP fijo de 30 fotogramas ---
        a.push("-color_primaries".into());
        a.push("bt709".into());
        a.push("-color_trc".into());
        a.push("bt709".into());
        a.push("-colorspace".into());
        a.push("bt709".into());
        a.push("-g".into());
        a.push(GOP_FRAMES.to_string());
        // H.264: perfil High y nivel 5.1 (o el mínimo que el fotograma exija)
        let is_h264 = enc.id.starts_with("h264") || enc.id == "libx264";
        if is_h264 {
            a.push("-profile:v".into());
            a.push("high".into());
            a.push("-level:v".into());
            a.push(
                h264_level(self.target_width, self.target_height, self.output_fps).into(),
            );
        }
        if self.has_audio {
            a.push("-c:a".into());
            a.push("aac".into());
            a.push("-b:a".into());
            a.push(format!("{}k", self.caps.audio_kbps));
        }
        a.push("-progress".into());
        a.push("pipe:1".into());
        a.push("-nostats".into());
        a.push(output.to_string_lossy().to_string());
        a
    }

    /// Variantes de reintento: de la ideal a la más compatible
    /// (si una técnica no es viable, se usa la mejor alternativa en vez de fallar).
    pub fn variants(&self) -> Vec<Variant> {
        let mut v = vec![Variant::Full];
        if self.use_hwaccel {
            v.push(Variant::NoHwAccel);
        }
        if self.interpolation.is_motion() {
            v.push(Variant::NoHeavyInterpolation);
        }
        if self.encoder.hw {
            v.push(Variant::CpuEncoder);
        }
        v.push(Variant::Minimal);
        v
    }

    /// Evento inicial de progreso con TODO el plan (resolución, aceleración…).
    pub fn progress_event(&self, phase: &str, label: &str) -> ProgressEvent {
        ProgressEvent {
            phase: phase.into(),
            percent: 0.0,
            frame: 0,
            fps: 0.0,
            eta_seconds: 0.0,
            speed: String::new(),
            label: label.into(),
            target_width: self.target_width,
            target_height: self.target_height,
            target_fps: self.target_fps,
            output_fps: self.output_fps,
            source_width: self.source.width,
            source_height: self.source.height,
            source_fps: self.source.fps,
            encoder: self.encoder.id.into(),
            acceleration: self.encoder.label.into(),
            interpolation: self.interpolation.label().into(),
            summary: self.summary.clone(),
            command: self.command.clone(),
            notes: self.notes.clone(),
            upscaled: self.upscaled,
        }
    }

    /// Comando real que se va a ejecutar (para mostrar en la UI, sin mentir).
    pub fn command_display(&self, input: &Path, output: &Path) -> String {
        let args = self.ffmpeg_args(Variant::Full, input, output);
        let mut s = String::from("ffmpeg");
        for a in &args {
            if a.contains(' ') {
                s.push_str(&format!(" \"{}\"", a));
            } else {
                s.push(' ');
                s.push_str(a);
            }
        }
        s
    }
}

/// Construye el plan completo: dimensiones (con tope de gama), filtros,
/// interpolación, codificador y avisos honestos.
pub fn build_plan(settings: &RenderSettings, source: &SourceInfo, hw: &HardwareProfile) -> RenderPlan {
    let platform = if settings.platform.is_empty() {
        current_platform()
    } else {
        settings.platform.clone()
    };
    let tier = match settings.device_tier.as_str() {
        "low" | "medium" => settings.device_tier.as_str(),
        _ => "high",
    };
    let caps = tier_caps(tier, &platform);

    let mut notes: Vec<String> = Vec::new();

    // --- resolución objetivo (respetando orientación y tope de gama) ---
    let (mut tw, mut th) =
        resolution_dims(&settings.resolution, source.width, source.height, settings.tiktok_preset);
    let base_long = tw.max(th);
    if base_long > caps.max_long_side {
        let k = caps.max_long_side as f64 / base_long as f64;
        tw = even_scaled(tw as f64 * k);
        th = even_scaled(th as f64 * k);
        notes.push(format!(
            "Resolución limitada a {tw}×{th} por la gama del dispositivo (evita sobrecalentamiento)"
        ));
    }

    // --- FPS ---
    let mut target_fps = settings.fps.clamp(24, 120);
    if target_fps > caps.max_fps {
        notes.push(format!(
            "FPS limitados a {} por la gama del dispositivo",
            caps.max_fps
        ));
        target_fps = caps.max_fps;
    }
    let target_pixels = (tw as u64) * (th as u64);
    let interpolation = decide_interpolation(settings, &caps, source, target_fps, target_pixels);
    let output_fps = match interpolation {
        Interpolation::KeepSource => source.fps.max(1.0),
        _ => target_fps as f64,
    };
    if interpolation == Interpolation::KeepSource {
        notes.push(format!(
            "Interpolación desactivada: se conservan {:.0} FPS de origen (sin duplicar fotogramas)",
            source.fps
        ));
    }

    // --- escalado ---
    let upscaler = select_upscaler(settings, &mut notes);
    let ratio = {
        let src_long = source.width.max(source.height).max(1) as f64;
        let dst_long = tw.max(th) as f64;
        (dst_long / src_long).max(1.0)
    };
    let upscaled = ratio > 1.01;
    if upscaled {
        notes.push(format!(
            "Escala {}×{} → {tw}×{th} ({:.0}%): el detalle añadido es reinterpolado, la fuente no aporta resolución real nueva",
            source.width,
            source.height,
            ratio * 100.0
        ));
    }
    if platform == "android" || platform == "ios" {
        notes.push(format!(
            "Perfil móvil: {} hilos de filtro y preset «{}» para evitar sobrecalentamiento y bloqueos",
            caps.filter_threads.max(1),
            caps.x264_preset
        ));
    }

    // --- filtros ---
    let mut filters: Vec<String> = Vec::new();

    // 1) Anti-duplicado: micro-zoom de firma CENTRADO aplicado en resolución de
    //    ORIGEN. Antes se aplicaba al final, reescalando el fotograma ya grande
    //    (4K → 4K×1.015 → recorte): mismo resultado visual, pero ahora sin esa
    //    reescalada completa → una sola interpolación (más nitidez) y mucha
    //    menos CPU/GPU por fotograma.
    let anti_dup_crop = (|| -> Option<String> {
        if !settings.anti_duplicate {
            return None;
        }
        let cw = even_scaled(source.width as f64 / 1.015);
        let ch = even_scaled(source.height as f64 / 1.015);
        if cw < source.width && ch < source.height {
            Some(format!("crop={cw}:{ch}"))
        } else {
            None
        }
    })();
    if let Some(f) = &anti_dup_crop {
        filters.push(f.clone());
    }

    // 2) FASE 1 · Reducción de ruido (antes de escalar y de enfocar: evita
    //    amplificar ruido). El preset activo manda con su perfil EXACTO;
    //    sin preset manda el slider (perfil base 25 % = hqdn3d=1.5:1.5:4:4).
    let pf = settings.preset_filters.as_ref();
    let nr = settings.noise_reduction.min(caps.denoise_max);
    if let Some(d) = pf.and_then(|p| p.denoise) {
        filters.push(format!("hqdn3d={l}:{c}:{lt}:{ct}", l = d[0], c = d[1], lt = d[2], ct = d[3]));
    } else if let Some((ls, cs, lt, ct)) = denoise_levels(nr) {
        filters.push(format!("hqdn3d={ls:.2}:{cs:.2}:{lt:.2}:{ct:.2}"));
    }

    // 2b) Conversión HDR/Dolby Vision → BT.709 (solo si la fuente ES HDR y el
    //     usuario la pidió): linealiza → tonemap Möbius → BT.709. Con una
    //     fuente SDR no se aplica nada (se conserva su color original).
    let hdr_applied = settings.hdr_convert && source.hdr;
    if hdr_applied {
        filters.push(HDR_TO_BT709.to_string());
        notes.push(
            "Fuente HDR (PQ/HLG) detectada: conversión real a BT.709 con tonemap Möbius"
                .into(),
        );
    } else if settings.hdr_convert {
        notes.push(
            "La fuente NO es HDR (transferencia SDR): no hay conversión; se conserva su color y se etiqueta BT.709"
                .into(),
        );
    }

    // --- 3) Exposición: multiplicador seguro 2^(e/100) con e en ±50
    //     (≈±0.5 paradas como máximo). Valores pequeños como +4 equivalen a
    //     ≈+0.04 paradas (+2,8 % de brillo): no recortan las altas luces; el
    //     `clip` final sólo evita salirse del rango 0..255.
    if settings.exposure.abs() > 0.001 {
        let f = exposure_factor(settings.exposure);
        // :u='val':v='val' → la LUT toca SOLO la luma: sin ello, una LUT
        // posterior a `eq` muta el croma (U ±1.0) y deriva el color de salida.
        filters.push(format!("lutyuv=y='clip(val*{f:.4},0,255)':u='val':v='val'"));
    }

    // 4) Curva sombras/luces (trozos 38/128/217)
    if let Some((y15, y85)) = tone_curve(settings.shadows, settings.highlights) {
        let p15 = y15 * 255.0;
        let p85 = y85 * 255.0;
        let k1 = p15 / 38.0;
        let b2 = p15;
        let k2 = (127.5 - p15) / 90.0;
        let k3 = (p85 - 127.5) / 89.0;
        let b4 = p85;
        let k4 = (255.0 - p85) / 38.0;
        filters.push(format!(
            "lutyuv=y='clip(if(lt(val,38),val*{k1:.4},if(lt(val,128),{b2:.4}+(val-38)*{k2:.4},if(lt(val,217),127.5+(val-128)*{k3:.4},{b4:.4}+(val-217)*{k4:.4}))),0,255)':u='val':v='val'"
        ));
    }

    // 5) Ecuación: contraste + brillo + saturación (+ gamma del preset).
    //    Los presets aportan valores EXACTOS (p. ej. Cine Pro Dark pide
    //    contrast=1.18 con gamma 0.92); sin preset se usan los sliders.
    let b_add = pf
        .and_then(|p| p.brightness)
        .unwrap_or_else(|| brightness_add(settings.brightness));
    let contrast = clamp(
        pf.and_then(|p| p.contrast).unwrap_or(settings.contrast),
        0.8,
        1.5,
    );
    let mut saturation = clamp(
        pf.and_then(|p| p.saturation).unwrap_or(settings.saturation),
        0.8,
        1.6,
    );
    if settings.ae_edit {
        // AE Edit: saturación ligeramente reducida (×0.94, recalada a rango)
        saturation = clamp(saturation * AE_SATURATION_MULT, 0.8, 1.6);
    }
    let gamma = pf.and_then(|p| p.gamma);
    let gamma_on = gamma.is_some_and(|g| (g - 1.0).abs() > 0.001);
    if (contrast - 1.0).abs() > 0.001
        || (saturation - 1.0).abs() > 0.001
        || b_add.abs() > 0.0001
        || gamma_on
    {
        let mut eq = format!("eq=contrast={contrast:.3}:brightness={b_add:.4}:saturation={saturation:.3}");
        if let Some(g) = gamma {
            eq.push_str(&format!(":gamma={g:.2}"));
        }
        filters.push(eq);
    }

    // 5b) `colorbalance` EXACTO del preset (Teal & Orange / Neón): sombras,
    //     medios y luces por canal. Es el mismo filtro FFmpeg que usa AE Edit,
    //     pero con los valores del perfil en lugar de los fijos de AE.
    if let Some(p) = pf {
        let mut cb_parts: Vec<String> = Vec::new();
        for (names, vals) in [
            (["rs", "gs", "bs"], p.cb_shadows),
            (["rm", "gm", "bm"], p.cb_mids),
            (["rh", "gh", "bh"], p.cb_highlights),
        ] {
            if let Some(v) = vals {
                for (n, x) in names.iter().zip(v) {
                    cb_parts.push(format!("{n}={x}"));
                }
            }
        }
        if !cb_parts.is_empty() {
            filters.push(format!("colorbalance={}", cb_parts.join(":")));
        }
    }

    // 5c) Unsharp Mask de doble pasada del preset (luma 5×5/3×3 + croma),
    //     p. ej. Topaz unsharp=5:5:0.8:3:3:0.4. Va antes de la claridad y
    //     antes de escalar (igual que el resto del grading).
    if let Some([m, la, cm, ca]) = pf.and_then(|p| p.detail) {
        filters.push(format!("unsharp={m}:{m}:{la}:{cm}:{cm}:{ca}"));
    }

    // 6) Claridad (contraste local, radio grande, fuerza limitada p/ evitar halos)
    let clar = clarity_amount(settings.clarity);
    if clar > 0.0 {
        filters.push(format!("unsharp=13:13:{clar:.4}:5:5:0"));
    }

    // 6b) Filtro AE «AE Edit» — grading cinematográfico REAL (opcional):
    //     curva S (contraste elevado + negros profundos con detalle + medios
    //     más oscuros), split toning frío en sombras / cálido en luces,
    //     detalle suave y viñeta muy sutil. Se aplica ANTES de escalar (como
    //     el resto del grading); el bloom de luces se añade en `ffmpeg_args`.
    if settings.ae_edit {
        filters.push(format!("lutyuv=y='{}':u='val':v='val'", AE_CURVE_LUT));
        filters.push(AE_COLORBALANCE.to_string());
        filters.push(format!("unsharp=5:5:{AE_DETAIL_UNSHARP}:5:5:0"));
        filters.push(format!("vignette=a={AE_VIGNETTE_ANGLE}"));
        // Subexposición premium al FINAL del bloque: nada aguas abajo la
        // compensa (ni colorbalance ni la ventana de recorte) y el fotograma
        // exportado queda más oscuro que la base, como el preview.
        filters.push(format!("eq=brightness={AE_EXPOSURE_OFFSET:.4}"));
    }

    // 7) Escalado de alta calidad
    let flags = if settings.lanczos {
        "lanczos+accurate_rnd+full_chroma_int"
    } else {
        "bicubic+accurate_rnd+full_chroma_int"
    };
    if upscaled && ratio > 1.6 {
        // Dos pasos: reduce el «ringing» del Lanczos en ampliaciones grandes
        let k = 1.0 / ratio.sqrt();
        let mw = even_scaled(tw as f64 * k);
        let mh = even_scaled(th as f64 * k);
        filters.push(format!(
            "scale={mw}:{mh}:force_original_aspect_ratio=increase:flags={flags}"
        ));
        filters.push(format!(
            "scale={tw}:{th}:force_original_aspect_ratio=increase:flags={flags}"
        ));
    } else {
        filters.push(format!(
            "scale={tw}:{th}:force_original_aspect_ratio=increase:flags={flags}"
        ));
    }
    filters.push(format!("crop={tw}:{th}"));

    // 8) FASE 2 · Nitidez CAS adaptativa (perfilado de bordes/textura fina sin
    //    halos; tope duro 0.70 — se reduce al ampliar mucho). El preset puede
    //    exigir un valor EXACTO (p. ej. «4K Topaz Natural» cas=0.70).
    let cas = clamp(
        pf.and_then(|p| p.cas)
            .unwrap_or_else(|| cas_amount(settings.sharpness, ratio)),
        0.0,
        CAS_MAX,
    );
    if cas > 0.0 {
        filters.push(format!("cas={cas:.4}"));
    }

    // 9) FASE 3 · Control de luz: mapa de tonos Möbius (opcional) y limitación
    //    de la luminancia máxima a 1.0 (235 = blanco legal BT.709) para
    //    prevenir luces quemadas. Va DESPUÉS del CAS: cualquier realce que
    //    empuje la luma hacia arriba queda contenido aquí.
    if settings.mobius {
        filters.push(format!(
            "lutyuv=y='if(lt(val,{k:.0}),val,{k:.0}+{s:.0}*(val-{k:.0})/((val-{k:.0})+{s:.0}))':u='val':v='val'",
            k = MOBIUS_KNEE,
            s = MOBIUS_SPAN
        ));
    }
    filters.push(format!(
        "lutyuv=y='min(val,{max:.0})':u='val':v='val'",
        max = LUMA_MAX
    ));

    // 10) FASE 3 · Salida BT.709 REAL (no sólo la etiqueta del contenedor) y
    //     4:2:0 8 bits, igual que piden los presets
    //     (colorspace=all=bt709 + format=yuv420p).
    //     · Si la fuente declara otra norma (p. ej. BT.601) se CONVIERTE.
    //     · Si no declara nada se declara bt709 (identidad comprobada: no
    //       altera ni un solo píxel y evita el error «Unsupported input
    //       primaries» que rompería la exportación).
    //     · Si es HDR y no se pidió convertir, no se fuerza nada.
    if source.hdr && !hdr_applied {
        notes.push(
            "Fuente HDR/BT.2020 sin conversión pedida: se etiqueta BT.709 en la salida (actívala con «HDR Boost 60FPS»)"
                .into(),
        );
    } else {
        let std = color_std_for_filter(if hdr_applied { "bt709" } else { &source.color_primaries });
        filters.push(format!("colorspace=iall={std}:all=bt709:space=bt709"));
    }
    filters.push("format=yuv420p".into());

    // (El micro-zoom anti-duplicado ya se aplicó al inicio, en resolución de
    //  origen — ver paso 1: no hace falta ninguna pasada de escala extra.)

    // Cadena mínima (último recurso si algún filtro opcional no existe)
    let mut min_filters: Vec<String> = Vec::new();
    if let Some(f) = &anti_dup_crop {
        min_filters.push(f.clone());
    }
    min_filters.push(format!(
        "scale={tw}:{th}:force_original_aspect_ratio=increase:flags={flags}"
    ));
    min_filters.push(format!("crop={tw}:{th}"));

    // 8K: H.264 no admite >4K → usar HEVC si está disponible
    let mut encoder = hw.encoder.clone();
    if tw.max(th) > 4096 {
        if let Some(hevc) = &hw.hevc {
            encoder = hevc.clone();
            notes.push(
                "Salida 8K: se usa HEVC/H.265 (H.264 no admite esta resolución en FFmpeg)".into(),
            );
        } else {
            notes.push(
                "FFmpeg sin HEVC: 8K se intentará con H.264 (puede requerir CPU y ser lento)".into(),
            );
        }
    }
    let use_hwaccel = encoder.hw;

    // Diagnóstico honesto de la aceleración realmente disponible
    if !encoder.hw && hw.detected_hardware.iter().any(|l| l.contains("GPU")) {
        notes.push(
            "La aceleración por hardware no pudo utilizarse en este equipo: se recurre a CPU (x264)"
                .into(),
        );
    }
    if !hw.available.is_empty() && !hw.available.iter().any(|e| e == "libx264") {
        notes.push("FFmpeg no incluye libx264: se usará el codificador disponible".into());
    }

    // FASE 3 · Estructura del contenedor (perfil/nivel H.264, GOP fijo, BT.709)
    if encoder.id.starts_with("h264") || encoder.id == "libx264" {
        let lvl = h264_level(tw, th, output_fps);
        if lvl == "5.1" {
            notes.push(
                "H.264 High Profile nivel 5.1 · GOP fijo 30 · BT.709 · faststart".into(),
            );
        } else {
            notes.push(format!(
                "H.264 High Profile nivel {lvl} (el nivel 5.1 no admite {tw}×{th} a {fps:.0} FPS) · GOP fijo 30 · BT.709 · faststart",
                fps = output_fps
            ));
        }
    } else {
        notes.push("GOP fijo 30 · BT.709 · faststart (el perfil/nivel del codificador lo elige HEVC)".into());
    }

    let mut summary_parts: Vec<String> = Vec::new();
    if let Some(d) = pf.and_then(|p| p.denoise) {
        summary_parts.push(format!("denoise {l}:{c}:{lt}:{ct}", l = d[0], c = d[1], lt = d[2], ct = d[3]));
    } else if settings.noise_reduction > 0.0 {
        summary_parts.push(format!("denoise {:.0}%", settings.noise_reduction.min(caps.denoise_max)));
    }
    if settings.exposure.abs() > 0.001 {
        summary_parts.push(format!("exposición {:+.0}", settings.exposure));
    }
    if settings.shadows > 0.0 || settings.highlights > 0.0 {
        summary_parts.push(format!(
            "sombras/luces {:.0}/{:.0}",
            settings.shadows, settings.highlights
        ));
    }
    summary_parts.push(format!("contraste {contrast:.2}x"));
    summary_parts.push(format!("color {saturation:.2}x"));
    if gamma_on {
        summary_parts.push(format!("gamma {:.2}x", gamma.unwrap_or(1.0)));
    }
    if pf.is_some_and(|p| p.cb_shadows.is_some() || p.cb_mids.is_some() || p.cb_highlights.is_some()) {
        summary_parts.push("colorbalance".into());
    }
    if pf.and_then(|p| p.detail).is_some() {
        summary_parts.push("unsharp doble pasada".into());
    }
    if settings.clarity > 0.0 {
        summary_parts.push(format!("claridad {:.0}%", settings.clarity));
    }
    if settings.ae_edit {
        summary_parts.push("AE Edit".into());
    }
    if settings.mobius {
        summary_parts.push("mapa de tonos Möbius".into());
    }
    if settings.hdr_convert && source.hdr {
        summary_parts.push("HDR→BT.709".into());
    }
    summary_parts.push(format!("escala {tw}×{th}"));
    if cas > 0.0 {
        if let Some(c) = pf.and_then(|p| p.cas) {
            summary_parts.push(format!("nitidez CAS {c:.2}"));
        } else {
            summary_parts.push(format!("nitidez CAS {:.0}%", settings.sharpness));
        }
    }
    if let Interpolation::Motion(_) | Interpolation::Smooth(_) = interpolation {
        summary_parts.push(format!("interpolación {target_fps} FPS"));
    }
    if settings.anti_duplicate {
        summary_parts.push("anti-duplicado".into());
    }
    summary_parts.push(format!("escalado {}", upscaler.label));
    summary_parts.push(format!("codificador {}", encoder.label));

    RenderPlan {
        source: source.clone(),
        settings: settings.clone(),
        target_width: tw,
        target_height: th,
        target_fps,
        output_fps,
        interpolation,
        encoder,
        caps,
        use_hwaccel,
        filters,
        min_filters,
        upscaler,
        upscaled,
        upscale_ratio: ratio,
        command: String::new(),
        notes,
        summary: summary_parts.join(" · "),
        has_audio: source.has_audio,
    }
}

pub fn current_platform() -> String {
    if cfg!(target_os = "windows") {
        "windows".into()
    } else if cfg!(target_os = "macos") {
        "macos".into()
    } else if cfg!(target_os = "android") {
        "android".into()
    } else if cfg!(target_os = "ios") {
        "ios".into()
    } else {
        "linux".into()
    }
}

// ---------------------------------------------------------------------------
// Progreso y ejecución
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub phase: String,
    pub percent: f64,
    pub frame: u64,
    pub fps: f64,
    pub eta_seconds: f64,
    pub speed: String,
    pub label: String,
    pub target_width: u32,
    pub target_height: u32,
    pub target_fps: u32,
    pub output_fps: f64,
    pub source_width: u32,
    pub source_height: u32,
    pub source_fps: f64,
    pub encoder: String,
    pub acceleration: String,
    pub interpolation: String,
    pub summary: String,
    pub command: String,
    pub notes: Vec<String>,
    pub upscaled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderReport {
    pub output: String,
    pub elapsed_ms: u64,
    pub frames: u64,
    pub encoder: String,
    pub acceleration: String,
    pub target_width: u32,
    pub target_height: u32,
    pub output_fps: f64,
    pub upscaled: bool,
    pub variant: Variant,
}

impl Serialize for Variant {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            Variant::Full => "full",
            Variant::NoHwAccel => "noHwAccel",
            Variant::NoHeavyInterpolation => "noHeavyInterpolation",
            Variant::CpuEncoder => "cpuEncoder",
            Variant::Minimal => "minimal",
        })
    }
}

async fn run_attempt(
    plan: &RenderPlan,
    variant: Variant,
    input: &Path,
    output: &Path,
    duration: f64,
    on_progress: &mut (dyn FnMut(&ProgressEvent) + Send),
) -> Result<(u64, u64), String> {
    let args = plan.ffmpeg_args(variant, input, output);
    let mut cmd = Command::new("ffmpeg");
    cmd.args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar FFmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("FFmpeg sin salida")?;
    let stderr = child.stderr.take().ok_or("FFmpeg sin error")?;

    // stderr: recolectamos el final para reportar fallos
    let err_task = tokio::spawn(async move {
        let mut tail: Vec<String> = Vec::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tail.push(line);
            if tail.len() > 40 {
                tail.remove(0);
            }
        }
        tail.join("\n")
    });

    let started = Instant::now();
    let mut frames: u64 = 0;
    // El progreso es estado que se ACUMULA: cada línea de `-progress` genera un
    // evento nuevo, y si no se propaga, las líneas `frame=`/`speed=` (que van
    // después de `out_time_ms` en cada bloque) emitirían percent=0 y la UI
    // retrocedería a 0 casi siempre.
    let mut percent: f64 = 0.0;
    let mut last_emit = Instant::now();
    let mut lines = BufReader::new(stdout).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        let mut ev = plan.progress_event("processing", "Procesando filtros ixi 4k…");
        ev.frame = frames;
        ev.percent = percent;
        let mut changed = false;
        // Se emite al CIERRE de cada bloque de `-progress` (línea `speed=`):
        // así el evento lleva ya el frame/out_time/speed COMPLETOS del bloque.
        // Emitir en la primera línea del bloque (`frame=`) hacía que la UI
        // viera estado antiguo (percent=0) en la mayoría de eventos.
        let mut block_end = false;
        if let Some(rest) = line.strip_prefix("frame=") {
            if let Ok(f) = rest.trim().parse::<u64>() {
                frames = f;
                ev.frame = f;
                changed = true;
            }
        } else if let Some(rest) = line.strip_prefix("out_time_ms=") {
            // FFmpeg publica microsegundos pese al nombre del campo
            if let Ok(us) = rest.trim().parse::<i64>() {
                let done = (us as f64 / 1_000_000.0).max(0.0);
                if duration > 0.0 {
                    percent = (done / duration * 100.0).min(99.0).max(0.0);
                    ev.percent = percent;
                }
                changed = true;
            }
        } else if let Some(rest) = line.strip_prefix("speed=") {
            let s = rest.trim().trim_end_matches('x').trim().to_string();
            ev.speed = format!("{s}x");
            if let Ok(v) = s.parse::<f64>() {
                if duration > 0.0 && v > 0.0 {
                    ev.eta_seconds = (duration - duration * (ev.percent / 100.0)) / v;
                }
            }
            changed = true;
            block_end = true;
        } else if line.starts_with("progress=end") {
            percent = 100.0;
            ev.percent = 100.0;
            ev.phase = "finalize".into();
            ev.label = "Optimizando archivo…".into();
            changed = true;
            block_end = true;
        }

        if changed {
            // FPS de codificación reales = fotogramas / tiempo transcurrido
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            ev.fps = frames as f64 / elapsed;
            if duration > 0.0 && ev.fps > 0.0 && ev.percent < 100.0 {
                // ETA = fotogramas restantes / fps de codificación
                let total_frames = duration * plan.output_fps;
                let rest = (total_frames - frames as f64).max(0.0);
                ev.eta_seconds = rest / ev.fps.max(0.001);
            }
            if block_end && (last_emit.elapsed().as_millis() >= 200 || ev.percent >= 100.0) {
                last_emit = Instant::now();
                on_progress(&ev);
            }
        }
    }

    let status = child.wait().await.map_err(|e| format!("FFmpeg: {e}"))?;
    let tail = err_task.await.unwrap_or_default();

    if status.success() {
        Ok((frames, started.elapsed().as_millis() as u64))
    } else if tail.trim().is_empty() {
        Err("FFmpeg finalizó con error (sin detalle)".into())
    } else {
        let short: String = tail
            .lines()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!("FFmpeg: {short}"))
    }
}

/// Ejecuta el plan con progreso real y reintentos de compatibilidad.
pub async fn run_render(
    plan: &RenderPlan,
    input: &Path,
    output: &Path,
    mut on_progress: impl FnMut(&ProgressEvent) + Send,
) -> Result<RenderReport, String> {
    let variants = plan.variants();
    let mut last_err = String::from("Sin intentos disponibles");

    for (i, variant) in variants.iter().enumerate() {
        let is_last = i + 1 == variants.len();
        // El primer intento emite el plan (resolución, aceleración…)
        if i == 0 {
            on_progress(&plan.progress_event("plan", "Analizando vídeo…"));
        }
        let phase = if i == 0 { "processing" } else { "retry" };
        if i > 0 {
            on_progress(&ProgressEvent {
                phase: phase.into(),
                percent: 0.0,
                frame: 0,
                fps: 0.0,
                eta_seconds: 0.0,
                speed: String::new(),
                label: format!(
                    "Reintentando con la mejor alternativa compatible ({}/{})…",
                    i + 1,
                    variants.len()
                ),
                ..plan.progress_event("processing", "")
            });
        }

        match run_attempt(
            plan,
            *variant,
            input,
            output,
            plan.source.duration_sec,
            &mut on_progress,
        )
        .await
        {
            Ok((frames, elapsed_ms)) => {
                let enc = plan.encoder_for(*variant);
                let mut ev = plan.progress_event("done", "¡Completado!");
                ev.percent = 100.0;
                ev.acceleration = enc.label.into();
                ev.encoder = enc.id.into();
                on_progress(&ev);
                return Ok(RenderReport {
                    output: output.to_string_lossy().to_string(),
                    elapsed_ms,
                    frames,
                    encoder: enc.id.into(),
                    acceleration: enc.label.into(),
                    target_width: plan.target_width,
                    target_height: plan.target_height,
                    output_fps: plan.output_fps,
                    upscaled: plan.upscaled,
                    variant: *variant,
                });
            }
            Err(e) => {
                last_err = e;
                if is_last {
                    break;
                }
                // Limpia salida parcial antes de reintentar
                let _ = tokio::fs::remove_file(output).await;
            }
        }
    }
    Err(last_err)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn src(w: u32, h: u32, fps: f64, dur: f64) -> SourceInfo {
        SourceInfo {
            width: w,
            height: h,
            fps,
            duration_sec: dur,
            has_audio: false,
            codec: "h264".into(),
            hdr: false,
            color_primaries: String::new(),
        }
    }

    /// Misma fuente pero declarando transferencia HDR (PQ/HLG).
    fn src_hdr(w: u32, h: u32, fps: f64, dur: f64) -> SourceInfo {
        SourceInfo {
            hdr: true,
            color_primaries: "bt2020".into(),
            ..src(w, h, fps, dur)
        }
    }

    fn hw() -> HardwareProfile {
        HardwareProfile {
            encoder: ENC_X264,
            hevc: None,
            available: vec!["libx264".into()],
            detected_hardware: vec![],
        }
    }

    fn has_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("ixi4k_render_{}_{}", std::process::id(), name));
        p
    }

    // ------------------------- unitarios -------------------------

    #[test]
    fn brightness_defaults_to_identity_not_white() {
        // Regresión: antes eq=brightness=1.0 dejaba la imagen BLANCA (YAVG=255)
        assert_eq!(brightness_add(1.0), 0.0);
        assert!(brightness_add(1.5) <= 0.2 && brightness_add(1.5) > 0.0);
        assert!(brightness_add(0.5) >= -0.2);
    }

    #[test]
    fn resolve_media_path_locates_source_by_name_and_size() {
        let root = std::env::temp_dir().join(format!("ixi4k_resolve_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let sub = root.join("clips");
        std::fs::create_dir_all(&sub).expect("mkdir");
        let target = sub.join("origen.mp4");
        std::fs::write(&target, b"0123456789").expect("write");

        // Solo el nombre (lo único que da la webview) + tamaño → localizado
        let hit = resolve_media_path("origen.mp4", Some(10), std::slice::from_ref(&root))
            .expect("debe localizar el archivo");
        assert_eq!(hit.canonicalize().unwrap(), target.canonicalize().unwrap());

        // Tamaño distinto → NO es el mismo vídeo (nunca procesar otro archivo)
        let err = resolve_media_path("origen.mp4", Some(999), std::slice::from_ref(&root))
            .expect_err("el tamaño no coincide");
        assert!(err.starts_with(MISSING_SOURCE_PREFIX), "{err}");

        // Inexistente → mensaje para abrir el selector nativo (sin fallar a ciegas)
        let err = resolve_media_path("no_existe.mp4", None, std::slice::from_ref(&root))
            .expect_err("no existe");
        assert!(err.starts_with(MISSING_SOURCE_PREFIX), "{err}");

        // Path traversal sigue bloqueado
        assert!(resolve_media_path("../truco.mp4", None, &[]).is_err());

        // Ruta absoluta existente → se usa tal cual (caso normal y de pruebas)
        let abs = resolve_media_path(target.to_str().unwrap(), Some(10), &[]).expect("abs");
        assert_eq!(abs, target.canonicalize().unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tone_curve_is_identity_when_zero() {
        assert!(tone_curve(0.0, 0.0).is_none());
        let (y15, y85) = tone_curve(50.0, 50.0).unwrap();
        assert!(y15 > 0.15, "las sombras deben subir");
        assert!(y85 < 0.85, "las luces deben comprimirse");
    }

    #[test]
    fn denoise_scales_with_percentage() {
        assert!(denoise_levels(0.0).is_none());
        let (l, c, lt, ct) = denoise_levels(35.0).unwrap();
        assert!((l - 2.1).abs() < 0.01);
        assert!((c - 2.1).abs() < 0.01);
        assert!(lt > l && ct > c, "el temporal debe ser mayor que el espacial");
        // Perfil base (nivel 25 %) = exactamente hqdn3d=1.5:1.5:4:4 (FASE 1)
        let (l, c, lt, ct) = denoise_levels(DENOISE_BASE_PERCENT).unwrap();
        assert!((l - 1.5).abs() < 1e-9 && (c - 1.5).abs() < 1e-9);
        assert!((lt - 4.0).abs() < 1e-9 && (ct - 4.0).abs() < 1e-9);
    }

    /// FASE 3 · El tope de luminancia y el mapa Möbius se aplican DESPUÉS del
    /// CAS (el sharpening no puede dejar valores por encima de 1.0).
    #[test]
    fn phase3_light_control_runs_after_cas_and_caps_luma() {
        let s = RenderSettings {
            mobius: true,
            noise_reduction: DENOISE_BASE_PERCENT,
            ..Default::default()
        };
        let plan = build_plan(&s, &src(1080, 1920, 30.0, 10.0), &hw());
        let f = plan.filters.join(",");
        let cas = f.find("cas=").expect("falta CAS");
        let mobius = f.find("if(lt(val,214)").expect("falta el mapa Möbius");
        let cap = f
            .find("lutyuv=y='min(val,235)':u='val':v='val'")
            .expect("falta el tope de luminancia 1.0");
        assert!(cas < mobius && mobius < cap, "orden CAS → Möbius → tope: {f}");
        // El perfil base de la FASE 1 está presente
        assert!(f.contains("hqdn3d=1.50:1.50:4.00:4.00"), "{f}");
        assert!(plan.summary.contains("mapa de tonos Möbius"), "{}", plan.summary);
    }

    /// Sin Möbius, el tope de luminancia sigue aplicándose (FASE 3 siempre).
    #[test]
    fn phase3_caps_luma_even_without_mobius() {
        let plan = build_plan(&RenderSettings::default(), &src(1080, 1920, 30.0, 10.0), &hw());
        let f = plan.filters.join(",");
        assert!(f.contains("lutyuv=y='min(val,235)':u='val':v='val'"), "{f}");
        assert!(!f.contains("214+41*"), "sin Möbius no debe haber rodilla: {f}");
    }

    /// Metadatos: BT.709 + GOP 30 + High@5.1 (o el nivel mínimo válido).
    #[test]
    fn phase3_metadata_faststart_profile_level_and_gop() {
        let plan = build_plan(&RenderSettings::default(), &src(1080, 1920, 30.0, 10.0), &hw());
        let args = plan.ffmpeg_args(Variant::Full, Path::new("in.mp4"), Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("+faststart"));
        assert!(joined.contains("-color_primaries bt709"));
        assert!(joined.contains("-color_trc bt709"));
        assert!(joined.contains("-colorspace bt709"));
        assert!(joined.contains("-g 30"));
        if joined.contains("-c:v libx264") || joined.contains("-c:v h264_") {
            assert!(joined.contains("-profile:v high"), "{joined}");
            assert!(joined.contains("-level:v"), "{joined}");
        }
        // Niveles por tamaño: 1080×1920@30 cabe en 5.1; 4K60 exige 5.2
        assert_eq!(h264_level(1080, 1920, 30.0), "5.1");
        assert_eq!(h264_level(2160, 3840, 60.0), "5.2");
        assert_eq!(h264_level(4320, 7680, 60.0), "6.1");
    }

    /// Los 5 presets de un clic envían sus cadenas EXACTAS al motor FFmpeg
    /// (no aproximaciones de slider): hqdn3d, eq+gamma, colorbalance, unsharp
    /// doble pasada, CAS y salida BT.709/yuv420p.
    #[test]
    fn five_one_click_presets_emit_exact_ffmpeg_chains() {
        let base = |pf: PresetFilters| RenderSettings {
            preset_filters: Some(pf),
            ..Default::default()
        };

        // 1) 4K Topaz Natural — fidelidad limpia (sin gradación, solo mejora)
        let plan = build_plan(
            &base(PresetFilters {
                denoise: Some([1.5, 1.2, 4.0, 3.0]),
                contrast: Some(1.0),
                brightness: Some(0.0),
                saturation: Some(1.0),
                detail: Some([5.0, 0.8, 3.0, 0.4]),
                cas: Some(0.70),
                ..Default::default()
            }),
            &src(1080, 1920, 30.0, 5.0),
            &hw(),
        );
        let f = plan.filters.join(",");
        assert!(f.contains("hqdn3d=1.5:1.2:4:3"), "{f}");
        assert!(f.contains("unsharp=5:5:0.8:3:3:0.4"), "{f}");
        assert!(f.contains("cas=0.7000"), "{f}");
        assert!(!f.contains("eq="), "sin gradación de color: {f}");
        assert!(f.contains("colorspace=iall=bt709:all=bt709:space=bt709"), "{f}");
        assert!(f.ends_with("format=yuv420p"), "{f}");
        assert!(
            plan.summary.contains("denoise 1.5:1.2:4:3"),
            "{}",
            plan.summary
        );

        // 2) AE Edit Pro — Teal & Orange (eq + colorbalance + gamma)
        let plan = build_plan(
            &base(PresetFilters {
                denoise: Some([1.2, 1.2, 3.0, 3.0]),
                contrast: Some(1.12),
                brightness: Some(-0.02),
                saturation: Some(1.10),
                gamma: Some(0.95),
                cb_shadows: Some([-0.05, 0.02, 0.08]),
                cb_mids: Some([0.05, 0.0, -0.04]),
                cas: Some(0.65),
                ..Default::default()
            }),
            &src(1080, 1920, 30.0, 5.0),
            &hw(),
        );
        let f = plan.filters.join(",");
        assert!(f.contains("hqdn3d=1.2:1.2:3:3"), "{f}");
        assert!(
            f.contains("eq=contrast=1.120:brightness=-0.0200:saturation=1.100:gamma=0.95"),
            "{f}"
        );
        assert!(
            f.contains("colorbalance=rs=-0.05:gs=0.02:bs=0.08:rm=0.05:gm=0:bm=-0.04"),
            "{f}"
        );
        assert!(f.contains("cas=0.6500"), "{f}");

        // 3) Cine Pro Dark — contraste profundo + gamma + mapa de tonos Möbius
        let plan = build_plan(
            &RenderSettings {
                mobius: true,
                ..base(PresetFilters {
                    denoise: Some([1.8, 1.5, 4.0, 3.0]),
                    contrast: Some(1.18),
                    brightness: Some(-0.03),
                    saturation: Some(0.95),
                    gamma: Some(0.92),
                    cas: Some(0.55),
                    ..Default::default()
                })
            },
            &src(1080, 1920, 30.0, 5.0),
            &hw(),
        );
        let f = plan.filters.join(",");
        assert!(f.contains("hqdn3d=1.8:1.5:4:3"), "{f}");
        assert!(
            f.contains("eq=contrast=1.180:brightness=-0.0300:saturation=0.950:gamma=0.92"),
            "{f}"
        );
        assert!(f.contains("if(lt(val,214)"), "rodilla Möbius: {f}");
        assert!(f.contains("cas=0.5500"), "{f}");

        // 4) HDR Boost 60FPS — rango dinámico + nitidez doble + fluidez
        let plan = build_plan(
            &base(PresetFilters {
                denoise: Some([1.0, 1.0, 2.0, 2.0]),
                contrast: Some(1.10),
                brightness: Some(0.01),
                saturation: Some(1.15),
                gamma: Some(1.02),
                detail: Some([3.0, 0.6, 3.0, 0.3]),
                cas: Some(0.50),
                ..Default::default()
            }),
            &src(1080, 1920, 30.0, 5.0),
            &hw(),
        );
        let f = plan.filters.join(",");
        assert!(f.contains("hqdn3d=1:1:2:2"), "{f}");
        assert!(
            f.contains("eq=contrast=1.100:brightness=0.0100:saturation=1.150:gamma=1.02"),
            "{f}"
        );
        assert!(f.contains("unsharp=3:3:0.6:3:3:0.3"), "{f}");
        assert!(f.contains("cas=0.5000"), "{f}");

        // 5) Neón Cyberpunk — solo sombras teñidas (sin medios/luces)
        let plan = build_plan(
            &base(PresetFilters {
                denoise: Some([1.2, 1.2, 3.0, 3.0]),
                contrast: Some(1.15),
                brightness: Some(0.0),
                saturation: Some(1.25),
                gamma: Some(0.94),
                cb_shadows: Some([-0.08, 0.04, 0.12]),
                cas: Some(0.60),
                ..Default::default()
            }),
            &src(1080, 1920, 30.0, 5.0),
            &hw(),
        );
        let f = plan.filters.join(",");
        assert!(f.contains("hqdn3d=1.2:1.2:3:3"), "{f}");
        assert!(
            f.contains("eq=contrast=1.150:brightness=0.0000:saturation=1.250:gamma=0.94"),
            "{f}"
        );
        assert!(f.contains("colorbalance=rs=-0.08:gs=0.04:bs=0.12"), "{f}");
        assert!(!f.contains("rm="), "sin medios: {f}");
        assert!(f.contains("cas=0.6000"), "{f}");
    }

    /// La salida es SIEMPRE BT.709 + 4:2:0: conversión real si la fuente
    /// declara otra norma, identidad si no declara nada (sin romper) y sin
    /// forzar nada si es HDR y no se pidió convertir.
    #[test]
    fn output_colorspace_and_format_stage_is_last_and_safe() {
        let plan = build_plan(
            &RenderSettings::default(),
            &src(1080, 1920, 30.0, 5.0),
            &hw(),
        );
        let f = plan.filters.join(",");
        assert!(f.contains("colorspace=iall=bt709:all=bt709:space=bt709"), "{f}");
        assert!(f.ends_with("format=yuv420p"), "{f}");
        // Orden de fases: denoise → gradación → escala → CAS → luz → color →4:2:0
        let d = f.find("hqdn3d").unwrap();
        let sc = f.find("scale=").unwrap();
        let cas = f.find("cas=").unwrap();
        let cap = f.rfind("min(val,235)").unwrap();
        let cs = f.find("colorspace=").unwrap();
        assert!(d < sc && sc < cas && cas < cap && cap < cs, "{f}");

        // Fuente que declara BT.601 → conversión REAL a BT.709
        let mut s601 = src(720, 576, 25.0, 5.0);
        s601.color_primaries = "smpte170m".into();
        let plan601 = build_plan(&RenderSettings::default(), &s601, &hw());
        let f601 = plan601.filters.join(",");
        assert!(
            f601.contains("colorspace=iall=smpte170m:all=bt709:space=bt709"),
            "{f601}"
        );

        // Fuente HDR sin conversión pedida: no se fuerza nada; se avisa
        let mut sh = src(1920, 1080, 30.0, 5.0);
        sh.hdr = true;
        sh.color_primaries = "bt2020".into();
        let plan_hdr = build_plan(&RenderSettings::default(), &sh, &hw());
        let f_hdr = plan_hdr.filters.join(",");
        assert!(!f_hdr.contains("colorspace="), "{f_hdr}");
        assert!(f_hdr.ends_with("format=yuv420p"), "{f_hdr}");
        assert!(
            plan_hdr.notes.iter().any(|n| n.contains("sin conversión")),
            "falta el aviso honesto: {:?}",
            plan_hdr.notes
        );
    }

    /// Conversión HDR → BT.709: solo con la opción Y solo si la fuente ES HDR.
    #[test]
    fn hdr_conversion_only_runs_for_real_hdr_sources() {
        let s = RenderSettings {
            hdr_convert: true,
            ..Default::default()
        };
        let plan = build_plan(&s, &src_hdr(1920, 1080, 30.0, 5.0), &hw());
        let f = plan.filters.join(",");
        assert!(f.contains("tonemap=mobius"), "{f}");
        assert!(f.contains("zscale=transfer=bt709"), "{f}");
        assert!(
            plan.notes.iter().any(|n| n.contains("Fuente HDR")),
            "falta el aviso de conversión: {:?}",
            plan.notes
        );
        // Fuente SDR: NO se convierte (se conserva su color)
        let plan_sdr = build_plan(&s, &src(1920, 1080, 30.0, 5.0), &hw());
        let f_sdr = plan_sdr.filters.join(",");
        assert!(!f_sdr.contains("tonemap"), "{f_sdr}");
        assert!(
            plan_sdr.notes.iter().any(|n| n.contains("NO es HDR")),
            "falta el aviso honesto SDR: {:?}",
            plan_sdr.notes
        );
    }

    #[test]
    fn cas_is_capped_and_reduced_when_upscaling() {
        let base = cas_amount(200.0, 1.0);
        assert!(base <= CAS_MAX + 1e-9);
        let up = cas_amount(200.0, 3.0);
        assert!(up < base, "al ampliar×3 la nitidez debe reducirse");
        assert_eq!(cas_amount(0.0, 2.0), 0.0);
    }

    #[test]
    fn exposure_is_half_stop_at_50() {
        let f = exposure_factor(50.0);
        assert!((f - 2f64.powf(0.5)).abs() < 1e-9);
        assert!((exposure_factor(0.0) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn resolution_orientation_matches_source_unless_tiktok() {
        // apaisado sin preset TikTok → 4K apaisado (no recorta a vertical)
        assert_eq!(resolution_dims("4K UHD", 1920, 1080, false), (3840, 2160));
        // con preset TikTok → siempre 9:16
        assert_eq!(resolution_dims("4K UHD", 1920, 1080, true), (2160, 3840));
        // vertical → 9:16 aunque no haya preset
        assert_eq!(resolution_dims("1080p", 1080, 1920, false), (1080, 1920));
        assert_eq!(resolution_dims("2K", 720, 1280, false), (1440, 2560));
    }

    #[test]
    fn low_tier_caps_are_constrained() {
        let caps = tier_caps("low", "windows");
        assert_eq!(caps.max_long_side, 1920);
        assert_eq!(caps.max_fps, 30);
        assert!(!caps.allow_mci);
        let hi = tier_caps("high", "windows");
        assert_eq!(hi.max_long_side, 7680);
        assert!(hi.allow_mci);
        // móvil: menos hilos y sin interpolación pesada
        let mob = tier_caps("high", "android");
        assert!(mob.threads <= 4 && mob.filter_threads <= 2);
        assert!(!mob.allow_mci);
        assert_ne!(mob.x264_preset, "slow");
    }

    #[test]
    fn plan_caps_resolution_on_low_tier() {
        let s = RenderSettings {
            device_tier: "low".into(),
            platform: "android".into(),
            ..Default::default()
        };
        let plan = build_plan(&s, &src(720, 1280, 30.0, 10.0), &hw());
        assert!(plan.target_width.max(plan.target_height) <= 1920);
        assert_eq!(plan.target_fps, 30);
        // preserva la orientación vertical
        assert!(plan.target_height > plan.target_width);
    }

    #[test]
    fn plan_uses_landscape_4k_for_landscape_source() {
        let s = RenderSettings {
            tiktok_preset: false,
            ..Default::default()
        };
        let plan = build_plan(&s, &src(1920, 1080, 30.0, 10.0), &hw());
        assert_eq!((plan.target_width, plan.target_height), (3840, 2160));
        assert!(plan.upscaled);
        assert!(plan
            .notes
            .iter()
            .any(|n| n.contains("reinterpolado")), "aviso honesto de escalado");
    }

    #[test]
    fn interpolation_never_duplicates_frames() {
        let caps = tier_caps("high", "windows");
        let s = RenderSettings::default();
        // subir 30 → 60 en 1080p: interpolación de movimiento
        let i = decide_interpolation(&s, &caps, &src(1080, 1920, 30.0, 60.0), 60, 2_073_600);
        assert!(matches!(i, Interpolation::Motion(60)), "{i:?}");
        // subir a 4K (píxeles > techo MCI): alternativa suave
        let i4k = decide_interpolation(&s, &caps, &src(1080, 1920, 30.0, 60.0), 60, 8_294_400);
        assert!(matches!(i4k, Interpolation::Smooth(60)), "{i4k:?}");
        // bajar 60 → 30: descarte
        let i2 = decide_interpolation(&s, &caps, &src(1080, 1920, 60.0, 60.0), 30, 2_073_600);
        assert!(matches!(i2, Interpolation::Drop(30)), "{i2:?}");
        // interpolación desactivada: conserva origen (no duplica)
        let s2 = RenderSettings {
            interpolate: false,
            ..Default::default()
        };
        let i3 = decide_interpolation(&s2, &caps, &src(1080, 1920, 30.0, 60.0), 60, 2_073_600);
        assert!(matches!(i3, Interpolation::KeepSource), "{i3:?}");
    }

    #[test]
    fn plan_filter_chain_has_all_stages_in_order() {
        let s = RenderSettings {
            noise_reduction: 40.0,
            exposure: 10.0,
            shadows: 30.0,
            highlights: 30.0,
            clarity: 50.0,
            sharpness: 120.0,
            ..Default::default()
        };
        let plan = build_plan(&s, &src(1080, 1920, 30.0, 10.0), &hw());
        let f = plan.filters.join(",");
        // El micro-zoom anti-duplicado es el PRIMER filtro: se recorta el origen
        // antes de cualquier procesado (evita una pasada de escala extra al final).
        let zoom = f.find("crop=").expect("falta crop anti-duplicado inicial");
        let denoise = f.find("hqdn3d=").unwrap_or_else(|| panic!("falta hqdn3d en {f}"));
        assert!(zoom < denoise, "el zoom inicial debe ir antes de hqdn3d");
        let order = [
            "hqdn3d=",
            "lutyuv=y='clip(val*",
            "lutyuv=y='clip(if(",
            "eq=",
            "unsharp=13:13:",
            "scale=",
            "cas=",
        ];
        let mut last = 0;
        for pat in order {
            let pos = f.find(pat).unwrap_or_else(|| panic!("falta {pat} en {f}"));
            assert!(pos >= last, "orden incorrecto: {pat}");
            last = pos;
        }
        // El recorte a resolución objetivo va DESPUÉS del scale (el último crop)
        let final_crop = f.rfind("crop=").expect("falta crop final");
        let scale = f.find("scale=").expect("falta scale en {f}");
        assert!(final_crop > scale, "crop final antes de scale");
    }

    #[test]
    fn plan_contains_no_duplication_output_flags() {
        // Nunca forzamos -r (duplicaría frames); el FPS lo controlan los filtros
        let s = RenderSettings::default();
        let plan = build_plan(&s, &src(1080, 1920, 30.0, 10.0), &hw());
        let args = plan.ffmpeg_args(Variant::Full, Path::new("in.mp4"), Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(!joined.contains("-r 60") && !joined.contains("-r 30"));
        assert!(joined.contains("+faststart"));
        assert!(joined.contains("-pix_fmt yuv420p"));
        assert!(joined.contains("-progress pipe:1"));
        // el FPS lo controlan los filtros (nunca -r, que duplicaría frames)
        assert!(
            joined.contains("minterpolate=")
                || joined.contains("framerate=")
                || joined.contains("-vf fps=")
                || joined.contains(",fps=")
        );
    }

    #[test]
    fn ae_edit_applies_the_cinematic_chain_and_bloom_graph() {
        let s = RenderSettings {
            ae_edit: true,
            ..Default::default()
        };
        let plan = build_plan(&s, &src(1080, 1920, 30.0, 10.0), &hw());
        let f = plan.filters.join(",");
        // Gradación AE real, ANTES de escalar
        assert!(
            f.contains("lutyuv=y='clip(if(lt(val,46)"),
            "falta la curva S de AE en {f}"
        );
        assert!(f.contains(AE_COLORBALANCE), "falta el split toning de AE en {f}");
        assert!(f.contains("unsharp=5:5:0.18:5:5:0"), "falta el detalle suave en {f}");
        assert!(f.contains("vignette=a=0.22"), "falta la viñeta en {f}");
        // Subexposición premium: tras la viñeta, al final del bloque AE
        assert!(
            f.contains("eq=brightness=-0.0200"),
            "falta la subexposición AE en {f}"
        );
        let cb = f.find(AE_COLORBALANCE).unwrap();
        assert!(cb < f.find("scale=").unwrap(), "el grading va antes de escalar");
        assert!(plan.summary.contains("AE Edit"), "resumen: {}", plan.summary);
        // Saturación efectiva ×0.94 (1.10 → 1.03), espejo de describeRenderPlan
        assert!(plan.summary.contains("color 1.03x"), "resumen: {}", plan.summary);

        // El comando real usa el grafo split/blend para el bloom y mapea audio
        let j = plan
            .ffmpeg_args(Variant::Full, Path::new("in.mp4"), Path::new("out.mp4"))
            .join(" ");
        assert!(j.contains("-filter_complex"), "falta el grafo AE en {j}");
        assert!(j.contains("gblur=sigma="), "falta el blur del bloom en {j}");
        assert!(j.contains("c0_mode=screen"), "falta el screen en luma en {j}");
        assert!(j.contains("c0_opacity=0.14"), "opacidad del bloom en {j}");
        assert!(
            j.contains("c1_opacity=0") && j.contains("c2_opacity=0"),
            "el croma no debe mezclarse: {j}"
        );
        assert!(j.contains("[vout]") && j.contains("0:a?"), "mapeo vídeo+audio: {j}");

        // La variante mínima prescinde del bloom (compatibilidad) pero no roba
        // el resto de filtros del pipeline principal
        let min = plan
            .ffmpeg_args(Variant::Minimal, Path::new("in.mp4"), Path::new("out.mp4"))
            .join(" ");
        assert!(!min.contains("-filter_complex"), "{min}");
        assert!(min.contains("-vf "), "{min}");
        assert!(!plan.min_filters.iter().any(|x| x.contains("colorbalance")));
    }

    #[test]
    fn ae_edit_off_keeps_the_original_pipeline_untouched() {
        let plan = build_plan(&RenderSettings::default(), &src(1080, 1920, 30.0, 10.0), &hw());
        let f = plan.filters.join(",");
        assert!(!f.contains("colorbalance"), "{f}");
        assert!(!f.contains("vignette"), "{f}");
        assert!(!f.contains("clip(if(lt(val,46)"), "{f}");
        assert!(!plan.summary.contains("AE Edit"), "{}", plan.summary);
        // Saturación sin AE intacta
        assert!(plan.summary.contains("color 1.10x"), "{}", plan.summary);
        let j = plan
            .ffmpeg_args(Variant::Full, Path::new("in.mp4"), Path::new("out.mp4"))
            .join(" ");
        assert!(!j.contains("-filter_complex"), "{j}");
        assert!(j.contains("-vf "), "{j}");
    }

    #[test]
    fn ai_upscale_falls_back_to_lanczos_instead_of_failing() {
        let s = RenderSettings {
            upscale_mode: "ai".into(),
            ..Default::default()
        };
        let plan = build_plan(&s, &src(720, 1280, 30.0, 5.0), &hw());
        assert!(!plan.upscaler.is_ai);
        assert!(plan.notes.iter().any(|n| n.contains("AI no disponible")));
        assert!(plan.filters.iter().any(|f| f.contains("flags=lanczos")));
    }

    #[test]
    fn hardware_profile_defaults_to_cpu_encoder() {
        let p = hw();
        assert!(!p.encoder.hw);
        assert_eq!(p.encoder.id, "libx264");
        assert!(p.available.iter().any(|e| e == "libx264"));
        // registro de super-resolución: solo clásico por ahora (IA = futuro)
        let reg = available_upscalers();
        assert_eq!(reg[0].id, "lanczos");
        assert!(!reg[0].is_ai);
    }

    #[test]
    fn plan_exposes_upscale_ratio_and_honest_notes() {
        let s = RenderSettings {
            tiktok_preset: false,
            ..Default::default()
        };
        let plan = build_plan(&s, &src(1280, 720, 30.0, 5.0), &hw());
        // 1280×720 → 3840×2160 = ×3
        assert!((plan.upscale_ratio - 3.0).abs() < 0.01, "{}", plan.upscale_ratio);
        assert!(plan.notes.iter().any(|n| n.contains("%")));
    }

    // ---------------------- ULTRA: 8K / 120 FPS / 100-200 Mbps ----------------------

    #[test]
    fn resolution_dims_8k_uhd() {
        // Landscape (source 1920×1080): 7680×4320
        let dims = resolution_dims("8K UHD", 1920, 1080, false);
        assert_eq!(dims, (7680, 4320));
        // Portrait (source 1080×1920): 4320×7680
        let dims_p = resolution_dims("8K UHD", 1080, 1920, false);
        assert_eq!(dims_p, (4320, 7680));
    }

    #[test]
    fn tier_caps_high_allows_8k_120() {
        let caps = tier_caps("high", "windows");
        assert_eq!(caps.max_long_side, 7680);
        assert_eq!(caps.max_fps, 120);
    }

    #[test]
    fn tier_caps_mobile_caps_at_4k_60() {
        let caps = tier_caps("high", "android");
        assert!(caps.max_long_side <= 3840);
        assert!(caps.max_fps <= 60);
    }

    #[test]
    fn encoder_args_ultra_bitrate_and_crf() {
        let caps = tier_caps("high", "windows");
        let args = encoder_args(&ENC_X264, 10, 200, &caps);
        let j = args.join(" ");
        assert!(j.contains("-crf 10"), "{j}");
        // X264 usa -crf + -maxrate (no -b:v); el bitrate 200M se refleja en maxrate
        assert!(j.contains("-maxrate 200M"), "{j}");
        assert!(j.contains("-bufsize 400M"), "{j}");
    }

    #[test]
    fn interpolation_30_to_120_motion_at_1080p() {
        let s = RenderSettings {
            interpolate: true,
            fps: 120,
            ..Default::default()
        };
        let source = src(1920, 1080, 30.0, 10.0);
        let caps = tier_caps("high", "windows");
        let interp = decide_interpolation(&s, &caps, &source, 120, 1920 * 1080);
        assert!(matches!(interp, Interpolation::Motion(120)), "{:?}", interp);
    }

    #[test]
    fn interpolation_4k_to_120_falls_back_to_smooth() {
        let s = RenderSettings {
            interpolate: true,
            fps: 120,
            ..Default::default()
        };
        let source = src(3840, 2160, 30.0, 10.0);
        let caps = tier_caps("high", "windows");
        let interp = decide_interpolation(&s, &caps, &source, 120, 3840 * 2160);
        assert!(matches!(interp, Interpolation::Smooth(120)), "{:?}", interp);
    }

    #[test]
    fn plan_8k_uses_hevc_when_available() {
        let s = RenderSettings {
            resolution: "8K UHD".into(),
            ..Default::default()
        };
        // Source portrait (1080×1920) → 8K portrait = 4320×7680
        let source = src(1080, 1920, 30.0, 10.0);
        let mut h = hw();
        h.hevc = Some(ENC_X265);
        let plan = build_plan(&s, &source, &h);
        assert_eq!(plan.target_width, 4320);
        assert_eq!(plan.target_height, 7680);
        assert_eq!(plan.encoder.id, "libx265");
        assert!(plan.notes.iter().any(|n| n.contains("HEVC")));
    }

    #[test]
    fn select_upscaler_auto_notes_honest_fallback() {
        let mut notes = Vec::new();
        let s = RenderSettings {
            upscale_mode: "auto".into(),
            ..Default::default()
        };
        let up = select_upscaler(&s, &mut notes);
        assert!(!up.is_ai);
        assert!(notes.iter().any(|n| n.contains("IA no disponible")));
    }

    // ---------------------- integración (FFmpeg) ----------------------
    // Si el entorno no tiene FFmpeg, se omiten (no fallan).

    async fn make_source(path: &Path, w: u32, h: u32, fps: u32, secs: u32, audio: bool) {
        let mut cmd = tokio::process::Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error"])
            .args(["-f", "lavfi", "-i"])
            .arg(format!(
                "testsrc2=size={w}x{h}:rate={fps}:duration={secs}"
            ));
        if audio {
            cmd.args(["-f", "lavfi"]).args(["-i", &format!("sine=frequency=440:duration={secs}")]);
        }
        cmd.args(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "20"]);
        if audio {
            cmd.args(["-c:a", "aac", "-shortest"]);
        }
        cmd.arg("-y").arg(path);
        let out = cmd.output().await.expect("ffmpeg");
        assert!(
            out.status.success(),
            "no se pudo crear el vídeo de prueba: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    async fn ffprobe_json(path: &Path) -> serde_json::Value {
        let out = tokio::process::Command::new("ffprobe")
            .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"])
            .arg(path)
            .output()
            .await
            .expect("ffprobe");
        serde_json::from_slice(&out.stdout).expect("json")
    }

    /// CRC por fotograma para detectar frames idénticos consecutivos
    /// (es decir, DUPLICACIÓN de fotogramas — prohibida por el diseño).
    async fn frame_hashes(path: &Path) -> Vec<String> {
        let out = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args(["-map", "0:v", "-f", "framecrc", "-"])
            .output()
            .await
            .expect("framecrc");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.split(',').nth(5).map(|s| s.trim().to_string()))
            .collect()
    }

    /// Energía de detalle (media de |imagen - imagen_difuminada|) en gris.
    /// Se calcula a resolución nativa (ambos ficheros comparten dimensiones).
    async fn detail_metric(path: &Path) -> f64 {
        let out = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "info", "-i"])
            .arg(path)
            .args([
                "-filter_complex",
                "[0:v]format=gray,boxblur=2:2[b];[0:v]format=gray[g];[b][g]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
            ])
            .args(["-frames:v", "1", "-f", "null", "-"])
            .output()
            .await
            .expect("metric");
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        text.lines()
            .find_map(|l| l.split("YAVG=").nth(1).and_then(|v| v.trim().parse::<f64>().ok()))
            .unwrap_or(-1.0)
    }

    /// Luma media del primer fotograma (detecta salida blanca/negra).
    async fn first_frame_luma(path: &Path) -> f64 {
        let out = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "info", "-i"])
            .arg(path)
            .args([
                "-vf",
                "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ])
            .output()
            .await
            .expect("luma");
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        text.lines()
            .find_map(|l| l.split("YAVG=").nth(1).and_then(|v| v.trim().parse::<f64>().ok()))
            .unwrap_or(-1.0)
    }

    /// Saturación media (SATAVG) del primer fotograma (detecta el ×0.94 real).
    async fn first_frame_sat(path: &Path) -> f64 {
        let out = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "info", "-i"])
            .arg(path)
            .args([
                "-vf",
                "signalstats,metadata=print:key=lavfi.signalstats.SATAVG:file=-",
                "-frames:v",
                "1",
                "-f",
                "null",
                "-",
            ])
            .output()
            .await
            .expect("sat");
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        text.lines()
            .find_map(|l| l.split("SATAVG=").nth(1).and_then(|v| v.trim().parse::<f64>().ok()))
            .unwrap_or(-1.0)
    }
    fn uses_faststart(path: &Path) -> bool {
        // faststart = «moov» aparece ANTES de «mdat»
        let Ok(bytes) = std::fs::read(path) else {
            return false;
        };
        let mut i = 0usize;
        let mut seen_moov = false;
        while i + 8 <= bytes.len() {
            let size = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
            let kind = &bytes[i + 4..i + 8];
            if kind == b"moov" {
                seen_moov = true;
                break;
            }
            if kind == b"mdat" {
                break;
            }
            if size < 8 {
                break;
            }
            i += size;
        }
        seen_moov
    }

    #[tokio::test]
    async fn real_export_applies_settings_and_reports_progress() {
        if !has_ffmpeg() {
            eprintln!("OMITIDO: sin FFmpeg en este entorno");
            return;
        }
        let input = tmp("in_land.mp4");
        let output = tmp("out_land.mp4");
        let _ = std::fs::remove_file(&output);
        make_source(&input, 640, 360, 30, 3, true).await;

        let source = probe_source(&input).await.expect("probe");
        assert_eq!(source.width, 640);
        assert!(source.has_audio);

        let settings = RenderSettings {
            resolution: "1080p".into(),
            fps: 30,
            tiktok_preset: false,
            device_tier: "high".into(),
            platform: current_platform(),
            noise_reduction: 30.0,
            contrast: 1.3,
            saturation: 1.4,
            brightness: 1.05,
            clarity: 40.0,
            sharpness: 130.0,
            shadows: 25.0,
            highlights: 25.0,
            exposure: 5.0,
            ..Default::default()
        };
        let hw_prof = detect_hardware().await;
        assert!(!hw_prof.available.is_empty(), "se debe poder listar codificadores");
        assert!(
            !hw_prof.detected_hardware.is_empty() || !hw_prof.encoder.hw,
            "sin GPU el codificador debe ser CPU"
        );
        let plan = build_plan(&settings, &source, &hw_prof);

        let mut events: Vec<ProgressEvent> = Vec::new();
        let report = {
            let plan_ref = &plan;
            run_render(plan_ref, &input, &output, |ev| events.push(ev.clone()))
                .await
                .expect("export")
        };

        // --- progreso real ---
        assert!(events.len() >= 3, "debe emitir varios eventos de progreso");
        assert_eq!(events[0].phase, "plan");
        assert!(events[0].target_width > 0 && !events[0].acceleration.is_empty());
        assert!(events[0].summary.contains("contraste"));
        let last = events.last().unwrap();
        assert_eq!(last.phase, "done");
        assert_eq!(last.percent, 100.0);
        let percents: Vec<f64> = events.iter().map(|e| e.percent).collect();
        assert!(percents.windows(2).all(|w| w[1] >= w[0] - 1e-6), "porcentaje monótono");
        // Regresión: el % debe propagarse entre líneas de `-progress` (antes,
        // las líneas `frame=`/`speed=` emitían percent=0 y la UI se quedaba en 0)
        assert!(
            events
                .iter()
                .any(|e| e.phase == "processing" && e.percent > 0.0 && e.percent < 100.0),
            "debe emitir progreso intermedio real (0<p<100)"
        );
        assert!(events.iter().any(|e| e.fps > 0.0), "debe informar FPS reales");
        assert!(events.iter().any(|e| e.eta_seconds >= 0.0));

        // --- salida válida ---
        assert!(output.exists());
        assert!(report.frames > 0);
        let meta = ffprobe_json(&output).await;
        let v = &meta["streams"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["codec_type"] == "video")
            .unwrap();
        assert_eq!(v["width"].as_u64().unwrap(), 1920);
        assert_eq!(v["height"].as_u64().unwrap(), 1080);
        assert_eq!(v["pix_fmt"].as_str().unwrap(), "yuv420p");
        let avg = v["avg_frame_rate"].as_str().unwrap();
        assert_eq!(avg, "30/1", "fps de salida: {avg}");
        assert!(uses_faststart(&output), "faststart para subidas sociales");
        let dur: f64 = meta["format"]["duration"].as_str().unwrap().parse().unwrap();
        assert!((dur - 3.0).abs() < 0.35, "duración preservada: {dur}");

        // --- los ajustes AFECTAN al vídeo ---
        let luma = first_frame_luma(&output).await;
        assert!(luma > 5.0 && luma < 250.0, "sin salida blanca/negra (YAVG={luma})");
        let neutral = tmp("out_neutral.mp4");
        let _ = std::fs::remove_file(&neutral);
        let s2 = RenderSettings {
            resolution: "1080p".into(),
            fps: 30,
            tiktok_preset: false,
            device_tier: "high".into(),
            platform: current_platform(),
            noise_reduction: 0.0,
            clarity: 0.0,
            sharpness: 0.0,
            exposure: 0.0,
            shadows: 0.0,
            highlights: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            brightness: 1.0,
            anti_duplicate: false,
            ..Default::default()
        };
        let plan2 = build_plan(&s2, &source, &hw_prof);
        run_render(&plan2, &input, &neutral, |_| {}).await.expect("neutral");
        // el procesado debe diferir del neutral (contraste/saturación/nitidez reales)
        let d_proc = detail_metric(&output).await;
        let d_neutral = detail_metric(&neutral).await;
        assert!(d_proc > 0.0 && d_neutral > 0.0);
        assert!(
            (d_proc - d_neutral).abs() / d_neutral.max(0.001) > 0.02,
            "los ajustes deben cambiar la imagen (proc={d_proc:.4} neutral={d_neutral:.4})"
        );

        // --- sin frames duplicados ---
        let hashes = frame_hashes(&output).await;
        assert!(hashes.len() >= 80, "≈3s × 30fps: {}", hashes.len());
        let dupes = hashes.windows(2).filter(|w| w[0] == w[1]).count();
        assert_eq!(dupes, 0, "{dupes} fotogramas duplicados consecutivos");

        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_file(&neutral);
    }

    #[tokio::test]
    async fn real_export_ae_edit_changes_the_look_and_keeps_the_source() {
        if !has_ffmpeg() {
            eprintln!("OMITIDO: sin FFmpeg en este entorno");
            return;
        }
        let input = tmp("in_ae.mp4");
        let out_base = tmp("out_ae_off.mp4");
        let out_ae = tmp("out_ae_on.mp4");
        let _ = std::fs::remove_file(&out_base);
        let _ = std::fs::remove_file(&out_ae);
        make_source(&input, 640, 360, 30, 3, true).await;

        let source = probe_source(&input).await.expect("probe");
        let hw_prof = detect_hardware().await;
        let base = RenderSettings {
            resolution: "1080p".into(),
            fps: 30,
            tiktok_preset: false,
            device_tier: "high".into(),
            platform: current_platform(),
            noise_reduction: 0.0,
            clarity: 0.0,
            sharpness: 0.0,
            exposure: 0.0,
            shadows: 0.0,
            highlights: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            brightness: 1.0,
            anti_duplicate: false,
            ..Default::default()
        };
        let ae = RenderSettings {
            ae_edit: true,
            ..base.clone()
        };
        run_render(&build_plan(&base, &source, &hw_prof), &input, &out_base, |_| {})
            .await
            .expect("sin AE");
        run_render(&build_plan(&ae, &source, &hw_prof), &input, &out_ae, |_| {})
            .await
            .expect("con AE");

        // --- el Filtro AE cambia REALMENTE los píxeles ---
        // Misma exportación base, pero con AE: más oscura (curva S + viñeta)
        // y menos saturada (eq saturation ×0.94).
        let luma_base = first_frame_luma(&out_base).await;
        let luma_ae = first_frame_luma(&out_ae).await;
        assert!(luma_ae > 5.0 && luma_ae < 250.0, "sin salida blanca/negra (YAVG={luma_ae})");
        assert!(
            luma_ae < luma_base,
            "AE debe oscurecer el grading: {luma_ae} >= {luma_base}"
        );
        let sat_base = first_frame_sat(&out_base).await;
        let sat_ae = first_frame_sat(&out_ae).await;
        assert!(sat_ae > 0.0 && sat_base > 0.0, "SATAVG ilegible: {sat_ae} / {sat_base}");
        assert!(
            sat_ae < sat_base,
            "AE debe reducir la saturación: {sat_ae} >= {sat_base}"
        );

        // --- duración, FPS y AUDIO intactos aunque el comando use filter_complex ---
        let meta = ffprobe_json(&out_ae).await;
        let dur: f64 = meta["format"]["duration"].as_str().unwrap().parse().unwrap();
        assert!((dur - 3.0).abs() < 0.35, "duración preservada: {dur}");
        let streams = meta["streams"].as_array().unwrap();
        assert!(
            streams.iter().any(|s| s["codec_type"] == "audio"),
            "el audio debe conservarse con el grafo AE"
        );
        let v = streams.iter().find(|s| s["codec_type"] == "video").unwrap();
        assert_eq!(v["width"].as_u64().unwrap(), 1920);
        assert_eq!(v["avg_frame_rate"].as_str().unwrap(), "30/1");

        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&out_base);
        let _ = std::fs::remove_file(&out_ae);
    }

    #[tokio::test]
    async fn real_export_interpolates_30_to_60_without_duplicates() {
        if !has_ffmpeg() {
            eprintln!("OMITIDO: sin FFmpeg en este entorno");
            return;
        }
        let input = tmp("in_30.mp4");
        let output = tmp("out_60.mp4");
        let _ = std::fs::remove_file(&output);
        make_source(&input, 360, 640, 30, 2, false).await;

        let source = probe_source(&input).await.unwrap();
        let settings = RenderSettings {
            fps: 60,
            resolution: "1080p".into(),
            tiktok_preset: true,
            interpolate: true,
            device_tier: "high".into(),
            platform: current_platform(),
            ..Default::default()
        };
        let hw_prof = detect_hardware().await;
        let plan = build_plan(&settings, &source, &hw_prof);
        // 360×640 → 1080×1920 (2073600 px ≤ techo MCI) ⇒ interpolación real
        assert!(matches!(plan.interpolation, Interpolation::Motion(60)), "{:?}", plan.interpolation);

        run_render(&plan, &input, &output, |_| {}).await.expect("export");

        let meta = ffprobe_json(&output).await;
        let v = meta["streams"].as_array().unwrap().iter()
            .find(|s| s["codec_type"] == "video").unwrap();
        assert_eq!(v["width"].as_u64().unwrap(), 1080);
        assert_eq!(v["height"].as_u64().unwrap(), 1920);
        assert_eq!(v["avg_frame_rate"].as_str().unwrap(), "60/1");

        let hashes = frame_hashes(&output).await;
        // 2 s × 60 fps = 120 (± margen); NUNCA la mitad (eso sería frames duplicados/omitidos)
        assert!(
            hashes.len() >= 110 && hashes.len() <= 126,
            "se esperaban ≈120 frames, hay {}",
            hashes.len()
        );
        let dupes = hashes.windows(2).filter(|w| w[0] == w[1]).count();
        assert_eq!(dupes, 0, "{dupes} frames idénticos consecutivos = duplicación");

        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
    }

    #[tokio::test]
    async fn real_export_mobile_profile_respects_caps() {
        if !has_ffmpeg() {
            eprintln!("OMITIDO: sin FFmpeg en este entorno");
            return;
        }
        let input = tmp("in_mob.mp4");
        let output = tmp("out_mob.mp4");
        let _ = std::fs::remove_file(&output);
        make_source(&input, 720, 1280, 60, 2, false).await;

        let source = probe_source(&input).await.unwrap();
        let settings = RenderSettings {
            resolution: "4K UHD".into(),
            fps: 60,
            tiktok_preset: true,
            device_tier: "low".into(),
            platform: "android".into(),
            sharpness: 150.0,
            noise_reduction: 60.0,
            ..Default::default()
        };
        let hw_prof = detect_hardware().await;
        let plan = build_plan(&settings, &source, &hw_prof);

        // tope de gama baja + móvil
        assert!(plan.target_width.max(plan.target_height) <= 1920);
        assert_eq!(plan.target_fps, 30);
        assert!(plan.notes.iter().any(|n| n.contains("Resolución limitada")));
        assert!(plan.notes.iter().any(|n| n.contains("FPS limitados")));
        assert!(!plan.caps.allow_mci, "sin interpolación pesada en móvil");
        assert!(plan.caps.filter_threads <= 2);

        run_render(&plan, &input, &output, |_| {}).await.expect("export móvil");

        let meta = ffprobe_json(&output).await;
        let v = meta["streams"].as_array().unwrap().iter()
            .find(|s| s["codec_type"] == "video").unwrap();
        let w = v["width"].as_u64().unwrap() as u32;
        let h = v["height"].as_u64().unwrap() as u32;
        assert!(w.max(h) <= 1920, "gama baja debe salir ≤1080p: {w}x{h}");
        assert_eq!(v["avg_frame_rate"].as_str().unwrap(), "30/1");
        // sin duplicación: 2 s × 30 fps
        let hashes = frame_hashes(&output).await;
        assert!(hashes.len() >= 55 && hashes.len() <= 66, "{} frames", hashes.len());
        let dupes = hashes.windows(2).filter(|w| w[0] == w[1]).count();
        assert_eq!(dupes, 0);

        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
    }

    #[tokio::test]
    async fn sharpness_setting_changes_the_pixels() {
        if !has_ffmpeg() {
            eprintln!("OMITIDO: sin FFmpeg en este entorno");
            return;
        }
        let input = tmp("in_sharp.mp4");
        make_source(&input, 480, 480, 24, 1, false).await;
        let source = probe_source(&input).await.unwrap();
        let hw_prof = detect_hardware().await;

        let mk = |sharp: f64| RenderSettings {
            resolution: "1080p".into(),
            tiktok_preset: false,
            device_tier: "high".into(),
            platform: current_platform(),
            sharpness: sharp,
            contrast: 1.0,
            saturation: 1.0,
            brightness: 1.0,
            noise_reduction: 0.0,
            clarity: 0.0,
            exposure: 0.0,
            shadows: 0.0,
            highlights: 0.0,
            anti_duplicate: false,
            ..Default::default()
        };

        let off = tmp("sharp_off.mp4");
        let on = tmp("sharp_on.mp4");
        let _ = std::fs::remove_file(&off);
        let _ = std::fs::remove_file(&on);
        run_render(&build_plan(&mk(0.0), &source, &hw_prof), &input, &off, |_| {})
            .await
            .expect("off");
        run_render(&build_plan(&mk(150.0), &source, &hw_prof), &input, &on, |_| {})
            .await
            .expect("on");

        let d_off = detail_metric(&off).await;
        let d_on = detail_metric(&on).await;
        assert!(d_off > 0.0 && d_on > 0.0, "métricas válidas: {d_off} / {d_on}");
        assert!(
            d_on > d_off * 1.02,
            "nitidez 150% debe añadir detalle medible: off={d_off:.4} on={d_on:.4}"
        );

        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&off);
        let _ = std::fs::remove_file(&on);
    }

    #[tokio::test]
    async fn export_falls_back_instead_of_failing_on_bad_encoder_args() {
        // plan construido con el codificador disponible; las variantes de
        // reintento deben existir siempre (full → … → minimal)
        let s = RenderSettings::default();
        let source = src(640, 360, 30.0, 1.0);
        let plan = build_plan(&s, &source, &hw());
        let v = plan.variants();
        assert_eq!(v.first(), Some(&Variant::Full));
        assert_eq!(v.last(), Some(&Variant::Minimal));
        assert!(v.contains(&Variant::Minimal));
        // todas las variantes generan argumentos válidos
        for var in &v {
            let args = plan.ffmpeg_args(*var, Path::new("in.mp4"), Path::new("out.mp4"));
            assert!(args.contains(&"-i".to_string()));
            assert!(args.contains(&"-vf".to_string()));
            assert!(args.contains(&"libx264".to_string()));
        }
    }
}
