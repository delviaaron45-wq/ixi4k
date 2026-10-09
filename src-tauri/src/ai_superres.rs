//! ===========================================================================
//! Super-resolución IA local — Real-ESRGAN (ncnn · Vulkan)
//! ===========================================================================
//! Motor REAL de mejora por redes neuronales (no son filtros FFmpeg disfrazados):
//!
//!   · Modelo : Real-ESRGAN (xinntao) — código y pesos incluidos en la build
//!              oficial ncnn, licencia MIT/BSD-3, coste 0 € y sin servidores:
//!              TODO ocurre en la GPU del propio usuario.
//!   · Runtime: realesrgan-ncnn-vulkan.exe (Vulkan) → funciona con GPU
//!              NVIDIA/AMD/Intel sin instalar CUDA ni PyTorch.
//!   · Instalación: se descarga UNA vez (45 MB) desde la release OFICIAL de
//!              GitHub, se verifica SHA-256 y se descomprime en
//!              %LOCALAPPDATA%\ixi4k\ai — nunca dentro del repositorio.
//!
//! PIPELINE (por chunks, memoria acotada):
//!
//!   ffmpeg#1 ──decodifica + grading previo──► RGB crudo (resolución origen)
//!        └─► PNG por chunk ─► Real-ESRGAN (GPU) ─► PNG(s) ─► ffmpeg#2
//!   ffmpeg#2 ──image2pipe + filtros finales + codificador + audio del original─► salida
//!
//!   · Audio: se coge SIEMPRE del original (mismo códec/timeline que la ruta
//!     clásica) → sincronía intacta.
//!   · Duración/FPS: el decodificador emite exactamente los fotogramas que
//!     produce el plan (incluida la interpolación) → mismos FPS de salida.
//!   · Memoria: `chunk_frames()` limita el tamaño del chunk según RAM y disco
//!     libres; el tiling de ncnn acota la VRAM (-t).
//!   · Sin GPU Vulkan o sin motor instalado → el plan vuelve a Lanczos con un
//!     aviso honesto (nunca se finge IA ni se aborta el export).
//!
//! Requisitos verificados antes de tocar nada: Vulkan (vulkan-1.dll), ≥2 GB
//! RAM libres y ≥500 MB de disco. Si no se cumplen, NO se descarga nada.
//! ===========================================================================

use crate::render::{Interpolation, ProgressEvent, RenderPlan};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

// ---------------------------------------------------------------------------
// Parámetros del motor oficial (release fijada por hash → anti-tampering)
// ---------------------------------------------------------------------------
pub const ENGINE_VERSION: &str = "20220424";
pub const ENGINE_URL: &str =
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip";
/// SHA-256 del ZIP oficial (verificado en cada instalación).
pub const ENGINE_SHA256: &str = "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d";
pub const ENGINE_BYTES: u64 = 45_474_481;

const ENGINE_EXE: &str = "realesrgan-ncnn-vulkan.exe";
const MODEL_DEFAULT: &str = "realesrgan-x4plus";
const MODEL_VIDEO: &str = "realesr-animevideov3";
const MODEL_ANIME: &str = "realesrgan-x4plus-anime";
/// Modelo que identifica una instalación completa.
const MODEL_SENTINEL: &str = "realesrgan-x4plus.param";

// Requisitos mínimos (se comprueban ANTES de descargar)
const MIN_RAM_MB: u64 = 2048;
const MIN_DISK_MB: u64 = 500;

// ---------------------------------------------------------------------------
// Rutas de instalación (fuera del repositorio, por usuario)
// ---------------------------------------------------------------------------
pub fn ai_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("ixi4k")
        .join("ai")
}

pub fn engine_dir() -> PathBuf {
    ai_root().join("engine")
}

pub fn engine_exe() -> PathBuf {
    engine_dir().join(ENGINE_EXE)
}

pub fn models_dir() -> PathBuf {
    engine_dir().join("models")
}

pub fn work_root() -> PathBuf {
    ai_root().join("work")
}

// ---------------------------------------------------------------------------
// Funciones de sistema (Windows sin crates adicionales; otros SO → sin datos)
// ---------------------------------------------------------------------------
#[cfg(windows)]
mod win {
    #[repr(C)]
    #[derive(Default)]
    pub struct MemoryStatusEx {
        pub dw_length: u32,
        pub dw_memory_load: u32,
        pub ull_total_phys: u64,
        pub ull_avail_phys: u64,
        pub ull_total_page_file: u64,
        pub ull_avail_page_file: u64,
        pub ull_total_virtual: u64,
        pub ull_avail_virtual: u64,
        pub ull_avail_extended_virtual: u64,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
        pub fn GetDiskFreeSpaceExW(
            dir: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }
}

/// RAM total (MB). 0 = desconocido.
#[allow(dead_code)]
pub fn ram_total_mb() -> u64 {
    #[cfg(windows)]
    {
        use win::MemoryStatusEx;
        let mut m = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            ..Default::default()
        };
        unsafe {
            if win::GlobalMemoryStatusEx(&mut m) == 0 {
                return 0;
            }
            m.ull_total_phys / (1024 * 1024)
        }
    }
    #[cfg(not(windows))]
    0
}

/// RAM disponible ahora mismo (MB). 0 = desconocido.
#[allow(dead_code)]
pub fn ram_free_mb() -> u64 {
    #[cfg(windows)]
    {
        use win::MemoryStatusEx;
        let mut m = MemoryStatusEx {
            dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
            ..Default::default()
        };
        unsafe {
            if win::GlobalMemoryStatusEx(&mut m) == 0 {
                return 0;
            }
            m.ull_avail_phys / (1024 * 1024)
        }
    }
    #[cfg(not(windows))]
    0
}

/// Espacio libre (MB) en la unidad que contiene `path`.
pub fn free_disk_mb(path: &Path) -> u64 {
    #[cfg(windows)]
    {
        let mut wide: Vec<u16> = path.to_string_lossy().encode_utf16().collect();
        wide.push(0);
        let mut free: u64 = 0;
        unsafe {
            if win::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
                == 0
            {
                return 0;
            }
        }
        free / (1024 * 1024)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        0
    }
}

