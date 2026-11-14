// WAP-04: enrutamiento de los entrantes, pasos de producto.md B4 en su orden. Todo entra FIRMADO por el webhook real
// (inyector de src/worker/test/whatsapp.ts) y los cobros salen por la ruta real del bot, contra el simulador.
// Reloj controlado para las 72 h; `fetch` vigilado: nada sale a la red.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HORA, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';
import { cuerpoMeta, entornoWa, entrante, estado, inyectar } from '../test/whatsapp';
import { PREFIJO_ELEGIR, TEXTO_ELEGIR, TEXTO_NEUTRO, VENTANA_ENRUTAMIENTO_MS } from './enrutar';
import { SimulatedGateway } from './simulado';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00'); // día hábil, en horario de cobro; segundo exacto
const DEUDOR = '+573001234567'; // ficticio
const OTRO_DEUDOR = '+573007654321'; // ficticio
const DUENO_A = '+573109998877'; // ficticio
const A = 'bus_uid_a';
const B = 'bus_uid_b';
const C = 'bus_uid_c';

type Fila = Record<string, any>;
const todas = async () => (await env.DB.prepare('SELECT * FROM whatsapp_messages ORDER BY created_at, id').all<Fila>()).results;
const entranteDe = async (wamid: string) => (await env.DB.prepare('SELECT * FROM whatsapp_messages WHERE wa_message_id = ?').bind(wamid).first<Fila>())!;
/** Lo que respondió el enrutador (salientes sin negocio: pregunta de elección o respuesta neutra). */
const respuestasDelBot = async () => (await todas()).filter((f) => f.direction === 'SALIENTE' && f.business_id === null);
const entrantesDe = async (negocio: string) => (await todas()).filter((f) => f.direction === 'ENTRANTE' && f.business_id === negocio);

let red: ReturnType<typeof vi.fn>;
let registros: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES_10);
  red = vi.fn(() => Promise.reject(new Error('el enrutamiento no debe salir a la red')));
  vi.stubGlobal('fetch', red);
  registros = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
  for (const uid of ['uid_a', 'uid_b', 'uid_c']) await sembrarNegocio(uid, { name: `Tienda ${uid.slice(-1).toUpperCase()}` });
});
afterEach(() => {
  try {
    expect(red).not.toHaveBeenCalled();
    for (const r of registros) expect(r).not.toHaveBeenCalled(); // B5: ni cuerpos ni teléfonos en los registros
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

/** Deudor con saldo, teléfono y consentimiento en la tienda `uid`. */
async function deudor(uid: string, telefono = DEUDOR) {
  const res = await api('/api/deudores', { uid }, { method: 'POST', body: JSON.stringify({ full_name: 'don Carlos', whatsapp_phone: telefono, wa_consentimiento: true }) });
  const { id } = await res.json<{ id: string }>();
  await api(`/api/deudores/${id}/movimientos`, { uid }, { method: 'POST', body: JSON.stringify({ request_id: `req-${id}`, type: 'FIADO', amount_cop: 84_900 }) });
  return id;
}

/** La tienda `uid` le cobra por el bot (ruta real de WAP-03) en el instante `en`. Devuelve el wamid del cobro. */
async function cobrar(uid: string, deudorId: string, en = Date.now(), toque = `toque-${deudorId}`) {
  const antes = Date.now();
  vi.setSystemTime(en);
  const res = await api(`/api/cobros-bot/${deudorId}`, { uid }, { method: 'POST', body: JSON.stringify({ tono: 'VECINO_AMIGABLE', request_id: toque }) });
  expect(res.status).toBe(200);
  vi.setSystemTime(Math.max(antes, en));
  const fila = await env.DB.prepare("SELECT wa_message_id FROM whatsapp_messages WHERE direction = 'SALIENTE' AND request_id LIKE ?")
    .bind(`cobro-bot:%:${deudorId}:%`).first<{ wa_message_id: string }>();
  return fila!.wa_message_id;
}

/** El deudor escribe (texto) en el instante `en`, firmado por el webhook real. */
async function escribe({ de = DEUDOR, id, en = Date.now(), respondeA, texto = 'Hola, ya pagué' }: { de?: string; id: string; en?: number; respondeA?: string; texto?: string }) {
  vi.setSystemTime(Math.max(Date.now(), en));
  const res = await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de, id, en, respondeA, texto })] }));
  expect(res.status).toBe(200);
  return entranteDe(id);
}

