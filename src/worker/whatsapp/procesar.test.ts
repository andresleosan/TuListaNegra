// WAP-05: comprobante → abono pendiente con evidencia; fecha de pago → promesa; «SALIR» → baja que bloquea cobros.
// Todo entra FIRMADO por el webhook real (inyector) tras un cobro real por el bot, para que el enrutador asigne el deudor.
// Reloj controlado; `fetch` vigilado: nada sale a la red; nada en consola (B5).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';
import { cuerpoMeta, entornoWa, entrante, inyectar } from '../test/whatsapp';
import { PREFIJO_ELEGIR } from './enrutar';
import {
  DESCRIPCION_COMPROBANTE, MAX_PENDIENTES_POR_DEUDOR, procesarEntrantes, TEXTO_BAJA, TEXTO_NO_IMAGEN, TEXTO_NO_REGISTRADO, textoPregunta, textoPromesa,
} from './procesar';
import { SimulatedGateway } from './simulado';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00'); // día hábil, en horario de cobro
const VIERNES = Date.parse('2026-11-20T00:00:00-05:00');
const DEUDOR = '+573001234567'; // ficticio
const DUENO_A = '+573109998877'; // ficticio
const DESCONOCIDO = '+573005550000'; // ficticio
const OTRO = '+573007770000'; // ficticio
const DIA_MS = 24 * 3_600_000;
const A = 'bus_uid_a';
const B = 'bus_uid_b';
const SALDO = 84_900;

type Fila = Record<string, any>;
const entranteDe = async (wamid: string) => (await env.DB.prepare('SELECT * FROM whatsapp_messages WHERE wa_message_id = ?').bind(wamid).first<Fila>())!;
const movimientos = async (negocio?: string) =>
  (await env.DB.prepare("SELECT * FROM ledger_transactions WHERE type = 'ABONO' AND (?1 IS NULL OR business_id = ?1) ORDER BY created_at")
    .bind(negocio ?? null).all<Fila>()).results;
const deudorDe = async (id: string) => (await env.DB.prepare('SELECT * FROM debtors WHERE id = ?').bind(id).first<Fila>())!;
const objetos = async (prefijo = 'negocios/') => (await env.ARCHIVOS.list({ prefix: prefijo })).objects.map((o) => o.key);
/** Respuestas de la tienda a un entrante (salientes que lo citan). */
const respuestasA = async (wamid: string) =>
  (await env.DB.prepare("SELECT * FROM whatsapp_messages WHERE direction = 'SALIENTE' AND reply_to_wa_message_id = ?").bind(wamid).all<Fila>()).results;

