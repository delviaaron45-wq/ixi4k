// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::net::UdpSocket;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

mod render;
use render::RenderSettings;

// ---------------------------------------------------------------------------
// Estado global: rate limiting de autenticación (5 intentos / 60 segundos)
// ---------------------------------------------------------------------------
const MAX_LOGIN_ATTEMPTS: usize = 5;
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const STORE_NAMESPACE: &str = "ixi4k-studio";
const ALLOWED_OUTPUT_EXT: [&str; 4] = ["mp4", "mov", "mkv", "webm"];

struct AppState {
    login_attempts: Mutex<Vec<Instant>>,
    /// Intentos FALLIDOS contra la cuenta de administrador (solo esa cuenta).
    /// Contador separado de `login_attempts` para no duplicar los intentos
    /// cuando el frontend consulta las dos capas de rate limiting.
    admin_login_attempts: Mutex<Vec<Instant>>,
}

// ---------------------------------------------------------------------------
// RenderSettings vive en `render.rs` (motor de render ixi 4k)
// ---------------------------------------------------------------------------
// SANITIZACIÓN DE RUTAS — prevención de Path Traversal / Directory Escapes
// ---------------------------------------------------------------------------

/// Directorio de exportación según plataforma:
///  - Windows/macOS/Linux → ~/Downloads
///  - Android → almacenamiento externo (Downloads / Galería)
///  - iOS → Documents (fotos vía PHPhotoLibrary plugin)
fn export_directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    let dir = {
        // Almacenamiento compartido (visible en la app Galería/Archivos).
        // Se comprueba permiso de escritura real porque Android 11+ restringe
        // /storage/emulated/0 (scoped storage) salvo MediaStore.
        let candidates = [
            PathBuf::from("/storage/emulated/0/Download"),
            PathBuf::from("/sdcard/Download"),
        ];
        let mut chosen: Option<PathBuf> = None;
        for candidate in &candidates {
            if candidate.exists() {
                let probe = candidate.join(".ixi4k_write_probe");
                if std::fs::write(&probe, b"").is_ok() {
                    let _ = std::fs::remove_file(&probe);
                    chosen = Some(candidate.clone());
                    break;
                }
            }
        }
        // Último recurso: directorio externo de la app (siempre escribible)
        chosen.unwrap_or_else(|| {
            std::env::var("EXTERNAL_STORAGE")
                .map(|p| PathBuf::from(p).join("Download"))
                .unwrap_or_else(|_| PathBuf::from("/storage/emulated/0/Download"))
        })
    };

    #[cfg(target_os = "ios")]
    let dir = {
        let home = dirs::home_dir().ok_or("Directorio home no disponible")?;
        home.join("Documents")
    };

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let dir = {
        let home = dirs::home_dir().ok_or("Directorio home no disponible")?;
        let downloads = home.join("Downloads");
        if !downloads.exists() {
            std::fs::create_dir_all(&downloads).map_err(|e| format!("Error creando Downloads: {e}"))?;
        }
        downloads
    };

    Ok(dir)
}

fn sanitize_path(input: &str, must_exist: bool) -> Result<PathBuf, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Ruta vacía rechazada".to_string());
    }
    if raw.contains('\0') {
        return Err("Carácter nulo detectado en la ruta (inyección)".to_string());
    }

    let path = Path::new(raw);

    // Bloqueo explícito de componentes de salto de directorio
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                return Err("Path Traversal detectado: se rechazó '..' en la ruta".to_string())
            }
            Component::Prefix(_)
            | Component::RootDir
            | Component::CurDir
            | Component::Normal(_) => {}
        }
    }

    // Resolución canónica del path real (siguiendo symlinks)
    let resolved = if path.exists() {
        path.canonicalize()
            .map_err(|e| format!("No se pudo resolver la ruta: {e}"))?
    } else {
        let parent = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent_canon = parent
            .canonicalize()
            .map_err(|_| "Directorio destino inexistente o inválido".to_string())?;
        let name = path
            .file_name()
            .ok_or_else(|| "Nombre de archivo inválido".to_string())?;
        parent_canon.join(name)
    };

    if must_exist && !resolved.exists() {
        return Err("El archivo especificado no existe".to_string());
    }
    Ok(resolved)
}

/// Las salidas SOLO se permiten dentro del directorio de exportación
/// de la plataforma (~/Downloads en desktop, almacenamiento en móvil).
fn sanitize_output_path(input: &str) -> Result<PathBuf, String> {
    let path = sanitize_path(input, false)?;
    let allowed = export_directory()?;
    let allowed_canon = allowed.canonicalize().unwrap_or(allowed);

    let parent = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let parent_canon = parent.canonicalize().unwrap_or(parent);

    if parent_canon != allowed_canon && !parent_canon.starts_with(&allowed_canon) {
        return Err(
            "La ruta de salida debe estar dentro del directorio de exportación de la plataforma"
                .to_string(),
        );
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_OUTPUT_EXT.contains(&ext.as_str()) {
        return Err("Extensión de salida no permitida".to_string());
    }
    Ok(path)
}

// (La sanitización numérica de los ajustes vive en `render.rs`.)

// ---------------------------------------------------------------------------
// Cadena de filtros FFmpeg → ahora en `render.rs` (motor de render ixi 4k)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------
#[tauri::command]
async fn check_ffmpeg() -> Result<String, String> {
    let output = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map_err(|e| format!("FFmpeg no encontrado: {e}"))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        Ok(version
            .lines()
            .next()
            .unwrap_or("FFmpeg instalado")
            .to_string())
    } else {
        Err("FFmpeg no está instalado en el sistema".to_string())
    }
}

#[tauri::command]
async fn get_downloads_path() -> Result<String, String> {
    let dir = export_directory()?;
    Ok(dir.to_string_lossy().to_string())
}

/// Directorio de exportación según la plataforma detectada
/// (Downloads en PC, Galería/Downloads en Android, Fotos en iOS).
#[tauri::command]
async fn get_export_directory() -> Result<String, String> {
    let dir = export_directory()?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: String,
    is_mobile: bool,
    export_dir: String,
}

/// Información de plataforma para adaptar resoluciones y destino de export.
#[tauri::command]
async fn get_platform_info() -> Result<PlatformInfo, String> {
    let os = std::env::consts::OS.to_string();
    let is_mobile = os == "android" || os == "ios";
    let export_dir = export_directory()?.to_string_lossy().to_string();
    Ok(PlatformInfo {
        os,
        is_mobile,
        export_dir,
    })
}

/// Rate Limiting nativo: máximo 5 intentos de login por minuto.
/// Devuelve los intentos restantes o error "RATE_LIMITED:<segundos>".
#[tauri::command]
async fn record_login_attempt(state: tauri::State<'_, AppState>) -> Result<u32, String> {
    let now = Instant::now();
    let mut attempts = state
        .login_attempts
        .lock()
        .map_err(|_| "Estado interno bloqueado".to_string())?;
    attempts.retain(|t| now.duration_since(*t) < LOGIN_WINDOW);

    if attempts.len() >= MAX_LOGIN_ATTEMPTS {
        let oldest = attempts.first().copied().unwrap_or(now);
        let elapsed = now.duration_since(oldest);
        let remaining = LOGIN_WINDOW.saturating_sub(elapsed).as_secs() + 1;
        return Err(format!("RATE_LIMITED:{remaining}"));
    }
    attempts.push(now);
    Ok((MAX_LOGIN_ATTEMPTS - attempts.len()) as u32)
}

