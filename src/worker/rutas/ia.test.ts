// IAS-02: con la respuesta grabada del modelo, la frase de ejemplo da la orden correcta; la ruta nunca escribe en el libro.
// DeepSeek se simula con `fetch`: AI_READY está apagado (cola del dueño).
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SIN_CUOTA } from '../cuotas';
import { EN_ESTADO, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';

const EJEMPLO = 'abónale veinte mil a don Carlos el del taller';
const encendida = (cambios: Partial<Env> = {}): Env => ({ ...env, AI_READY: '1', DEEPSEEK_API_KEY: 'clave-de-prueba', ...cambios });

/** DeepSeek con una respuesta grabada; guarda el cuerpo de cada petición saliente. */
function deepseek(contenido: unknown, status = 200) {
  const pedidos: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    pedidos.push(String(init.body));
    return Response.json({ choices: [{ message: { content: JSON.stringify(contenido) } }] }, { status });
  }));
  return pedidos;
}
afterEach(() => vi.unstubAllGlobals());

const orden = (cuerpo: unknown, entorno: Env = encendida(), uid = 'uid_1') =>
  api('/api/ia/orden', { uid }, { method: 'POST', body: JSON.stringify(cuerpo) }, entorno);

const usadas = async () => (await env.DB.prepare("SELECT ai_chat_used_count AS n FROM businesses WHERE id = 'bus_uid_1'").first<{ n: number }>())!.n;

/** Deudores y libro de la tienda: lo que la ruta nunca debe cambiar. */
const libro = async () =>
  JSON.stringify({
    deudores: (await env.DB.prepare('SELECT id, current_balance_cop FROM debtors ORDER BY id').all()).results,
    movimientos: (await env.DB.prepare('SELECT id FROM ledger_transactions').all()).results,
  });