fn vulkan_loader_present() -> bool {
    #[cfg(windows)]
    {
        let windir =
            std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
        Path::new(&windir)
            .join("System32")
            .join("vulkan-1.dll")
            .exists()
    }
    #[cfg(not(windows))]
    true
}

// ---------------------------------------------------------------------------
// Sondeo de GPU (cacheado: nvidia-smi tarda ~150 ms)
// ---------------------------------------------------------------------------
#[derive(Debug, Default, Clone)]
struct GpuInfo {
    name: Option<String>,
    vram_mb: Option<u64>,
}

static GPU: OnceLock<GpuInfo> = OnceLock::new();

fn gpu_info() -> &'static GpuInfo {
    GPU.get_or_init(|| {
        let out = std::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ])
            .output();
        match out {
            Ok(o) if o.status.success() => {
                let line = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if line.is_empty() {
                    return GpuInfo::default();
                }
                // "NVIDIA GeForce RTX 5060 Ti, 16311" → el número va al final
                let (name, mem) = line.rsplit_once(',').unwrap_or((&line, ""));
                GpuInfo {
                    name: Some(name.trim().to_string()),
                    vram_mb: mem.trim().parse::<u64>().ok(),
                }
            }
            _ => GpuInfo::default(),
        }
    })
}

// ---------------------------------------------------------------------------
// Capacidad (estado honesto para la UI y para el plan de render)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCapability {
    /// Motor instalado + requisitos cumplidos → se puede ejecutar la IA
    pub available: bool,
    /// ¿El motor ya está descargado e instalado?
    pub installed: bool,
    /// ¿Se PUEDE instalar ahora (requisitos verificados)? Si false, no se
    /// descarga nada.
    pub can_install: bool,
    /// Motivo honesto del bloqueo (si lo hay)
    pub reason: Option<String>,
    /// "vulkan" | "none"
    pub backend: String,
    pub gpu_name: Option<String>,
    pub vram_mb: Option<u64>,
    pub ram_free_mb: u64,
    pub disk_free_mb: u64,
    pub engine_version: String,
    pub engine_bytes: u64,
    pub engine_sha256: String,
    pub models: Vec<String>,
}

fn installed_marker() -> bool {
    engine_exe().is_file() && models_dir().join(MODEL_SENTINEL).is_file()
}

/// Lista de modelos realmente instalados (param/*.param).
pub fn installed_models() -> Vec<String> {
    let dir = models_dir();
    let mut v = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("param") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    v.push(stem.to_string());
                }
            }
        }
    }
    v.sort();
    v
}

/// Estado completo del motor IA (se llama desde la UI y desde el plan).
pub fn capability() -> AiCapability {
    let installed = installed_marker();
    let vulkan = vulkan_loader_present();
    let ram = ram_free_mb();
    let disk = free_disk_mb(&ai_root());
    let g = gpu_info();

    // can_install: se verifica ANTES de descargar nada
    let install_blocker = if cfg!(not(windows)) {
        Some("La super-resolución IA local sólo está disponible en Windows (v1)".into())
    } else if !vulkan {
        Some("Sin Vulkan (vulkan-1.dll): GPU no compatible con el motor IA".into())
    } else if ram != 0 && ram < MIN_RAM_MB {
        Some(format!("RAM libre insuficiente ({ram} MB; mínimo {MIN_RAM_MB} MB)"))
    } else if disk != 0 && disk < MIN_DISK_MB {
        Some(format!("Disco libre insuficiente ({disk} MB; mínimo {MIN_DISK_MB} MB)"))
    } else {
        None
    };

    let (installed_final, reason) = if installed {
        if let Some(b) = &install_blocker {
            (true, Some(b.clone()))
        } else {
            (true, None)
        }
    } else {
        (
            false,
            Some(
                install_blocker
                    .clone()
                    .unwrap_or_else(|| format!("Motor IA no instalado (descarga oficial {ENGINE_BYTES} B)")),
            ),
        )
    };

    AiCapability {
        available: installed_final && reason.is_none(),
        installed,
        can_install: install_blocker.is_none(),
        reason: if installed_final && reason.is_none() {
            None
        } else {
            reason
        },
        backend: if vulkan { "vulkan".into() } else { "none".into() },
        gpu_name: g.name.clone(),
        vram_mb: g.vram_mb,
        ram_free_mb: ram,
        disk_free_mb: disk,
        engine_version: ENGINE_VERSION.into(),
        engine_bytes: ENGINE_BYTES,
        engine_sha256: ENGINE_SHA256.into(),
        models: installed_models(),
    }
}

/// ¿Listo para ejecutar IA? (lo consulta `build_plan` de render)
pub fn is_engine_ready() -> bool {
    capability().available
}

/// Motivo (honesto) por el que la IA no está disponible ahora mismo.
pub fn unavailable_reason() -> String {
    let c = capability();
    c.reason.unwrap_or_else(|| "error desconocido".into())
}

// ---------------------------------------------------------------------------
// Requisitos + instalación (descarga oficial con verificación SHA-256)
// ---------------------------------------------------------------------------
fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

fn download_engine_bytes(progress: &dyn Fn(u8)) -> Result<Vec<u8>, String> {
    let mut resp = ureq::get(ENGINE_URL)
        .call()
        .map_err(|e| format!("No se pudo descargar el motor IA: {e}"))?;
    progress(35);
    let bytes = resp
        .body_mut()
        .with_config()
        .limit(128 * 1024 * 1024) // por encima de los 45 MB oficiales
        .read_to_vec()
        .map_err(|e| format!("Lectura de la descarga fallida: {e}"))?;
    if bytes.len() as u64 != ENGINE_BYTES {
        return Err(format!(
            "Descarga incompleta ({} de {ENGINE_BYTES} bytes)",
            bytes.len()
        ));
    }
    Ok(bytes)
}

