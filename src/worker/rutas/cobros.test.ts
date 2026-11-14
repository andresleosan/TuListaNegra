// MOS-04 (servidor): cobrar por el WhatsApp del tendero respeta las reglas de contacto y usa plantillas fijas.
// AJU-01 (servidor): los ajustes de la tienda se guardan y aparecen en los cobros.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EN_ESTADO, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00'); // día hábil, en horario
const DIA = 86_400_000;
const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;
const post = (ruta: string, cuerpo: unknown, uid = 'uid_1', method = 'POST') => api(ruta, { uid }, { method, body: JSON.stringify(cuerpo) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES_10);
});
afterEach(() => vi.useRealTimers());

/** Deudor con saldo, teléfono y consentimiento: listo para cobrarle. */
async function deudorCobrable(extra: object = {}, uid = 'uid_1') {
  const d = await json(post('/api/deudores', { full_name: 'don Carlos', whatsapp_phone: '+573001234567', wa_consentimiento: true, ...extra }, uid));
  await post(`/api/deudores/${d.id}/movimientos`, { request_id: `req-${d.id}`, type: 'FIADO', amount_cop: 84_900 }, uid);
  return d.id as string;
}
const cobrar = (id: string, tono = 'VECINO_AMIGABLE', uid = 'uid_1') => post(`/api/deudores/${id}/cobros`, { tono }, uid);

describe('cobrar', () => {
  test.each([
    ['VECINO_AMIGABLE', 'Le recordamos con mucho gusto'],
    ['CORTE_DE_QUINCENA', 'Llegó la quincena'],
    ['AVISO_FIRME', 'ya pasó el plazo acordado'],
  ])('tono %s: abre el WhatsApp del deudor con el texto de la plantilla', async (tono, frase) => {
    await sembrarNegocio('uid_1', { name: 'La Esquina de Rubi', payment_methods_info: 'Nequi 300 999 0000' });
    const id = await deudorCobrable();
    const res = await cobrar(id, tono);
    expect(res.status).toBe(200);
    const { texto, url, last_reminder_sent_at } = await res.json<any>();
    for (const parte of [frase, 'don Carlos', 'La Esquina de Rubi', '$ 84.900', 'Puede pagar así: Nequi 300 999 0000', 'responda SALIR']) expect(texto).toContain(parte);
    expect(texto).not.toMatch(/lista negra/i);
    expect(new URL(url).pathname).toBe('/573001234567');
    expect(new URL(url).searchParams.get('text')).toBe(texto);
    expect(last_reminder_sent_at).toBe(MARTES_10);
    expect((await json(api(`/api/deudores/${id}`))).last_reminder_sent_at).toBe(MARTES_10);
  });

  test.each<[string, object, number, string]>([
    ['sin consentimiento', { wa_consentimiento: false }, MARTES_10, 'SIN_CONSENTIMIENTO'],
    ['domingo', {}, Date.parse('2026-11-22T10:00:00-05:00'), 'DOMINGO'],
    ['festivo (lunes 16 de noviembre)', {}, Date.parse('2026-11-16T10:00:00-05:00'), 'FESTIVO'],
    ['19:01', {}, Date.parse('2026-11-17T19:01:00-05:00'), 'FUERA_DE_HORARIO'],
    ['sábado 15:01', {}, Date.parse('2026-11-21T15:01:00-05:00'), 'FUERA_DE_HORARIO'],
  ])('%s: no entrega enlace y explica por qué', async (_caso, extra, cuando, motivo) => {
    await sembrarNegocio();
    const id = await deudorCobrable(extra);
    vi.setSystemTime(cuando);
    const res = await cobrar(id);
    expect(res.status).toBe(409);
    const cuerpo = await res.json<any>();
    expect(cuerpo).toMatchObject({ error: 'contacto_bloqueado', motivo });
    expect(cuerpo.mensaje.length).toBeGreaterThan(10);
    expect(cuerpo.url).toBeUndefined();
    expect((await json(api(`/api/deudores/${id}`))).last_reminder_sent_at).toBeNull();
  });

  test('con baja registrada no se cobra', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    await post(`/api/deudores/${id}`, { wa_baja: true }, 'uid_1', 'PATCH');
    expect(await json(cobrar(id))).toMatchObject({ error: 'contacto_bloqueado', motivo: 'BAJA' });
  });

  test('un cobro al día y uno cada 7 días; dos toques a la vez generan un solo cobro', async () => {
    await sembrarNegocio('uid_1', { subscription_expires_at: MARTES_10 + 30 * DIA }); // que el pase no venza a mitad de la prueba
    const id = await deudorCobrable();
    const estados = (await Promise.all([cobrar(id), cobrar(id), cobrar(id)])).map((r) => r.status).sort();
    expect(estados).toEqual([200, 409, 409]);
    vi.setSystemTime(MARTES_10 + 3_600_000);
    expect(await json(cobrar(id))).toMatchObject({ motivo: 'YA_COBRADO_HOY' });
    vi.setSystemTime(MARTES_10 + 3 * DIA); // viernes
    expect(await json(cobrar(id))).toMatchObject({ motivo: 'FRECUENCIA' });
    vi.setSystemTime(MARTES_10 + 7 * DIA); // martes siguiente
    expect((await cobrar(id)).status).toBe(200);
  });

  test('sin saldo, sin teléfono o con tono inventado no hay cobro', async () => {
    await sembrarNegocio();
    const alDia = await json(post('/api/deudores', { full_name: 'Al día', whatsapp_phone: '+573001234567', wa_consentimiento: true }));
    expect(await json(cobrar(alDia.id))).toEqual({ error: 'sin_saldo' });
    const sinTelefono = await deudorCobrable({ whatsapp_phone: null });
    expect(await json(cobrar(sinTelefono))).toEqual({ error: 'sin_telefono' });
    const id = await deudorCobrable({ full_name: 'Otro' });
    expect((await cobrar(id, 'AMENAZA')).status).toBe(400);
    expect((await post(`/api/deudores/${id}/cobros`, { tono: 'AVISO_FIRME', texto: 'Pague o lo reporto' })).status).toBe(200); // el texto libre se ignora
  });

  test('una tienda no cobra al deudor de otra; vencida no cobra', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    await sembrarNegocio('uid_3', EN_ESTADO.EXPIRED_READONLY());
    const id = await deudorCobrable();
    expect((await cobrar(id, 'VECINO_AMIGABLE', 'uid_2')).status).toBe(404);
    expect((await cobrar(id, 'VECINO_AMIGABLE', 'uid_3')).status).toBe(403);
    expect((await json(api(`/api/deudores/${id}`))).last_reminder_sent_at).toBeNull();
  });
});