describe('POST /api/ia/orden', () => {
  test('la frase de ejemplo da la orden grabada, gasta una interacción y no escribe nada en el libro', async () => {
    await sembrarNegocio();
    const deudor = await (await api('/api/deudores', {}, { method: 'POST', body: JSON.stringify({ full_name: 'don Carlos', alias_reference: 'el del taller' }) })).json<{ id: string }>();
    await api(`/api/deudores/${deudor.id}/movimientos`, {}, { method: 'POST', body: JSON.stringify({ request_id: 'semilla-0001', type: 'FIADO', amount_cop: 50_000 }) });
    const antes = await libro();
    const pedidos = deepseek({ accion: 'ABONAR', monto: 20000, deudor_buscado: 'don Carlos el del taller' });

    const res = await orden({ frase: EJEMPLO });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accion: 'ABONAR', monto: 20000, deudor_buscado: 'don Carlos el del taller' });
    expect(pedidos).toHaveLength(1);
    expect(await usadas()).toBe(1);
    expect(await libro()).toBe(antes); // la IA propone; la persona confirma con el POST de movimientos (A1.3)
  });

  test('a DeepSeek no salen el teléfono ni el documento que se dicten', async () => {
    await sembrarNegocio();
    const pedidos = deepseek({ accion: 'FIAR', monto: 5000, deudor_buscado: 'Yuleidy' });
    expect((await orden({ frase: 'fíale cinco mil a Yuleidy, cédula 1.032.456.789, celular 300 123 4567' })).status).toBe(200);
    expect(pedidos).toHaveLength(1);
    for (const prohibido of ['1032456789', '1.032.456.789', '3001234567', '300 123 4567']) expect(pedidos[0]).not.toContain(prohibido);
    expect(pedidos[0]).not.toMatch(/\d{7,}/);
  });

  test('una respuesta que no cuadra es «no entendí», nunca un dato a medias', async () => {
    await sembrarNegocio();
    deepseek({ accion: 'BORRAR_TODO', monto: 1, deudor_buscado: 'x' });
    expect(await (await orden({ frase: 'borra todo' })).json()).toEqual({ accion: 'DESCONOCIDA', monto: null, deudor_buscado: null });
  });

  test('IA apagada: 409 ia_apagada, nadie recibe la frase y no se gasta cuota', async () => {
    await sembrarNegocio();
    const pedidos = deepseek({});
    for (const entorno of [env, encendida({ DEEPSEEK_API_KEY: undefined }), encendida({ AI_READY: '0' })]) {
      const res = await orden({ frase: EJEMPLO }, entorno);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'ia_apagada' });
    }
    expect(pedidos).toHaveLength(0);
    expect(await usadas()).toBe(0);
  });

  test('proveedor caído o con error: 503 y la interacción se devuelve', async () => {
    await sembrarNegocio();
    deepseek({}, 500);
    expect((await orden({ frase: EJEMPLO })).status).toBe(503);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('red caída'); }));
    const res = await orden({ frase: EJEMPLO });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ia_no_disponible' });
    expect(await usadas()).toBe(0);
  });

  test('sin cuota: 409 con el mensaje claro y ninguna llamada', async () => {
    await sembrarNegocio('uid_1', { ...EN_ESTADO.TRIAL(), ai_chat_used_count: 10 });
    const pedidos = deepseek({});
    const res = await orden({ frase: EJEMPLO });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'sin_cuota', mensaje: SIN_CUOTA.ia });
    expect(pedidos).toHaveLength(0);
    expect(await usadas()).toBe(10);
  });

  test.each([
    ['vacía', { frase: '' }],
    ['solo espacios', { frase: '   ' }],
    ['de más de 300 letras', { frase: 'a'.repeat(301) }],
    ['que no es texto', { frase: 5000 }],
    ['ausente', {}],
  ])('frase %s → 400 sin llamar ni gastar', async (_caso, cuerpo) => {
    await sembrarNegocio();
    const pedidos = deepseek({});
    const res = await orden(cuerpo);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'datos_invalidos', campos: ['frase'] });
    expect(pedidos).toHaveLength(0);
    expect(await usadas()).toBe(0);
  });

  test('una frase de 300 letras sí entra', async () => {
    await sembrarNegocio();
    deepseek({ accion: 'DESCONOCIDA', monto: null, deudor_buscado: null });
    expect((await orden({ frase: 'a'.repeat(300) })).status).toBe(200);
  });

  test.each([
    ['vencida', EN_ESTADO.EXPIRED_READONLY()],
    ['suspendida', EN_ESTADO.SUSPENDED_BY_ADMIN()],
  ])('tienda %s: 403 sin llamar ni gastar', async (_caso, estado) => {
    await sembrarNegocio('uid_1', estado);
    const pedidos = deepseek({});
    expect((await orden({ frase: EJEMPLO })).status).toBe(403);
    expect(pedidos).toHaveLength(0);
    expect(await usadas()).toBe(0);
  });

  test('el límite de frecuencia va por negocio: 429 sin llamar ni gastar', async () => {
    await sembrarNegocio();
    const pedidos = deepseek({});
    const claves: string[] = [];
    const agotado = { limit: async ({ key }: { key: string }) => (claves.push(key), { success: false }) } as unknown as RateLimit;
    const res = await orden({ frase: EJEMPLO }, encendida({ LIMITE_IA: agotado }));
    expect(res.status).toBe(429);
    expect(claves).toEqual(['bus_uid_1']);
    expect(pedidos).toHaveLength(0);
    expect(await usadas()).toBe(0);
  });
});

test('IA apagada y cuota agotada → ia_apagada (no «sin cuota»), sin escribir en el negocio', async () => {
  await sembrarNegocio('uid_1', { ...EN_ESTADO.TRIAL(), ai_chat_used_count: 10 });
  const antes = await env.DB.prepare("SELECT * FROM businesses WHERE id = 'bus_uid_1'").first();
  const res = await orden({ frase: EJEMPLO }, env);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: 'ia_apagada' });
  expect(await env.DB.prepare("SELECT * FROM businesses WHERE id = 'bus_uid_1'").first()).toEqual(antes);
});