fn extract_engine(bytes: &[u8]) -> Result<(), String> {
    let dest = engine_dir();
    if dest.exists() {
        std::fs::remove_dir_all(&dest).map_err(|e| format!("Limpieza previa: {e}"))?;
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("Creando {dest:?}: {e}"))?;

    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("ZIP inválido: {e}"))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("ZIP entrada {i}: {e}"))?;
        let rel = match file.enclosed_name() {
            Some(p) => p,
            None => continue, // ruta relativa sospechosa → se ignora
        };
        let out = dest.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("Creando {out:?}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Creando {parent:?}: {e}"))?;
        }
        let mut dst = std::fs::File::create(&out).map_err(|e| format!("Escribiendo {out:?}: {e}"))?;
        std::io::copy(&mut file, &mut dst).map_err(|e| format!("Extrayendo {out:?}: {e}"))?;
    }
    Ok(())
}

/// Instala el motor oficial (idempotente). Verifica requisitos ANTES de
/// descargar y el SHA-256 del paquete DESPUÉS. `progress` recibe 0..100.
pub async fn install_engine(progress: Arc<dyn Fn(u8) + Send + Sync>) -> Result<AiCapability, String> {
    let report: &(dyn Fn(u8) + Send + Sync) = progress.as_ref();
    let cap = capability();
    if cap.available {
        report(100);
        return Ok(cap);
    }
    if !cap.can_install {
        return Err(format!(
            "Requisitos no cumplidos: {}",
            cap.reason.unwrap_or_else(|| "desconocido".into())
        ));
    }

    report(5);
    let bytes = {
        let p = progress.clone();
        tokio::task::spawn_blocking(move || download_engine_bytes(p.as_ref()))
            .await
            .map_err(|e| format!("Tarea de descarga: {e}"))??
    };

    report(80);
    let hash = sha256_hex(&bytes);
    if hash != ENGINE_SHA256 {
        return Err(format!(
            "SHA-256 no coincide (obtenido {hash}): paquete oficial corrupto o manipulado"
        ));
    }

    report(88);
    tokio::task::spawn_blocking(move || extract_engine(&bytes))
        .await
        .map_err(|e| format!("Tarea de extracción: {e}"))??;

    report(97);
    let cap = capability();
    if !cap.installed {
        return Err("La extracción terminó sin instalar el motor (falta el modelo)".into());
    }
    report(100);
    Ok(cap)
}

// ---------------------------------------------------------------------------
// Selección de modelo / escala / tiling (con criterio medible)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone)]
pub struct AiRunConfig {
    pub model: String,
    /// Escala nativa pedida a la red: 2 | 3 | 4
    pub scale: u32,
    /// Tamaño de tesela (0 = automático): acota la VRAM en GPUs modestas
    pub tile: u32,
    pub gpu_id: i32,
    /// hilos load:proc:save
    pub jobs: String,
}

/// Escala nativa más cercana al ratio pedido (2..4). El reescalado final (si
/// hace falta) lo resuelve la cadena de filtros de salida, no la red.
pub fn nearest_scale(ratio: f64) -> u32 {
    if !ratio.is_finite() || ratio < 2.0 {
        2
    } else if ratio > 4.0 {
        4
    } else {
        ratio.round() as u32
    }
}

/// Tiling por VRAM: GPUs con poca memoria usan teselas más pequeñas (la
/// memoria de la red por tesela es constante → nunca se sale de la VRAM).
pub fn tile_for_vram(vram_mb: Option<u64>) -> u32 {
    match vram_mb {
        Some(v) if v >= 8192 => 0,  // automático (GPU holgada)
        Some(v) if v >= 4096 => 256,
        Some(v) if v >= 2048 => 192,
        Some(_) => 128,             // VRAM desconocida o muy justa
        None => 0,                  // sin dato → automático (ncnn ajusta)
    }
}

/// Modelo + escala para un plan. `pref` = "" | "auto" (por defecto),
/// "x4plus" (vídeo real, mejor detalle), "animevideov3" (ligero, entrenado
/// sobre vídeo) o "x4plus-anime".
///
/// REGLA DE ORO (medida en esta máquina, no supuesta): el binario oficial
/// sólo va bien cuando `-s` coincide con la escala NATIVA del modelo:
///   · `realesrgan-x4plus` (-s 4, nativo)      → 29.4 dB contra la entrada
///   · `realesrgan-x4plus` (-s 2, NO nativo)   → 15.3 dB → TESELAS CORRUPTAS
///   · `realesr-animevideov3` (-s 2/3/4, nativos) → 30.2 / 30.4 dB
/// Por eso la política es SIEMPRE elegir el modelo nativo de la escala:
///   · escala 2 ó 3 → `animevideov3` (tiene ficheros x2 y x3; además es el
///     modelo entrenado sobre VÍDEO → menos parpadeo entre fotogramas)
///   · escala 4     → `x4plus` (el modelo general ×4 nativo, más fiel en
///     fotografía/rodaje real)
///   · VRAM < 2 GB  → `animevideov3` a la escala que toque (1,2 MB frente a
///     33 MB: mucha menos memoria y más rápido)
/// Si el usuario pide explícitamente "photo" (x4plus), la escala se fija en 4
/// (su escala nativa) y el codificador reduce después al objetivo.
pub fn pick_model_and_scale(pref: &str, vram_mb: Option<u64>, ratio: f64) -> (String, u32) {
    let scale = nearest_scale(ratio);
    let low_vram = matches!(vram_mb, Some(v) if v < 2048);
    match pref {
        "animevideov3" | "anime" => (MODEL_VIDEO.to_string(), scale),
        "x4plus" | "photo" => (MODEL_DEFAULT.to_string(), 4),
        "x4plus-anime" => (MODEL_ANIME.to_string(), 4),
        // auto | ""
        _ => {
            if low_vram || scale < 4 {
                (MODEL_VIDEO.to_string(), scale)
            } else {
                (MODEL_DEFAULT.to_string(), scale)
            }
        }
    }
}