let red: ReturnType<typeof vi.fn>;
let registros: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES_10);
  red = vi.fn(() => Promise.reject(new Error('WAP-05 no debe salir a la red')));
  vi.stubGlobal('fetch', red);
  registros = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
  for (const uid of ['uid_a', 'uid_b', 'uid_c']) await sembrarNegocio(uid, { name: `Tienda ${uid.slice(-1).toUpperCase()}` });
});
afterEach(() => {
  try {
    expect(red).not.toHaveBeenCalled();
    for (const r of registros) expect(r).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

/** Deudor con saldo, teléfono y consentimiento en la tienda `uid`, creado por la API real. */
async function deudor(uid: string, telefono = DEUDOR) {
  const res = await api('/api/deudores', { uid }, { method: 'POST', body: JSON.stringify({ full_name: 'don Carlos', whatsapp_phone: telefono, wa_consentimiento: true }) });
  const { id } = await res.json<{ id: string }>();
  await api(`/api/deudores/${id}/movimientos`, { uid }, { method: 'POST', body: JSON.stringify({ request_id: `req-${id}`, type: 'FIADO', amount_cop: SALDO }) });
  return id;
}

/** La tienda `uid` le cobra por el bot (ruta real) y devuelve el wamid del cobro. */
async function cobrar(uid: string, deudorId: string, toque = `toque-${deudorId}`) {
  const res = await api(`/api/cobros-bot/${deudorId}`, { uid }, { method: 'POST', body: JSON.stringify({ tono: 'VECINO_AMIGABLE', request_id: toque }) });
  expect(res.status).toBe(200);
  const fila = await env.DB.prepare("SELECT wa_message_id FROM whatsapp_messages WHERE direction = 'SALIENTE' AND request_id = ?")
    .bind(`cobro-bot:bus_${uid}:${deudorId}:${toque}`).first<{ wa_message_id: string }>();
  return fila!.wa_message_id;
}

const imagen = (id: string, { de = DEUDOR, mediaId = 'sim-png', respondeA }: { de?: string; mediaId?: string; respondeA?: string } = {}) =>
  cuerpoMeta({ mensajes: [entrante.imagen({ de, id, mediaId, mimeType: 'image/png', respondeA })] });
const texto = (id: string, t: string, { de = DEUDOR, respondeA }: { de?: string; respondeA?: string } = {}) =>
  cuerpoMeta({ mensajes: [entrante.texto({ de, id, texto: t, respondeA })] });
async function manda(cuerpo: unknown, entorno?: Env) {
  expect((await inyectar(cuerpo, entorno)).status).toBe(200);
}

/** `env.DB` que lanza la PRIMERA vez que se prepara una consulta que cumple `cae`; lo demás pasa tal cual. */
function dbQueFallaUnaVez(cae: (q: string) => boolean): D1Database {
  let fallos = 0;
  return new Proxy(env.DB, {
    get(db, p) {
      if (p === 'prepare') {
        return (q: string) => {
          if (cae(q) && fallos++ === 0) throw new Error('D1 caído');
          return db.prepare(q);
        };
      }
      const v = Reflect.get(db, p);
      return typeof v === 'function' ? v.bind(db) : v;
    },
  });
}

/**
 * `env.DB` cuya lectura por id (la de ./procesar.ts) falla la PRIMERA vez que devuelve el entrante `wamid`. Por el
 * contenido y no por el orden: dos entrantes del mismo milisegundo se ordenan por la parte aleatoria del ULID.
 */
function dbQueFallaAlLeer(wamid: string): D1Database {
  let fallos = 0;
  const lectura = (q: string) => q.includes('routing_state IS NOT NULL') && q.includes('WHERE id = ?1');
  return new Proxy(env.DB, {
    get(db, p) {
      if (p === 'prepare') {
        return (q: string) => {
          const consulta = db.prepare(q);
          if (!lectura(q)) return consulta;
          return {
            bind: (...args: unknown[]) => {
              const s = consulta.bind(...args);
              return {
                first: async () => {
                  const fila = await s.first<Fila>();
                  if (fila?.wa_message_id === wamid && fallos++ === 0) throw new Error('D1 caído');
                  return fila;
                },
              };
            },
          };
        };
      }
      const v = Reflect.get(db, p);
      return typeof v === 'function' ? v.bind(db) : v;
    },
  });
}

/** Cobros por enlace y por bot de la tienda `uid` a ese deudor: ambos bloqueados por la baja. */
async function cobrosBloqueados(uid: string, deudorId: string) {
  const enlace = await api(`/api/deudores/${deudorId}/cobros`, { uid }, { method: 'POST', body: JSON.stringify({ tono: 'VECINO_AMIGABLE' }) });
  expect(enlace.status).toBe(409);
  expect(await enlace.json()).toMatchObject({ error: 'contacto_bloqueado', motivo: 'BAJA' });
  const bot = await api(`/api/cobros-bot/${deudorId}`, { uid }, { method: 'POST', body: JSON.stringify({ tono: 'VECINO_AMIGABLE', request_id: `tras-baja-${Date.now()}` }) });
  expect(bot.status).toBe(409);
  expect(await bot.json()).toMatchObject({ error: 'contacto_bloqueado', motivo: 'BAJA' });
}

/** La pregunta de promesa que respondió al entrante `wamid`. */
const preguntaA = async (wamid: string) => (await env.DB.prepare(
  "SELECT * FROM whatsapp_messages WHERE direction = 'SALIENTE' AND request_id = 'promesa:' || (SELECT id FROM whatsapp_messages WHERE wa_message_id = ?)",
).bind(wamid).first<Fila>())!;
const boton = (id: string, respondeA: string, botonId: string, { de = DEUDOR, titulo = 'Sí' }: { de?: string; titulo?: string } = {}) =>
  cuerpoMeta({ mensajes: [entrante.boton({ de, id, respondeA, botonId, titulo })] });

describe('comprobante → abono PENDIENTE_VERIFICACION_WHATSAPP con evidencia', () => {
  test('PNG: un ABONO pendiente con la imagen en R2 bajo el negocio, monto sugerido = saldo, saldo intacto', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(imagen('wamid.C1'));

    const [mov, ...otros] = await movimientos();
    expect(otros).toEqual([]);
    expect(mov).toMatchObject({
      business_id: A, debtor_id: d, request_id: 'wa:wamid.C1', type: 'ABONO', amount_cop: SALDO, status: 'PENDIENTE_VERIFICACION_WHATSAPP',
      balance_after_cop: null, confirmed_at: null, source: 'WHATSAPP_BOT', description: DESCRIPCION_COMPROBANTE,
    });
    expect(mov!.evidence_r2_key).toMatch(new RegExp(`^negocios/${A}/comprobantes/[0-9a-f]{64}\\.png$`));
    const objeto = await env.ARCHIVOS.get(mov!.evidence_r2_key);
    expect(objeto?.httpMetadata?.contentType).toBe('image/png');
    expect(new Uint8Array(await objeto!.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    // B3: un pendiente no mueve el saldo; el tendero lo sigue viendo igual por la API.
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO });
    expect(await (await api(`/api/deudores/${d}`, { uid: 'uid_a' })).json()).toMatchObject({ current_balance_cop: SALDO });
    expect(await respuestasA('wamid.C1')).toEqual([]); // avisar y aprobar es de WAP-06
  });

  test('JPEG y WebP también; la evidencia la sirve la ruta autenticada solo al dueño', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(imagen('wamid.J', { mediaId: 'sim-jpeg' }));
    await manda(imagen('wamid.W', { mediaId: 'sim-webp' }));
    const claves = (await movimientos(A)).map((m) => m.evidence_r2_key as string);
    expect(claves.map((k) => k.split('.').at(-1))).toEqual(['jpg', 'webp']);
    expect((await api(`/api/archivos/${claves[0]}`, { uid: 'uid_a' })).status).toBe(200);
    expect((await api(`/api/archivos/${claves[0]}`, { uid: 'uid_b' })).status).toBe(404);
  });

  test('el mismo evento dos veces (y dos a la vez), o reprocesado, deja un solo pendiente', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    const cuerpo = imagen('wamid.REP');
    await Promise.all([inyectar(cuerpo), inyectar(cuerpo)]);
    await manda(cuerpo); // reentrega de Meta
    await procesarEntrantes(entornoWa(), [(await entranteDe('wamid.REP')).id]); // reprocesar a mano
    expect(await movimientos()).toHaveLength(1);
    expect(await objetos()).toHaveLength(1);
  });

  test('la misma imagen en otro mensaje, con el pendiente sin resolver, no se duplica', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(imagen('wamid.I1'));
    await manda(imagen('wamid.I2'));
    expect(await movimientos()).toHaveLength(1);
    await manda(imagen('wamid.I3', { mediaId: 'sim-jpeg' })); // otra imagen sí
    expect(await movimientos()).toHaveLength(2);
    expect(await objetos()).toHaveLength(2);
  });

  test('un archivo que no es imagen (aunque diga image/jpeg) no crea nada y recibe una respuesta neutra', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(imagen('wamid.NO', { mediaId: 'sim-no-imagen' }));
    expect(await movimientos()).toEqual([]);
    expect(await objetos()).toEqual([]);
    const [r, ...mas] = await respuestasA('wamid.NO');
    expect(mas).toEqual([]);
    expect(r).toMatchObject({ business_id: A, phone: DEUDOR, kind: 'text', status: 'accepted', content_json: JSON.stringify({ text: TEXTO_NO_IMAGEN }) });
  });

  test('un medio que no se puede descargar no crea nada', async () => {
    await cobrar('uid_a', await deudor('uid_a'));
    await manda(imagen('wamid.X', { mediaId: 'no-existe' }));
    expect(await movimientos()).toEqual([]);
    expect(await objetos()).toEqual([]);
  });

  test('sin saldo no cabe un abono: nada se descarga ni se guarda', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await api(`/api/deudores/${d}/movimientos`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ request_id: 'req-saldar', type: 'ABONO', amount_cop: SALDO }) });
    await manda(imagen('wamid.S0'));
    expect((await movimientos()).filter((m) => m.status !== 'CONFIRMADO')).toEqual([]);
    expect(await objetos()).toEqual([]);
  });

  test('aislamiento: el comprobante del deudor de A nunca llega al deudor de B, aunque tengan el mismo teléfono', async () => {
    const dA = await deudor('uid_a');
    const dB = await deudor('uid_b');
    const cobroA = await cobrar('uid_a', dA);
    await cobrar('uid_b', dB);
    await manda(imagen('wamid.ISO', { respondeA: cobroA }));
    expect(await movimientos(B)).toEqual([]);
    expect(await objetos(`negocios/${B}/`)).toEqual([]);
    expect(await movimientos(A)).toMatchObject([{ debtor_id: dA, business_id: A }]);
    expect(await deudorDe(dB)).toMatchObject({ current_balance_cop: SALDO, promised_payment_date: null, wa_opt_out_at: null });
  });
});