describe('paso 1: un evento repetido no se enruta dos veces', () => {
  test('el mismo wa_message_id entregado otra vez (y dos a la vez) → una sola decisión y una sola respuesta', async () => {
    const respuestas = vi.spyOn(SimulatedGateway.prototype, 'sendReply');
    const cuerpo = cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id: 'wamid.REP', texto: 'hola' })] });
    await Promise.all([inyectar(cuerpo), inyectar(cuerpo)]);
    const primera = await entranteDe('wamid.REP');
    expect(primera).toMatchObject({ routing_state: 'UNROUTED' });
    await inyectar(cuerpo); // reentrega de Meta
    expect(await entranteDe('wamid.REP')).toEqual(primera);
    expect(respuestas).toHaveBeenCalledTimes(1);
    expect(await respuestasDelBot()).toHaveLength(1);
  });

  test('ya enrutado por elección, la reentrega del mensaje original no lo vuelve a preguntar ni a cambiar', async () => {
    await cobrar('uid_a', await deudor('uid_a'));
    await cobrar('uid_b', await deudor('uid_b'));
    await escribe({ id: 'wamid.ORIG' });
    const [pregunta] = await respuestasDelBot();
    await inyectar(cuerpoMeta({ mensajes: [entrante.boton({ de: DEUDOR, id: 'wamid.ELIGE', respondeA: pregunta!.wa_message_id, botonId: `${PREFIJO_ELEGIR}${A}`, titulo: 'Tienda A' })] }));
    const enrutado = await entranteDe('wamid.ORIG');
    expect(enrutado).toMatchObject({ routing_state: 'ROUTED', business_id: A });
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id: 'wamid.ORIG', texto: 'Hola, ya pagué' })] }));
    expect(await entranteDe('wamid.ORIG')).toEqual(enrutado);
    expect(await respuestasDelBot()).toHaveLength(1);
  });
});

describe('paso 2: respuesta a un mensaje nuestro → negocio y deudor exactos', () => {
  test('responde al cobro de A, aunque B le escribió después → A, con el deudor de A; B no recibe nada', async () => {
    const deudorA = await deudor('uid_a');
    const cobroA = await cobrar('uid_a', deudorA);
    await cobrar('uid_b', await deudor('uid_b'), MARTES_10 + HORA);
    const fila = await escribe({ id: 'wamid.R1', respondeA: cobroA, en: MARTES_10 + 2 * HORA });
    expect(fila).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'RESPUESTA', business_id: A, debtor_id: deudorA });
    expect(await entrantesDe(B)).toEqual([]);
    expect(await respuestasDelBot()).toEqual([]); // no hizo falta preguntar
  });

  test('citando un mensaje que no es nuestro no cuenta: sigue al paso siguiente', async () => {
    const deudorA = await deudor('uid_a');
    await cobrar('uid_a', deudorA);
    const fila = await escribe({ id: 'wamid.R2', respondeA: 'wamid.AJENO' });
    expect(fila).toMatchObject({ routing_rule: 'UNICO_72H', business_id: A, debtor_id: deudorA });
  });

  test('aislamiento: citar un cobro de A enviado a OTRO teléfono no lleva el mensaje a A', async () => {
    const cobroAOtro = await cobrar('uid_a', await deudor('uid_a', OTRO_DEUDOR));
    const deudorB = await deudor('uid_b');
    await cobrar('uid_b', deudorB);
    const fila = await escribe({ id: 'wamid.R3', respondeA: cobroAOtro });
    expect(fila).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'UNICO_72H', business_id: B, debtor_id: deudorB });
    expect(await entrantesDe(A)).toEqual([]);
  });

  test('citar un entrante (no un saliente nuestro) tampoco cuenta', async () => {
    await escribe({ id: 'wamid.PROPIO' });
    const fila = await escribe({ id: 'wamid.R4', respondeA: 'wamid.PROPIO' });
    expect(fila).toMatchObject({ routing_state: 'UNROUTED', business_id: null });
  });

  test('va antes que el paso 3: el dueño verificado de A que responde a un cobro de B → B', async () => {
    await env.DB.prepare('UPDATE businesses SET whatsapp_phone = ?1, whatsapp_verified_at = ?2 WHERE id = ?3').bind(DUENO_A, MARTES_10, A).run();
    const deudorB = await deudor('uid_b', DUENO_A);
    const cobroB = await cobrar('uid_b', deudorB);
    const fila = await escribe({ de: DUENO_A, id: 'wamid.R5', respondeA: cobroB });
    expect(fila).toMatchObject({ routing_rule: 'RESPUESTA', business_id: B, debtor_id: deudorB });
  });
});

