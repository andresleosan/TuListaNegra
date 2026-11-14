import { Hono } from 'hono';
import { type AppEnv, requiereSesion } from './auth';
import { requiereNegocio } from './guardian';
import { registrarAvisos } from './avisos';
import { archivos } from './rutas/archivos';
import { cuadernos } from './rutas/cuadernos';
import { deudores } from './rutas/deudores';
import { negocio } from './rutas/negocio';
import { superadmin } from './rutas/superadmin';
import { suscripcion } from './rutas/suscripcion';
import { esSuperadmin } from './superadmin';

export const app = new Hono<AppEnv>();

/** Rutas de /api que NO exigen sesión. Todo lo demás la exige por defecto. */
export const RUTAS_PUBLICAS = new Set(['/api/health']);

/** Rutas con sesión que NO pasan por el guardián del negocio (aún no hay negocio, o tienen su propio control). */
export const sinNegocio = (metodo: string, ruta: string) =>
  ruta === '/api/sesion' || (ruta === '/api/negocio' && metodo === 'POST') || ruta.startsWith('/api/superadmin/');

app.use('/api/*', (c, next) => (RUTAS_PUBLICAS.has(c.req.path) ? next() : requiereSesion(c, next)));
app.use('/api/*', (c, next) =>
  RUTAS_PUBLICAS.has(c.req.path) || sinNegocio(c.req.method, c.req.path) ? next() : requiereNegocio(c, next),
);

app.get('/api/health', (c) => c.json({ ok: true, servicio: 'tulistanegra' }));
// `es_superadmin` solo sirve para que la app muestre el enlace a la consola; el permiso real se comprueba en cada ruta.
app.get('/api/sesion', (c) => c.json({ ...c.var.sesion, es_superadmin: esSuperadmin(c.var.sesion, c.env) }));
app.route('/api/negocio', negocio);
app.route('/api/deudores', deudores);
app.route('/api/suscripcion', suscripcion);
app.route('/api/archivos', archivos);
app.route('/api/cuadernos', cuadernos);
app.route('/api/superadmin', superadmin);

app.notFound((c) => c.json({ error: 'no_encontrado' }, 404));

export default {
  fetch: app.fetch,
  // Cron horario: solo envía avisos, nunca decide el acceso (SUS-03).
  async scheduled(controlador, env, ctx) {
    ctx.waitUntil(registrarAvisos(env.DB, controlador.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