describe('fecha de pago → propuesta que el deudor confirma con un botón (A1.3)', () => {
  /** El deudor escribe «el viernes» y recibe la pregunta; devuelve el id del entrante y la pregunta. */
  async function propuesta(t = 'Le pago el viernes sin falta', wamid = 'wamid.P1', de = DEUDOR) {
    const d = await deudor('uid_a', de);
    await cobrar('uid_a', d);
    await manda(texto(wamid, t, { de }));
    return { d, id: (await entranteDe(wamid)).id as string, pregunta: await preguntaA(wamid) };
  }

  test('«el viernes» el martes → pregunta con botones Sí / No; nada se guarda todavía', async () => {
    const { d, id, pregunta } = await propuesta();
    expect(await deudorDe(d)).toMatchObject({ promised_payment_date: null, current_balance_cop: SALDO });
    expect(pregunta).toMatchObject({
      business_id: A, phone: DEUDOR, kind: 'buttons', callback_data: 'promesa', reply_to_wa_message_id: 'wamid.P1',
      content_json: JSON.stringify({ text: textoPregunta(VIERNES) }),
      buttons_json: JSON.stringify([{ id: `tln.v1:promesa:${id}:2026-11-20`, title: 'Sí' }, { id: `tln.v1:promesa-no:${id}`, title: 'No' }]),
    });
    expect(textoPregunta(VIERNES)).toBe('¿Anotamos que pagas el viernes 20 de noviembre?');
    expect(await movimientos()).toEqual([]); // no es dinero
  });

  test('«Sí» de ese teléfono citando la pregunta → 00:00 de Bogotá del viernes 20; pulsarlo otra vez no hace nada', async () => {
    const { d, id, pregunta } = await propuesta();
    const si = `tln.v1:promesa:${id}:2026-11-20`;
    await manda(boton('wamid.SI', pregunta.wa_message_id, si));
    expect((await entranteDe('wamid.SI'))).toMatchObject({ routing_rule: 'RESPUESTA', debtor_id: d });
    expect(await deudorDe(d)).toMatchObject({ promised_payment_date: VIERNES, current_balance_cop: SALDO });
    expect(await (await api(`/api/deudores/${d}`, { uid: 'uid_a' })).json()).toMatchObject({ estado: 'PROMESA_PAGO' });
    expect(await respuestasA('wamid.SI')).toMatchObject([{ business_id: A, callback_data: 'promesa_ok', content_json: JSON.stringify({ text: textoPromesa(VIERNES) }) }]);
    expect(textoPromesa(VIERNES)).toBe('Anotamos tu fecha de pago: viernes 20 de noviembre.');

    // Otra fecha anotada después (p. ej., por el tendero): pulsar el mismo «Sí» otra vez no la pisa ni responde.
    const OTRA = Date.parse('2026-11-25T00:00:00-05:00');
    await env.DB.prepare('UPDATE debtors SET promised_payment_date = ?1 WHERE id = ?2').bind(OTRA, d).run();
    await manda(boton('wamid.SI2', pregunta.wa_message_id, si));
    expect(await deudorDe(d)).toMatchObject({ promised_payment_date: OTRA });
    expect(await respuestasA('wamid.SI2')).toEqual([]);
  });

  test.each([
    ['un id inventado (otra fecha)', (id: string) => `tln.v1:promesa:${id}:2026-11-25`],
    ['el id de otro entrante', () => 'tln.v1:promesa:wam_INVENTADO:2026-11-20'],
    ['«No»', (id: string) => `tln.v1:promesa-no:${id}`],
  ])('%s → nada', async (_, idBoton) => {
    const { d, id, pregunta } = await propuesta();
    await manda(boton('wamid.B', pregunta.wa_message_id, idBoton(id)));
    expect(await deudorDe(d)).toMatchObject({ promised_payment_date: null });
    expect(await respuestasA('wamid.B')).toEqual([]);
  });

  test('el «Sí» desde otro teléfono, o sin citar la pregunta, no hace nada', async () => {
    const { d, id, pregunta } = await propuesta();
    const si = `tln.v1:promesa:${id}:2026-11-20`;
    await manda(boton('wamid.OT', pregunta.wa_message_id, si, { de: DESCONOCIDO }));
    await manda(cuerpoMeta({ mensajes: [entrante.boton({ de: DEUDOR, id: 'wamid.SC', botonId: si, titulo: 'Sí' })] }));
    expect(await deudorDe(d)).toMatchObject({ promised_payment_date: null });
  });

  test('el «Sí» cuando la fecha ya no es futura, o sin saldo, no hace nada', async () => {
    const { d, id, pregunta } = await propuesta();
    const si = `tln.v1:promesa:${id}:2026-11-20`;
    vi.setSystemTime(VIERNES + 8 * 3_600_000); // el viernes 20 a las 8:00
    await manda(boton('wamid.TARDE', pregunta.wa_message_id, si));
    expect(await deudorDe(d)).toMatchObject({ promised_payment_date: null });

    const otra = await propuesta('el 15 de diciembre', 'wamid.P2', OTRO);
    await api(`/api/deudores/${otra.d}/movimientos`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ request_id: 'req-saldar', type: 'ABONO', amount_cop: SALDO }) });
    await manda(boton('wamid.SINSALDO', otra.pregunta.wa_message_id, `tln.v1:promesa:${otra.id}:2026-12-15`, { de: OTRO }));
    expect(await deudorDe(otra.d)).toMatchObject({ promised_payment_date: null });
  });

  test.each([
    ['fecha pasada', 'Le pago el 15 de noviembre'], ['irreconocible', 'Hola, ya pagué'], ['ambigua', 'el viernes o el lunes'],
    ['pasado', 'ya le pagué el viernes'], ['negación', 'mañana no puedo'], ['despedida', 'hasta mañana'], ['monto', 'le abono el 2 millones'],
  ])('%s → nada', async (_, t) => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(texto('wamid.PN', t));
    expect(await deudorDe(d)).toMatchObject({ promised_payment_date: null });
    expect(await respuestasA('wamid.PN')).toEqual([]);
  });

  test('sin saldo no se pregunta', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await api(`/api/deudores/${d}/movimientos`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ request_id: 'req-saldar', type: 'ABONO', amount_cop: SALDO }) });
    await manda(texto('wamid.PS', 'el viernes'));
    expect(await respuestasA('wamid.PS')).toEqual([]);
  });
});

