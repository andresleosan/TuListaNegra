import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fuentes.css';
import './styles/tokens.css';
import './styles/base.css';
import { App } from './App';

// PWA (MOS-05): el service worker deja abrir la app sin red. En desarrollo solo si se pide con
// `localStorage['tln-sw'] = '1'` (lo hace e2e/pwa.spec.ts): así no se mete entre el HMR y los demás recorridos.
if ('serviceWorker' in navigator && (import.meta.env.PROD || localStorage.getItem('tln-sw') === '1')) {
  const sw = navigator.serviceWorker;
  // Primera visita: lo que ya cargó la página no pasó por el worker; cuando toma el control, se le pide guardarlo.
  // Se espera a las fuentes: pudieron empezar a bajar antes y terminar después de que el worker tomara el control.
  const guardarLoCargado = () => sw.controller?.postMessage(performance.getEntriesByType('resource').map((r) => r.name));
  if (!sw.controller) sw.addEventListener('controllerchange', () => void document.fonts.ready.then(guardarLoCargado), { once: true });
  addEventListener('load', () => void sw.register('/sw.js').catch(() => {}));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