describe('ajustes de la tienda', () => {
  const ajustar = (cuerpo: unknown, uid = 'uid_1') => post('/api/negocio', cuerpo, uid, 'PATCH');

  test('valores iniciales', async () => {
    await sembrarNegocio();
    expect(await json(api('/api/negocio'))).toMatchObject({ payment_methods_info: null, default_alert_days: 30, tono_cobro: 'VECINO_AMIGABLE' });
  });

  test('se guardan y aparecen en los cobros y en el estado de mora', async () => {
    await sembrarNegocio('uid_1', { name: 'La Esquina de Rubi' });
    const id = await deudorCobrable();
    const res = await ajustar({ payment_methods_info: '  Nequi 300 999 0000 a nombre de Rubiela  ', default_alert_days: 7, tono_cobro: 'CORTE_DE_QUINCENA' });
    expect(res.status).toBe(200);
    const guardado = { payment_methods_info: 'Nequi 300 999 0000 a nombre de Rubiela', default_alert_days: 7, tono_cobro: 'CORTE_DE_QUINCENA' };
    expect(await res.json()).toMatchObject(guardado);
    expect(await json(api('/api/negocio'))).toMatchObject(guardado);
    expect((await json(cobrar(id))).texto).toContain('Puede pagar así: Nequi 300 999 0000 a nombre de Rubiela');
    vi.setSystemTime(MARTES_10 + 8 * DIA); // con 7 días de alerta, el fiado de hace 8 días ya es mora
    expect((await json(api(`/api/deudores/${id}`))).estado).toBe('EN_MORA');
  });

  test('cambiar una cosa no pisa las otras; vaciar los medios de pago los deja en nulo', async () => {
    await sembrarNegocio();
    await ajustar({ payment_methods_info: 'Efectivo', tono_cobro: 'AVISO_FIRME' });
    expect(await json(ajustar({ default_alert_days: 15 }))).toMatchObject({ payment_methods_info: 'Efectivo', default_alert_days: 15, tono_cobro: 'AVISO_FIRME' });
    expect(await json(ajustar({ payment_methods_info: '   ' }))).toMatchObject({ payment_methods_info: null, tono_cobro: 'AVISO_FIRME' });
  });

  test.each([
    ['días 0', { default_alert_days: 0 }], ['días con decimales', { default_alert_days: 7.5 }], ['días absurdos', { default_alert_days: 366 }],
    ['tono inventado', { tono_cobro: 'AMENAZA' }], ['medios de pago enormes', { payment_methods_info: 'x'.repeat(301) }], ['nada', {}],
    ['solo campos que no se cambian por aquí', { subscription_plan: 'PASS_30D', free_forever_at: 1, name: 'Otra' }],
  ])('%s → 400 sin cambiar nada', async (_caso, cuerpo) => {
    await sembrarNegocio();
    const antes = await env.DB.prepare("SELECT * FROM businesses WHERE id = 'bus_uid_1'").first();
    expect((await ajustar(cuerpo)).status).toBe(400);
    expect(await env.DB.prepare("SELECT * FROM businesses WHERE id = 'bus_uid_1'").first()).toEqual(antes);
  });

  test('el plan, las fechas y el nombre no se cambian por aquí aunque vengan junto a un ajuste válido', async () => {
    const sembrado = await sembrarNegocio('uid_1', EN_ESTADO.TRIAL());
    await ajustar({ default_alert_days: 10, subscription_plan: 'PASS_30D', subscription_expires_at: 9e15, free_forever_at: 1, name: 'Otra' });
    const fila = await env.DB.prepare("SELECT * FROM businesses WHERE id = 'bus_uid_1'").first();
    expect(fila).toEqual({ ...sembrado, default_alert_days: 10 });
  });

  test('una tienda vencida no cambia ajustes', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    expect((await ajustar({ default_alert_days: 10 })).status).toBe(403);
  });
});