describe('«SALIR» → baja inmediata que bloquea los cobros', () => {
  test('registra la baja una sola vez, confirma en tono neutro y luego el cobro por enlace y por bot dan 409', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(texto('wamid.SAL', 'SALIR.'));
    const { wa_opt_out_at } = await deudorDe(d);
    expect(wa_opt_out_at).toBe(MARTES_10);
    expect(await respuestasA('wamid.SAL')).toMatchObject([{ business_id: A, callback_data: 'baja', content_json: JSON.stringify({ text: TEXTO_BAJA }) }]);

    vi.setSystemTime(MARTES_10 + 60_000);
    await manda(texto('wamid.SAL2', 'salir'));
    expect((await deudorDe(d)).wa_opt_out_at).toBe(wa_opt_out_at); // la primera fecha se conserva

    // Mismo día del cobro: el motivo es BAJA porque `puedeContactar` evalúa la baja antes que «ya cobrado hoy».
    const enlace = await api(`/api/deudores/${d}/cobros`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ tono: 'VECINO_AMIGABLE' }) });
    expect(enlace.status).toBe(409);
    expect(await enlace.json()).toMatchObject({ error: 'contacto_bloqueado', motivo: 'BAJA' });
    const bot = await api(`/api/cobros-bot/${d}`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ tono: 'VECINO_AMIGABLE', request_id: 'toque-tras-baja' }) });
    expect(bot.status).toBe(409);
    expect(await bot.json()).toMatchObject({ error: 'contacto_bloqueado', motivo: 'BAJA' });
  });

  test('«quiero salir de esto» no es una baja', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(texto('wamid.NB', 'quiero salir de esto'));
    expect(await deudorDe(d)).toMatchObject({ wa_opt_out_at: null });
  });

  test('la baja es del deudor de la tienda a la que respondió: el de B sigue igual', async () => {
    const dA = await deudor('uid_a');
    const dB = await deudor('uid_b');
    const cobroA = await cobrar('uid_a', dA);
    await cobrar('uid_b', dB);
    await manda(texto('wamid.SB', 'SALIR', { respondeA: cobroA }));
    expect(await deudorDe(dA)).toMatchObject({ wa_opt_out_at: MARTES_10 });
    expect(await deudorDe(dB)).toMatchObject({ wa_opt_out_at: null });
  });
});

