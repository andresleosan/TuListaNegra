// WAP-03: cobro por el bot con la plantilla fija de cada tono. Respeta las reglas de contacto (COB-01) y la cuota
// «cobros por bot»; cada envío queda en `whatsapp_messages` con el negocio de la sesión. Nada sale a la red.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { textoDeCobro, type Tono } from '../../shared/cobro';
import { SIN_CUOTA } from '../cuotas';
import { EN_ESTADO, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';
import { SimulatedGateway } from '../whatsapp/simulado';
import type { NombrePlantilla } from '../whatsapp/tipos';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00'); // día hábil, en horario
const DIA = 86_400_000;
const TELEFONO = '+573001234567'; // ficticio
const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;
const post = (ruta: string, cuerpo: unknown, uid = 'uid_1', method = 'POST', entorno: Env = env) =>
  api(ruta, { uid }, { method, body: JSON.stringify(cuerpo) }, entorno);

let red: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES_10);
  red = vi.fn(() => Promise.reject(new Error('el cobro por bot no debe salir a la red')));
  vi.stubGlobal('fetch', red);
});
afterEach(() => {
  expect(red).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Deudor con saldo, teléfono y consentimiento: listo para cobrarle. */
async function deudorCobrable(extra: object = {}, uid = 'uid_1') {
  const d = await json(post('/api/deudores', { full_name: 'don Carlos', whatsapp_phone: TELEFONO, wa_consentimiento: true, ...extra }, uid));
  await post(`/api/deudores/${d.id}/movimientos`, { request_id: `req-${d.id}`, type: 'FIADO', amount_cop: 84_900 }, uid);
  return d.id as string;
}
const enviar = (id: string, { tono = 'VECINO_AMIGABLE', request_id = 'toque-0001', uid = 'uid_1', entorno = env }: { tono?: string; request_id?: string; uid?: string; entorno?: Env } = {}) =>
  post(`/api/cobros-bot/${id}`, { tono, request_id }, uid, 'POST', entorno);

const salientes = async () =>
  (await env.DB.prepare("SELECT * FROM whatsapp_messages WHERE direction = 'SALIENTE' ORDER BY created_at, id").all<Record<string, any>>()).results;
const usados = async (uid = 'uid_1') =>
  (await env.DB.prepare('SELECT wa_reminders_used_count AS n FROM businesses WHERE id = ?').bind(`bus_${uid}`).first<{ n: number }>())!.n;
const ultimoCobro = async (id: string) => (await json(api(`/api/deudores/${id}`))).last_reminder_sent_at as number | null;

/** Nada se envió, no se gastó cuota y el deudor sigue sin cobro anotado. */
async function nadaPaso(id: string) {
  expect(await salientes()).toEqual([]);
  expect(await usados()).toBe(0);
  expect(await ultimoCobro(id)).toBeNull();
}

/** Fuerza un rechazo real del simulador: la plantilla llega con un nombre que el catálogo no tiene. */
function forzarPlantillaInvalida() {
  const original = SimulatedGateway.prototype.sendTemplate;
  return vi.spyOn(SimulatedGateway.prototype, 'sendTemplate').mockImplementation(function (this: SimulatedGateway, input) {
    return original.call(this, { ...input, template: 'cobro_amenaza' as NombrePlantilla });
  });
}

describe('bloqueos: 409, sin enviar, sin gastar cuota y sin fila en whatsapp_messages', () => {
  test.each<[string, object, number, string]>([
    ['sin consentimiento', { wa_consentimiento: false }, MARTES_10, 'SIN_CONSENTIMIENTO'],
    ['domingo', {}, Date.parse('2026-11-22T10:00:00-05:00'), 'DOMINGO'],
    ['festivo (lunes 16 de noviembre)', {}, Date.parse('2026-11-16T10:00:00-05:00'), 'FESTIVO'],
    ['antes de las 7:00', {}, Date.parse('2026-11-17T06:59:00-05:00'), 'FUERA_DE_HORARIO'],
    ['19:01', {}, Date.parse('2026-11-17T19:01:00-05:00'), 'FUERA_DE_HORARIO'],
    ['sábado 15:01', {}, Date.parse('2026-11-21T15:01:00-05:00'), 'FUERA_DE_HORARIO'],
  ])('%s', async (_caso, extra, cuando, motivo) => {
    await sembrarNegocio();
    const id = await deudorCobrable(extra);
    vi.setSystemTime(cuando);
    const res = await enviar(id);
    expect(res.status).toBe(409);
    const cuerpo = await res.json<any>();
    expect(cuerpo).toMatchObject({ error: 'contacto_bloqueado', motivo });
    expect(cuerpo.mensaje.length).toBeGreaterThan(10);
    await nadaPaso(id);
  });

  test('con baja registrada', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    await post(`/api/deudores/${id}`, { wa_baja: true }, 'uid_1', 'PATCH');
    expect(await json(enviar(id))).toMatchObject({ error: 'contacto_bloqueado', motivo: 'BAJA' });
    await nadaPaso(id);
  });

  test('sin saldo y sin teléfono', async () => {
    await sembrarNegocio();
    const alDia = await json(post('/api/deudores', { full_name: 'Al día', whatsapp_phone: TELEFONO, wa_consentimiento: true }));
    const r1 = await enviar(alDia.id);
    expect([r1.status, await r1.json()]).toEqual([409, { error: 'sin_saldo' }]);
    const sinTelefono = await deudorCobrable({ whatsapp_phone: null });
    const r2 = await enviar(sinTelefono);
    expect([r2.status, await r2.json()]).toEqual([409, { error: 'sin_telefono' }]);
    await nadaPaso(sinTelefono);
  });

  test('tono inventado o request_id que no vale → 400', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    expect((await enviar(id, { tono: 'AMENAZA' })).status).toBe(400);
    for (const request_id of ['', 'corto', 'con espacios 123', 'x'.repeat(65), 'a:b:c:d:e:f']) {
      expect((await enviar(id, { request_id })).status, request_id).toBe(400);
    }
    expect((await post(`/api/cobros-bot/${id}`, { tono: 'AVISO_FIRME' })).status).toBe(400);
    await nadaPaso(id);
  });
});

