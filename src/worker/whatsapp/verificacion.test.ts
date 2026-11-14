// WAP-02: verificación del teléfono del dueño por código (producto.md B4; contrato-sarin.md d.9). El código se emite
// por la ruta real de la app y el entrante llega FIRMADO por el webhook real (inyector de src/worker/test/whatsapp.ts).
// Reloj controlado para el vencimiento; `fetch` vigilado: nada sale a la red.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';
import { cuerpoMeta, entrante, inyectar } from '../test/whatsapp';
import { ESPERA_CODIGO_MS, MAX_INTENTOS_CODIGO, TEXTO_CODIGO_NO_VALE, TEXTO_VERIFICADO, VIGENCIA_CODIGO_MS } from './verificacion';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00');
const DUENO_A = '+573109998877'; // ficticio
const DUENO_B = '+573109998866'; // ficticio
const EXTRANO = '+573001112299'; // ficticio
const A = 'bus_uid_a';
const B = 'bus_uid_b';

type Fila = Record<string, any>;
const negocio = async (id: string) => (await env.DB.prepare('SELECT * FROM businesses WHERE id = ?').bind(id).first<Fila>())!;
const entranteDe = async (wamid: string) => (await env.DB.prepare('SELECT * FROM whatsapp_messages WHERE wa_message_id = ?').bind(wamid).first<Fila>())!;
const respuestaA = async (wamid: string) =>
  (await env.DB.prepare("SELECT * FROM whatsapp_messages WHERE direction = 'SALIENTE' AND reply_to_wa_message_id = ?").bind(wamid).all<Fila>()).results;

/** La tienda `uid` pide un código en la app (ruta real). */
async function pedirCodigo(uid: string) {
  const res = await api('/api/negocio/whatsapp/codigo', { uid }, { method: 'POST', body: '{}' });
  return { status: res.status, cuerpo: await res.json<{ codigo: string; vence_en: number; error?: string }>() };
}

/** `de` escribe `texto` por WhatsApp, firmado por el webhook real. */
async function escribe(de: string, id: string, texto: string) {
  const res = await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de, id, texto })] }));
  expect(res.status).toBe(200);
  return entranteDe(id);
}

