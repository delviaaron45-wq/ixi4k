# ixi 4k — Compatibilidad Multiplataforma (PC + Móvil)

La app está construida con **Tauri v2** + React + Tailwind, por lo que compila
para **Windows / macOS / Linux** (escritorio) y **Android / iOS** (móvil).

---

## 1. Diseño de interfaz responsiva

### Escritorio (≥ 1024px)
- Diseño **split-screen**: vista previa (Before/After + Score) a la izquierda,
  panel **ixi 4k Pro Controls** fijo a la derecha (`w-80`).
- Sidebar de navegación completo (Editor, Mejoras, Anti-Shadowban, Analíticas,
  Reportar Problema).

### Móvil / Tablet (< 1024px)
- **Tab Bar inferior** con 4 pestañas táctiles:
  | Pestaña | Contenido |
  |---|---|
  | **Vista Previa** | Dropzone / Before-After + Score de Viralidad + Exportar |
  | **Ajustes 4K** | Resolución, FPS, Bitrate y botón de exportación |
  | **Filtros** | Presets de 1 clic + sliders en tiempo real |
  | **Admin** | Acceso al Panel Admin, reportes, estado del sistema y diagnóstico |
- Indicador animado de pestaña activa (Framer Motion `layoutId`, 60 fps).
- Soporte **safe-area** de iPhone (`env(safe-area-inset-bottom)` + `viewport-fit=cover`).
- Sidebar oculta; header compacto con acceso rápido a Admin y Reportes.

### Before/After con gestos táctiles
- El comparador usa **Pointer Events** (`pointerdown/move/up` + `setPointerCapture`),
  por lo que responde idéntico a **ratón, dedo y lápiz**.
- `touch-action: pan-y`: el arrastre horizontal mueve el slider mientras el
  scroll vertical sigue funcionando.
- Los controles internos (play/pausa y barra de progreso) llevan
  `data-slider-controls` para no desplazar el slider al tocarlos.

---

## 2. Exportación y renderizado por plataforma

### Destino automático (`export_directory()` en Rust)
| Plataforma | Destino |
|---|---|
| Windows / macOS / Linux | `~/Downloads` |
| Android | `/storage/emulated/0/Download` (o `EXTERNAL_STORAGE`) |
| iOS | `~/Documents` (Galería vía plugin de fotos, ver abajo) |

- Frontend: `get_export_directory()` → el store escribe el MP4 en esa ruta.
- `sanitize_output_path()` solo acepta rutas **dentro** del directorio de
  exportación de la plataforma activa (bloquea path traversal).

### Adaptación por gama del dispositivo (`platformService.ts`)
Se detecta RAM (`navigator.deviceMemory`), núcleos (`hardwareConcurrency`)
y plataforma:

| Tier | Dispositivo | Resoluciones | FPS | Bitrate máx. |
|---|---|---|---|---|
| `low` | Móvil ≤3GB o ≤4 núcleos | 1080p | 30 | 15 Mbps (CRF 20) |
| `medium` | Móvil gama media / PC modesta | 1080p, 2K | 30/60 | 30 Mbps (CRF 16) |
| `high` | PC potente / móvil gama alto | 1080p, 2K, 4K UHD | 30/60 | 50 Mbps "Modo Bestia" (CRF 14) |

- Las opciones no permitidas **no se muestran** y los ajustes actuales se
  recalculan automáticamente (`ProControlsPanel`).
- El panel muestra un badge con la gama detectada y avisa de que los ajustes
  están adaptados para evitar **sobrecalentamiento y falta de RAM**.
- Capacidad detectada también en la pestaña **Admin** móvil → "Diagnóstico
  del dispositivo".

### Guardar en la Galería (Android/iOS)
El código Rust ya contiene ramas `#[cfg(target_os = "android")]` y
`#[cfg(target_os = "ios")]` en `export_directory()`. Para publicar el vídeo
directamente en la **Galería/Carrete**, añade el plugin de media correspondiente
y marca el permiso (`READ_MEDIA_VIDEO` / `NSPhotoLibraryAddUsageDescription`).

---

## 3. Admin Panel + Modo Mantenimiento en móvil

- **Misma lógica y mismas credenciales** en escritorio y móvil
  (correo del administrador configurado → verificación bcrypt, rate-limit 5 intentos/min,
  mensaje de auditoría `Acceso No Autorizado: Credenciales de Administrador Incorrectas`).
- Acceso desde móvil:
  1. Pestaña **Admin** del Tab Bar → "Iniciar sesión Admin", o
  2. Botón 🛡️ **Admin** del header.
- El `AdminDashboard` es un overlay `fixed inset-0` con:
  - Header compacto (`flex-wrap`, etiqueta "Cerrar sesión" oculta en xs),
  - Tabs envueltos (`flex-wrap`),
  - Métricas en `grid-cols-2` en móvil,
  - Tablas con `min-w-[640px]` dentro de `overflow-x-auto` (scroll horizontal).
- El interruptor **Estado del Sistema** (Modo Mantenimiento) vive en la pestaña
  "Panel General" y funciona igual: al activarlo, los usuarios normales ven la
  pantalla de bloqueo neon y el admin mantiene acceso completo (banner en el header).
- El Tab Bar (z-40) queda por debajo del Admin Panel (z-50) y de los modales.

---

## 4. Cómo compilar para cada plataforma

```bash
# Escritorio (Windows / macOS / Linux)
npm run tauri dev
npm run tauri build

# Móvil (requiere Android Studio / Xcode + Tauri CLI)
npm run tauri android init      # una sola vez
npm run tauri ios init          # una sola vez (solo macOS)

npm run tauri android dev       # deploy en dispositivo/emulador Android
npm run tauri android build     # genera el .apk/.aab
npm run tauri ios dev           # deploy en iPhone (solo macOS)
```

### Dependencias de sistema (Linux/WSL)
```bash
sudo apt install build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

### Notas Tauri v2 móvil
- `identifier`: `com.ixi4k.studio` (usado por Android `applicationId` y iOS `bundleId`).
- En Android añade en `AndroidManifest.xml` los permisos de almacenamiento:
  `READ_EXTERNAL_STORAGE` / `READ_MEDIA_VIDEO` + `WRITE_EXTERNAL_STORAGE` (API ≤ 28).
- En iOS añade en `Info.plist`:
  `NSPhotoLibraryAddUsageDescription` para guardar en el Carrete.
- `src-tauri/gen/android` y `src-tauri/gen/apple` se generan con
  `tauri android init` / `tauri ios init`.