describe('con todo en regla', () => {
  test.each<[Tono, string]>([
    ['VECINO_AMIGABLE', 'cobro_vecino_amigable'],
    ['CORTE_DE_QUINCENA', 'cobro_corte_de_quincena'],
    ['AVISO_FIRME', 'cobro_aviso_firme'],
  ])('tono %s: una fila saliente con la plantilla %s, sus variables y el negocio de la sesión; una unidad de cuota', async (tono, plantilla) => {
    await sembrarNegocio('uid_1', { name: 'La Esquina de Rubi', payment_methods_info: 'Nequi 300 999 0000' });
    await sembrarNegocio('uid_2');
    const id = await deudorCobrable();
    const res = await enviar(id, { tono });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ estado: 'enviado', simulado: true, last_reminder_sent_at: MARTES_10 });

    const [fila, ...otras] = await salientes();
    expect(otras).toEqual([]);
    expect(fila).toMatchObject({
      direction: 'SALIENTE', kind: 'template', template: plantilla, phone: TELEFONO, status: 'accepted', business_id: 'bus_uid_1',
      wa_message_id: expect.stringMatching(/^wamid\.SIM\./), request_id: 'cobro-bot:bus_uid_1:' + id + ':toque-0001', callback_data: `cobro:${id}`,
    });
    const contenido = JSON.parse(fila!.content_json);
    // Variables en el orden del catálogo: nombre, tienda, saldo y cómo pagar.
    expect(contenido).toMatchObject({ language: 'es_CO', variables: ['don Carlos', 'La Esquina de Rubi', '$ 84.900', 'Puede pagar así: Nequi 300 999 0000.'] });
    // El texto que resuelve la plantilla es el mismo que el tendero ve en «Así le llega» (y el del cobro por enlace).
    expect(contenido.texto).toBe(textoDeCobro(tono, { tienda: 'La Esquina de Rubi', nombre: 'don Carlos', saldo_cop: 84_900, medios_de_pago: 'Nequi 300 999 0000' }));
    // `callback_data` vuelve en los estados de Meta: sin teléfono, nombre ni saldo.
    // Su forma exacta (prefijo y el id interno del deudor) ya excluye cualquier dato personal; buscar «84» fallaba al azar
    // cuando el ULID aleatorio contenía esos dígitos.
    expect(fila!.callback_data).toMatch(/^cobro:deb_[0-9A-HJKMNP-TV-Z]{26}$/);

    expect(await usados()).toBe(1);
    expect(await usados('uid_2')).toBe(0);
    expect(await ultimoCobro(id)).toBe(MARTES_10);
    expect((await json(api('/api/negocio'))).usados.cobros).toBe(1);
  });

  test('sin medios de pago la cuarta variable invita a pagar en la tienda', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    await enviar(id);
    const [fila] = await salientes();
    expect(JSON.parse(fila!.content_json).variables[3]).toBe('Puede pagar directamente en la tienda.');
  });

  test('un cobro al día y uno cada 7 días, igual que el cobro por enlace (y entre los dos canales)', async () => {
    await sembrarNegocio('uid_1', { subscription_expires_at: MARTES_10 + 30 * DIA });
    const id = await deudorCobrable();
    expect((await enviar(id, { request_id: 'toque-0001' })).status).toBe(200);
    vi.setSystemTime(MARTES_10 + 3_600_000);
    expect(await json(enviar(id, { request_id: 'toque-0002' }))).toMatchObject({ motivo: 'YA_COBRADO_HOY' });
    expect(await json(post(`/api/deudores/${id}/cobros`, { tono: 'AVISO_FIRME' }))).toMatchObject({ motivo: 'YA_COBRADO_HOY' });
    vi.setSystemTime(MARTES_10 + 3 * DIA);
    expect(await json(enviar(id, { request_id: 'toque-0003' }))).toMatchObject({ motivo: 'FRECUENCIA' });
    vi.setSystemTime(MARTES_10 + 7 * DIA);
    expect((await enviar(id, { request_id: 'toque-0004' })).status).toBe(200);
    expect(await salientes()).toHaveLength(2);
    expect(await usados()).toBe(2);
  });
});

