// SUS-03: el cron horario deja un aviso a 3 días, a 1 día y al vencer; nunca decide el acceso.
// WAP-07: después los envía al WhatsApp VERIFICADO del dueño, de día y una sola vez.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { avisoQueToca } from './avisos';
import worker from './index';
import { DIA, HORA, sembrarNegocio } from './test/datos';
import { SimulatedGateway } from './whatsapp/simulado';
import type { NombrePlantilla } from './whatsapp/tipos';

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

async function correrCron(ahora: number, entorno: Env = env) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime: ahora, cron: '0 * * * *' }), entorno, ctx);
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

describe('envío de los avisos al WhatsApp del dueño (WAP-07)', () => {
  const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00');
  const verificado = (telefono: string) => ({ whatsapp_phone: telefono, whatsapp_verified_at: MARTES_10 - 30 * DIA });
  const salientes = async () =>
    (await env.DB.prepare("SELECT * FROM whatsapp_messages WHERE direction = 'SALIENTE' ORDER BY phone").all<Record<string, any>>()).results;

  let red: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    red = vi.fn(() => Promise.reject(new Error('los avisos no deben salir a la red')));
    vi.stubGlobal('fetch', red);
  });
  afterEach(() => {
    expect(red).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Un gateway que NO deduplica por requestId (como podría ser el real): cada llamada es un mensaje nuevo. */
  function gatewaySinDeduplicar() {
    const original = SimulatedGateway.prototype.sendTemplate;
    let n = 0;
    return vi.spyOn(SimulatedGateway.prototype, 'sendTemplate').mockImplementation(function (this: SimulatedGateway, input) {
      n += 1;
      return original.call(this, { ...input, requestId: `${input.requestId}:llamada${n}` });
    });
  }

  test('avisos pendientes de dueños verificados → una fila saliente con la plantilla y sent_at; sin verificar → nada', async () => {
    await sembrarNegocio('tres', { ...verificado('+573001110001'), subscription_expires_at: Date.parse('2026-11-19T12:00:00-05:00') });
    await sembrarNegocio('vencido', { ...verificado('+573001110002'), subscription_expires_at: MARTES_10 - HORA });
    await sembrarNegocio('sinverificar', { whatsapp_phone: '+573001110003', subscription_expires_at: MARTES_10 + 5 * HORA });
    await sembrarNegocio('sintelefono', { subscription_expires_at: MARTES_10 + 5 * HORA });

    await correrCron(MARTES_10);
    const filas = await salientes();
    expect(filas).toMatchObject([
      { business_id: 'bus_tres', phone: '+573001110001', kind: 'template', template: 'aviso_vencimiento', status: 'accepted', callback_data: 'aviso_vencimiento' },
      { business_id: 'bus_vencido', phone: '+573001110002', kind: 'template', template: 'aviso_vencimiento', status: 'accepted' },
    ]);
    expect(filas.map((f) => JSON.parse(f.content_json).variables)).toEqual([
      ['vence en menos de 3 días', '19 de noviembre'],
      ['ya venció', '17 de noviembre'],
    ]);
    expect(JSON.parse(filas[1]!.content_json).texto).toContain('el pase de tu tienda ya venció (17 de noviembre)');
    expect((await avisos()).map((a) => [a.business_id, a.sent_at])).toEqual([
      ['bus_sintelefono', null],
      ['bus_sinverificar', null],
      ['bus_tres', MARTES_10],
      ['bus_vencido', MARTES_10],
    ]);
  });

  test('correr el cron dos veces (también a la vez) → un solo envío por aviso', async () => {
    await sembrarNegocio('uno', { ...verificado('+573001110004'), subscription_expires_at: MARTES_10 + 5 * HORA });
    await correrCron(MARTES_10);
    await correrCron(MARTES_10 + HORA);
    await Promise.all([correrCron(MARTES_10 + 2 * HORA), correrCron(MARTES_10 + 2 * HORA)]);
    expect(await salientes()).toHaveLength(1);
    expect((await avisos()).map((a) => a.sent_at)).toEqual([MARTES_10]);
  });

  test('dos crons solapados → un solo envío aunque el gateway no deduplique: se reserva el aviso antes de enviar', async () => {
    const espia = gatewaySinDeduplicar();
    await sembrarNegocio('uno', { ...verificado('+573001110010'), subscription_expires_at: MARTES_10 + 5 * HORA });
    await Promise.all([correrCron(MARTES_10), correrCron(MARTES_10)]);
    await correrCron(MARTES_10 + HORA);
    expect(espia).toHaveBeenCalledTimes(1);
    expect(await salientes()).toHaveLength(1);
    expect((await avisos()).map((a) => a.sent_at)).toEqual([MARTES_10]);
  });

  test('si WhatsApp rechaza el aviso, queda marcado y no se reintenta cada hora', async () => {
    const original = SimulatedGateway.prototype.sendTemplate;
    const espia = vi.spyOn(SimulatedGateway.prototype, 'sendTemplate').mockImplementation(function (this: SimulatedGateway, input) {
      return original.call(this, { ...input, template: 'aviso_inventado' as NombrePlantilla });
    });
    await sembrarNegocio('rechazo', { ...verificado('+573001110011'), subscription_expires_at: MARTES_10 + 5 * HORA });
    await correrCron(MARTES_10);
    await correrCron(MARTES_10 + HORA);
    expect(espia).toHaveBeenCalledTimes(1);
    expect(await salientes()).toMatchObject([{ business_id: 'bus_rechazo', status: 'rejected' }]);
    expect((await avisos()).map((a) => a.sent_at)).toEqual([MARTES_10]);
  });

  test('un fallo de D1 en un aviso no corta los demás ni el cron', async () => {
    await sembrarNegocio('falla', { ...verificado('+573001110012'), subscription_expires_at: MARTES_10 + 5 * HORA });
    await sembrarNegocio('sigue', { ...verificado('+573001110013'), subscription_expires_at: MARTES_10 + 6 * HORA });
    // La base responde, salvo al reservar el aviso de `bus_falla`.
    const propio = <T extends object>(o: T, p: string | symbol) => {
      const v = Reflect.get(o, p);
      return typeof v === 'function' ? v.bind(o) : v;
    };
    const DB = new Proxy(env.DB, {
      get(base, prop) {
        if (prop !== 'prepare') return propio(base, prop);
        return (sql: string) => {
          const sentencia = base.prepare(sql);
          return new Proxy(sentencia, {
            get(s, p) {
              if (p !== 'bind') return propio(s, p);
              return (...args: unknown[]) => {
                if (sql.includes('UPDATE subscription_notices') && args.includes('bus_falla')) throw new Error('D1 no respondió');
                return s.bind(...args);
              };
            },
          });
        };
      },
    });
    await correrCron(MARTES_10, { ...env, DB });
    expect((await salientes()).map((f) => f.business_id)).toEqual(['bus_sigue']);
    expect((await avisos()).map((a) => [a.business_id, a.sent_at])).toEqual([
      ['bus_falla', null],
      ['bus_sigue', MARTES_10],
    ]);
  });

  test('con más de 20 pendientes, cada ejecución envía 20 y el resto sale en la siguiente', async () => {
    for (let i = 0; i < 21; i++) {
      await sembrarNegocio(`n${String(i).padStart(2, '0')}`, { ...verificado(`+5730011120${String(i).padStart(2, '0')}`), subscription_expires_at: MARTES_10 + 5 * HORA });
    }
    await correrCron(MARTES_10);
    expect(await salientes()).toHaveLength(20);
    await correrCron(MARTES_10 + HORA);
    expect(await salientes()).toHaveLength(21);
    expect((await avisos()).filter((a) => a.sent_at === null)).toEqual([]);
  });

  test('de noche no sale nada: queda pendiente y sale a las 7:00', async () => {
    await sembrarNegocio('noche', { ...verificado('+573001110005'), subscription_expires_at: Date.parse('2026-11-18T12:00:00-05:00') });
    for (const hora of ['2026-11-16T19:00:00-05:00', '2026-11-16T23:00:00-05:00', '2026-11-17T06:00:00-05:00']) await correrCron(Date.parse(hora));
    expect(await salientes()).toEqual([]);
    expect((await avisos()).map((a) => a.sent_at)).toEqual([null]);
    await correrCron(Date.parse('2026-11-17T07:00:00-05:00'));
    expect(await salientes()).toHaveLength(1);
  });

  test('un aviso de hace más de 3 días o que ya no toca (renovó, o el de 1 día cuando ya venció) no sale y queda como estaba', async () => {
    const vence = MARTES_10 + 2 * DIA;
    await sembrarNegocio('viejo', { ...verificado('+573001110006'), subscription_expires_at: vence });
    await env.DB.prepare("INSERT INTO subscription_notices (business_id, kind, expires_at, created_at) VALUES ('bus_viejo', 'TRES_DIAS', ?1, ?2)")
      .bind(vence, MARTES_10 - 3 * DIA - 1).run();
    // Renovó después del aviso: su vencimiento ya no es el del aviso.
    await sembrarNegocio('renovo', { ...verificado('+573001110007'), subscription_expires_at: MARTES_10 + 20 * DIA });
    await env.DB.prepare("INSERT INTO subscription_notices (business_id, kind, expires_at, created_at) VALUES ('bus_renovo', 'UN_DIA', ?1, ?2)")
      .bind(MARTES_10 + 5 * HORA, MARTES_10 - HORA).run();
    // El de 1 día quedó sin enviar (de noche) y ya venció: sale el de «vencido», no el de 1 día.
    await sembrarNegocio('supero', { ...verificado('+573001110008'), subscription_expires_at: MARTES_10 - HORA });
    await env.DB.prepare("INSERT INTO subscription_notices (business_id, kind, expires_at, created_at) VALUES ('bus_supero', 'UN_DIA', ?1, ?2)")
      .bind(MARTES_10 - HORA, MARTES_10 - 10 * HORA).run();

    await correrCron(MARTES_10);
    const filas = await salientes();
    expect(filas.map((f) => [f.business_id, JSON.parse(f.content_json).variables[0]])).toEqual([['bus_supero', 'ya venció']]);
    expect((await avisos()).map((a) => [a.business_id, a.kind, a.sent_at])).toEqual([
      ['bus_renovo', 'UN_DIA', null],
      ['bus_supero', 'UN_DIA', null],
      ['bus_supero', 'VENCIDO', MARTES_10],
      ['bus_viejo', 'TRES_DIAS', null],
    ]);
  });

  test('en producción con el interruptor apagado no sale nada (los avisos se registran igual)', async () => {
    await sembrarNegocio('prod', { ...verificado('+573001110009'), subscription_expires_at: MARTES_10 + 5 * HORA });
    await correrCron(MARTES_10, { ...env, TEST_WHATSAPP_SIMULADO: undefined });
    expect(await salientes()).toEqual([]);
    expect(await avisos()).toMatchObject([{ business_id: 'bus_prod', kind: 'UN_DIA', sent_at: null }]);
  });
});