describe('paso 3: teléfono verificado de un dueño → orden del dueño', () => {
  test('el dueño VERIFICADO de A escribe → orden de A, sin deudor y sin respuesta del bot', async () => {
    await env.DB.prepare('UPDATE businesses SET whatsapp_phone = ?1, whatsapp_verified_at = ?2 WHERE id = ?3').bind(DUENO_A, MARTES_10 - HORA, A).run();
    const fila = await escribe({ de: DUENO_A, id: 'wamid.D1', texto: 'APROBAR 0042' });
    expect(fila).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'ORDEN_DUENO', business_id: A, debtor_id: null });
    expect(await respuestasDelBot()).toEqual([]);
  });

  test('el dueño SIN verificar no da órdenes: es un desconocido', async () => {
    await env.DB.prepare('UPDATE businesses SET whatsapp_phone = ?1 WHERE id = ?2').bind(DUENO_A, A).run();
    const fila = await escribe({ de: DUENO_A, id: 'wamid.D2', texto: 'APROBAR 0042' });
    expect(fila).toMatchObject({ routing_state: 'UNROUTED', routing_rule: null, business_id: null });
  });
});

describe('paso 4: un único negocio le escribió en las últimas 72 h → ese negocio', () => {
  test('solo A le escribió → A, con el deudor de A', async () => {
    const deudorA = await deudor('uid_a');
    await cobrar('uid_a', deudorA);
    const fila = await escribe({ id: 'wamid.U1', en: MARTES_10 + 5 * HORA });
    expect(fila).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'UNICO_72H', business_id: A, debtor_id: deudorA });
    expect(await respuestasDelBot()).toEqual([]);
  });

  test('a las 72 h exactas todavía cuenta', async () => {
    await cobrar('uid_a', await deudor('uid_a'), MARTES_10);
    const fila = await escribe({ id: 'wamid.U2', en: MARTES_10 + VENTANA_ENRUTAMIENTO_MS });
    expect(fila.occurred_at - MARTES_10).toBe(VENTANA_ENRUTAMIENTO_MS);
    expect(fila).toMatchObject({ routing_rule: 'UNICO_72H', business_id: A });
  });

  test('a las 72 h + 1 ms ya no: desconocido', async () => {
    await cobrar('uid_a', await deudor('uid_a'), MARTES_10 - 1);
    const fila = await escribe({ id: 'wamid.U3', en: MARTES_10 + VENTANA_ENRUTAMIENTO_MS });
    expect(fila.occurred_at - (MARTES_10 - 1)).toBe(VENTANA_ENRUTAMIENTO_MS + 1);
    expect(fila).toMatchObject({ routing_state: 'UNROUTED', business_id: null });
  });

  test('un cobro que falló no cuenta como «le escribió»', async () => {
    const cobroB = await cobrar('uid_b', await deudor('uid_b'));
    await inyectar(cuerpoMeta({ estados: [estado(cobroB, 'failed', { codigo: 131026 })] }));
    await cobrar('uid_a', await deudor('uid_a'));
    expect(await escribe({ id: 'wamid.U4' })).toMatchObject({ routing_rule: 'UNICO_72H', business_id: A });
  });
});