describe('cuota', () => {
  test('sin cuota → 409 con el mensaje de SIN_CUOTA, y nada enviado ni anotado', async () => {
    await sembrarNegocio('uid_1', { wa_reminders_used_count: 40 }); // PASS_7D: 40 cobros por bot
    const id = await deudorCobrable();
    const res = await enviar(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'sin_cuota', mensaje: SIN_CUOTA.cobros });
    expect(await salientes()).toEqual([]);
    expect(await usados()).toBe(40);
    expect(await ultimoCobro(id)).toBeNull();
  });

  test('con la última unidad, dos deudores a la vez: uno sale y el otro se queda sin cuota', async () => {
    await sembrarNegocio('uid_1', { wa_reminders_used_count: 39 });
    const a = await deudorCobrable();
    const b = await deudorCobrable({ full_name: 'doña Rosa' });
    const estados = (await Promise.all([enviar(a), enviar(b)])).map((r) => r.status).sort();
    expect(estados).toEqual([200, 409]);
    expect(await salientes()).toHaveLength(1);
    expect(await usados()).toBe(40);
  });
});

describe('idempotencia y carreras', () => {
  test('dos toques a la vez (cada uno con su request_id) → un solo envío y una sola cuota', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    const respuestas = await Promise.all(['toque-000a', 'toque-000b', 'toque-000c'].map((request_id) => enviar(id, { request_id })));
    expect(respuestas.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const bloqueadas = await Promise.all(respuestas.filter((r) => r.status === 409).map((r) => r.json<any>()));
    expect(bloqueadas.every((b) => b.motivo === 'YA_COBRADO_HOY')).toBe(true);
    expect(await salientes()).toHaveLength(1);
    expect(await usados()).toBe(1);
  });

  test('el mismo request_id otra vez → la misma respuesta, sin enviar ni gastar de nuevo', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    const primero = await json(enviar(id));
    vi.setSystemTime(MARTES_10 + 60_000);
    const segundo = await enviar(id);
    expect(segundo.status).toBe(200);
    expect(await segundo.json()).toEqual(primero);
    // También a la vez: el reintento no cobra otra vez.
    await Promise.all([enviar(id), enviar(id)]);
    expect(await salientes()).toHaveLength(1);
    expect(await usados()).toBe(1);
  });

  test('el mismo request_id en otra tienda no choca (el request_id de la tabla lleva el negocio)', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    const a = await deudorCobrable({}, 'uid_1');
    const b = await deudorCobrable({}, 'uid_2');
    expect((await enviar(a, { uid: 'uid_1' })).status).toBe(200);
    expect((await enviar(b, { uid: 'uid_2' })).status).toBe(200);
    expect((await salientes()).map((f) => f.business_id).sort()).toEqual(['bus_uid_1', 'bus_uid_2']);
    expect([await usados('uid_1'), await usados('uid_2')]).toEqual([1, 1]);
  });
});

describe('respuesta del gateway', () => {
  test('rechazo (plantilla inválida forzada) → 502, sin gastar cuota y sin anotar el cobro; el envío queda registrado', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    const espia = forzarPlantillaInvalida();
    const res = await enviar(id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'envio_rechazado', codigo: 'INVALID_TEMPLATE' });
    expect(await usados()).toBe(0);
    expect(await ultimoCobro(id)).toBeNull();
    expect(await salientes()).toMatchObject([{ status: 'rejected', error_code: 'INVALID_TEMPLATE', business_id: 'bus_uid_1', wa_message_id: null }]);

    // El mismo request_id repite el rechazo sin volver a intentarlo.
    expect((await enviar(id)).status).toBe(502);
    expect(espia).toHaveBeenCalledTimes(1);
    expect(await salientes()).toHaveLength(1);

    // Un toque nuevo, ya sin el fallo, sí sale: el rechazo no dejó al deudor «cobrado hoy».
    espia.mockRestore();
    expect((await enviar(id, { request_id: 'toque-0002' })).status).toBe(200);
    expect(await usados()).toBe(1);
  });

  test('resultado «unknown» → 202: pudo salir, así que la cuota se gasta, el cobro queda anotado y no se reintenta', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    const espia = vi.spyOn(SimulatedGateway.prototype, 'sendTemplate').mockResolvedValue({ status: 'unknown' });
    const res = await enviar(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ estado: 'sin_confirmar', simulado: true, last_reminder_sent_at: MARTES_10 });
    expect(await usados()).toBe(1);
    expect(await ultimoCobro(id)).toBe(MARTES_10);
    espia.mockRestore();
    // Un toque nuevo el mismo día no lo reintenta.
    expect(await json(enviar(id, { request_id: 'toque-0002' }))).toMatchObject({ motivo: 'YA_COBRADO_HOY' });
    expect(await salientes()).toEqual([]);
  });

  test('con el interruptor encendido y sin gateway real, falla cerrado: nada sale, nada se gasta ni se anota', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    const res = await enviar(id, { entorno: { ...env, WHATSAPP_SEND_READY: '1' } });
    expect(res.status).toBe(500);
    await nadaPaso(id);
  });
});

