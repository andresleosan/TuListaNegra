import { Hono } from 'hono';

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true, servicio: 'tulistanegra' }));

app.notFound((c) => c.json({ error: 'no_encontrado' }, 404));

export default {
  fetch: app.fetch,
  // Cron horario: solo envía avisos, nunca decide el acceso (SUS-03).
  async scheduled() {},
} satisfies ExportedHandler<Env>;
