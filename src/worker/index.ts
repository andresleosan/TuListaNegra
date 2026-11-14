import { Hono } from 'hono';
import { type AppEnv, requiereSesion } from './auth';
import { requiereNegocio } from './guardian';
import { enviarAvisos, registrarAvisos } from './avisos';
import { abonos } from './rutas/abonos';
import { archivos } from './rutas/archivos';
import { cobrosBot } from './rutas/cobros-bot';
import { cuadernos } from './rutas/cuadernos';
import { deudores } from './rutas/deudores';
import { ia } from './rutas/ia';
import { negocio } from './rutas/negocio';
import { superadmin } from './rutas/superadmin';
import { suscripcion } from './rutas/suscripcion';
import { whatsapp } from './rutas/whatsapp';
import { esSuperadmin } from './superadmin';

export const app = new Hono<AppEnv>();

/** Rutas de /api que NO exigen sesión. Todo lo demás la exige por defecto. El webhook se autentica con su firma HMAC. */
export const RUTAS_PUBLICAS = new Set(['/api/health', '/api/whatsapp/webhook']);

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
app.route('/api/cobros-bot', cobrosBot);
app.route('/api/abonos', abonos);
app.route('/api/ia', ia);
app.route('/api/superadmin', superadmin);
app.route('/api/whatsapp', whatsapp);

app.notFound((c) => c.json({ error: 'no_encontrado' }, 404));

export default {
  fetch: app.fetch,
  // Cron horario: registra los avisos y luego los envía al WhatsApp verificado del dueño; nunca decide el acceso (SUS-03, WAP-07).
  async scheduled(controlador, env, ctx) {
    const ahora = controlador.scheduledTime;
    ctx.waitUntil(registrarAvisos(env.DB, ahora).then(() => enviarAvisos(env, ahora)));
  },
} satisfies ExportedHandler<Env>;