let red: ReturnType<typeof vi.fn>;
let registros: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES_10);
  red = vi.fn(() => Promise.reject(new Error('la verificación no debe salir a la red')));
  vi.stubGlobal('fetch', red);
  registros = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
  await sembrarNegocio('uid_a', { name: 'Tienda A', whatsapp_phone: DUENO_A });
  await sembrarNegocio('uid_b', { name: 'Tienda B', whatsapp_phone: DUENO_B });
});
afterEach(() => {
  try {
    expect(red).not.toHaveBeenCalled();
    for (const r of registros) expect(r).not.toHaveBeenCalled(); // B5: ni códigos ni teléfonos en los registros
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('emitir el código en la app', () => {
  test('6 dígitos, vence en 10 minutos; la base guarda solo su huella, nunca el código', async () => {
    const { status, cuerpo } = await pedirCodigo('uid_a');
    expect(status).toBe(200);
    expect(cuerpo.codigo).toMatch(/^\d{6}$/);
    expect(cuerpo.vence_en).toBe(MARTES_10 + VIGENCIA_CODIGO_MS);
    const fila = await negocio(A);
    expect(fila).toMatchObject({ whatsapp_code_expires_at: MARTES_10 + VIGENCIA_CODIGO_MS, whatsapp_code_attempts: 0, whatsapp_verified_at: null });
    expect(fila.whatsapp_code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(fila.whatsapp_code_hash).not.toContain(cuerpo.codigo);
    // En ninguna tabla aparece el código en claro.
    const todo = JSON.stringify([
      (await env.DB.prepare('SELECT * FROM businesses').all()).results,
      (await env.DB.prepare('SELECT * FROM whatsapp_messages').all()).results,
    ]);
    expect(todo).not.toContain(cuerpo.codigo);
  });

  test('el estado sale en GET /api/negocio (sin la huella)', async () => {
    await pedirCodigo('uid_a');
    const cuerpo = await (await api('/api/negocio', { uid: 'uid_a' })).json<Fila>();
    expect(cuerpo).toMatchObject({ whatsapp_verificado_en: null });
    expect(JSON.stringify(cuerpo)).not.toContain((await negocio(A)).whatsapp_code_hash);
  });

  test('límite de frecuencia: uno cada 30 s', async () => {
    expect((await pedirCodigo('uid_a')).status).toBe(200);
    vi.setSystemTime(MARTES_10 + ESPERA_CODIGO_MS - 1);
    expect(await pedirCodigo('uid_a')).toMatchObject({ status: 429, cuerpo: { error: 'espera_codigo' } });
    vi.setSystemTime(MARTES_10 + ESPERA_CODIGO_MS);
    expect((await pedirCodigo('uid_a')).status).toBe(200);
  });

  test('ya verificado o sin teléfono: no se emite', async () => {
    await env.DB.prepare('UPDATE businesses SET whatsapp_verified_at = ?1 WHERE id = ?2').bind(MARTES_10 - 1, A).run();
    expect(await pedirCodigo('uid_a')).toMatchObject({ status: 409, cuerpo: { error: 'ya_verificado' } });
    await sembrarNegocio('uid_c');
    expect(await pedirCodigo('uid_c')).toMatchObject({ status: 409, cuerpo: { error: 'sin_telefono' } });
  });
});

describe('verificar por WhatsApp', () => {
  test('código correcto y vigente → verificado, confirmación neutra, y desde entonces sus mensajes son orden del dueño', async () => {
    const { cuerpo } = await pedirCodigo('uid_a');
    vi.setSystemTime(MARTES_10 + 60_000);
    const fila = await escribe(DUENO_A, 'wamid.V1', ` ${cuerpo.codigo} `);
    expect(fila).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'VERIFICACION', business_id: A, debtor_id: null });
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: MARTES_10 + 60_000, whatsapp_code_hash: null, whatsapp_code_expires_at: null, whatsapp_code_attempts: 0 });
    const [respuesta, ...otras] = await respuestaA('wamid.V1');
    expect(otras).toEqual([]);
    expect(JSON.parse(respuesta!.content_json)).toEqual({ text: TEXTO_VERIFICADO });
    expect(await (await api('/api/negocio', { uid: 'uid_a' })).json()).toMatchObject({ whatsapp_verificado_en: MARTES_10 + 60_000 });

    // Paso 3 de enrutar.ts: ya es orden del dueño, sin respuesta del bot.
    const orden = await escribe(DUENO_A, 'wamid.V2', 'APROBAR 0042');
    expect(orden).toMatchObject({ routing_state: 'ROUTED', routing_rule: 'ORDEN_DUENO', business_id: A });
    expect(await respuestaA('wamid.V2')).toEqual([]);
  });

  test('sin verificar no se aceptan órdenes: el dueño es un desconocido', async () => {
    await pedirCodigo('uid_a');
    expect(await escribe(DUENO_A, 'wamid.O1', 'APROBAR 0042')).toMatchObject({ routing_state: 'UNROUTED', business_id: null });
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: null, whatsapp_code_attempts: 0 });
  });

  test('incorrecto → no verifica y suma un intento', async () => {
    const { cuerpo } = await pedirCodigo('uid_a');
    const malo = String((Number(cuerpo.codigo) + 1) % 1_000_000).padStart(6, '0');
    expect(await escribe(DUENO_A, 'wamid.M1', malo)).toMatchObject({ routing_rule: 'VERIFICACION', business_id: A });
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: null, whatsapp_code_attempts: 1 });
    expect(JSON.parse((await respuestaA('wamid.M1'))[0]!.content_json)).toEqual({ text: TEXTO_CODIGO_NO_VALE });
  });

  test('vencido → no verifica aunque sea el correcto', async () => {
    const { cuerpo } = await pedirCodigo('uid_a');
    vi.setSystemTime(MARTES_10 + VIGENCIA_CODIGO_MS);
    await escribe(DUENO_A, 'wamid.T1', cuerpo.codigo);
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: null });
  });

  test(`${MAX_INTENTOS_CODIGO} intentos fallidos: el siguiente, aunque sea el correcto, no verifica`, async () => {
    const { cuerpo } = await pedirCodigo('uid_a');
    for (let i = 1; i <= MAX_INTENTOS_CODIGO; i++) {
      await escribe(DUENO_A, `wamid.I${i}`, String((Number(cuerpo.codigo) + i) % 1_000_000).padStart(6, '0'));
    }
    expect(await negocio(A)).toMatchObject({ whatsapp_code_attempts: MAX_INTENTOS_CODIGO });
    await escribe(DUENO_A, 'wamid.I6', cuerpo.codigo);
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: null });
    // Un código nuevo vuelve a empezar la cuenta.
    vi.setSystemTime(MARTES_10 + ESPERA_CODIGO_MS);
    const nuevo = await pedirCodigo('uid_a');
    expect(await negocio(A)).toMatchObject({ whatsapp_code_attempts: 0 });
    await escribe(DUENO_A, 'wamid.I7', nuevo.cuerpo.codigo);
    expect((await negocio(A)).whatsapp_verified_at).not.toBeNull();
  });

  test('un código nuevo invalida el anterior', async () => {
    const viejo = await pedirCodigo('uid_a');
    vi.setSystemTime(MARTES_10 + ESPERA_CODIGO_MS);
    const nuevo = await pedirCodigo('uid_a');
    if (nuevo.cuerpo.codigo === viejo.cuerpo.codigo) return; // 1 entre un millón: no hay nada que comprobar
    await escribe(DUENO_A, 'wamid.N1', viejo.cuerpo.codigo);
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: null, whatsapp_code_attempts: 1 });
    await escribe(DUENO_A, 'wamid.N2', nuevo.cuerpo.codigo);
    expect((await negocio(A)).whatsapp_verified_at).not.toBeNull();
  });

  test('aislamiento: el código de A enviado desde el teléfono de B no verifica a nadie', async () => {
    const { cuerpo } = await pedirCodigo('uid_a');
    await pedirCodigo('uid_b');
    const antesA = await negocio(A);
    await escribe(DUENO_B, 'wamid.X1', cuerpo.codigo);
    expect(await negocio(A)).toEqual(antesA);
    expect(await negocio(B)).toMatchObject({ whatsapp_verified_at: null, whatsapp_code_attempts: 1 });
  });

  test('otro remitente con el código de A → nada', async () => {
    const { cuerpo } = await pedirCodigo('uid_a');
    const antesA = await negocio(A);
    expect(await escribe(EXTRANO, 'wamid.X2', cuerpo.codigo)).toMatchObject({ routing_state: 'UNROUTED', business_id: null });
    expect(await negocio(A)).toEqual(antesA);
  });

  test('sin código pendiente, unos dígitos del dueño no son un intento', async () => {
    expect(await escribe(DUENO_A, 'wamid.S1', '123456')).toMatchObject({ routing_state: 'UNROUTED' });
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: null, whatsapp_code_attempts: 0 });
  });

  test('idempotente: el mismo entrante entregado otra vez no suma otro intento ni responde dos veces', async () => {
    const { cuerpo: emitido } = await pedirCodigo('uid_a');
    const malo = String((Number(emitido.codigo) + 1) % 1_000_000).padStart(6, '0');
    const cuerpo = cuerpoMeta({ mensajes: [entrante.texto({ de: DUENO_A, id: 'wamid.R1', texto: malo })] });
    await Promise.all([inyectar(cuerpo), inyectar(cuerpo)]);
    await inyectar(cuerpo);
    expect((await negocio(A)).whatsapp_code_attempts).toBe(1);
    expect(await respuestaA('wamid.R1')).toHaveLength(1);
  });
});

