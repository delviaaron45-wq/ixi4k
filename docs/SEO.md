# ixi 4k — SEO, Sitemap y Google Search Console

Guía de lo implementado y de los pasos que quedan **pendientes de tu parte**
(no se ha creado ninguna cuenta ni credencial externa).

---

## 1. Qué está implementado

| Pieza | Fichero | Estado |
|---|---|---|
| Meta title | `index.html` | ✅ `ixi 4k \| Edits 4K optimizados para TikTok` |
| Meta description | `index.html` | ✅ |
| Canonical | `index.html` | ✅ `%VITE_SITE_URL%/` |
| Robots (index/follow) | `index.html` | ✅ `index, follow, max-image-preview:large` |
| Open Graph | `index.html` | ✅ type, url, title, description, image 1200×630 |
| Twitter/X Cards | `index.html` | ✅ `summary_large_image` |
| Favicon | `public/favicon.svg` + PNG 32/180 | ✅ |
| Schema.org | `index.html` | ✅ JSON-LD `WebSite` + `SoftwareApplication` |
| robots.txt | `public/robots.txt` | ✅ con `Sitemap:` |
| sitemap.xml | `public/sitemap.xml` | ✅ solo rutas públicas reales (`/`) |
| PWA manifest | `public/manifest.webmanifest` | ✅ |
| Service Worker | `public/sw.js` | ✅ (solo producción web) |
| Iconos PWA/OG | `public/icons/` | ✅ 32/180/192/512 + `og-1200x630.png` |
| Noindex de privados | `src/main.tsx` + robots.txt | ✅ |
| Sin secretos en el bundle | `src/services/authService.ts` | ✅ verificación en Rust |

### URL pública (canonical / sitemap)

La URL se define **una sola vez** en `.env`:

```bash
VITE_SITE_URL=https://tu-dominio.com
```

`vite.config.ts` sustituye `%VITE_SITE_URL%` en `index.html`, `robots.txt` y
`sitemap.xml` tanto en `dev` como en `build`, así canonical, OG y sitemap
siempre coinciden. Si no existe la variable se usa
`https://ixi4k.example.com` (placeholder) — **cámbialo antes de publicar**.

> Mientras `VITE_SITE_URL` apunte a un dominio de ejemplo, conviene marcar el
> sitio como *no publicado* en Search Console hasta tener el dominio real.

### Páginas indexables / no indexables

- **Indexable:** `/` (la única ruta pública existente).
- **No indexables:** `/admin`, `/dashboard`, `/panel`, `/app`, `/account`,
  `/login`, `/user`, `/private`, `/api`, cualquier URL con `?parámetros`,
  y todo el panel privado (marcado con `noindex` en tiempo de ejecución).
  El contenido privado además requiere sesión, así que Google no puede verlo.

### Regenerar iconos / imagen OG

```bash
sudo apt install librsvg2-bin        # una vez
bash scripts/generate-web-icons.sh
```

---

## 2. Pasos pendientes (tu parte)

### Añadir el sitio a Google Search Console
1. Abre <https://searchconsole.google.com> → **Añadir propiedad**.
2. Elige **Prefijo de URL** → `https://tu-dominio.com/`.
3. Verificación por **etiqueta HTML**: Search Console te da una etiqueta
   `<meta name="google-site-verification" content="XXXX">`.
   Pégala en el `<head>` de `index.html` (justo antes de `</head>`).
   *No se ha añadido ninguna etiqueta porque no existe aún ningún código de
   verificación real.*
4. Alternativa: verificar por **Archivo HTML** (sube el fichero que te da
   Google a `public/`) o por **DNS**.

### Enviar el sitemap
1. Search Console → **Sitemaps** → `sitemap.xml` → **Enviar**.
2. Comprueba después en **Cobertura** que `/` aparece como *Enviado, no
   indexado aún* (normal tarda unos días).
3. Usa **Inspección de URL** → `https://tu-dominio.com/` → **Solicitar
   indexación** para acelerar el primer rastreo.

### Antes de publicar
- [ ] `VITE_SITE_URL` con el dominio real.
- [ ] Etiqueta `google-site-verification`.
- [ ] Imagen OG accesible públicamente (`/icons/og-1200x630.png`).
- [ ] `npm run build` y comprobar `dist/robots.txt` y `dist/sitemap.xml`
      con la URL correcta.
- [ ] HTTPS activo (obligatorio para Search Console y para la PWA).