describe('lo que no es de un deudor enrutado no se procesa aquí', () => {
  test('órdenes del dueño verificado (aunque su teléfono sea también el de un deudor): ni abono, ni baja, ni promesa', async () => {
    await env.DB.prepare('UPDATE businesses SET whatsapp_phone = ?1 WHERE id = ?2').bind(DUENO_A, A).run(); // un número nuevo llega sin verificar
    await env.DB.prepare('UPDATE businesses SET whatsapp_verified_at = ?1 WHERE id = ?2').bind(MARTES_10 - 1, A).run();
    const d = await deudor('uid_a', DUENO_A);
    await cobrar('uid_a', d);
    await manda(imagen('wamid.D1', { de: DUENO_A }));
    await manda(texto('wamid.D2', 'SALIR', { de: DUENO_A }));
    await manda(texto('wamid.D3', 'el viernes', { de: DUENO_A }));
    expect((await entranteDe('wamid.D1')).routing_rule).toBe('ORDEN_DUENO');
    expect(await movimientos()).toEqual([]);
    expect(await objetos()).toEqual([]);
    expect(await deudorDe(d)).toMatchObject({ wa_opt_out_at: null, promised_payment_date: null });
  });

  test('un número desconocido (UNROUTED) no crea nada', async () => {
    await manda(imagen('wamid.U1', { de: DESCONOCIDO }));
    await manda(texto('wamid.U2', 'SALIR', { de: DESCONOCIDO }));
    expect((await entranteDe('wamid.U1')).routing_state).toBe('UNROUTED');
    expect(await movimientos()).toEqual([]);
    expect(await objetos()).toEqual([]);
  });

  test('en espera de elección no se procesa; al elegir A, el comprobante entra en A y nada en B', async () => {
    const dA = await deudor('uid_a');
    const dB = await deudor('uid_b');
    await cobrar('uid_a', dA);
    await cobrar('uid_b', dB);
    await manda(imagen('wamid.AMB'));
    expect((await entranteDe('wamid.AMB')).routing_state).toBe('AWAITING_TENANT_SELECTION');
    expect(await movimientos()).toEqual([]);

    const pregunta = (await env.DB.prepare("SELECT wa_message_id FROM whatsapp_messages WHERE direction = 'SALIENTE' AND callback_data = 'elegir'").first<{ wa_message_id: string }>())!;
    await manda(cuerpoMeta({ mensajes: [entrante.boton({ de: DEUDOR, id: 'wamid.ELIGE', respondeA: pregunta.wa_message_id, botonId: `${PREFIJO_ELEGIR}${A}`, titulo: 'Tienda A' })] }));
    expect(await movimientos()).toMatchObject([{ business_id: A, debtor_id: dA, request_id: 'wa:wamid.AMB', status: 'PENDIENTE_VERIFICACION_WHATSAPP' }]);
    expect(await objetos(`negocios/${B}/`)).toEqual([]);
  });
});