describe('paso 5: ambiguo → AWAITING_TENANT_SELECTION y pregunta con botones', () => {
  test('A y B le escribieron: no se asigna, sale UNA pregunta por el simulador con solo esos comercios', async () => {
    await cobrar('uid_a', await deudor('uid_a'));
    await cobrar('uid_b', await deudor('uid_b'), MARTES_10 + HORA);
    const fila = await escribe({ id: 'wamid.M1', en: MARTES_10 + 2 * HORA });
    expect(fila).toMatchObject({ routing_state: 'AWAITING_TENANT_SELECTION', routing_rule: null, business_id: null, debtor_id: null });
    const bot = await respuestasDelBot();
    expect(bot).toHaveLength(1);
    expect(bot[0]).toMatchObject({ kind: 'buttons', phone: DEUDOR, status: 'accepted', reply_to_wa_message_id: 'wamid.M1', content_json: JSON.stringify({ text: TEXTO_ELEGIR }) });
    // Solo los comercios que le escribieron (C no), el más reciente primero.
    expect(JSON.parse(bot[0]!.buttons_json)).toEqual([{ id: `${PREFIJO_ELEGIR}${B}`, title: 'Tienda B' }, { id: `${PREFIJO_ELEGIR}${A}`, title: 'Tienda A' }]);
  });

  test('mientras espera, otro mensaje no repite la pregunta; al elegir A, ambos van a A y B no recibe nada', async () => {
    const deudorA = await deudor('uid_a');
    await cobrar('uid_a', deudorA);
    await cobrar('uid_b', await deudor('uid_b'));
    await escribe({ id: 'wamid.M2' });
    await escribe({ id: 'wamid.M3', texto: 'el comprobante va ahora' });
    const preguntas = await respuestasDelBot();
    expect(preguntas).toHaveLength(1);
    expect(await entranteDe('wamid.M3')).toMatchObject({ routing_state: 'AWAITING_TENANT_SELECTION' });

    await inyectar(cuerpoMeta({ mensajes: [entrante.boton({ de: DEUDOR, id: 'wamid.ELIGE_A', respondeA: preguntas[0]!.wa_message_id, botonId: `${PREFIJO_ELEGIR}${A}`, titulo: 'Tienda A' })] }));
    for (const id of ['wamid.M2', 'wamid.M3', 'wamid.ELIGE_A']) {
      expect(await entranteDe(id)).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'ELECCION', business_id: A, debtor_id: deudorA });
    }
    expect(await entrantesDe(B)).toEqual([]);
  });

  test('aislamiento: un botón inventado con un comercio que no se ofreció (C) no asigna nada a C', async () => {
    await cobrar('uid_a', await deudor('uid_a'));
    await cobrar('uid_b', await deudor('uid_b'));
    await escribe({ id: 'wamid.M4' });
    const [pregunta] = await respuestasDelBot();
    await inyectar(cuerpoMeta({ mensajes: [entrante.boton({ de: DEUDOR, id: 'wamid.FALSO', respondeA: pregunta!.wa_message_id, botonId: `${PREFIJO_ELEGIR}${C}`, titulo: 'Tienda C' })] }));
    expect(await entranteDe('wamid.FALSO')).toMatchObject({ routing_state: 'AWAITING_TENANT_SELECTION', business_id: null });
    expect(await entranteDe('wamid.M4')).toMatchObject({ routing_state: 'AWAITING_TENANT_SELECTION', business_id: null });
    expect(await entrantesDe(C)).toEqual([]);
  });

  test('aislamiento: el botón de elección pulsado desde OTRO teléfono no cuenta', async () => {
    await cobrar('uid_a', await deudor('uid_a'));
    await cobrar('uid_b', await deudor('uid_b'));
    await escribe({ id: 'wamid.M5' });
    const [pregunta] = await respuestasDelBot();
    await inyectar(cuerpoMeta({ mensajes: [entrante.boton({ de: OTRO_DEUDOR, id: 'wamid.AJENO_ELIGE', respondeA: pregunta!.wa_message_id, botonId: `${PREFIJO_ELEGIR}${A}`, titulo: 'Tienda A' })] }));
    expect(await entranteDe('wamid.AJENO_ELIGE')).toMatchObject({ business_id: null });
    expect(await entranteDe('wamid.M5')).toMatchObject({ routing_state: 'AWAITING_TENANT_SELECTION', business_id: null });
  });
});

