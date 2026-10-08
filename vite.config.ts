import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'node:fs';
import { loadEnv } from 'vite';

/**
 * URL pública de la web (cambiar tras desplegar).
 * Se define en .env → VITE_SITE_URL. Ver .env.example y docs/SEO.md.
 */
const DEFAULT_SITE_URL = 'https://ixi4k.example.com';

/**
 * Sustituye %VITE_SITE_URL% en el HTML (canonical, Open Graph, Schema.org)
 * y en los ficheros SEO estáticos (robots.txt, sitemap.xml) tanto en dev
 * como en el build, para que canonical y sitemap siempre coincidan.
 */
function seoUrlsPlugin(siteUrl: string): Plugin {
  const fill = (text: string) => text.split('%VITE_SITE_URL%').join(siteUrl);
  const SEO_FILES = ['/robots.txt', '/sitemap.xml'];

  return {
    name: 'ixi4k:seo-urls',
    transformIndexHtml: (html) => fill(html),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0];
        if (!SEO_FILES.includes(pathname)) return next();
        const file = path.resolve(process.cwd(), 'public', pathname.slice(1));
        if (!fs.existsSync(file)) return next();
        res.setHeader(
          'Content-Type',
          pathname.endsWith('.xml') ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8'
        );
        res.end(fill(fs.readFileSync(file, 'utf8')));
      });
    },
    closeBundle() {
      for (const name of ['robots.txt', 'sitemap.xml']) {
        const file = path.resolve(process.cwd(), 'dist', name);
        if (fs.existsSync(file)) {
          fs.writeFileSync(file, fill(fs.readFileSync(file, 'utf8')));
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const siteUrl = (env.VITE_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
  // Versión real de la app (fuente única: package.json) — usada por las
  // estadísticas y el gestor de versiones del Panel Admin.
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
    version: string;
  };

  return {
    plugins: [react(), seoUrlsPlugin(siteUrl)],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      target: 'esnext',
      minify: 'esbuild',
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            motion: ['framer-motion'],
            icons: ['lucide-react'],
          },
        },
      },
    },
    server: {
      port: 1420,
      strictPort: true,
    },
  };
});