describe('revisión de WAP-05: un fallo no pierde el comprobante ni la baja', () => {
  test('fetchMedia falla una vez: el siguiente mensaje del mismo teléfono lo reintenta', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    vi.spyOn(SimulatedGateway.prototype, 'fetchMedia').mockRejectedValueOnce(new Error('Meta caído'));
    await manda(imagen('wamid.F1'));
    expect(await movimientos()).toEqual([]);
    await manda(texto('wamid.F2', 'hola'));
    expect(await movimientos()).toMatchObject([{ debtor_id: d, request_id: 'wa:wamid.F1', status: 'PENDIENTE_VERIFICACION_WHATSAPP' }]);
    await manda(texto('wamid.F3', 'gracias')); // ya tiene efecto: no se repite
    expect(await movimientos()).toHaveLength(1);
  });

  test('ARCHIVOS.put falla una vez: se reintenta y queda la evidencia', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    let fallos = 0;
    const r2 = new Proxy(env.ARCHIVOS, {
      get(o, p) {
        if (p === 'put' && fallos++ === 0) return () => Promise.reject(new Error('R2 caído'));
        const v = Reflect.get(o, p);
        return typeof v === 'function' ? v.bind(o) : v;
      },
    });
    await manda(imagen('wamid.R1'), entornoWa({ ARCHIVOS: r2 }));
    expect(await movimientos()).toEqual([]);
    await manda(texto('wamid.R2', 'hola'));
    const [mov] = await movimientos();
    expect(mov).toMatchObject({ request_id: 'wa:wamid.R1', debtor_id: d });
    expect(await env.ARCHIVOS.head(mov!.evidence_r2_key)).not.toBeNull();
  });

  test('el INSERT del abono falla una vez: se reintenta', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(imagen('wamid.IN1'), entornoWa({ DB: dbQueFallaUnaVez((q) => q.includes('INSERT INTO ledger_transactions')) }));
    expect(await movimientos()).toEqual([]);
    await manda(texto('wamid.IN2', 'hola'));
    expect(await movimientos()).toMatchObject([{ request_id: 'wa:wamid.IN1', debtor_id: d }]);
  });

  test('el UPDATE de la baja falla una vez: el siguiente mensaje la aplica y confirma', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(texto('wamid.BJ1', 'SALIR'), entornoWa({ DB: dbQueFallaUnaVez((q) => q.includes('SET wa_opt_out_at')) }));
    expect(await deudorDe(d)).toMatchObject({ wa_opt_out_at: null });
    vi.setSystemTime(MARTES_10 + 60_000);
    await manda(texto('wamid.BJ2', 'hola'));
    expect(await deudorDe(d)).toMatchObject({ wa_opt_out_at: MARTES_10 + 60_000 });
    expect(await respuestasA('wamid.BJ1')).toMatchObject([{ callback_data: 'baja', content_json: JSON.stringify({ text: TEXTO_BAJA }) }]);
    await cobrosBloqueados('uid_a', d);
  });

  test('si falla la lectura de un entrante, los demás del lote siguen y ese se reintenta después', async () => {
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    const lote = cuerpoMeta({ mensajes: [entrante.imagen({ de: DEUDOR, id: 'wamid.L1', mediaId: 'sim-png', mimeType: 'image/png' }), entrante.texto({ de: DEUDOR, id: 'wamid.L2', texto: 'SALIR' })] });
    await manda(lote, entornoWa({ DB: dbQueFallaAlLeer('wamid.L1') }));
    expect(await deudorDe(d)).toMatchObject({ wa_opt_out_at: MARTES_10 }); // el segundo sí se procesó
    expect(await movimientos()).toEqual([]);
    await manda(texto('wamid.L3', 'hola'));
    expect(await movimientos()).toMatchObject([{ request_id: 'wa:wamid.L1' }]);
  });

  test('no se reintenta lo de hace más de 7 días, ni una promesa', async () => {
    const d = await deudor('uid_a');
    const cobro = await cobrar('uid_a', d);
    await manda(texto('wamid.PR', 'el viernes', { respondeA: cobro }), entornoWa({ DB: dbQueFallaAlLeer('wamid.PR') }));
    await manda(texto('wamid.PR2', 'hola', { respondeA: cobro }));
    expect(await respuestasA('wamid.PR')).toEqual([]); // la propuesta vieja no se reprocesa

    vi.spyOn(SimulatedGateway.prototype, 'fetchMedia').mockRejectedValueOnce(new Error('Meta caído'));
    await manda(imagen('wamid.VIEJA', { respondeA: cobro }));
    vi.setSystemTime(MARTES_10 + 8 * DIA_MS);
    await manda(texto('wamid.TARDE', 'hola', { respondeA: cobro }));
    expect(await movimientos()).toEqual([]);
  });
});