// ---------------------------------------------------------------------------
// VERIFICACIÓN DE CREDENCIALES DE ADMINISTRADOR (backend)
//
// NADA de credenciales en el frontend: el email y el hash bcrypt viven solo
// en el proceso nativo, nunca en el bundle JavaScript ni en el repositorio.
//
// Fuentes (por orden de prioridad):
//   1. Variables de entorno en tiempo de EJECUCIÓN (no del build):
//        IXI4K_ADMIN_EMAIL=...
//        IXI4K_ADMIN_PASSWORD_HASH=$2b$12$...
//   2. Fichero local de secretos FUERA del repositorio:
//        ~/.ixi4k/admin_credentials.json   (permisos 600)
//      Se crea con:  npm run admin:setup
//   3. Sin ninguna fuente configurada → acceso denegado.
// ---------------------------------------------------------------------------
const ADMIN_NOT_CONFIGURED: &str = "ADMIN_NOT_CONFIGURED";

fn admin_credentials() -> Result<(String, String), String> {
    // 1) Variables de entorno del proceso
    let env_email = std::env::var("IXI4K_ADMIN_EMAIL")
        .ok()
        .map(|v| v.trim().to_lowercase())
        .filter(|v| !v.is_empty());
    let env_hash = std::env::var("IXI4K_ADMIN_PASSWORD_HASH")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if let (Some(email), Some(hash)) = (env_email, env_hash) {
        return Ok((email, hash));
    }

    // 2) Fichero local de secretos (fuera del repositorio)
    let path = dirs::home_dir()
        .ok_or_else(|| "No se pudo resolver el directorio home".to_string())?
        .join(".ixi4k")
        .join("admin_credentials.json");

    if path.exists() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("No se pudo leer el secreto de administrador: {e}"))?;
        let value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| "Fichero de secreto de administrador inválido".to_string())?;
        let email = value
            .get("email")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let hash = value
            .get("password_hash")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if email.is_empty() || hash.is_empty() {
            return Err(ADMIN_NOT_CONFIGURED.to_string());
        }
        return Ok((email, hash));
    }

    // 3) Sin secretos configurados → no hay acceso admin local
    Err(ADMIN_NOT_CONFIGURED.to_string())
}

/// ¿Son estas credenciales las del administrador configurado?
/// bcrypt::verify se ejecuta siempre: mismo coste temporal exista o no
/// coincidencia de email (mitigación de ataques por timing).
fn resolve_admin_role(email: &str, password: &str, expected_email: &str, expected_hash: &str) -> bool {
    let email_ok = email.trim().to_lowercase() == expected_email;
    let hash_ok = bcrypt::verify(password, expected_hash).unwrap_or(false);
    email_ok && hash_ok
}

/// Verifica email + contraseña contra el hash bcrypt guardado en el backend.
/// Nunca devuelve la contraseña ni el hash al frontend.
/// Devuelve Err("ADMIN_NOT_CONFIGURED") si no existe fuente de credenciales.
#[tauri::command]
fn verify_admin_credentials(email: String, password: String) -> Result<bool, String> {
    let (expected_email, expected_hash) = admin_credentials()?;
    Ok(resolve_admin_role(&email, &password, &expected_email, &expected_hash))
}

// ---------------------------------------------------------------------------
// SESIÓN DE ADMINISTRADOR — rol emitido y validado SIEMPRE por el backend
//
// El frontend NUNCA decide el rol: solo recibe un token opaco generado aquí
// (UUID aleatorio) cuando —y solo cuando— las credenciales coinciden con el
// administrador configurado (bcrypt en este proceso). La sesión se guarda en
// ~/.ixi4k/admin_session.json (0600 en Unix) y su validación/revocación
// también ocurre aquí: manipular localStorage, keyring o la URL del navegador
// no concede acceso al panel de administración.
// ---------------------------------------------------------------------------

const ADMIN_SESSION_TTL_SECS: u64 = 3600;
const ROLE_ADMIN: &str = "admin";
const ROLE_USER: &str = "user";

/// Respuesta del login. El rol (`role`) lo asigna exclusivamente el backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginResult {
    role: String,
    token: Option<String>,
    expires_at: Option<u64>,
    /// `true` cuando el backend exige verificar el código TOTP (2FA) ANTES de
    /// conceder la sesión: `token` es entonces un token PENDIENTE (caduca en
    /// minutos y no abre el panel hasta `two_factor_verify_login`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    two_factor_required: Option<bool>,
}

/// Fichero de sesión emitido por el backend (nunca contiene contraseñas).
#[derive(Debug, Serialize, Deserialize)]
struct AdminSessionFile {
    token: String,
    email: String,
    expires_at: u64,
}

fn admin_session_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "No se pudo resolver el directorio home".to_string())?
        .join(".ixi4k")
        .join("admin_session.json"))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Emite un token de sesión admin (UUID aleatorio) con caducidad.
