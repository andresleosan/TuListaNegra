// IAS-01: 20 llamadas simultáneas no pasan la cuota; la petición saliente no lleva documento, teléfono ni saldo;
// sin cuota, mensaje claro y ninguna llamada.
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { conCuota, consumirCuota, devolverCuota, SIN_CUOTA } from './cuotas';
import { anonimizar, IaApagada, IaNoDisponible, interpretarFrase } from './ia';
import { EN_ESTADO, sembrarNegocio } from './test/datos';

const DIA = 86_400_000;
const encendida = { ...env, AI_READY: '1', DEEPSEEK_API_KEY: 'clave-de-prueba' };
const usados = async (id = 'bus_uid_1') =>
  env.DB.prepare('SELECT ai_ocr_used_count AS ocr, ai_chat_used_count AS ia, wa_reminders_used_count AS cobros, quota_cycle_started_at AS ciclo FROM businesses WHERE id = ?').bind(id).first<any>();

/** Simula DeepSeek con una respuesta grabada y guarda lo que se le envió. */
function deepseek(contenido: unknown, status = 200) {
  const pedidos: { url: string; headers: Headers; cuerpo: any; texto: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    pedidos.push({ url: String(url), headers: new Headers(init.headers), cuerpo: JSON.parse(String(init.body)), texto: String(init.body) });
    return Response.json({ choices: [{ message: { content: typeof contenido === 'string' ? contenido : JSON.stringify(contenido) } }] }, { status });
  }));
  return pedidos;
}
afterEach(() => vi.unstubAllGlobals());

describe('cuota', () => {
  test('20 llamadas simultáneas con 10 de cuota: pasan exactamente 10 y solo esas llegan al modelo', async () => {
    const negocio = await sembrarNegocio('uid_1', EN_ESTADO.TRIAL()); // prueba: 10 interacciones
    const pedidos = deepseek({ accion: 'FIAR', monto: 5000, deudor_buscado: 'Carlos' });
    const resultados = await Promise.all(Array.from({ length: 20 }, () => conCuota(env, negocio, 'ia', () => interpretarFrase(encendida, 'fíale cinco mil a Carlos'))));
    expect(resultados.filter((r) => r.ok)).toHaveLength(10);
    expect(pedidos).toHaveLength(10);
    expect((await usados()).ia).toBe(10);
  });

  test('sin cuota: mensaje claro, ninguna llamada y el contador no se mueve', async () => {
    const negocio = await sembrarNegocio('uid_1', { ...EN_ESTADO.TRIAL(), ai_chat_used_count: 10 });
    const pedidos = deepseek({});
    const trabajo = vi.fn(() => interpretarFrase(encendida, 'hola'));
    expect(await conCuota(env, negocio, 'ia', trabajo)).toEqual({ ok: false, error: 'sin_cuota', mensaje: SIN_CUOTA.ia });
    expect(trabajo).not.toHaveBeenCalled();
    expect(pedidos).toHaveLength(0);
    expect((await usados()).ia).toBe(10);
  });

  test('cada tipo gasta su contador y respeta el límite de su plan', async () => {
    const negocio = await sembrarNegocio('uid_1', EN_ESTADO.TRIAL()); // 3 fotos, 10 interacciones, 5 cobros
    const gastar = async (tipo: 'ocr' | 'ia' | 'cobros', veces: number) =>
      (await Promise.all(Array.from({ length: veces }, () => consumirCuota(env, negocio, tipo)))).filter(Boolean).length;
    expect([await gastar('ocr', 6), await gastar('cobros', 9), await gastar('ia', 4)]).toEqual([3, 5, 4]);
    expect(await usados()).toMatchObject({ ocr: 3, ia: 4, cobros: 5 });
  });

  test('si el modelo falla, la unidad se devuelve', async () => {
    const negocio = await sembrarNegocio('uid_1', EN_ESTADO.TRIAL());
    deepseek({}, 500);
    await expect(conCuota(env, negocio, 'ia', () => interpretarFrase(encendida, 'fíale'))).rejects.toBeInstanceOf(IaNoDisponible);
    expect((await usados()).ia).toBe(0);
    await devolverCuota(env, negocio, 'ia'); // nunca baja de cero
    expect((await usados()).ia).toBe(0);
  });

  test('una tienda no gasta la cuota de otra', async () => {
    const a = await sembrarNegocio('uid_1', EN_ESTADO.TRIAL());
    await sembrarNegocio('uid_2', EN_ESTADO.TRIAL());
    await consumirCuota(env, a, 'ia');
    expect((await usados('bus_uid_2')).ia).toBe(0);
  });

  test('cuenta gratis: los contadores se reinician a los 30 días, al usar la primera del ciclo nuevo', async () => {
    const ahora = Date.now();
    const negocio = await sembrarNegocio('uid_1', { free_forever_at: ahora - 40 * DIA, quota_cycle_started_at: ahora - 29 * DIA, ai_chat_used_count: 300, ai_ocr_used_count: 60, wa_reminders_used_count: 7 });
    expect(await consumirCuota(env, negocio, 'ia', ahora)).toBe(false); // día 29: agotada
    expect(await consumirCuota(env, negocio, 'ia', ahora + DIA)).toBe(true); // día 30: ciclo nuevo
    expect(await usados()).toEqual({ ocr: 0, ia: 1, cobros: 0, ciclo: ahora + DIA });
  });

  test('con un pase, pasar 30 días no reinicia nada', async () => {
    const ahora = Date.now();
    const negocio = await sembrarNegocio('uid_1', { subscription_plan: 'PASS_7D', quota_cycle_started_at: ahora - 60 * DIA, ai_chat_used_count: 50 });
    expect(await consumirCuota(env, negocio, 'ia', ahora)).toBe(false);
    expect((await usados()).ia).toBe(50);
  });
});