describe('revisión de WAP-05: «SALIR» sin un único deudor', () => {
  test('UNROUTED pasadas 72 h: baja en los deudores con ese teléfono de las tiendas que le escribieron, y en ninguna otra', async () => {
    const dA = await deudor('uid_a');
    const dC = await deudor('uid_c'); // la tienda C nunca le escribió
    await cobrar('uid_a', dA);
    vi.setSystemTime(MARTES_10 + 73 * 3_600_000); // viernes 20, 11:00
    await manda(texto('wamid.U72', 'Salir, gracias'));
    expect((await entranteDe('wamid.U72')).routing_state).toBe('UNROUTED');
    expect(await deudorDe(dA)).toMatchObject({ wa_opt_out_at: MARTES_10 + 73 * 3_600_000 });
    expect(await deudorDe(dC)).toMatchObject({ wa_opt_out_at: null });
    // Una sola respuesta: la confirmación, sin nombrar tiendas (no la neutra del enrutador).
    expect(await respuestasA('wamid.U72')).toMatchObject([{ business_id: null, callback_data: 'baja', content_json: JSON.stringify({ text: TEXTO_BAJA }) }]);
    await cobrosBloqueados('uid_a', dA);
  });

  test('en espera de elección (sin pulsar botón): baja en A y en B, no en C, y no se pregunta por la tienda', async () => {
    const dA = await deudor('uid_a');
    const dB = await deudor('uid_b');
    const dC = await deudor('uid_c');
    await cobrar('uid_a', dA);
    await cobrar('uid_b', dB);
    await manda(texto('wamid.AW', 'STOP'));
    expect((await entranteDe('wamid.AW')).routing_state).toBe('AWAITING_TENANT_SELECTION');
    expect(await deudorDe(dA)).toMatchObject({ wa_opt_out_at: MARTES_10 });
    expect(await deudorDe(dB)).toMatchObject({ wa_opt_out_at: MARTES_10 });
    expect(await deudorDe(dC)).toMatchObject({ wa_opt_out_at: null });
    expect(await respuestasA('wamid.AW')).toMatchObject([{ callback_data: 'baja', content_json: JSON.stringify({ text: TEXTO_BAJA }) }]);
    vi.setSystemTime(MARTES_10 + DIA_MS); // otro día: ya no es «cobrado hoy»
    await cobrosBloqueados('uid_a', dA);
    await cobrosBloqueados('uid_b', dB);
  });

  test('ROUTED sin deudor único (dos deudores de A con ese teléfono): baja en ambos', async () => {
    const d1 = await deudor('uid_a');
    const d2 = await deudor('uid_a');
    await cobrar('uid_a', d1);
    await manda(texto('wamid.DOS', 'no me escriban más'));
    expect(await entranteDe('wamid.DOS')).toMatchObject({ routing_state: 'ROUTED', debtor_id: null });
    expect(await deudorDe(d1)).toMatchObject({ wa_opt_out_at: MARTES_10 });
    expect(await deudorDe(d2)).toMatchObject({ wa_opt_out_at: MARTES_10 });
  });

  test('un número desconocido que escribe SALIR no toca a nadie más', async () => {
    const dA = await deudor('uid_a', OTRO);
    await manda(texto('wamid.DS', 'SALIR', { de: DESCONOCIDO }));
    expect(await deudorDe(dA)).toMatchObject({ wa_opt_out_at: null });
  });
});