describe('cambiar el teléfono de la tienda', () => {
  test('borra la verificación y el código pendiente', async () => {
    await pedirCodigo('uid_a');
    await env.DB.prepare('UPDATE businesses SET whatsapp_verified_at = ?1 WHERE id = ?2').bind(MARTES_10, A).run();
    await env.DB.prepare('UPDATE businesses SET whatsapp_phone = ?1 WHERE id = ?2').bind('+573109990000', A).run();
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: null, whatsapp_code_hash: null, whatsapp_code_expires_at: null, whatsapp_code_attempts: 0 });
    // Sin cambiar el número (o cambiando otra cosa), nada se borra.
    await env.DB.prepare('UPDATE businesses SET whatsapp_verified_at = ?1 WHERE id = ?2').bind(MARTES_10, A).run();
    await env.DB.prepare('UPDATE businesses SET whatsapp_phone = whatsapp_phone, name = ?1 WHERE id = ?2').bind('Tienda A2', A).run();
    expect(await negocio(A)).toMatchObject({ whatsapp_verified_at: MARTES_10 });
  });
});

describe('revisión independiente de WAP-02', () => {
  test('un código vencido o con los intentos agotados ya no desvía los mensajes de 6 dígitos de ese teléfono', async () => {
    await pedirCodigo('uid_a');
    vi.setSystemTime(MARTES_10 + VIGENCIA_CODIGO_MS + 3_600_000); // una hora después de vencer
    const vencido = await escribe(DUENO_A, 'wamid.V1', '150000'); // p. ej. un monto que escribe como deudor de otra tienda
    expect(vencido.routing_rule).not.toBe('VERIFICACION');
    expect(vencido.business_id).not.toBe(A);
    expect(await negocio(A)).toMatchObject({ whatsapp_code_attempts: 0 }); // no cuenta como intento

    vi.setSystemTime(MARTES_10 + VIGENCIA_CODIGO_MS + 3_600_000 + ESPERA_CODIGO_MS);
    await pedirCodigo('uid_a');
    await env.DB.prepare('UPDATE businesses SET whatsapp_code_attempts = ? WHERE id = ?').bind(MAX_INTENTOS_CODIGO, A).run();
    const agotado = await escribe(DUENO_A, 'wamid.V2', '150000');
    expect(agotado.routing_rule).not.toBe('VERIFICACION');
    expect(agotado.business_id).not.toBe(A);
  });
});