pub fn plan_run(plan: &RenderPlan) -> AiRunConfig {
    let g = gpu_info();
    let (model, scale) = pick_model_and_scale(&plan.settings.ai_model, g.vram_mb, plan.upscale_ratio);
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    AiRunConfig {
        model,
        scale,
        tile: tile_for_vram(g.vram_mb),
        gpu_id: 0,
        jobs: format!("1:{}:2", (cores / 2).clamp(1, 4)),
    }
}

/// Argumentos EXACTOS del binario oficial (misma CLI que su README).
pub fn engine_args(cfg: &AiRunConfig, input: &Path, output: &Path) -> Vec<String> {
    vec![
        "-i".into(),
        input.to_string_lossy().into_owned(),
        "-o".into(),
        output.to_string_lossy().into_owned(),
        "-n".into(),
        cfg.model.clone(),
        "-s".into(),
        cfg.scale.to_string(),
        "-t".into(),
        cfg.tile.to_string(),
        "-g".into(),
        cfg.gpu_id.to_string(),
        "-j".into(),
        cfg.jobs.clone(),
        "-f".into(),
        "png".into(),
        "-m".into(),
        models_dir().to_string_lossy().into_owned(),
    ]
}

/// Comando completo (para mostrarlo en la UI sin mentir).
pub fn engine_command_display(cfg: &AiRunConfig, input: &Path, output: &Path) -> String {
    let mut s = String::from(ENGINE_EXE);
    for a in engine_args(cfg, input, output) {
        if a.contains(' ') {
            s.push_str(&format!(" \"{a}\""));
        } else {
            s.push(' ');
            s.push_str(&a);
        }
    }
    s
}

// ---------------------------------------------------------------------------
// Gestión de memoria: tamaño de chunk según RAM y disco libres
// ---------------------------------------------------------------------------
/// Fotogramas que se procesan por lote. Presupuesto = min(30 % RAM libre,
/// 20 % disco libre, 1.5 GiB); cada fotograma consume su crudo + su PNG de
/// entrada + su PNG de salida estimado (~40 % del crudo ampliado).
pub fn chunk_frames(
    src_w: u32,
    src_h: u32,
    scale: u32,
    free_ram_mb: u64,
    free_disk_mb: u64,
) -> usize {
    let in_raw = src_w as u64 * src_h as u64 * 3;
    let out_raw = (src_w as u64 * scale as u64) * (src_h as u64 * scale as u64) * 3;
    let per_frame = in_raw + (in_raw * 12) / 10 + (out_raw * 4) / 10;

    let ram_budget = free_ram_mb.saturating_mul(1024 * 1024) * 30 / 100;
    let disk_budget = free_disk_mb.saturating_mul(1024 * 1024) * 20 / 100;
    let budget = ram_budget
        .min(disk_budget)
        .min(1536_u64 * 1024 * 1024)
        .max(8 * 1024 * 1024); // mínimo razonable (8 MB)

    let n = budget / per_frame.max(1);
    (n as usize).clamp(4, 64)
}

// ---------------------------------------------------------------------------
// Ejecución del pipeline
// ---------------------------------------------------------------------------
type TailTask = tokio::task::JoinHandle<String>;

fn drain_tail<R>(r: R) -> TailTask
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(r).lines();
        let mut tail: Vec<String> = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if tail.len() >= 40 {
                tail.remove(0);
            }
            tail.push(line);
        }
        tail.join("\n")
    })
}

fn short_tail(tail: &str) -> String {
    tail.lines()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ")
}

/// FPS EXACTOS del pipeline de salida: la interpolación impone entero; sin
/// interpolación se conserva la racional de origen (24000/1001…) para que
/// audio y vídeo duren exactamente lo mismo.
async fn exact_fps(input: &Path, plan: &RenderPlan) -> String {
    if !matches!(plan.interpolation, Interpolation::KeepSource) {
        return (plan.output_fps.round().max(1.0) as u32).to_string();
    }
    let out = tokio::process::Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0"])
        .args(["-show_entries", "stream=r_frame_rate"])
        .args(["-of", "default=nw=1:nk=1"])
        .arg(input)
        .output()
        .await;
    if let Ok(o) = out {
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if let Some((num, den)) = s.split_once('/') {
            if let (Ok(n), Ok(d)) = (num.parse::<u64>(), den.parse::<u64>()) {
                if n > 0 && d > 0 && s.len() <= 16 {
                    return s;
                }
            }
        }
    }
    format!("{:.6}", plan.output_fps)
}

/// Evento de progreso del pipeline IA (mismos campos que la ruta clásica).
fn ai_progress(
    plan: &RenderPlan,
    frames: u64,
    total_est: u64,
    started: Instant,
    label: &str,
) -> ProgressEvent {
    let mut ev = plan.progress_event("processing", label);
    let elapsed = started.elapsed().as_secs_f64().max(0.001);
    ev.frame = frames;
    ev.fps = frames as f64 / elapsed;
    if total_est > 0 {
        ev.percent = (frames as f64 / total_est as f64 * 100.0).min(99.0);
        if ev.fps > 0.0 {
            ev.eta_seconds = (total_est as f64 - frames as f64).max(0.0) / ev.fps;
        }
    }
    ev.speed = format!("{:.1} fps IA", ev.fps);
    ev
}

