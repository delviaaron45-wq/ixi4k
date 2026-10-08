import React from 'react';
import ReactDOM from 'react-dom/client';
import { AnimatePresence } from 'framer-motion';
import App from './App';
import './index.css';

/**
 * SEO defensivo: cualquier ruta privada (admin, dashboards, APIs…) se marca
 * con noindex para que Google nunca la incluya en el índice.
 * La página pública principal ("/") mantiene index, follow (en index.html).
 */
function applyRobotsMeta(): void {
  const PRIVATE_PATH =
    /^\/(admin|dashboard|panel|app|account|login|user|private|api)(\/|$|\?)/i;
  if (!PRIVATE_PATH.test(window.location.pathname)) return;

  let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'robots');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', 'noindex, nofollow');
}

/**
 * PWA: solo en builds web de producción (nunca en el binario Tauri ni en dev,
 * para no interferir con HMR ni con el protocolo tauri://).
 */
function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  if (!window.location.protocol.startsWith('http')) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}

applyRobotsMeta();
registerServiceWorker();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AnimatePresence mode="wait">
      <App />
    </AnimatePresence>
  </React.StrictMode>
);
