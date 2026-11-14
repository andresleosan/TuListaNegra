// IAS-04: con 3 fotos de prueba la tabla se puede corregir; importar crea deudores y saldos con la foto como evidencia;
// nada entra sin confirmar. La visión de Workers AI se simula: AI_READY está apagado (cola del dueño).
import { env } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import { EN_ESTADO, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6]);
const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;

/** Workers AI simulado con respuestas grabadas, una por llamada. */
function conVision(...respuestas: (unknown | Error)[]) {
  const run = vi.fn(async () => {
    const r = respuestas.shift();
    if (r instanceof Error) throw r;
    return { response: typeof r === 'string' ? r : JSON.stringify(r) };
  });
  return { entorno: { ...env, AI_READY: '1', AI: { run } as unknown as Ai }, run };
}

async function subir(bytes: Uint8Array = PNG, uid = 'uid_1', entorno: Env = env) {
  const formulario = new FormData();
  formulario.set('foto', new File([bytes], 'cuaderno.png', { type: 'image/png' }));
  const serializado = new Response(formulario);
  const body = await serializado.arrayBuffer();
  return api('/api/cuadernos/fotos', { uid }, { method: 'POST', body, headers: { 'Content-Type': serializado.headers.get('Content-Type')!, 'Content-Length': String(body.byteLength) } }, entorno);
}
const importar = (cuerpo: unknown, uid = 'uid_1') => api('/api/cuadernos/importar', { uid }, { method: 'POST', body: JSON.stringify(cuerpo) });

const contar = async (tabla: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).first<{ n: number }>())!.n;
const ocrUsado = async () => (await env.DB.prepare("SELECT ai_ocr_used_count AS n FROM businesses WHERE id = 'bus_uid_1'").first<{ n: number }>())!.n;