/// Escribe `count` fotogramas crudos RGB24 como PNG en `dir` (ffmpeg#1).
async fn write_pngs(
    raw: &[u8],
    count: usize,
    w: u32,
    h: u32,
    dir: &Path,
) -> Result<(), String> {
    if count == 0 {
        return Ok(());
    }
    let pattern = dir.join("frame%06d.png");
    let mut c = Command::new("ffmpeg");
    c.args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24"])
        .args(["-s", &format!("{w}x{h}")])
        .args(["-i", "pipe:0"])
        .args(["-frames:v", &count.to_string()])
        .args(["-f", "image2", "-start_number", "1"])
        .arg(&pattern)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = c.spawn().map_err(|e| format!("FFmpeg (PNG): {e}"))?;
    let mut stdin = child.stdin.take().ok_or("FFmpeg (PNG) sin entrada")?;
    let tail = drain_tail(child.stderr.take().ok_or("FFmpeg (PNG) sin stderr")?);

    stdin
        .write_all(raw)
        .await
        .map_err(|e| format!("FFmpeg (PNG) entrada: {e}"))?;
    drop(stdin);

    let st = child.wait().await.map_err(|e| format!("FFmpeg (PNG): {e}"))?;
    let tail = tail.await.unwrap_or_default();
    if !st.success() {
        return Err(format!("FFmpeg (PNG): {}", short_tail(&tail)));
    }
    Ok(())
}

/// Ejecuta Real-ESRGAN sobre un directorio de PNG (una invocación por chunk).
async fn run_engine_once(cfg: &AiRunConfig, in_dir: &Path, out_dir: &Path) -> Result<usize, String> {
    let args = engine_args(cfg, in_dir, out_dir);
    let mut c = Command::new(engine_exe());
    c.args(&args)
        .current_dir(engine_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = c
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar Real-ESRGAN: {e}"))?;
    let tail = drain_tail(child.stderr.take().ok_or("Real-ESRGAN sin stderr")?);
    let st = child
        .wait()
        .await
        .map_err(|e| format!("Real-ESRGAN: {e}"))?;
    let tail = tail.await.unwrap_or_default();

    if !st.success() {
        return Err(format!(
            "Real-ESRGAN ({}): {}",
            st.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            short_tail(&tail)
        ));
    }
    let n = std::fs::read_dir(out_dir)
        .map(|rd| rd.flatten().filter(|e| e.path().is_file()).count())
        .unwrap_or(0);
    if n == 0 {
        return Err(format!("Real-ESRGAN no produjo fotogramas: {}", short_tail(&tail)));
    }
    Ok(n)
}

async fn list_sorted(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| format!("Leyendo {dir:?}: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    v.sort();
    Ok(v)
}

async fn clean_dir(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let _ = if p.is_dir() {
                tokio::fs::remove_dir_all(&p).await
            } else {
                tokio::fs::remove_file(&p).await
            };
        }
    }
}

/// Pipeline completo de super-resolución IA. Devuelve (fotogramas, ms).
///
/// Esta función es la ÚNICA vía de la IA: si devuelve Err, `run_render`
/// continúa con la ruta clásica (Lanczos) — el export nunca se queda sin
/// resultado.
pub async fn run_superres(
    plan: &RenderPlan,
    input: &Path,
    output: &Path,
    cfg_override: Option<&AiRunConfig>,
    on_progress: &mut (dyn FnMut(&ProgressEvent) + Send),
) -> Result<(u64, u64), String> {
    let cap = capability();
    if !cap.available {
        return Err(cap.reason.unwrap_or_else(|| "motor IA no disponible".into()));
    }

    let cfg = cfg_override.cloned().unwrap_or_else(|| plan_run(plan));
    let run_dir = work_root().join(format!("run_{}", uuid::Uuid::new_v4()));
    let res = superres_inner(plan, input, output, &cfg, &run_dir, on_progress).await;
    // Limpieza SIEMPRE (temporales de fotogramas)
    let _ = tokio::fs::remove_dir_all(&run_dir).await;
    res
}

