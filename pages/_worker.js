// tulistanegra.pages.dev: Pages sirve la app (dist/client) y solo /api/* llega aquí (ver _routes.json).
// Se reenvía tal cual al Worker `tulistanegra` por un service binding: sin salir a internet y con los mismos
// encabezados (Authorization, CF-Connecting-IP para los límites, firma del webhook). El Worker decide todo.
export default {
  fetch: (request, env) => env.API.fetch(request),
};
