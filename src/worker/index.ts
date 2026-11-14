import { Hono } from 'hono';
import { type AppEnv, requiereSesion } from './auth';

export const app = new Hono<AppEnv>();

// Rutas de /api que NO exigen sesión. Todo lo demás la exige por defecto.
export const RUTAS_PUBLICAS = new Set(['/api/health']);

app.use('/api/*', (c, next) => (RUTAS_PUBLICAS.has(c.req.path) ? next() : requiereSesion(c, next)));

app.get('/api/health', (c) => c.json({ ok: true, servicio: 'tulistanegra' }));

app.get('/api/sesion', (c) => c.json(c.var.sesion));

app.notFound((c) => c.json({ error: 'no_encontrado' }, 404));

export default {
  fetch: app.fetch,
  // Cron horario: solo envía avisos, nunca decide el acceso (SUS-03).
  async scheduled() {},
} satisfies ExportedHandler<Env>;