fn issue_admin_session_at(path: &Path, email: &str, ttl_secs: u64) -> Result<(String, u64), String> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let expires_at = unix_now().saturating_add(ttl_secs);
    let payload = AdminSessionFile {
        token: token.clone(),
        email: email.to_string(),
        expires_at,
    };
    let dir = path
        .parent()
        .ok_or_else(|| "Ruta de sesión inválida".to_string())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("No se pudo crear el directorio de sesión: {e}"))?;
    let raw = serde_json::to_string(&payload)
        .map_err(|_| "No se pudo serializar la sesión".to_string())?;
    std::fs::write(path, raw).map_err(|e| format!("No se pudo guardar la sesión: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok((token, expires_at))
}

/// Validación de sesión EN EL BACKEND: token emitido por nosotros + no caducado.
fn verify_admin_session_at(path: &Path, token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(session) = serde_json::from_str::<AdminSessionFile>(&raw) else {
        return false;
    };
    !session.token.is_empty() && session.token == token && session.expires_at > unix_now()
}

/// Revoca en el backend la sesión (logout). Solo borra si el token es válido.
fn revoke_admin_session_at(path: &Path, token: &str) -> bool {
    if verify_admin_session_at(path, token) {
        return std::fs::remove_file(path).is_ok();
    }
    false
}

// --- Rate limiting de la cuenta de administrador (5 fallos / 60 s) -----------

/// Devuelve (intentos_en_ventana, segundos_de_bloqueo). Bloqueo = 5 fallos.
fn admin_rate_state(attempts: &Mutex<Vec<Instant>>) -> Result<(usize, u64), String> {
    let now = Instant::now();
    let mut list = attempts
        .lock()
        .map_err(|_| "Estado interno bloqueado".to_string())?;
    list.retain(|t| now.duration_since(*t) < LOGIN_WINDOW);
    if list.len() >= MAX_LOGIN_ATTEMPTS {
        let oldest = list.first().copied().unwrap_or(now);
        let remaining = LOGIN_WINDOW
            .saturating_sub(now.duration_since(oldest))
            .as_secs()
            + 1;
        Ok((list.len(), remaining))
    } else {
        Ok((list.len(), 0))
    }
}

fn admin_rate_record(attempts: &Mutex<Vec<Instant>>) -> Result<(), String> {
    let now = Instant::now();
    let mut list = attempts
        .lock()
        .map_err(|_| "Estado interno bloqueado".to_string())?;
    list.retain(|t| now.duration_since(*t) < LOGIN_WINDOW);
    list.push(now);
    Ok(())
}

fn admin_rate_clear(attempts: &Mutex<Vec<Instant>>) -> Result<(), String> {
    let mut list = attempts
        .lock()
        .map_err(|_| "Estado interno bloqueado".to_string())?;
    list.clear();
    Ok(())
}

/// Núcleo del login con rol (aislado de Tauri para poder testearlo).
///
/// - Credenciales del administrador configurado → rol "admin" + token de sesión.
/// - Cualquier otra combinación → rol "user" (entrada normal, sin token).
/// - SOLO los intentos fallidos sobre la cuenta admin consumen el rate limit;
///   los usuarios normales no se ven limitados (comportamiento actual).
/// Nunca devuelve ni registra la contraseña ni el hash.
fn login_with_role_inner(
    attempts: &Mutex<Vec<Instant>>,
    email: &str,
    password: &str,
    admin: Option<(&str, &str)>,
    session_path: Option<&Path>,
) -> Result<LoginResult, String> {
    let normalized = email.trim().to_lowercase();

    if let Some((expected_email, expected_hash)) = admin {
        let is_admin_account = normalized == expected_email;

        if is_admin_account {
            let (_, blocked_for) = admin_rate_state(attempts)?;
            if blocked_for > 0 {
                return Err(format!("RATE_LIMITED:{blocked_for}"));
            }
        }

        if resolve_admin_role(&normalized, password, expected_email, expected_hash) {
            let path = session_path.ok_or_else(|| "SESSION_NOT_AVAILABLE".to_string())?;
            let (token, expires_at) =
                issue_admin_session_at(path, &normalized, ADMIN_SESSION_TTL_SECS)?;
            let _ = admin_rate_clear(attempts);
            return Ok(LoginResult {
                role: ROLE_ADMIN.to_string(),
                token: Some(token),
                expires_at: Some(expires_at),
                two_factor_required: None,
            });
        }

        if is_admin_account {
            admin_rate_record(attempts)?;
        }
    }

    Ok(LoginResult {
        role: ROLE_USER.to_string(),
        token: None,
        expires_at: None,
        two_factor_required: None,
    })
}

/// Login único del frontend: el BACKEND decide el rol.
/// (async para no bloquear la UI mientras bcrypt verifica la contraseña)
///
/// Si el 2FA está activo, la sesión emitida se guarda como PENDIENTE: el
/// token resultante NO abre el panel hasta `two_factor_verify_login`.
#[tauri::command]
async fn login_with_role(
    state: tauri::State<'_, AppState>,
    email: String,
    password: String,
    device: Option<String>,
) -> Result<LoginResult, String> {
    let credentials = admin_credentials().ok();
    let two_fa = two_factor_enabled();
    let session_path = if two_fa {
        two_factor_pending_path().ok()
    } else {
        admin_session_path().ok()
    };
    let admin_ref = credentials
        .as_ref()
        .map(|(e, h)| (e.as_str(), h.as_str()));
    let mut result = login_with_role_inner(
        &state.admin_login_attempts,
        &email,
        &password,
        admin_ref,
        session_path.as_deref(),
    )?;
    if result.role == ROLE_ADMIN {
        if two_fa && result.token.is_some() {
            // Credenciales correctas → token PENDIENTE: falta el código TOTP.
            result.two_factor_required = Some(true);
            result.expires_at = Some(unix_now() + TWO_FACTOR_PENDING_TTL_SECS);
        } else if let Some(token) = result.token.as_deref() {
            // Sesión completa → se registra para verla/cerrarla desde el panel
            sessions_issue(token, &email, device.as_deref());
        }
    }
    Ok(result)
}

/// Valida en el backend un token de sesión admin (se usa al restaurar sesión).
/// Acepta el registro multi-sesión (y marca actividad) o el fichero legacy.
#[tauri::command]
fn verify_admin_session(token: String) -> Result<bool, String> {
    if sessions_verify(&token) {
        return Ok(true);
    }
    let path = admin_session_path()?;
    Ok(verify_admin_session_at(&path, &token))
}

/// Revoca en el backend la sesión admin (logout). Si el token no es válido
/// no se borra nada.
#[tauri::command]
fn revoke_admin_session(token: String) -> Result<bool, String> {
    let path = admin_session_path()?;
    let removed_registry = sessions_remove_token(&token);
    let removed_legacy = revoke_admin_session_at(&path, &token);
    Ok(removed_registry || removed_legacy)
}

// ---------------------------------------------------------------------------
// 2FA (TOTP RFC 6238) PARA LA CUENTA DE ADMINISTRADOR
//
// El secreto vive SOLO en ~/.ixi4k/admin_2fa.json (0600 en Unix); se genera y
// verifica en ESTE proceso. Tras activarlo el frontend ya no recibe el secreto
// (solo durante la configuración inicial, que es inevitable para registrarlo
// en la app autenticadora). El login con contraseña correcta emite un token
// PENDIENTE que no concede el panel hasta verificar el código TOTP.
// ---------------------------------------------------------------------------

const TWO_FACTOR_PENDING_TTL_SECS: u64 = 300; // 5 min para introducir el código
const TWO_FACTOR_MAX_ATTEMPTS: u8 = 5; // intentos de código por cada login

type HmacSha1 = hmac::Hmac<sha1::Sha1>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwoFactorFile {
    secret: String,
    enabled: bool,
    #[serde(default)]
    enabled_at: Option<u64>,
}

/// Credenciales correctas pero 2FA aún sin verificar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwoFactorPending {
    token: String,
    email: String,
    expires_at: u64,
    #[serde(default)]
    attempts: u8,
}

fn two_factor_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "No se pudo resolver el directorio home".to_string())?
        .join(".ixi4k")
        .join("admin_2fa.json"))
}

fn two_factor_pending_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "No se pudo resolver el directorio home".to_string())?
        .join(".ixi4k")
        .join("admin_2fa_pending.json"))
}

