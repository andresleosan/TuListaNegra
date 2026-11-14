// Service worker de TuListaNegra (MOS-05): guarda el esqueleto de la app (HTML, JS, CSS, fuentes, iconos) para abrirla
// sin red. Siempre va primero a la red y solo si no hay, usa lo guardado: con internet se comporta como sin él.
// NUNCA guarda /api/* ni /__dev/*: datos privados y sesión van siempre a la red (lo vigila scripts/check-release.mjs).
const CACHE = 'tln-esqueleto-v1'; // subir la versión al cambiar este archivo: al activar se borran las anteriores
const ESQUELETO = '/'; // la SPA es el mismo HTML en cualquier ruta
const DESTINOS = new Set(['document', 'script', 'style', 'font', 'image', 'manifest']);

const seGuarda = (url) => url.origin === location.origin && !/^\/(api|__dev)(\/|$)/.test(url.pathname);

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE).then((cache) => cache.add(ESQUELETO)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// En la primera carga la página se pidió antes de que existiera este worker: la página manda lo que ya cargó.
self.addEventListener('message', (evento) => {
  if (!Array.isArray(evento.data)) return;
  const urls = evento.data.filter((u) => typeof u === 'string' && seGuarda(new URL(u)));
  evento.waitUntil(caches.open(CACHE).then((cache) => Promise.all(urls.map((u) => cache.add(u).catch(() => {})))));
});

self.addEventListener('fetch', (evento) => {
  const pedido = evento.request;
  // Lo demás (fetch() de la app, otros orígenes, envíos) no se toca: va a la red como si no hubiera worker.
  if (pedido.method !== 'GET' || !DESTINOS.has(pedido.destination) || !seGuarda(new URL(pedido.url))) return;
  const clave = pedido.mode === 'navigate' ? ESQUELETO : pedido;
  evento.respondWith(
    fetch(pedido).then(
      (respuesta) => {
        if (respuesta.ok && respuesta.type === 'basic') {
          const copia = respuesta.clone();
          evento.waitUntil(caches.open(CACHE).then((cache) => cache.put(clave, copia)));
        }
        return respuesta;
      },
      // `ignoreVary`: lo guardado desde la página (sin cabecera Origin) sirve igual para un `<script type=module>`.
      () => caches.match(clave, { ignoreVary: true }).then((guardada) => guardada ?? Response.error()),
    ),
  );
});