async fn superres_inner(
    plan: &RenderPlan,
    input: &Path,
    output: &Path,
    cfg: &AiRunConfig,
    run_dir: &Path,
    on_progress: &mut (dyn FnMut(&ProgressEvent) + Send),
) -> Result<(u64, u64), String> {
    let src_w = plan.source.width;
    let src_h = plan.source.height;
    if src_w == 0 || src_h == 0 {
        return Err("Fuente sin resolución válida".into());
    }
    // El decodificador emite el tamaño REAL de su cadena (el crop
    // anti-duplicado reduce el fotograma): usar el tamaño de la fuente aquí
    // desincronizaría el muestreo y perdería/desplazaría fotogramas.
    let (dec_w, dec_h) = plan.ai_decoder_dims();
    let frame_bytes = dec_w as usize * dec_h as usize * 3;
    let ai_w = dec_w * cfg.scale;
    let ai_h = dec_h * cfg.scale;
    let fps_rational = exact_fps(input, plan).await;
    let total_est = (plan.source.duration_sec * plan.output_fps).ceil().max(1.0) as u64;
    let chunk = chunk_frames(dec_w, dec_h, cfg.scale, ram_free_mb(), free_disk_mb(&ai_root()));

    let in_dir = run_dir.join("in");
    let out_dir = run_dir.join("out");
    tokio::fs::create_dir_all(&in_dir)
        .await
        .map_err(|e| format!("Creando temporales: {e}"))?;
    tokio::fs::create_dir_all(&out_dir)
        .await
        .map_err(|e| format!("Creando temporales: {e}"))?;

    // --- ffmpeg#1: decodifica + grading previo (incl. interpolación) -------
    let mut dec = Command::new("ffmpeg");
    dec.args(plan.ai_decoder_args(input))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut dec_child = dec
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar FFmpeg (decodificador): {e}"))?;
    let dec_out = dec_child.stdout.take().ok_or("FFmpeg sin salida")?;
    let dec_tail = drain_tail(dec_child.stderr.take().ok_or("FFmpeg sin stderr")?);
    let mut reader = BufReader::new(dec_out);

    // --- ffmpeg#2: image2pipe + filtros finales + codificador + audio ------
    let mut enc = Command::new("ffmpeg");
    enc.args(plan.ai_encoder_args(input, &fps_rational, ai_w, ai_h, output))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut enc_child = enc
        .spawn()
        .map_err(|e| format!("No se pudo ejecutar FFmpeg (codificador): {e}"))?;
    let mut enc_in = enc_child.stdin.take().ok_or("FFmpeg sin entrada")?;
    let enc_tail = drain_tail(enc_child.stderr.take().ok_or("FFmpeg sin stderr")?);

    let started = Instant::now();
    let mut frames_done: u64 = 0;
    let mut last_emit = Instant::now();
    let label = format!(
        "Super-resolución IA · {} ×{} → {ai_w}×{ai_h}",
        cfg.model, cfg.scale
    );

    let mut eof = false;
    while !eof {
        // 1) Leer hasta `chunk` fotogramas del decodificador (exactos)
        let mut raw = vec![0u8; frame_bytes * chunk];
        let mut got = 0usize;
        while got < chunk {
            let slot = &mut raw[got * frame_bytes..(got + 1) * frame_bytes];
            let mut read = 0usize;
            while read < frame_bytes {
                match reader.read(&mut slot[read..]).await {
                    Ok(0) => break,
                    Ok(n) => read += n,
                    Err(e) => return Err(format!("Lectura de fotogramas: {e}")),
                }
            }
            if read < frame_bytes {
                eof = true; // fin (o tramo parcial final, descartado)
                break;
            }
            got += 1;
        }
        if got == 0 {
            break;
        }
        raw.truncate(got * frame_bytes);

        // 2) PNG del chunk  →  3) Real-ESRGAN en la GPU
        clean_dir(&in_dir).await;
        clean_dir(&out_dir).await;
        write_pngs(&raw, got, dec_w, dec_h, &in_dir).await?;
        run_engine_once(cfg, &in_dir, &out_dir).await?;

        // 4) Enviar los PNG ya mejorados al codificador (en orden)
        for f in list_sorted(&out_dir).await? {
            let bytes = tokio::fs::read(&f)
                .await
                .map_err(|e| format!("Leyendo salida IA: {e}"))?;
            if let Err(e) = enc_in.write_all(&bytes).await {
                // El codificador murió: matarlo y reportar SU error real
                let _ = enc_child.kill().await;
                let tail = enc_tail.await.unwrap_or_default();
                return Err(format!(
                    "FFmpeg (codificador) cerró la tubería: {e}. Causa: {}",
                    short_tail(&tail)
                ));
            }
        }
        clean_dir(&in_dir).await;
        clean_dir(&out_dir).await;

        frames_done += got as u64;
        if last_emit.elapsed().as_millis() >= 250 || eof {
            last_emit = Instant::now();
            on_progress(&ai_progress(plan, frames_done, total_est, started, &label));
        }
    }
    drop(enc_in);

    // --- cierre y verificación (primero el decodificador: es la causa raíz) --
    let dec_status = dec_child
        .wait()
        .await
        .map_err(|e| format!("FFmpeg (decodificador): {e}"))?;
    let dec_tail = dec_tail.await.unwrap_or_default();
    if !dec_status.success() {
        return Err(format!("FFmpeg (decodificador): {}", short_tail(&dec_tail)));
    }

    let enc_status = enc_child
        .wait()
        .await
        .map_err(|e| format!("FFmpeg (codificador): {e}"))?;
    let enc_tail = enc_tail.await.unwrap_or_default();
    if !enc_status.success() {
        return Err(format!("FFmpeg (codificador): {}", short_tail(&enc_tail)));
    }

    Ok((frames_done, started.elapsed().as_millis() as u64))
}

// ---------------------------------------------------------------------------
// Medición real antes/después (PSNR + SSIM con FFmpeg, sin inventar números)
// ---------------------------------------------------------------------------
// Medición real antes/después (PSNR + SSIM con FFmpeg, sin inventar números).
// La usan los tests de mejora; se expone también para futuras medidas desde
// el panel (mismo código, cero simulación).
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize)]
pub struct VideoMetrics {
    /// dB (máximo = infinito); mide fidelidad respecto a la referencia
    pub psnr: f64,
    /// 0..1; mide similitud estructural
    pub ssim: f64,
}

#[allow(dead_code)]
async fn run_compare(input: &Path, reference: &Path, lavfi: &str) -> Result<String, String> {
    let out = Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "info", "-nostdin"])
        .arg("-i")
        .arg(input)
        .arg("-i")
        .arg(reference)
        .args(["-lavfi", lavfi])
        .args(["-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("FFmpeg: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stderr).to_string())
}