describe('revisión de WAP-05: comprobante reutilizado y tope de pendientes', () => {
  test('la misma imagen ya confirmada, o de otro deudor del negocio, no crea otro abono y responde neutro', async () => {
    const d1 = await deudor('uid_a');
    const d2 = await deudor('uid_a', OTRO);
    await cobrar('uid_a', d1);
    await cobrar('uid_a', d2);
    await manda(imagen('wamid.O1'));
    const [mov] = await movimientos();
    await env.DB.prepare("UPDATE ledger_transactions SET status = 'CONFIRMADO', balance_after_cop = 0, confirmed_at = ?1 WHERE id = ?2").bind(MARTES_10, mov!.id).run();
    await manda(imagen('wamid.O2')); // mismo deudor, ya confirmado
    await manda(imagen('wamid.O3', { de: OTRO })); // otro deudor del mismo negocio
    expect(await movimientos()).toHaveLength(1);
    expect(await objetos()).toHaveLength(1);
    for (const w of ['wamid.O2', 'wamid.O3']) {
      expect(await respuestasA(w)).toMatchObject([{ callback_data: 'comprobante_no_registrado', content_json: JSON.stringify({ text: TEXTO_NO_REGISTRADO }) }]);
    }
  });

  test(`máximo ${MAX_PENDIENTES_POR_DEUDOR} abonos pendientes por deudor: el siguiente no guarda imagen ni crea nada`, async () => {
    expect(MAX_PENDIENTES_POR_DEUDOR).toBe(3);
    const d = await deudor('uid_a');
    await cobrar('uid_a', d);
    await manda(imagen('wamid.T1', { mediaId: 'sim-png' }));
    await manda(imagen('wamid.T2', { mediaId: 'sim-jpeg' }));
    await manda(imagen('wamid.T3', { mediaId: 'sim-webp' }));
    expect(await movimientos()).toHaveLength(3);
    const descargas = vi.spyOn(SimulatedGateway.prototype, 'fetchMedia');
    await manda(imagen('wamid.T4', { mediaId: 'sim-png' }));
    expect(await movimientos()).toHaveLength(3);
    expect(await objetos()).toHaveLength(3);
    expect(descargas).not.toHaveBeenCalled();
    expect(await respuestasA('wamid.T4')).toMatchObject([{ callback_data: 'comprobante_no_registrado', content_json: JSON.stringify({ text: TEXTO_NO_REGISTRADO }) }]);
  });
});
