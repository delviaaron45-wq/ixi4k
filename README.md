# ixi 4k — Studio

Optimizador de edits de películas/series para TikTok: **upscale a calidad
cinematográfica 4K + optimización 100% algoritmo** (anti-duplicate,
anti-shadowban, score de viralidad 0–100%).

Desktop y móvil con **Tauri v2 + React + Tailwind CSS + Framer Motion**.

---

## Arranque rápido

```bash
npm install

# Solo frontend (navegador, http://localhost:1420)
npm run dev

# App nativa completa (Windows/macOS/Linux)
npm run tauri dev

# Build de producción
npm run build          # frontend
npm run tauri build    # instalador nativo
```

> Compilación nativa (Linux/WSL):  
> `sudo apt install build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

---

## Estructura

```
src/
├── screens/          AuthScreen, Dashboard (split-screen + Tab Bar móvil)
├── components/       BeforeAfterSlider, ProControlsPanel, AdminDashboard,
│                     MobileTabBar, MobileAdminTab, MaintenanceScreen, ...
├── store/            useAppStore, useAdminStore, useReportStore, useMaintenanceStore
├── services/         authService (bcrypt), platformService (tier/dispositivo),
│                     secureSession (keyring), deviceInfo
src-tauri/src/
└── main.rs           Comandos seguros: sanitización de rutas, FFmpeg aislado,
                      get_export_directory / get_platform_info, keyring, auditoría
supabase/security/    RLS policies
docs/MOBILE.md        Guía multiplataforma PC + Android + iOS
```

---

## Funciones clave

- **Split-screen en PC** / **Tab Bar inferior en móvil**: Vista Previa ·
  Ajustes 4K · Filtros · Admin.
- **Before/After** arrastrable con ratón, dedo y lápiz (Pointer Events).
- **Safe Zone 9:16**, diagnóstico de bitrate y anti-duplicate
  (micro-zoom 1.5% + modulación de firma).
- **Pro Controls**: presets de 1 clic, sliders en tiempo real, resolución
  (1080p/2K/4K UHD), FPS y bitrate dinámicos según la **gama del dispositivo**.
- **Exportación automática** a `~/Downloads` (PC), almacenamiento de Android o
  Fotos (iOS) con toast de éxito y botón "Abrir carpeta".
- **Admin Panel**: métricas, ban de usuarios, logs de auditoría, inbox de
  reportes, alertas de seguridad y **Modo Mantenimiento** con pantalla de
  bloqueo neon (el admin mantiene acceso).
- **Seguridad**: sin claves estáticas, bcrypt + rate limiting (5/min), RLS de
  Supabase, args de FFmpeg aislados, sesiones en keyring, auditoría inmutable.

---

## Credenciales de administrador

**No hay ninguna credencial en el frontend** (ni contraseña, ni email, ni hash):
el bundle JavaScript que llega al navegador y a GitHub está limpio de secretos.

- La verificación bcrypt ocurre en el **backend nativo (Rust)** mediante el
  comando `verify_admin_credentials`.
- El hash vive **fuera del repositorio**: `~/.ixi4k/admin_credentials.json`
  (permisos 600), que se crea con:

```bash
npm run admin:setup
```

- Alternativa: variables de entorno del proceso
  `IXI4K_ADMIN_EMAIL` / `IXI4K_ADMIN_PASSWORD_HASH` (nunca se compilan).
- Web con Supabase Auth: `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.
- Rate limiting de 5 intentos/min en local y en Rust; los intentos fallidos
  se rechazan con `Acceso No Autorizado: Credenciales de Administrador Incorrectas`.

## SEO y PWA

- `index.html`: title, description, canonical, Open Graph, Twitter Cards,
  favicon/manifest y Schema.org (`WebSite` + `SoftwareApplication`).
- `public/robots.txt` (bloquea `/admin`, dashboards, APIs y parámetros) y
  `public/sitemap.xml` (solo la ruta pública `/`).
- PWA: `public/manifest.webmanifest` + `public/sw.js` (solo en producción web).
- La URL pública se define en `.env` → `VITE_SITE_URL`.
- Guía completa e instrucciones de Google Search Console: [`docs/SEO.md`](docs/SEO.md)

Más información: [`docs/MOBILE.md`](docs/MOBILE.md)