/// PSNR y SSIM reales entre `input` y `reference` (mismo tamaño y FPS).
#[allow(dead_code)]
pub async fn compare_videos(input: &Path, reference: &Path) -> Result<VideoMetrics, String> {
    let psnr_txt = run_compare(input, reference, "psnr").await?;
    let ssim_txt = run_compare(input, reference, "ssim").await?;

    let psnr = psnr_txt
        .lines()
        .rev()
        .find_map(|l| l.split("average:").nth(1))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse::<f64>().ok())
        .ok_or_else(|| "No se pudo leer PSNR en la salida de FFmpeg".to_string())?;
    let ssim = ssim_txt
        .lines()
        .rev()
        .find_map(|l| l.split("All:").nth(1))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|v| v.parse::<f64>().ok())
        .ok_or_else(|| "No se pudo leer SSIM en la salida de FFmpeg".to_string())?;

    Ok(VideoMetrics { psnr, ssim })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn has_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    // ------------------------------ unidad ------------------------------

    #[test]
    fn nearest_scale_maps_ratios_to_native_scales() {
        assert_eq!(nearest_scale(1.2), 2);
        assert_eq!(nearest_scale(1.9), 2);
        assert_eq!(nearest_scale(2.0), 2);
        assert_eq!(nearest_scale(2.6), 3);
        assert_eq!(nearest_scale(3.0), 3);
        assert_eq!(nearest_scale(3.6), 4);
        assert_eq!(nearest_scale(9.0), 4);
        assert_eq!(nearest_scale(f64::NAN), 2);
    }

    #[test]
    fn tile_shrinks_with_less_vram() {
        assert_eq!(tile_for_vram(Some(16000)), 0);
        assert_eq!(tile_for_vram(Some(5000)), 256);
        assert_eq!(tile_for_vram(Some(3000)), 192);
        assert_eq!(tile_for_vram(Some(1000)), 128);
        assert_eq!(tile_for_vram(None), 0);
    }

    #[test]
    fn chunk_size_is_bounded_by_ram_and_disk() {
        // 1080p ×2 con 4 GB libres y 20 GB de disco
        let a = chunk_frames(1920, 1080, 2, 4096, 20480);
        assert!((4..=64).contains(&a), "{a}");
        // Poca RAM → menos fotogramas por lote
        let low = chunk_frames(1920, 1080, 4, 512, 20480);
        let high = chunk_frames(1920, 1080, 4, 16384, 20480);
        assert!(low < high, "low={low} high={high}");
        // 4K ×4 con disco justito → tope mínimo (4)
        let tiny = chunk_frames(3840, 2160, 4, 2048, 600);
        assert!(tiny >= 4, "{tiny}");
        // Nunca se pasa del tope duro
        assert!(chunk_frames(320, 180, 2, 65536, 65536) <= 64);
    }

    #[test]
    fn auto_model_uses_native_scale_for_every_model() {
        // Política MEDIDA (no supuesta): modelo con fichero nativo para la
        // escala. x4plus a -s 2 ensambla teselas corruptas (15 dB medidos);
        // los modelos nativos dan 29-30 dB.
        // ×2 → modelo de vídeo (fichero nativo x2)
        let (low, s1) = pick_model_and_scale("", Some(1500), 2.0);
        assert_eq!(low, MODEL_VIDEO);
        assert_eq!(s1, 2);
        // ×3 → sigue siendo nativo (animevideov3 tiene x3)
        let (mid, s2) = pick_model_and_scale("", Some(8000), 3.0);
        assert_eq!(mid, MODEL_VIDEO);
        assert_eq!(s2, 3);
        // ×4 → el modelo general (nativo ×4)
        let (hi, s3) = pick_model_and_scale("", Some(8000), 4.0);
        assert_eq!(hi, MODEL_DEFAULT);
        assert_eq!(s3, 4);
        // VRAM corta → modelo ligero en TODAS las escalas (x2/x3/x4 nativos)
        let (tiny, s4) = pick_model_and_scale("", Some(1500), 4.0);
        assert_eq!(tiny, MODEL_VIDEO);
        assert_eq!(s4, 4);
        // Petición explícita "photo" (x4plus): SU escala es 4, aunque el
        // objetivo sea ×2 (el codificador reduce después; nunca -s no nativo)
        let (photo, s5) = pick_model_and_scale("photo", Some(8000), 2.0);
        assert_eq!(photo, MODEL_DEFAULT);
        assert_eq!(s5, 4);
        let (an, _) = pick_model_and_scale("animevideov3", None, 2.0);
        assert_eq!(an, MODEL_VIDEO);
    }

    #[test]
    fn sha256_of_known_bytes() {
        // vector de prueba oficial de FIPS 180 ("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn engine_args_match_official_cli() {
        // Combinación VÁLIDA (modelo + escala nativos): animevideov3 ×2
        let cfg = AiRunConfig {
            model: MODEL_VIDEO.into(),
            scale: 2,
            tile: 256,
            gpu_id: 0,
            jobs: "1:2:2".into(),
        };
        let a = engine_args(&cfg, Path::new("in_dir"), Path::new("out_dir"));
        let j = a.join(" ");
        assert!(j.contains("-n realesr-animevideov3"), "{j}");
        assert!(j.contains("-s 2"), "{j}");
        assert!(j.contains("-t 256"), "{j}");
        assert!(j.contains("-f png"), "{j}");
        assert!(j.contains("-m "), "{j}");
    }

    #[test]
    fn capability_is_serializable_for_the_web() {
        let cap = capability();
        let json = serde_json::to_string(&cap).expect("serializable");
        assert!(json.contains("\"installed\""), "{json}");
        assert!(json.contains("\"canInstall\""), "{json}");
        assert!(!json.to_lowercase().contains("password"), "sin secretos");
    }

    #[test]
    fn requirements_block_download_when_not_met() {
        // Con instalación ya hecha available=true; sin ella, reason explicado.
        let cap = capability();
        if cap.installed {
            assert!(cap.reason.is_none() || !cap.can_install);
        } else {
            assert!(!cap.available);
            assert!(cap.reason.as_deref().unwrap_or("").contains("instalado"));
        }
    }

    // --------------------- instalación (red, opcional) ---------------------
    // Ejecutar con:  cargo test -- --ignored engine_install
    #[tokio::test]
    #[ignore = "descarga 45 MB de la release oficial (red)"]
    async fn engine_install_downloads_verifies_and_extracts() {
        let cap0 = capability();
        if !cap0.can_install && !cap0.installed {
            eprintln!(
                "SKIP: requisitos no cumplidos → {}",
                cap0.reason.unwrap_or_default()
            );
            return;
        }
        let p = Arc::new(|_v: u8| {});
        let cap = install_engine(p).await.expect("instalación del motor oficial");
        assert!(cap.installed && cap.available);
        assert!(engine_exe().is_file());
        assert!(models_dir().join(MODEL_SENTINEL).is_file());
    }

    // ---------------- integración real (GPU + FFmpeg) ----------------
    // Se omiten automáticamente si falta FFmpeg o el motor.

    async fn probe(path: &Path) -> crate::render::SourceInfo {
        crate::render::probe_source(path).await.expect("ffprobe")
    }

    async fn make_source(path: &Path, w: u32, h: u32, fps: u32, secs: u32, audio: bool) {
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=size={w}x{h}:rate={fps}:duration={secs}"));
        if audio {
            cmd.args(["-f", "lavfi", "-i", &format!("sine=frequency=440:duration={secs}")]);
        }
        cmd.args(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18"]);
        if audio {
            cmd.args(["-c:a", "aac", "-shortest"]);
        }
        cmd.arg(path);
        let st = cmd.status().await.expect("ffmpeg");
        assert!(st.success(), "fallo creando fuente de prueba");
    }

    fn ai_settings() -> crate::render::RenderSettings {
        crate::render::RenderSettings {
            resolution: "1080p".into(),
            tiktok_preset: false,
            interpolate: false,
            fps: 30,
            upscale_mode: "ai".into(),
            device_tier: "high".into(),
            platform: "windows".into(),
            ..Default::default()
        }
    }

    /// Pipeline REAL completo: fuente 640×360 (+audio) → 1920×1080 con IA.
    /// Comprueba que se conservan duración, FPS, resolución objetivo y audio.
    #[tokio::test]
    async fn ia_pipeline_conserva_fps_duracion_y_audio() {
        if !has_ffmpeg() || !is_engine_ready() {
            eprintln!("SKIP: requiere FFmpeg + motor IA instalado");
            return;
        }
        let dir = std::env::temp_dir().join(format!("ixi_ai_e2e_{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let src = dir.join("src.mp4");
        let out = dir.join("out.mp4");
        make_source(&src, 640, 360, 30, 2, true).await;

        let source = probe(&src).await;
        let hw = crate::render::detect_hardware().await;
        let settings = ai_settings();
        let mut plan = crate::render::build_plan(&settings, &source, &hw);
        plan.command = plan.ai_command_display(&src, &out);
        assert!(plan.upscaled, "esperaba escalado");
        assert_eq!((plan.target_width, plan.target_height), (1920, 1080));

        let mut events = 0usize;
        let r = run_superres(&plan, &src, &out, None, &mut |_ev| events += 1)
            .await
            .expect("pipeline IA");
        assert!(r.0 > 0, "sin fotogramas");
        assert!(events > 0, "sin eventos de progreso");

        let meta = crate::render::probe_source(&out).await.expect("sondeo salida");
        assert_eq!((meta.width, meta.height), (1920, 1080), "resolución objetivo");
        assert!((meta.fps - source.fps).abs() < 0.01, "FPS {} vs {}", meta.fps, source.fps);
        assert!(
            (meta.duration_sec - source.duration_sec).abs() < 0.15,
            "duración {} vs {}",
            meta.duration_sec,
            source.duration_sec
        );
        assert!(meta.has_audio, "audio perdido");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// PRUEBA ANTES/DESPUÉS con referencia real (ground truth):
    ///   GT 1920×1080 → se degrada a 960×540 → se recupera con Lanczos y con IA
    ///   → PSNR/SSIM de cada una contra el GT. La IA debe superar a Lanczos
    ///   en la métrica estructural (SSIM); si no, el test falla y se ven los
    ///   números reales en la salida.
    #[tokio::test]
    async fn ia_supera_a_lanczos_en_prueba_antes_despues() {
        if !has_ffmpeg() || !is_engine_ready() {
            eprintln!("SKIP: requiere FFmpeg + motor IA instalado");
            return;
        }
        let dir = std::env::temp_dir().join(format!("ixi_ai_ab_{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let gt = dir.join("gt.mp4");
        let low = dir.join("low.mp4");
        let lanczos = dir.join("lanczos.mp4");
        let ai = dir.join("ai.mp4");

        // GT con detalle orgánico (mandelbrot) + audio
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"])
            .arg("mandelbrot=size=1920x1080:rate=30")
            .args(["-t", "1.5", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5"])
            .args(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-c:a", "aac", "-shortest"])
            .arg(&gt);
        let st = cmd.status().await.unwrap();
        assert!(st.success(), "creando GT");

        // Degradación controlada: escala a la mitad (misma codificación en ambas
        // rutas para que la comparación sea justa)
        let st = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&gt)
            .args(["-vf", "scale=960:540:flags=bicubic", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "14"])
            .arg(&low)
            .status()
            .await
            .unwrap();
        assert!(st.success(), "degradando");

        // RUTA A: Lanczos clásico (plan real, upscale_mode "auto")
        let source = probe(&low).await;
        let hw = crate::render::detect_hardware().await;
        let mut s_lan = ai_settings();
        s_lan.upscale_mode = "auto".into();
        let plan_lan = crate::render::build_plan(&s_lan, &source, &hw);
        let r = crate::render::run_render(&plan_lan, &low, &lanczos, |_ev| {}).await;
        assert!(r.is_ok(), "ruta Lanczos falló: {r:?}");

        // RUTA B: IA Real-ESRGAN (plan real, upscale_mode "ai")
        let plan_ai = crate::render::build_plan(&ai_settings(), &source, &hw);
        assert!(plan_ai.upscaler.is_ai, "el plan no eligió IA: {:?}", plan_ai.notes);
        crate::render::run_render(&plan_ai, &low, &ai, |_ev| {}).await
            .expect("ruta IA falló");

        let m_lan = compare_videos(&lanczos, &gt).await.expect("métricas Lanczos");
        let m_ai = compare_videos(&ai, &gt).await.expect("métricas IA");
        println!(
            "ANTES/DESPUÉS vs GT (1920×1080, degradado 960×540):\n  \
             Lanczos: PSNR {:6.2} dB  SSIM {:.5}\n  \
             IA     : PSNR {:6.2} dB  SSIM {:.5}",
            m_lan.psnr, m_lan.ssim, m_ai.psnr, m_ai.ssim
        );

        // La mejora debe ser REAL y medible (SSIM estructural es la métrica
        // que penaliza la borrosidad de Lanczos; se exige además no empeorar
        // la fidelidad PSNR más de 0.2 dB).
        assert!(
            m_ai.ssim > m_lan.ssim,
            "la IA no supera a Lanczos en SSIM ({:.5} vs {:.5})",
            m_ai.ssim,
            m_lan.ssim
        );
        assert!(
            m_ai.psnr >= m_lan.psnr - 0.2,
            "la IA empeora PSNR demasiado ({:.2} vs {:.2})",
            m_ai.psnr,
            m_lan.psnr
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