/// Escribe JSON con permisos 0600 en Unix (mismo criterio que la sesión).
fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "Ruta inválida".to_string())?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("No se pudo crear el directorio: {e}"))?;
    let raw = serde_json::to_string(value)
        .map_err(|_| "Error interno al serializar".to_string())?;
    std::fs::write(path, raw).map_err(|e| format!("No se pudo guardar: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn two_factor_read() -> Option<TwoFactorFile> {
    let path = two_factor_path().ok()?;
    read_json(&path)
}

fn two_factor_enabled() -> bool {
    two_factor_read().map(|f| f.enabled).unwrap_or(false)
}

fn base32_decode_secret(input: &str) -> Result<Vec<u8>, String> {
    let clean: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    data_encoding::BASE32_NOPAD
        .decode(clean.as_bytes())
        .map_err(|_| "Secreto TOTP inválido".to_string())
}

/// Código TOTP de 6 dígitos para un instante dado (SHA-1, 30 s, RFC 6238).
fn totp_at(secret_b32: &str, time_secs: u64) -> Result<String, String> {
    use hmac::Mac;
    let key = base32_decode_secret(secret_b32)?;
    let counter = time_secs / 30;
    let mut mac =
        HmacSha1::new_from_slice(&key).map_err(|_| "Clave TOTP inválida".to_string())?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let bin = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    Ok(format!("{:06}", bin % 1_000_000))
}

/// Verifica un código aceptando ±1 periodo de deriva de reloj.
fn totp_verify(secret_b32: &str, code: &str) -> bool {
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let now = unix_now();
    for t in [now.saturating_sub(30), now, now + 30] {
        if let Ok(expected) = totp_at(secret_b32, t) {
            if expected == code {
                return true;
            }
        }
    }
    false
}

/// Secreto aleatorio de 20 bytes (OS RNG vía uuid v4) en base32 mayúsculas.
fn generate_totp_secret() -> String {
    let a = uuid::Uuid::new_v4();
    let b = uuid::Uuid::new_v4();
    let mut bytes = [0u8; 20];
    bytes[..16].copy_from_slice(a.as_bytes());
    bytes[16..].copy_from_slice(&b.as_bytes()[..4]);
    data_encoding::BASE32_NOPAD.encode(&bytes)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TwoFactorStatus {
    enabled: bool,
    configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TwoFactorSetup {
    secret: String,
    otpauth_uri: String,
}

/// Toda operación sobre el 2FA exige una sesión admin válida.
fn require_admin_session(token: &str) -> Result<(), String> {
    if sessions_verify(token) {
        return Ok(());
    }
    let path = admin_session_path()?;
    if verify_admin_session_at(&path, token) {
        return Ok(());
    }
    Err("SESSION_INVALID".to_string())
}

#[tauri::command]
fn two_factor_status() -> Result<TwoFactorStatus, String> {
    let file = two_factor_read();
    Ok(TwoFactorStatus {
        enabled: file.as_ref().map(|f| f.enabled).unwrap_or(false),
        configured: file
            .as_ref()
            .map(|f| !f.secret.is_empty())
            .unwrap_or(false),
    })
}

/// Paso 1: genera (o reutiliza) el secreto pendiente de activación.
#[tauri::command]
fn two_factor_setup(admin_token: String) -> Result<TwoFactorSetup, String> {
    require_admin_session(&admin_token)?;
    let mut file = two_factor_read().unwrap_or(TwoFactorFile {
        secret: String::new(),
        enabled: false,
        enabled_at: None,
    });
    if file.enabled {
        return Err("2FA_ALREADY_ENABLED".to_string());
    }
    if file.secret.is_empty() {
        file.secret = generate_totp_secret();
        write_private_json(&two_factor_path()?, &file)?;
    }
    let label = admin_credentials()
        .map(|(e, _)| e)
        .unwrap_or_else(|_| "admin".to_string());
    let otpauth = format!(
        "otpauth://totp/ixi%204k:{label}?secret={}&issuer=ixi%204k&algorithm=SHA1&digits=6&period=30",
        file.secret
    );
    Ok(TwoFactorSetup {
        secret: file.secret,
        otpauth_uri: otpauth,
    })
}

/// Paso 2: activa el 2FA verificando un código válido del secreto pendiente.
#[tauri::command]
fn two_factor_enable(admin_token: String, code: String) -> Result<TwoFactorStatus, String> {
    require_admin_session(&admin_token)?;
    let mut file = two_factor_read().ok_or_else(|| "2FA_NOT_CONFIGURED".to_string())?;
    if file.enabled {
        return Err("2FA_ALREADY_ENABLED".to_string());
    }
    if !totp_verify(&file.secret, &code) {
        return Err("INVALID_CODE".to_string());
    }
    file.enabled = true;
    file.enabled_at = Some(unix_now());
    write_private_json(&two_factor_path()?, &file)?;
    Ok(TwoFactorStatus {
        enabled: true,
        configured: true,
    })
}

/// Desactiva el 2FA (exige sesión admin + código vigente).
#[tauri::command]
fn two_factor_disable(admin_token: String, code: String) -> Result<TwoFactorStatus, String> {
    require_admin_session(&admin_token)?;
    let file = two_factor_read().ok_or_else(|| "2FA_NOT_CONFIGURED".to_string())?;
    if !file.enabled {
        return Err("2FA_NOT_ENABLED".to_string());
    }
    if !totp_verify(&file.secret, &code) {
        return Err("INVALID_CODE".to_string());
    }
    let _ = std::fs::remove_file(two_factor_path()?);
    // Los tokens pendientes de otros logins dejan de servir
    let _ = std::fs::remove_file(two_factor_pending_path()?);
    Ok(TwoFactorStatus {
        enabled: false,
        configured: false,
    })
}

/// Intercambia el token PENDIENTE por la sesión real verificando el código.
#[tauri::command]
fn two_factor_verify_login(
    token: String,
    code: String,
    device: Option<String>,
) -> Result<LoginResult, String> {
    let pending_path = two_factor_pending_path()?;
    let mut pending: TwoFactorPending =
        read_json(&pending_path).ok_or_else(|| "SESSION_EXPIRED".to_string())?;
    if pending.token != token || pending.expires_at <= unix_now() {
        let _ = std::fs::remove_file(&pending_path);
        return Err("SESSION_EXPIRED".to_string());
    }
    let file = two_factor_read().ok_or_else(|| "2FA_NOT_ENABLED".to_string())?;
    if !file.enabled {
        let _ = std::fs::remove_file(&pending_path);
        return Err("2FA_NOT_ENABLED".to_string());
    }
    if pending.attempts >= TWO_FACTOR_MAX_ATTEMPTS {
        let _ = std::fs::remove_file(&pending_path);
        return Err("RATE_LIMITED:60".to_string());
    }
    if !totp_verify(&file.secret, &code) {
        pending.attempts += 1;
        let _ = write_private_json(&pending_path, &pending);
        return Err("INVALID_CODE".to_string());
    }
    let _ = std::fs::remove_file(&pending_path);
    let path = admin_session_path()?;
    let (new_token, expires_at) =
        issue_admin_session_at(&path, &pending.email, ADMIN_SESSION_TTL_SECS)?;
    sessions_issue(&new_token, &pending.email, device.as_deref());
    Ok(LoginResult {
        role: ROLE_ADMIN.to_string(),
        token: Some(new_token),
        expires_at: Some(expires_at),
        two_factor_required: None,
    })
}

// ---------------------------------------------------------------------------
// SESIONES ACTIVAS DE ADMINISTRADOR — visibilidad y cierre remoto
//
// Registro multi-sesión en ~/.ixi4k/admin_sessions.json (0600). Cada login
// añade una entrada con dispositivo/host/IP; el panel puede listarlas y
// revocarlas a distancia. El fichero legacy admin_session.json sigue
// conteniendo la sesión "actual" para el flujo de validación existente.
// Los tokens NUNCA salen del backend en las listas.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEntry {
    id: String,
    token: String,
    email: String,
    device: String,
    hostname: String,
    ip: String,
    created_at: u64,
    last_seen: u64,
    expires_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionRegistry {
    #[serde(default)]
    sessions: Vec<SessionEntry>,
}

fn sessions_registry_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "No se pudo resolver el directorio home".to_string())?
        .join(".ixi4k")
        .join("admin_sessions.json"))
}

fn sessions_read_at(path: &Path) -> SessionRegistry {
    let mut reg: SessionRegistry = read_json(path).unwrap_or_default();
    let now = unix_now();
    reg.sessions.retain(|s| s.expires_at > now); // poda de caducadas
    reg
}

fn sessions_write_at(path: &Path, reg: &SessionRegistry) -> Result<(), String> {
    write_private_json(path, reg)
}

fn sessions_read() -> SessionRegistry {
    match sessions_registry_path() {
        Ok(path) => sessions_read_at(&path),
        Err(_) => SessionRegistry::default(),
    }
}

fn sessions_write(reg: &SessionRegistry) -> Result<(), String> {
    sessions_write_at(&sessions_registry_path()?, reg)
}

fn sessions_issue_at(path: &Path, token: &str, email: &str, device: Option<&str>) {
    let mut reg = sessions_read_at(path);
    let now = unix_now();
    let entry = SessionEntry {
        id: uuid::Uuid::new_v4().simple().to_string(),
        token: token.to_string(),
        email: email.trim().to_lowercase(),
        device: device
            .filter(|d| !d.trim().is_empty())
            .unwrap_or("Dispositivo desconocido")
            .to_string(),
        hostname: hostname(),
        ip: local_ip_address(),
        created_at: now,
        last_seen: now,
        expires_at: now + ADMIN_SESSION_TTL_SECS,
    };
    reg.sessions.retain(|s| s.token != token);
    reg.sessions.push(entry);
    let _ = sessions_write_at(path, &reg); // un fallo de auditoría no bloquea el login
}

