// AUT-03: estado calculado y permiso de cada ruta.
import { describe, expect, test } from 'vitest';
import type { EstadoNegocio } from '../shared/acceso';
import { cumple, requisitoDeRuta } from './guardian';
import { CUOTAS_GRATIS, cuotasDe, PLANES } from './planes';
import { DIA, EN_ESTADO, sembrarNegocio } from './test/datos';
import { api } from './test/sesion';

const ESTADOS = Object.keys(EN_ESTADO) as EstadoNegocio[];

describe('requisitoDeRuta', () => {
  test.each([
    ['GET', '/api/negocio', 'siempre'],
    ['PATCH', '/api/negocio', 'escribir'],
    ['GET', '/api/suscripcion/pases', 'no_suspendido'],
    ['POST', '/api/suscripcion/pagos', 'no_suspendido'],
    ['GET', '/api/suscripcion-falsa', 'ver'],
    ['POST', '/api/ia/orden', 'ia'],
    ['GET', '/api/ia/cuota', 'ia'],
    ['POST', '/api/cobros-bot/enviar', 'ia'],
    ['GET', '/api/deudores', 'ver'],
    ['HEAD', '/api/deudores', 'ver'],
    ['POST', '/api/deudores', 'escribir'],
    ['PUT', '/api/deudores/deb_1', 'escribir'],
    ['PATCH', '/api/deudores/deb_1', 'escribir'],
    ['DELETE', '/api/deudores/deb_1', 'escribir'],
    ['POST', '/api/deudores/deb_1/movimientos', 'escribir'],
    ['GET', '/api/archivos/k', 'ver'],
    ['POST', '/api/cualquier-ruta-nueva', 'escribir'],
  ])('%s %s → %s', (metodo, ruta, esperado) => {
    expect(requisitoDeRuta(metodo, ruta)).toBe(esperado);
  });
});

describe('cumple: tabla de B2 por requisito', () => {
  //                        siempre  no_susp  ver    escribir  ia
  test.each<[EstadoNegocio, boolean, boolean, boolean, boolean, boolean]>([
    ['TRIAL',              true,    true,    true,  true,     true],
    ['ACTIVE',             true,    true,    true,  true,     true],
    ['GRACE_UNLOCK_24H',   true,    true,    true,  true,     true],
    ['EXPIRED_READONLY',   true,    true,    true,  false,    false],
    ['SUSPENDED_BY_ADMIN', true,    false,   false, false,    false],
  ])('%s', (estado, siempre, noSuspendido, ver, escribir, ia) => {
    expect([cumple(estado, 'siempre'), cumple(estado, 'no_suspendido'), cumple(estado, 'ver'), cumple(estado, 'escribir'), cumple(estado, 'ia')])
      .toEqual([siempre, noSuspendido, ver, escribir, ia]);
  });
});

describe('el guardián en la API', () => {
  // 404 no_encontrado = el guardián dejó pasar (la ruta aún no existe); 403 = el guardián bloqueó.
  const PASA = 404;
  const BLOQUEA = 403;
  test.each<[EstadoNegocio, number, number, number, number]>([
    //                      ver      escribir  ia        suscripción
    ['TRIAL',              PASA,    PASA,     PASA,     PASA],
    ['ACTIVE',             PASA,    PASA,     PASA,     PASA],
    ['GRACE_UNLOCK_24H',   PASA,    PASA,     PASA,     PASA],
    ['EXPIRED_READONLY',   PASA,    BLOQUEA,  BLOQUEA,  PASA],
    ['SUSPENDED_BY_ADMIN', BLOQUEA, BLOQUEA,  BLOQUEA,  BLOQUEA],
  ])('%s', async (estado, ver, escribir, ia, suscripcion) => {
    await sembrarNegocio('uid_1', EN_ESTADO[estado]());
    const estados = await Promise.all([
      api('/api/ruta-de-lectura'),
      api('/api/ruta-de-escritura', {}, { method: 'POST' }),
      api('/api/ia/ruta-inexistente', {}, { method: 'POST' }),
      api('/api/suscripcion/ruta-inexistente', {}, { method: 'POST' }),
    ]);
    expect(estados.map((r) => r.status)).toEqual([ver, escribir, ia, suscripcion]);
    const propio = await api('/api/negocio');
    expect(propio.status).toBe(200);
    expect(await propio.json()).toMatchObject({ estado });
  });

  test('el bloqueo dice el estado, para que la app explique qué pasa', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    const res = await api('/api/x', {}, { method: 'POST' });
    expect(await res.json()).toEqual({ error: 'acceso_denegado', estado: 'EXPIRED_READONLY' });
  });

  test('una sesión sin negocio recibe 404 sin_negocio en las rutas de negocio', async () => {
    const res = await api('/api/negocio', { uid: 'uid_nuevo' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'sin_negocio' });
  });

  test('el negocio sale de la sesión: cada cuenta ve solo el suyo', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2', EN_ESTADO.EXPIRED_READONLY());
    expect(await (await api('/api/negocio', { uid: 'uid_1' })).json()).toMatchObject({ id: 'bus_uid_1', estado: 'ACTIVE' });
    expect(await (await api('/api/negocio', { uid: 'uid_2' })).json()).toMatchObject({ id: 'bus_uid_2', estado: 'EXPIRED_READONLY' });
  });

  test('un suspendido solo recibe el aviso y cómo contactar', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.SUSPENDED_BY_ADMIN());
    const cuerpo = await (await api('/api/negocio')).json();
    expect(cuerpo).toEqual({ estado: 'SUSPENDED_BY_ADMIN', permisos: { ver: false, escribir: false, ia: false }, contacto: null });
  });

  test('gratis sin vencimiento: activo aunque esté vencido, sin fecha de fin', async () => {
    await sembrarNegocio('uid_1', { ...EN_ESTADO.EXPIRED_READONLY(), free_forever_at: Date.now() });
    expect(await (await api('/api/negocio')).json()).toMatchObject({ estado: 'ACTIVE', gratis: true, vence_en: null, limites: CUOTAS_GRATIS });
  });
});

describe('límites del plan', () => {
  test('la tabla de planes de B2', () => {
    expect(Object.fromEntries(Object.entries(PLANES).map(([id, p]) => [id, [p.duracion_ms / DIA, p.precio_cop, p.cuotas.deudores, p.cuotas.ocr, p.cuotas.ia, p.cuotas.cobros]]))).toEqual({
      TRIAL_3D: [3, 0, 15, 3, 10, 5],
      PASS_7D: [7, 14_900, null, 10, 50, 40],
      PASS_15D: [15, 27_900, null, 25, 120, 100],
      PASS_30D: [30, 49_900, null, 60, 300, 250],
    });
    expect(CUOTAS_GRATIS).toEqual({ deudores: null, ocr: 60, ia: 300, cobros: 250 });
  });

  test('cuotasDe: la gratuidad manda sobre el plan', () => {
    expect(cuotasDe({ free_forever_at: null, subscription_plan: 'TRIAL_3D' }).deudores).toBe(15);
    expect(cuotasDe({ free_forever_at: 1, subscription_plan: 'TRIAL_3D' })).toBe(CUOTAS_GRATIS);
  });

  test('la app recibe los límites y lo usado de su plan', async () => {
    await sembrarNegocio('uid_1', { ...EN_ESTADO.TRIAL(), ai_chat_used_count: 4 });
    expect(await (await api('/api/negocio')).json()).toMatchObject({
      plan: 'TRIAL_3D', limites: { deudores: 15, ocr: 3, ia: 10, cobros: 5 }, usados: { ocr: 0, ia: 4, cobros: 0 },
    });
  });
});
