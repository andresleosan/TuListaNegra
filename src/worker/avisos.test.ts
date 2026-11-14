// SUS-03: el cron horario deja un aviso a 3 días, a 1 día y al vencer; nunca decide el acceso.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { avisoQueToca } from './avisos';
import worker from './index';
import { DIA, HORA, sembrarNegocio } from './test/datos';

const T = 1_800_000_000_000;
const base = { suspended_at: null, free_forever_at: null, subscription_plan: 'PASS_7D', grace_unlock_ends_at: null };

describe('avisoQueToca', () => {
  test.each([
    [7 * DIA, null],
    [3 * DIA + 1, null],
    [3 * DIA, 'TRES_DIAS'],
    [2 * DIA, 'TRES_DIAS'],
    [DIA + 1, 'TRES_DIAS'],
    [DIA, 'UN_DIA'],
    [HORA, 'UN_DIA'],
    [0, 'VENCIDO'],
    [-71 * HORA, 'VENCIDO'],
    [-72 * HORA, null], // vencido hace más de 3 días: no se avisa (evita avisos viejos al estrenar el cron)
  ])('faltando %i ms → %s', (falta, esperado) => {
    expect(avisoQueToca({ ...base, subscription_expires_at: T + falta }, T)).toBe(esperado);
  });

  test('la prueba de 3 días no recibe el aviso de 3 días (nace con 72 h), sí el de 1 día y el de vencido', () => {
    const prueba = { ...base, subscription_plan: 'TRIAL_3D' };
    expect(avisoQueToca({ ...prueba, subscription_expires_at: T + 2 * DIA }, T)).toBeNull();
    expect(avisoQueToca({ ...prueba, subscription_expires_at: T + HORA }, T)).toBe('UN_DIA');
    expect(avisoQueToca({ ...prueba, subscription_expires_at: T - HORA }, T)).toBe('VENCIDO');
  });

  test('gratis y suspendido no reciben avisos', () => {
    expect(avisoQueToca({ ...base, free_forever_at: T - DIA, subscription_expires_at: T + HORA }, T)).toBeNull();
    expect(avisoQueToca({ ...base, suspended_at: T - DIA, subscription_expires_at: T + HORA }, T)).toBeNull();
  });

  test('en el desbloqueo de 24 h no se avisa «vencido»; si el pago se rechaza, se avisa desde el fin del desbloqueo', () => {
    expect(avisoQueToca({ ...base, subscription_expires_at: T - DIA, grace_unlock_ends_at: T + HORA }, T)).toBeNull();
    // Venció hace 5 días, pero el desbloqueo terminó hace 1 hora (rechazo): cuenta desde ahí.
    expect(avisoQueToca({ ...base, subscription_expires_at: T - 5 * DIA, grace_unlock_ends_at: T - HORA }, T)).toBe('VENCIDO');
  });
});

async function correrCron(ahora: number) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: ahora, cron: '0 * * * *' }), env, ctx);
  await waitOnExecutionContext(ctx);
}

const avisos = async () =>
  (await env.DB.prepare('SELECT business_id, kind, expires_at, sent_at FROM subscription_notices ORDER BY business_id, kind, expires_at').all()).results;

describe('manejador scheduled', () => {
  test('deja un aviso por negocio y tipo, y correrlo otra vez no duplica', async () => {
    const ahora = Date.now();
    await sembrarNegocio('tres', { subscription_expires_at: ahora + 2 * DIA });
    await sembrarNegocio('uno', { subscription_expires_at: ahora + 5 * HORA });
    await sembrarNegocio('vencido', { subscription_expires_at: ahora - HORA });
    await sembrarNegocio('lejos', { subscription_expires_at: ahora + 10 * DIA });
    await sembrarNegocio('gratis', { subscription_expires_at: ahora + HORA, free_forever_at: ahora - DIA });
    await sembrarNegocio('suspendido', { subscription_expires_at: ahora + HORA, suspended_at: ahora - DIA });

    await correrCron(ahora);
    await correrCron(ahora + HORA);
    expect(await avisos()).toEqual([
      { business_id: 'bus_tres', kind: 'TRES_DIAS', expires_at: ahora + 2 * DIA, sent_at: null },
      { business_id: 'bus_uno', kind: 'UN_DIA', expires_at: ahora + 5 * HORA, sent_at: null },
      { business_id: 'bus_vencido', kind: 'VENCIDO', expires_at: ahora - HORA, sent_at: null },
    ]);
  });

  test('el mismo negocio recibe 3 días, luego 1 día y luego vencido, uno por vez', async () => {
    const ahora = Date.now();
    const vence = ahora + 3 * DIA;
    await sembrarNegocio('ciclo', { subscription_expires_at: vence });
    for (const momento of [ahora, ahora + 2 * DIA + HORA, vence + HORA, vence + 2 * HORA]) await correrCron(momento);
    expect((await avisos()).map((a) => a.kind)).toEqual(['TRES_DIAS', 'UN_DIA', 'VENCIDO']);
  });

  test('un pase nuevo (vencimiento distinto) vuelve a tener sus avisos', async () => {
    const ahora = Date.now();
    await sembrarNegocio('renueva', { subscription_expires_at: ahora + HORA });
    await correrCron(ahora);
    await env.DB.prepare('UPDATE businesses SET subscription_expires_at = ? WHERE id = ?').bind(ahora + 20 * HORA, 'bus_renueva').run();
    await correrCron(ahora + HORA);
    expect((await avisos()).map((a) => [a.kind, a.expires_at])).toEqual([
      ['UN_DIA', ahora + HORA],
      ['UN_DIA', ahora + 20 * HORA],
    ]);
  });

  test('no cambia nada del negocio: el cron no decide el acceso', async () => {
    const ahora = Date.now();
    const antes = await sembrarNegocio('quieto', { subscription_expires_at: ahora - HORA });
    await correrCron(ahora);
    expect(await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind('bus_quieto').first()).toEqual(antes);
  });
});
