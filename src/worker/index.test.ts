import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { app } from './index';

test('GET /api/health responde ok', async () => {
  const res = await app.request('/api/health', {}, env);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, servicio: 'tulistanegra' });
});

test('una ruta de API desconocida no revela nada sin sesión', async () => {
  const res = await app.request('/api/no-existe', {}, env);
  expect(res.status).toBe(401);
});

test('los interruptores arrancan apagados', () => {
  expect([env.SIGNUP_READY, env.AI_READY, env.WHATSAPP_SEND_READY, env.SEMAFORO_READY]).toEqual(['0', '0', '0', '0']);
});