describe('leer la foto', () => {
  test('con la IA apagada: la foto se guarda en R2 privado, la tabla llega vacía para llenarla a mano y no gasta cuota', async () => {
    await sembrarNegocio();
    const res = await subir();
    expect(res.status).toBe(201);
    const r = await res.json<any>();
    expect(r).toMatchObject({ lectura: 'apagada', filas: [] });
    expect(r.foto).toMatch(/^negocios\/bus_uid_1\/cuadernos\/cua_[0-9A-Z]{26}\.png$/);
    expect(await env.ARCHIVOS.head(r.foto)).not.toBeNull();
    expect(await ocrUsado()).toBe(0);
  });

  test('tres fotos de prueba: cada una propone su tabla, descarta las filas que no cuadran y gasta una foto de cuota', async () => {
    await sembrarNegocio();
    const { entorno, run } = conVision(
      { filas: [{ nombre: 'Doña Marta', apodo: null, saldo: 15000 }, { nombre: 'El Mono', apodo: 'el de la moto', saldo: 8500 }] },
      // El modelo a veces envuelve el JSON en texto: se toma el objeto.
      'Aquí está: {"filas": [{"nombre": "Wilmar", "saldo": 32000}, {"nombre": "", "saldo": 100}, {"nombre": "Pedro", "saldo": -5}, {"nombre": "Ana", "saldo": 12.5}]}',
      'no veo nada',
    );
    const lecturas = [];
    for (let i = 0; i < 3; i++) lecturas.push(await json(subir(PNG, 'uid_1', entorno)));
    expect(lecturas.map((l) => [l.lectura, l.filas])).toEqual([
      ['leida', [{ full_name: 'Doña Marta', alias_reference: null, saldo_cop: 15000 }, { full_name: 'El Mono', alias_reference: 'el de la moto', saldo_cop: 8500 }]],
      ['leida', [{ full_name: 'Wilmar', alias_reference: null, saldo_cop: 32000 }]],
      ['leida', []],
    ]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(await ocrUsado()).toBe(3);
    expect(await contar('debtors')).toBe(0); // leer no escribe nada en el libro
    expect(await contar('ledger_transactions')).toBe(0);
  });

  test('si la IA falla, la foto queda, la tabla se llena a mano y la foto de cuota se devuelve', async () => {
    await sembrarNegocio();
    const { entorno } = conVision(new Error('caído'));
    expect(await json(subir(PNG, 'uid_1', entorno))).toMatchObject({ lectura: 'fallida', filas: [] });
    expect(await ocrUsado()).toBe(0);
  });

  test('sin fotos de cuota: no se llama a la IA y se explica', async () => {
    await sembrarNegocio('uid_1', { ...EN_ESTADO.TRIAL(), ai_ocr_used_count: 3 });
    const { entorno, run } = conVision({ filas: [] });
    expect(await json(subir(PNG, 'uid_1', entorno))).toMatchObject({ lectura: 'sin_cuota', filas: [], mensaje: expect.stringContaining('fotos') });
    expect(run).not.toHaveBeenCalled();
  });

  test('un archivo que no es imagen → 400 y nada en R2; una tienda vencida no puede', async () => {
    await sembrarNegocio();
    expect((await subir(new TextEncoder().encode('hola, no soy una foto'))).status).toBe(400);
    expect((await env.ARCHIVOS.list()).objects).toEqual([]);
    await sembrarNegocio('uid_2', EN_ESTADO.EXPIRED_READONLY());
    expect((await subir(PNG, 'uid_2')).status).toBe(403);
  });
});

describe('importar', () => {
  test('la tabla corregida entra entera: deudores, saldo y un FIADO «Saldo anterior (cuaderno)» con la foto como evidencia', async () => {
    await sembrarNegocio();
    const { foto } = await json(subir());
    // El tendero corrigió lo que leyó la IA (o lo escribió a mano): esto es lo único que entra.
    const res = await importar({ foto, request_id: 'cuaderno-0001', filas: [
      { full_name: 'Doña Marta', saldo_cop: 15000 },
      { full_name: 'El Mono', alias_reference: 'el de la moto', saldo_cop: 9000 },
    ] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ repetido: false, deudores: [
      { unique_code: 'TLN-0001', full_name: 'Doña Marta', alias_reference: null, current_balance_cop: 15000 },
      { unique_code: 'TLN-0002', full_name: 'El Mono', alias_reference: 'el de la moto', current_balance_cop: 9000 },
    ] });
    const libro = (await env.DB.prepare('SELECT type, amount_cop, balance_after_cop, description, evidence_r2_key, source, status FROM ledger_transactions ORDER BY amount_cop').all()).results;
    expect(libro).toEqual([9000, 15000].map((monto) => ({
      type: 'FIADO', amount_cop: monto, balance_after_cop: monto, description: 'Saldo anterior (cuaderno)', evidence_r2_key: foto, source: 'SARIN_IMAGE_OCR', status: 'CONFIRMADO',
    })));
    // Los deudores importados quedan con su fecha de deuda, como cualquier fiado.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM debtors WHERE oldest_unpaid_date IS NOT NULL').first<{ n: number }>())!.n).toBe(2);
  });

  test('reintentar la misma importación no duplica nada', async () => {
    await sembrarNegocio();
    const { foto } = await json(subir());
    const cuerpo = { foto, request_id: 'cuaderno-0002', filas: [{ full_name: 'Wilmar', saldo_cop: 32000 }] };
    const [a, b] = await Promise.all([importar(cuerpo), importar(cuerpo)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect((await json(importar(cuerpo))).repetido).toBe(true);
    expect(await contar('debtors')).toBe(1);
    expect(await contar('ledger_transactions')).toBe(1);
  });

  test('la evidencia tiene que ser una foto de cuaderno de esta tienda que exista', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    const { foto: ajena } = await json(subir(PNG, 'uid_2'));
    const filas = [{ full_name: 'X', saldo_cop: 1000 }];
    for (const foto of [ajena, 'negocios/bus_uid_1/cuadernos/cua_NOEXISTE.png', 'negocios/bus_uid_1/pagos/pay_1.png', 'negocios/bus_uid_1/cuadernos/../pagos/x.png']) {
      const res = await importar({ foto, request_id: 'cuaderno-0003', filas });
      expect(res.status, foto).toBe(400);
      expect(await res.json()).toEqual({ error: 'datos_invalidos', campos: ['foto'] });
    }
    expect(await contar('debtors')).toBe(0);
  });

  test('si el plan no admite tantos deudores, no entra ninguno', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.TRIAL()); // la prueba admite 15
    const { foto } = await json(subir());
    for (let i = 0; i < 14; i++) await api('/api/deudores', { uid: 'uid_1' }, { method: 'POST', body: JSON.stringify({ full_name: `Deudor ${i}` }) });
    const res = await importar({ foto, request_id: 'cuaderno-0004', filas: [{ full_name: 'Uno', saldo_cop: 1000 }, { full_name: 'Dos', saldo_cop: 2000 }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'limite_deudores', limite: 15 });
    expect(await contar('debtors')).toBe(14);
    expect(await contar('ledger_transactions')).toBe(0);
    expect((await importar({ foto, request_id: 'cuaderno-0005', filas: [{ full_name: 'Uno', saldo_cop: 1000 }] })).status).toBe(201);
  });

  test('filas inválidas (saldo 0, negativo, decimal, sin nombre, demasiadas) → 400 sin escribir', async () => {
    await sembrarNegocio();
    const { foto } = await json(subir());
    for (const filas of [[], [{ full_name: 'A', saldo_cop: 0 }], [{ full_name: 'A', saldo_cop: -1 }], [{ full_name: 'A', saldo_cop: 1.5 }], [{ full_name: ' ', saldo_cop: 1 }],
      Array.from({ length: 61 }, (_, i) => ({ full_name: `D${i}`, saldo_cop: 1 }))]) {
      expect((await importar({ foto, request_id: 'cuaderno-0006', filas })).status).toBe(400);
    }
    expect(await contar('debtors')).toBe(0);
  });
});