describe('paso 6: desconocido → una respuesta neutra, sin datos', () => {
  test('nadie le escribió: UNROUTED y un texto neutro que no nombra ningún comercio', async () => {
    const fila = await escribe({ id: 'wamid.X1' });
    expect(fila).toMatchObject({ routing_state: 'UNROUTED', routing_rule: null, business_id: null, debtor_id: null });
    const bot = await respuestasDelBot();
    expect(bot).toHaveLength(1);
    expect(bot[0]).toMatchObject({ kind: 'text', phone: DEUDOR, status: 'accepted', reply_to_wa_message_id: 'wamid.X1' });
    expect(JSON.parse(bot[0]!.content_json)).toEqual({ text: TEXTO_NEUTRO });
    expect(bot[0]!.content_json).not.toMatch(/Tienda/);
  });

  test('no contesta en bucle: una sola respuesta neutra por teléfono cada 24 h', async () => {
    await escribe({ id: 'wamid.X2' });
    await escribe({ id: 'wamid.X3', en: MARTES_10 + 23 * HORA });
    expect(await respuestasDelBot()).toHaveLength(1);
    await escribe({ id: 'wamid.X4', en: MARTES_10 + 25 * HORA });
    expect(await respuestasDelBot()).toHaveLength(2);
  });
});