describe('acceso', () => {
  test('una tienda no cobra al deudor de otra; vencida → 403; nada se envía', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    await sembrarNegocio('uid_3', EN_ESTADO.EXPIRED_READONLY());
    const id = await deudorCobrable();
    expect((await enviar(id, { uid: 'uid_2' })).status).toBe(404);
    const vencida = await enviar(id, { uid: 'uid_3' });
    expect(vencida.status).toBe(403);
    expect(await vencida.json()).toMatchObject({ error: 'acceso_denegado', estado: 'EXPIRED_READONLY' });
    await nadaPaso(id);
    expect([await usados('uid_2'), await usados('uid_3')]).toEqual([0, 0]);
  });

  test('con el desbloqueo de 24 h sí cobra, con la cuota que quedaba', async () => {
    await sembrarNegocio('uid_1', { ...EN_ESTADO.GRACE_UNLOCK_24H(), wa_reminders_used_count: 40 });
    const id = await deudorCobrable();
    expect(await json(enviar(id))).toMatchObject({ error: 'sin_cuota' });
  });
});

describe('revisión independiente de WAP-03', () => {
  test('en producción con el interruptor apagado (sin el simulador de desarrollo) → 409 bot_apagado: ni cuota, ni anotación, ni fila', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    const produccion = { ...env, TEST_WHATSAPP_SIMULADO: undefined };
    const res = await enviar(id, { entorno: produccion });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'bot_apagado' });
    await nadaPaso(id);
    // Y el cobro por enlace sigue libre ese mismo día.
    expect((await post(`/api/deudores/${id}/cobros`, { tono: 'VECINO_AMIGABLE' })).status).toBe(200);
  });

  test('si el envío lanza, es ambiguo: 202, la cuota queda gastada y el cobro anotado (no se reintenta)', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    vi.spyOn(SimulatedGateway.prototype, 'sendTemplate').mockRejectedValue(new Error('se cayó la base a medias'));
    const res = await enviar(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ estado: 'sin_confirmar' });
    expect(await usados()).toBe(1);
    expect(await ultimoCobro(id)).toBe(MARTES_10);
  });

  test('un envío que Meta marcó «failed» no se responde como enviado al reintentar', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    expect((await enviar(id)).status).toBe(200);
    await env.DB.prepare("UPDATE whatsapp_messages SET status = 'failed', error_code = 131026 WHERE direction = 'SALIENTE'").run();
    const res = await enviar(id);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'envio_rechazado' });
  });

  test('el envío ya lleva el negocio en cuanto sale (revisión de WAP-04: una respuesta inmediata encuentra la tienda)', async () => {
    await sembrarNegocio();
    const id = await deudorCobrable();
    const original = SimulatedGateway.prototype.sendTemplate;
    let negocioAlSalir: unknown = 'sin envío';
    vi.spyOn(SimulatedGateway.prototype, 'sendTemplate').mockImplementation(async function (this: SimulatedGateway, input) {
      const r = await original.call(this, input);
      negocioAlSalir = (await salientes())[0]?.business_id; // lo que vería un entrante que llegara en este instante
      return r;
    });
    expect((await enviar(id)).status).toBe(200);
    expect(negocioAlSalir).toBe('bus_uid_1');
  });

  test('la cuarta variable va en una sola línea aunque el tendero escriba sus medios de pago en varias', async () => {
    await sembrarNegocio('uid_1', { payment_methods_info: 'Nequi 300 999 0000\n\tDaviplata    311 000 0000' });
    const id = await deudorCobrable();
    expect((await enviar(id)).status).toBe(200);
    const [fila] = await salientes();
    expect(JSON.parse(fila!.content_json).variables.at(-1)).toBe('Puede pagar así: Nequi 300 999 0000 Daviplata 311 000 0000.');
  });
});