fn sessions_issue(token: &str, email: &str, device: Option<&str>) {
    if let Ok(path) = sessions_registry_path() {
        sessions_issue_at(&path, token, email, device);
    }
}

/// ¿Es este token una sesión admin viva? (marca última actividad si cambia)
fn sessions_verify_at(path: &Path, token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    let mut reg = sessions_read_at(path);
    let now = unix_now();
    let Some(entry) = reg
        .sessions
        .iter_mut()
        .find(|s| s.token == token && s.expires_at > now)
    else {
        return false;
    };
    if entry.last_seen != now {
        entry.last_seen = now;
        let _ = sessions_write_at(path, &reg);
    }
    true
}

fn sessions_verify(token: &str) -> bool {
    match sessions_registry_path() {
        Ok(path) => sessions_verify_at(&path, token),
        Err(_) => false,
    }
}

fn sessions_remove_token_at(path: &Path, token: &str) -> bool {
    let mut reg = sessions_read_at(path);
    let before = reg.sessions.len();
    reg.sessions.retain(|s| s.token != token);
    let removed = reg.sessions.len() != before;
    if removed {
        let _ = sessions_write_at(path, &reg);
    }
    removed
}

fn sessions_remove_token(token: &str) -> bool {
    match sessions_registry_path() {
        Ok(path) => sessions_remove_token_at(&path, token),
        Err(_) => false,
    }
}

fn sessions_remove_by_id_at(path: &Path, id: &str) -> Option<SessionEntry> {
    let mut reg = sessions_read_at(path);
    let pos = reg.sessions.iter().position(|s| s.id == id)?;
    let entry = reg.sessions.remove(pos);
    let _ = sessions_write_at(path, &reg);
    Some(entry)
}

fn sessions_remove_by_id(id: &str) -> Option<SessionEntry> {
    let path = sessions_registry_path().ok()?;
    sessions_remove_by_id_at(&path, id)
}

fn sessions_remove_others_at(path: &Path, keep_token: &str) -> u32 {
    let mut reg = sessions_read_at(path);
    let before = reg.sessions.len();
    reg.sessions.retain(|s| s.token == keep_token);
    let removed = (before - reg.sessions.len()) as u32;
    if removed > 0 {
        let _ = sessions_write_at(path, &reg);
    }
    removed
}

fn sessions_remove_others(keep_token: &str) -> u32 {
    match sessions_registry_path() {
        Ok(path) => sessions_remove_others_at(&path, keep_token),
        Err(_) => 0,
    }
}

/// Vista para el panel — NUNCA incluye tokens.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionView {
    id: String,
    device: String,
    hostname: String,
    ip: String,
    created_at: u64,
    last_seen: u64,
    expires_at: u64,
    current: bool,
}

/// Migra al registro la sesión actual si solo existe en el fichero legacy
/// (emitida por una versión anterior de la app).
fn ensure_current_in_registry(admin_token: &str) {
    let path = match admin_session_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(session) = serde_json::from_str::<AdminSessionFile>(&raw) else {
        return;
    };
    if session.token != admin_token || session.expires_at <= unix_now() {
        return;
    }
    let mut reg = sessions_read();
    if reg.sessions.iter().any(|s| s.token == admin_token) {
        return;
    }
    reg.sessions.push(SessionEntry {
        id: uuid::Uuid::new_v4().simple().to_string(),
        token: admin_token.to_string(),
        email: session.email.clone(),
        device: "Dispositivo actual".to_string(),
        hostname: hostname(),
        ip: local_ip_address(),
        created_at: unix_now(),
        last_seen: unix_now(),
        expires_at: session.expires_at,
    });
    let _ = sessions_write(&reg);
}

#[tauri::command]
fn list_admin_sessions(admin_token: String) -> Result<Vec<SessionView>, String> {
    require_admin_session(&admin_token)?;
    ensure_current_in_registry(&admin_token);
    let reg = sessions_read();
    Ok(reg
        .sessions
        .iter()
        .map(|s| SessionView {
            id: s.id.clone(),
            device: s.device.clone(),
            hostname: s.hostname.clone(),
            ip: s.ip.clone(),
            created_at: s.created_at,
            last_seen: s.last_seen,
            expires_at: s.expires_at,
            current: s.token == admin_token,
        })
        .collect())
}

#[tauri::command]
fn revoke_admin_session_by_id(admin_token: String, id: String) -> Result<bool, String> {
    require_admin_session(&admin_token)?;
    let entry = sessions_remove_by_id(&id).ok_or_else(|| "SESSION_NOT_FOUND".to_string())?;
    if entry.token == admin_token {
        // Se revoca la sesión ACTUAL → además se limpia el fichero legacy
        let path = admin_session_path()?;
        let _ = revoke_admin_session_at(&path, &entry.token);
    }
    Ok(true)
}

#[tauri::command]
fn revoke_other_admin_sessions(admin_token: String) -> Result<u32, String> {
    require_admin_session(&admin_token)?;
    Ok(sessions_remove_others(&admin_token))
}

/// Renderizado con el motor ixi 4k (`render.rs`):
///  · los AJUSTES de la UI afectan realmente al vídeo exportado
///  · aceleración por hardware con reserva automática a CPU
///  · progreso REAL (%, FPS, ETA, resolución y aceleración) → `export-progress`
///  · rutas saneadas y argumentos aislados (sin shell → sin inyección)
#[tauri::command]
async fn process_video(
    input_path: String,
    output_path: String,
    file_size: Option<u64>,
    settings: Option<RenderSettings>,
    window: tauri::Window,
) -> Result<String, String> {
    let settings = settings.unwrap_or_default();

    // Origen: la webview solo entrega el nombre del archivo, así que el
    // backend localiza la ruta real (nombre + tamaño, con presupuesto). Si no
    // es unívoco devuelve `ARCHIVO_ORIGEN:` y la UI abre el selector nativo
    // en lugar de procesar a ciegas otro archivo.
    let input =
        render::resolve_media_path(&input_path, file_size, &render::media_search_roots())?;
    // Validación de salida (solo dentro del directorio de exportación)
    let output = sanitize_output_path(&output_path)?;

    // Fuente + hardware disponibles (un solo sondeo, cacheado)
    let source = render::probe_source(&input).await?;
    let hw = render::detect_hardware().await;
    let mut plan = render::build_plan(&settings, &source, &hw);
    // Comando real que se va a ejecutar (la UI lo muestra sin inventar nada)
    plan.command = plan.command_display(&input, &output);
    let output_str = output.to_string_lossy().to_string();

    let w = window.clone();
    let report = render::run_render(&plan, &input, &output, move |ev| {
        let _ = w.emit("export-progress", ev);
    })
    .await?;

    // Informe final para que la UI muestre lo realmente ejecutado
    let _ = window.emit("export-complete", &output_str);
    let _ = window.emit("export-report", &report);
    Ok(output_str)
}

#[tauri::command]
async fn get_video_info(path: String) -> Result<serde_json::Value, String> {
    let safe = sanitize_path(&path, true)?;
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(&safe)
        .output()
        .map_err(|e| format!("Error obteniendo info del vídeo: {e}"))?;

    if output.status.success() {
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Error parseando info: {e}"))
    } else {
        Err("No se pudo obtener información del vídeo".to_string())
    }
}