describe('envío mínimo de datos', () => {
  test('a DeepSeek solo va la frase: nada del deudor, ni documento, teléfono o saldo aunque el tendero los dicte', async () => {
    const pedidos = deepseek({ accion: 'ABONAR', monto: 20000, deudor_buscado: 'don Carlos el del taller' });
    const frase = 'abónale veinte mil a don Carlos el del taller, cédula 1.032.456.789, celular 300 123 4567, debe 1250000';
    expect(await interpretarFrase(encendida, frase)).toEqual({ accion: 'ABONAR', monto: 20000, deudor_buscado: 'don Carlos el del taller' });
    expect(pedidos).toHaveLength(1);
    const [pedido] = pedidos;
    expect(pedido!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(pedido!.headers.get('Authorization')).toBe('Bearer clave-de-prueba');
    for (const prohibido of ['1032456789', '1.032.456.789', '3001234567', '300 123 4567', '1250000']) expect(pedido!.texto).not.toContain(prohibido);
    expect(pedido!.texto).not.toMatch(/\d{7,}/);
    // Solo dos mensajes: las instrucciones fijas y la frase ya enmascarada. Ningún otro campo con datos.
    expect(Object.keys(pedido!.cuerpo).sort()).toEqual(['max_tokens', 'messages', 'model', 'response_format', 'temperature']);
    expect(pedido!.cuerpo.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect(pedido!.cuerpo.messages[1].content).toBe('abónale veinte mil a don Carlos el del taller, cédula [número], celular [número], debe [número]');
  });

  test.each([
    ['fíale 5000 a Yuleidy', 'fíale 5000 a Yuleidy'],
    ['abónale 20.000 a Wilmar', 'abónale 20.000 a Wilmar'],
    ['fíale 150 000 a Rubi', 'fíale 150 000 a Rubi'],
    ['el del 3001234567', 'el del [número]'],
    ['cc 1032456789', 'cc [número]'],
    ['nit 900.123.456-7', 'nit [número]'],
    ['+57 300-123-4567', '+[número]'],
    ['cc 1,032,456,789', 'cc [número]'],
    ['cel (300) 123-4567', 'cel ([número]'],
    ['+57 (300) 123 4567', '+[número]'],
    ['300  123   4567', '[número]'],
    ['300/123/4567', '[número]'],
    ['３００１２３４５６７', '[número]'], // dígitos de ancho completo
    ['٣٠٠١٢٣٤٥٦٧', '[número]'], // dígitos arábigo-índicos
    ['3 0 0 1 2 3 4 5 6 7', '[número]'],
    ['debe 20.000 y abonó 5.000', 'debe 20.000 y abonó 5.000'], // dos montos separados por palabras no se juntan
  ])('anonimizar(%j) → %j', (frase, esperado) => {
    expect(anonimizar(frase)).toBe(esperado);
  });

  test('una frase enorme se recorta', () => {
    expect(anonimizar('a'.repeat(2000))).toHaveLength(300);
  });
});

describe('la respuesta del modelo es un dato, no una orden', () => {
  test.each<[string, unknown]>([
    ['texto que no es JSON', 'claro, con gusto'],
    ['acción inventada', { accion: 'BORRAR_TODO', monto: 1, deudor_buscado: 'x' }],
    ['monto negativo', { accion: 'ABONAR', monto: -5000, deudor_buscado: 'x' }],
    ['monto con decimales', { accion: 'FIAR', monto: 10.5, deudor_buscado: 'x' }],
    ['monto absurdo', { accion: 'FIAR', monto: 999_999_999_999, deudor_buscado: 'x' }],
    ['monto como texto', { accion: 'FIAR', monto: '5000', deudor_buscado: 'x' }],
    ['faltan campos', { accion: 'FIAR' }],
    ['una lista', []],
  ])('%s → «no entendí»', async (_caso, contenido) => {
    deepseek(contenido);
    expect(await interpretarFrase(encendida, 'frase')).toEqual({ accion: 'DESCONOCIDA', monto: null, deudor_buscado: null });
  });

  test('campos de más se descartan', async () => {
    deepseek({ accion: 'FIAR', monto: 5000, deudor_buscado: ' Carlos ', business_id: 'bus_x', confirmar: true });
    expect(await interpretarFrase(encendida, 'frase')).toEqual({ accion: 'FIAR', monto: 5000, deudor_buscado: 'Carlos' });
  });
});

describe('interruptor AI_READY', () => {
  test.each([
    ['apagado (valor por defecto)', env],
    ['encendido pero sin clave', { ...env, AI_READY: '1' }],
    ['con clave pero apagado', { ...env, DEEPSEEK_API_KEY: 'x' }],
  ])('%s: no se llama a nadie', async (_caso, entorno) => {
    const pedidos = deepseek({});
    await expect(interpretarFrase(entorno as Env, 'fíale cinco mil a Carlos')).rejects.toBeInstanceOf(IaApagada);
    expect(pedidos).toHaveLength(0);
  });

  test('el proveedor caído o lento es IaNoDisponible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('red caída'); }));
    await expect(interpretarFrase(encendida, 'x')).rejects.toBeInstanceOf(IaNoDisponible);
  });
});