describe('revisión independiente de WAP-04', () => {
  /** El deudor pulsa el botón de la tienda `negocio` en la pregunta `pregunta`. */
  const elige = (id: string, pregunta: string, negocio: string) =>
    inyectar(cuerpoMeta({ mensajes: [entrante.boton({ de: DEUDOR, id, respondeA: pregunta, botonId: `${PREFIJO_ELEGIR}${negocio}`, titulo: 'Tienda' })] }));

  test('dos entrantes ambiguos a la vez (dos POST) → UNA pregunta, y al elegir ambos van a esa tienda', async () => {
    const deudorA = await deudor('uid_a');
    await cobrar('uid_a', deudorA);
    await cobrar('uid_b', await deudor('uid_b'));
    vi.setSystemTime(MARTES_10 + HORA);
    await Promise.all(['wamid.C1', 'wamid.C2'].map((id) => inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id, texto: 'hola' })] }))));
    const preguntas = await respuestasDelBot();
    expect(preguntas).toHaveLength(1);
    expect(preguntas[0]).toMatchObject({ kind: 'buttons', status: 'accepted' });
    await elige('wamid.C_ELIGE', preguntas[0]!.wa_message_id, A);
    for (const id of ['wamid.C1', 'wamid.C2']) expect(await entranteDe(id)).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'ELECCION', business_id: A, debtor_id: deudorA });
  });

  test('si la pregunta no llegó a salir (el envío lanza), el siguiente mensaje pregunta y la elección enruta los dos', async () => {
    await cobrar('uid_a', await deudor('uid_a'));
    await cobrar('uid_b', await deudor('uid_b'));
    vi.spyOn(SimulatedGateway.prototype, 'sendReply').mockRejectedValueOnce(new Error('gateway caído'));
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id: 'wamid.S1', texto: 'hola' })] }));
    expect(await respuestasDelBot()).toEqual([]);
    await escribe({ id: 'wamid.S2', en: MARTES_10 + HORA });
    const preguntas = await respuestasDelBot();
    expect(preguntas).toHaveLength(1);
    await elige('wamid.S_ELIGE', preguntas[0]!.wa_message_id, B);
    for (const id of ['wamid.S1', 'wamid.S2']) expect(await entranteDe(id)).toMatchObject({ routing_state: 'ROUTED', business_id: B });
  });

  test('si el enrutamiento falla en un mensaje, sigue con los demás del lote y la reentrega de Meta lo enruta', async () => {
    let fallos = 0;
    const roto = new Proxy(env.DB, {
      get(db, p) {
        if (p === 'prepare') {
          return (q: string) => {
            if (q.includes('FROM businesses WHERE whatsapp_phone') && fallos++ === 0) throw new Error('D1 caído');
            return db.prepare(q);
          };
        }
        const v = Reflect.get(db, p);
        return typeof v === 'function' ? v.bind(db) : v;
      },
    });
    const cuerpo = cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id: 'wamid.F1', texto: 'a' }), entrante.texto({ de: OTRO_DEUDOR, id: 'wamid.F2', texto: 'b' })] });
    expect((await inyectar(cuerpo, entornoWa({ DB: roto as D1Database }))).status).toBe(200);
    expect(await entranteDe('wamid.F1')).toMatchObject({ routing_state: null });
    expect(await entranteDe('wamid.F2')).toMatchObject({ routing_state: 'UNROUTED' });
    expect((await inyectar(cuerpo)).status).toBe(200); // reentrega: F1 ya existía, pero sigue sin enrutar
    expect(await entranteDe('wamid.F1')).toMatchObject({ routing_state: 'UNROUTED' });
    expect((await respuestasDelBot()).map((f) => f.phone).sort()).toEqual([DEUDOR, OTRO_DEUDOR].sort()); // una neutra a cada uno
  });

  test('una elección en una pregunta VIEJA solo enruta los mensajes de esa pregunta, no los de una pregunta posterior', async () => {
    await cobrar('uid_a', await deudor('uid_a'));
    const deudorB = await deudor('uid_b');
    await cobrar('uid_b', deudorB);
    await escribe({ id: 'wamid.P1', en: MARTES_10 + HORA });
    const [q1] = await respuestasDelBot();
    // A las 48 h cobran B y C; a las 74 h A ya no cuenta (72 h) y la pregunta nueva ofrece solo B y C.
    await env.DB.prepare('UPDATE debtors SET last_reminder_sent_at = NULL').run();
    await cobrar('uid_b', deudorB, MARTES_10 + 48 * HORA, 'toque-segundo');
    await cobrar('uid_c', await deudor('uid_c'), MARTES_10 + 48 * HORA);
    await escribe({ id: 'wamid.P2', en: MARTES_10 + 74 * HORA, texto: 'para C' });
    const q2 = (await respuestasDelBot()).find((f) => f.id !== q1!.id)!;
    expect(JSON.parse(q2.buttons_json).map((b: { id: string }) => b.id).sort()).toEqual([`${PREFIJO_ELEGIR}${B}`, `${PREFIJO_ELEGIR}${C}`]);

    await elige('wamid.EL_Q1', q1!.wa_message_id, A);
    expect(await entranteDe('wamid.P1')).toMatchObject({ routing_state: 'ROUTED', business_id: A });
    expect(await entranteDe('wamid.P2')).toMatchObject({ routing_state: 'AWAITING_TENANT_SELECTION', business_id: null });
    await elige('wamid.EL_Q2', q2.wa_message_id, C);
    expect(await entranteDe('wamid.P2')).toMatchObject({ routing_state: 'ROUTED', business_id: C });
    expect(await entranteDe('wamid.P1')).toMatchObject({ business_id: A });
  });

  test('paso 4: un entrante fechado ANTES del cobro (reentrega tardía) no es de esa tienda', async () => {
    await cobrar('uid_a', await deudor('uid_a'), MARTES_10 + 2 * HORA + 500);
    vi.setSystemTime(MARTES_10 + 2 * HORA + 500);
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id: 'wamid.VIEJO', en: MARTES_10, texto: 'mensaje de antes' })] }));
    expect(await entranteDe('wamid.VIEJO')).toMatchObject({ routing_state: 'UNROUTED', business_id: null });
    // En el mismo segundo del cobro sí cuenta: Meta fecha en segundos, así que llega como 0,5 s antes del cobro.
    expect(await escribe({ id: 'wamid.MISMO_SEGUNDO', en: MARTES_10 + 2 * HORA + 500 })).toMatchObject({ routing_rule: 'UNICO_72H', business_id: A });
  });

  test('dos desconocidos a la vez del mismo teléfono → UNA respuesta neutra', async () => {
    await Promise.all(['wamid.N1', 'wamid.N2'].map((id) => inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id, texto: 'hola' })] }))));
    expect(await respuestasDelBot()).toHaveLength(1);
  });
});