#[tauri::command]
async fn open_downloads_folder(path: String) -> Result<(), String> {
    let safe = sanitize_path(&path, false)?;

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg("/select,").arg(&safe);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg("-R").arg(&safe);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&safe);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("Error abriendo carpeta: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ALMACENAMIENTO SEGURO DE SESIONES — gestor de credenciales del SO
// (Windows Credential Manager / macOS Keychain / Linux Secret Service)
// ---------------------------------------------------------------------------
fn validate_store_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 64 {
        return Err("Clave de almacenamiento inválida".to_string());
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Clave de almacenamiento con caracteres no permitidos".to_string());
    }
    Ok(())
}

#[tauri::command]
fn secure_store_save(key: String, value: String) -> Result<(), String> {
    validate_store_key(&key)?;
    if value.len() > 64 * 1024 {
        return Err("Valor demasiado grande para el keyring".to_string());
    }
    let entry = Entry::new(STORE_NAMESPACE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_store_load(key: String) -> Result<Option<String>, String> {
    validate_store_key(&key)?;
    let entry = Entry::new(STORE_NAMESPACE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secure_store_delete(key: String) -> Result<(), String> {
    validate_store_key(&key)?;
    let entry = Entry::new(STORE_NAMESPACE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// INFO DE DISPOSITIVO para auditoría de seguridad (IP + hostname + ID)
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    device_id: String,
    hostname: String,
    ip: String,
    platform: String,
}

fn local_ip_address() -> String {
    // Determina la IP local de salida sin crear conexiones reales
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "desconocido".to_string())
}

#[tauri::command]
fn get_device_info() -> Result<DeviceInfo, String> {
    // ID de dispositivo persistente en el keyring
    let device_id = match Entry::new(STORE_NAMESPACE, "device_id") {
        Ok(entry) => match entry.get_password() {
            Ok(id) if !id.is_empty() => id,
            _ => {
                let new_id = uuid::Uuid::new_v4().to_string();
                let _ = entry.set_password(&new_id);
                new_id
            }
        },
        Err(_) => uuid::Uuid::new_v4().to_string(),
    };

    Ok(DeviceInfo {
        device_id,
        hostname: hostname(),
        ip: local_ip_address(),
        platform: std::env::consts::OS.to_string(),
    })
}

// ---------------------------------------------------------------------------
// GPU — chip "RTX ACTIVE" de la interfaz (hardware verificado, nunca inventado)
// ---------------------------------------------------------------------------

/// Extrae la primera línea no vacía de la salida CSV de `nvidia-smi`.
fn parse_gpu_name(raw: &str) -> String {
    raw.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Nombre real de la GPU NVIDIA consultando a `nvidia-smi`.
/// Sin la herramienta, sin GPU NVIDIA o con salida vacía → `Err`: la
/// interfaz sólo pinta "RTX ACTIVE" si existe un modelo RTX verificado.
#[tauri::command]
fn get_gpu_name() -> Result<String, String> {
    let output = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .output()
        .map_err(|e| format!("nvidia-smi no disponible: {e}"))?;
    if !output.status.success() {
        return Err("nvidia-smi devolvió un error".to_string());
    }
    let name = parse_gpu_name(&String::from_utf8_lossy(&output.stdout));
    if name.is_empty() {
        Err("sin nombre de GPU".to_string())
    } else {
        Ok(name)
    }
}

#[cfg(test)]
mod gpu_name_tests {
    use super::parse_gpu_name;

    #[test]
    fn parse_gpu_name_toma_la_primera_linea_no_vacia() {
        assert_eq!(
            parse_gpu_name("NVIDIA GeForce RTX 5060 Ti\n"),
            "NVIDIA GeForce RTX 5060 Ti"
        );
        assert_eq!(
            parse_gpu_name("  NVIDIA GeForce RTX 4060 \n\n"),
            "NVIDIA GeForce RTX 4060"
        );
    }

    #[test]
    fn parse_gpu_name_vacio_devuelve_cadena_vacia() {
        assert_eq!(parse_gpu_name(""), "");
        assert_eq!(parse_gpu_name("\n \n"), "");
    }
}

// ---------------------------------------------------------------------------
// CACHÉ DEL WEBVIEW2 — invalidación tras una actualización
//
// El WebView2 (motor Chromium) cachea `index.html` y el service worker de ixi
// 4k. Si el usuario actualiza la app, esa caché serviría la interfaz ANTIGUA y
// la pantalla de selección Usuario/Administrador no llegaría nunca a cargar.
// Por eso, cuando cambia el binario (versión nueva o build nuevo) purgamos
// únicamente las carpetas de caché del navegador. NO se tocan localStorage,
// las contraseñas guardadas, el historial ni el keyring de sesiones.
// ---------------------------------------------------------------------------

/// `identifier` de la app en tauri.conf.json (carpeta del perfil WebView2).
const WEBVIEW_PROFILE_DIR: &str = "com.ixi4k.studio";

/// Carpetas de caché descartables del perfil (se regeneran solas).
const WEBVIEW_CACHE_DIRS: [&str; 4] = ["Cache", "Code Cache", "Service Worker", "GPUCache"];

/// Borra la caché de WebView2 solo si `fingerprint` no coincide con el marker.
/// Devuelve `true` si ha purgado. Nunca falla: cualquier error se ignora.
fn purge_webview_cache_if_stale(cache_root: &Path, marker: &Path, fingerprint: &str) -> bool {
    if std::fs::read_to_string(marker)
        .map(|prev| prev == fingerprint)
        .unwrap_or(false)
    {
        return false; // misma versión del binario → la caché sigue siendo válida
    }

    let profile = cache_root
        .join(WEBVIEW_PROFILE_DIR)
        .join("EBWebView")
        .join("Default");
    for dir in WEBVIEW_CACHE_DIRS {
        let _ = std::fs::remove_dir_all(profile.join(dir));
    }

    if let Some(parent) = marker.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(marker, fingerprint).is_ok()
}

/// Identidad del binario actual (tamaño + fecha de modificación).
fn current_binary_fingerprint() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let meta = std::fs::metadata(&exe).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(format!("{}|{}", meta.len(), mtime))
}

/// Punto de entrada: invalida la caché antigua ANTES de crear el WebView2.
fn purge_stale_webview_cache() {
    let Some(fingerprint) = current_binary_fingerprint() else {
        return;
    };
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let marker = home.join(".ixi4k").join("webview_cache.fingerprint");
    let Some(cache_root) = dirs::cache_dir() else {
        return;
    };
    purge_webview_cache_if_stale(&cache_root, &marker, &fingerprint);
}

fn main() {
    // Tras una actualización, sirve el frontend nuevo (nunca uno cacheado)
    purge_stale_webview_cache();

    tauri::Builder::default()
        .manage(AppState {
            login_attempts: Mutex::new(Vec::new()),
            admin_login_attempts: Mutex::new(Vec::new()),
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            check_ffmpeg,
            get_downloads_path,
            get_export_directory,
            get_platform_info,
            record_login_attempt,
            verify_admin_credentials,
            login_with_role,
            verify_admin_session,
            revoke_admin_session,
            process_video,
            get_video_info,
            open_downloads_folder,
            secure_store_save,
            secure_store_load,
            secure_store_delete,
            get_device_info,
            get_gpu_name,
            two_factor_status,
            two_factor_setup,
            two_factor_enable,
            two_factor_disable,
            two_factor_verify_login,
            list_admin_sessions,
            revoke_admin_session_by_id,
            revoke_other_admin_sessions,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod admin_security_tests {
    use super::admin_credentials;

    /// bcrypt (crate Rust) y bcryptjs (usado por `npm run admin:setup`)
    /// deben ser compatibles entre sí en ambos sentidos.
    #[test]
    fn bcrypt_round_trip() {
        let hash = bcrypt::hash("ixi4k-test-password", 4).expect("hash");
        assert!(bcrypt::verify("ixi4k-test-password", &hash).expect("verify"));
        assert!(!bcrypt::verify("password-incorrecta", &hash).expect("verify"));
    }

    /// Si existe el secreto local (fuera del repositorio), el backend debe
    /// poder leerlo y descartar contraseñas incorrectas sin exponer nada.
    #[test]
    fn local_admin_secret_is_verifiable() {
        let Ok((email, hash)) = admin_credentials() else {
            return; // sin configurar → también es un estado válido (denegado)
        };
        assert!(!email.is_empty());
        // El hash debe ser parseable por bcrypt (formato $2b$ de bcryptjs)
        assert!(
            bcrypt::verify("esta-contrase\u{f1}a-no-es-la-correcta", &hash).is_ok(),
            "el hash almacenado no es un bcrypt válido"
        );
        assert!(!bcrypt::verify("esta-contrase\u{f1}a-no-es-la-correcta", &hash).unwrap());
    }

    /// El comando IPC debe denegar siempre contraseñas incorrectas
    /// (y devolver ADMIN_NOT_CONFIGURED cuando no hay secretos).
    #[test]
    fn verify_command_denies_wrong_password() {
        match crate::verify_admin_credentials(
            "no-existe@ejemplo.com".to_string(),
            "password-incorrecta".to_string(),
        ) {
            Ok(allowed) => assert!(!allowed),
            Err(err) => assert_eq!(err, super::ADMIN_NOT_CONFIGURED),
        }
    }

    // -------------------------------------------------------------------------
    // Rol Usuario / Administrador (lo decide SIEMPRE el backend)
    // -------------------------------------------------------------------------

    use super::{
        issue_admin_session_at, login_with_role_inner, resolve_admin_role,
        revoke_admin_session_at, verify_admin_session_at, ROLE_ADMIN, ROLE_USER,
    };

    fn temp_session_path() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ixi4k-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("directorio temporal");
        dir.join("admin_session.json")
    }

    /// El rol admin solo se emite con las credenciales exactas del backend.
    #[test]
    fn role_admin_requires_backend_credentials() {
        let hash = bcrypt::hash("contrase\u{f1}a-de-prueba", 4).expect("hash");
        assert!(resolve_admin_role(
            "Admin@Ejemplo.com ",
            "contrase\u{f1}a-de-prueba",
            "admin@ejemplo.com",
            &hash
        ));
        assert!(!resolve_admin_role(
            "admin@ejemplo.com",
            "contrase\u{f1}a-mala",
            "admin@ejemplo.com",
            &hash
        ));
        assert!(!resolve_admin_role(
            "otro@ejemplo.com",
            "contrase\u{f1}a-de-prueba",
            "admin@ejemplo.com",
            &hash
        ));
    }

    /// login con rol: el admin recibe token; el resto recibe rol "user" sin token.
    #[test]
    fn login_with_role_issues_token_only_for_admin() {
        let path = temp_session_path();
        let hash = bcrypt::hash("secreto-admin", 4).expect("hash");
        let attempts = std::sync::Mutex::new(Vec::new());
        let admin = Some(("admin@ejemplo.com", hash.as_str()));

        // Usuario normal → rol "user" y SIN sesión admin emitida
        let user = login_with_role_inner(
            &attempts,
            "normal@ejemplo.com",
            "secreto-admin",
            admin,
            Some(&path),
        )
        .expect("login usuario normal");
        assert_eq!(user.role, ROLE_USER);
        assert!(user.token.is_none());
        assert!(!path.exists(), "un usuario normal no emite sesión admin");

        // Email admin con contraseña incorrecta → rol "user", sin token
        let wrong = login_with_role_inner(
            &attempts,
            "admin@ejemplo.com",
            "contrase\u{f1}a-mala",
            admin,
            Some(&path),
        )
        .expect("login con credenciales incorrectas");
        assert_eq!(wrong.role, ROLE_USER);
        assert!(wrong.token.is_none());
        assert!(!path.exists(), "no se emite sesión con credenciales malas");

        // Credenciales del administrador → rol "admin" + token emitido por el backend
        let ok = login_with_role_inner(
            &attempts,
            "admin@ejemplo.com",
            "secreto-admin",
            admin,
            Some(&path),
        )
        .expect("login admin");
        assert_eq!(ok.role, ROLE_ADMIN);
        let token = ok.token.expect("token de sesión");
        assert!(verify_admin_session_at(&path, &token));
        assert!(!verify_admin_session_at(&path, "token-inventado"));

        let _ = std::fs::remove_file(&path);
    }

    /// Sin secretos configurados nadie puede obtener el rol admin.
    #[test]
    fn login_without_configured_admin_never_grants_admin() {
        let path = temp_session_path();
        let attempts = std::sync::Mutex::new(Vec::new());
        let res = login_with_role_inner(
            &attempts,
            "cualquiera@ejemplo.com",
            "cualquier-contrase\u{f1}a",
            None,
            Some(&path),
        )
        .expect("login sin secretos");
        assert_eq!(res.role, ROLE_USER);
        assert!(res.token.is_none());
        let _ = std::fs::remove_file(&path);
    }

    /// 5 fallos sobre la cuenta admin → bloqueo RATE_LIMITED (60 s),
    /// mientras que los usuarios normales nunca se limitan.
    #[test]
    fn admin_login_is_rate_limited() {
        let path = temp_session_path();
        let hash = bcrypt::hash("secreto-admin", 4).expect("hash");
        let attempts = std::sync::Mutex::new(Vec::new());
        let admin = Some(("admin@ejemplo.com", hash.as_str()));

        for _ in 0..5 {
            let res = login_with_role_inner(
                &attempts,
                "admin@ejemplo.com",
                "contrase\u{f1}a-mala",
                admin,
                Some(&path),
            )
            .expect("intento fallido");
            assert_eq!(res.role, ROLE_USER);
        }

        // Sexto intento (aunque ahora sea correcto) → bloqueado
        let err = login_with_role_inner(
            &attempts,
            "admin@ejemplo.com",
            "secreto-admin",
            admin,
            Some(&path),
        )
        .expect_err("debe estar bloqueado por rate limiting");
        assert!(
            err.starts_with("RATE_LIMITED:"),
            "esperaba RATE_LIMITED, llegó: {err}"
        );

        // Un usuario normal sigue pudiendo entrar (no consume el contador)
        let res = login_with_role_inner(
            &attempts,
            "normal@ejemplo.com",
            "otra-contrase\u{f1}a",
            admin,
            Some(&path),
        )
        .expect("login usuario normal");
        assert_eq!(res.role, ROLE_USER);

        let _ = std::fs::remove_file(&path);
    }

    /// Una sesión caducada o revocada es denegada por el backend.
    #[test]
    fn admin_session_expires_and_revokes() {
        let path = temp_session_path();

        // Sin sesión emitida → cualquier token es inválido
        assert!(!verify_admin_session_at(&path, "token-inventado"));
        assert!(!verify_admin_session_at(&path, ""));

        // Token caducado → denegado
        std::fs::write(
            &path,
            r#"{"token":"tok","email":"admin@ejemplo.com","expires_at":1}"#,
        )
        .expect("escribir sesión caducada");
        assert!(!verify_admin_session_at(&path, "tok"), "sesión caducada denegada");

        // Sesión válida → emitida por el backend
        let (token, expires_at) =
            issue_admin_session_at(&path, "admin@ejemplo.com", 3600).expect("emitir sesión");
        assert!(expires_at > 0);
        assert!(verify_admin_session_at(&path, &token));
        assert!(!verify_admin_session_at(&path, "otro-token"));

        // Revocación en backend
        assert!(revoke_admin_session_at(&path, &token));
        assert!(!verify_admin_session_at(&path, &token), "sesión revocada denegada");

        let _ = std::fs::remove_file(&path);
    }
}

// ---------------------------------------------------------------------------
// 2FA (TOTP) y registro multi-sesión
// ---------------------------------------------------------------------------

#[cfg(test)]
mod two_factor_and_sessions_tests {
    use super::{
        generate_totp_secret, sessions_issue_at, sessions_read_at, sessions_remove_by_id_at,
        sessions_remove_others_at, sessions_remove_token_at, sessions_verify_at, totp_at,
        totp_verify, SessionEntry,
    };

    /// Vector de prueba del RFC 6238 (SHA-1, secreto ASCII "12345678901234567890").
    #[test]
    fn totp_matches_rfc6238_vector() {
        // El secreto ASCII en base32 (sin relleno, mayúsculas)
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let code = totp_at(secret, 59).expect("calcular código T=59");
        assert_eq!(code, "287082", "vector RFC 6238 T=59");
        let code_t = totp_at(secret, 1_111_111_109).expect("calcular código");
        assert_eq!(code_t, "081804", "vector RFC 6238 T=1111111109");
        let code_t2 = totp_at(secret, 2_000_000_000).expect("calcular código");
        assert_eq!(code_t2, "279037", "vector RFC 6238 T=2000000000");
    }

    /// El secreto generado valida su propio código y rechaza entradas corruptas.
    #[test]
    fn totp_verify_roundtrip_and_rejects_garbage() {
        let secret = generate_totp_secret();
        assert!(secret.len() >= 32, "secreto en base32 suficientemente largo");
        let now = super::unix_now();
        let code = totp_at(&secret, now).expect("código actual");
        assert!(totp_verify(&secret, &code), "acepta el código vigente");
        // Ventana de ±1 periodo: el código anterior también es válido
        let prev = totp_at(&secret, now - 30).expect("código periodo anterior");
        assert!(totp_verify(&secret, &prev), "acepta ±30 s de deriva");

        let wrong = if code == "000000" { "111111" } else { "000000" };
        assert!(!totp_verify(&secret, wrong), "rechaza otro código");
        assert!(!totp_verify(&secret, "12345"), "rechaza longitud != 6");
        assert!(!totp_verify(&secret, "abcdef"), "rechaza no numérico");
        assert!(!totp_verify(&secret, ""), "rechaza vacío");
        assert!(!totp_verify("no-es-base32!!", &code), "rechaza secreto corrupto");
    }

    /// Ciclo de vida del registro de sesiones: emitir, verificar, revocar.
    #[test]
    fn sessions_registry_lifecycle() {
        let dir = std::env::temp_dir().join(format!("ixi4k-sessions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("crear tmp");
        let path = dir.join("admin_sessions.json");

        // Dos dispositivos con sesión activa
        sessions_issue_at(&path, "tok-a", "Admin@Ejemplo.com", Some("windows · escritorio"));
        sessions_issue_at(&path, "tok-b", "Admin@Ejemplo.com", Some("android · movil"));
        assert!(sessions_verify_at(&path, "tok-a"));
        assert!(sessions_verify_at(&path, "tok-b"));
        assert!(!sessions_verify_at(&path, "tok-otro"));
        assert!(!sessions_verify_at(&path, ""));

        let reg = sessions_read_at(&path);
        assert_eq!(reg.sessions.len(), 2, "dos sesiones registradas");
        assert!(
            reg.sessions.iter().all(|s| s.email == "admin@ejemplo.com"),
            "email normalizado en minúsculas"
        );
        // Los tokens nunca salen en campos visibles del panel (solo id)
        assert!(reg.sessions.iter().all(|s| !s.id.is_empty()));

        // Cierre remoto de las demás sesiones (se conserva la actual)
        assert_eq!(sessions_remove_others_at(&path, "tok-a"), 1);
        assert!(sessions_verify_at(&path, "tok-a"), "la actual sigue viva");
        assert!(!sessions_verify_at(&path, "tok-b"), "la otra quedó revocada");

        // Revocación por id de la sesión restante
        let id = sessions_read_at(&path).sessions[0].id.clone();
        assert!(sessions_remove_by_id_at(&path, &id).is_some());
        assert!(!sessions_verify_at(&path, "tok-a"), "sin sesiones activas");
        assert!(sessions_read_at(&path).sessions.is_empty());

        // Revocación directa por token
        sessions_issue_at(&path, "tok-c", "admin@ejemplo.com", None);
        assert!(sessions_remove_token_at(&path, "tok-c"));
        assert!(!sessions_remove_token_at(&path, "tok-c"), "ya no existe");

        // Una sesión caducada se poda al leer
        sessions_issue_at(&path, "tok-d", "admin@ejemplo.com", None);
        let mut reg = sessions_read_at(&path);
        reg.sessions.push(SessionEntry {
            id: "caducada".into(),
            token: "tok-viejo".into(),
            email: "admin@ejemplo.com".into(),
            device: "legacy".into(),
            hostname: "h".into(),
            ip: "1.2.3.4".into(),
            created_at: 1,
            last_seen: 1,
            expires_at: 1, // en el pasado
        });
        super::sessions_write_at(&path, &reg).expect("escribir registro");
        let reg = sessions_read_at(&path);
        assert!(
            reg.sessions.iter().all(|s| s.token != "tok-viejo"),
            "las caducadas se podan al leer"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ---------------------------------------------------------------------------
// Arranque: la caché antigua del WebView2 no puede tapar el frontend nuevo
// ---------------------------------------------------------------------------

#[cfg(test)]
mod startup_tests {
    use super::{purge_webview_cache_if_stale, WEBVIEW_CACHE_DIRS, WEBVIEW_PROFILE_DIR};

    #[test]
    fn webview_cache_purged_only_when_binary_changes() {
        let root = std::env::temp_dir().join(format!("ixi4k-cache-{}", uuid::Uuid::new_v4()));
        let profile = root.join(WEBVIEW_PROFILE_DIR).join("EBWebView").join("Default");
        let marker = root.join("sub").join("marker");

        // Caché "del build anterior" (debe borrarse) + datos del usuario (no)
        for dir in WEBVIEW_CACHE_DIRS {
            let d = profile.join(dir);
            std::fs::create_dir_all(d.join("sub")).expect("crear caché");
            std::fs::write(d.join("sub").join("asset.js"), "antiguo").expect("asset");
        }
        let user_data = profile.join("Local Storage");
        std::fs::create_dir_all(&user_data).expect("datos usuario");
        std::fs::write(user_data.join("data"), "conservar").expect("dato");

        // Mismo binario que la última arrancada → la caché es válida, no se purga
        std::fs::create_dir_all(marker.parent().unwrap()).expect("dir marker");
        std::fs::write(&marker, "build-1").expect("marker");
        assert!(!purge_webview_cache_if_stale(&root, &marker, "build-1"));
        assert!(profile.join(WEBVIEW_CACHE_DIRS[0]).exists(), "misma versión: caché intacta");

        // Binario nuevo (actualización o build) → se purga solo la caché
        assert!(purge_webview_cache_if_stale(&root, &marker, "build-2"));
        for dir in WEBVIEW_CACHE_DIRS {
            assert!(!profile.join(dir).exists(), "la caché '{dir}' debía borrarse");
        }
        assert_eq!(std::fs::read_to_string(&marker).expect("marker"), "build-2");
        assert!(user_data.join("data").exists(), "los datos del usuario se conservan");

        // Siguiente arranque con el mismo binario → sin purga innecesaria
        assert!(!purge_webview_cache_if_stale(&root, &marker, "build-2"));

        let _ = std::fs::remove_dir_all(&root);
    }
}