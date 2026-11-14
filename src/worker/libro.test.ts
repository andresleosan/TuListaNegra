// LIB-01: saldo exacto bajo concurrencia, idempotencia por request_id, abono mayor al saldo rechazado, fecha de mora.
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import verificarSaldos from '../../scripts/verificar-saldos.sql?raw';
import { registrarMovimiento } from './libro';
import { EN_ESTADO, sembrarNegocio } from './test/datos';
import { api } from './test/sesion';

const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;
let n = 0;
const rid = () => `req_prueba_${n++}`;

async function deudorNuevo(uid = 'uid_1', datos: object = {}) {
  return json(api('/api/deudores', { uid }, { method: 'POST', body: JSON.stringify({ full_name: 'Carlos', ...datos }) }));
}
const mover = (deudorId: string, datos: object, uid = 'uid_1') =>
  api(`/api/deudores/${deudorId}/movimientos`, { uid }, { method: 'POST', body: JSON.stringify({ request_id: rid(), ...datos }) });
const fiar = (id: string, monto: number, extra: object = {}) => mover(id, { type: 'FIADO', amount_cop: monto, ...extra });
const abonar = (id: string, monto: number) => mover(id, { type: 'ABONO', amount_cop: monto });
const ficha = (id: string, uid = 'uid_1') => json(api(`/api/deudores/${id}`, { uid }));
const descuadrados = async () => (await env.DB.prepare(verificarSaldos).all()).results;

describe('fiar, abonar y ajustar', () => {
  test('cada movimiento deja su saldo resultante', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    const r1 = await fiar(d.id, 5_000);
    expect(r1.status).toBe(201);
    expect(await r1.json()).toMatchObject({
      repetido: false, deudor: { current_balance_cop: 5_000 },
      movimiento: { type: 'FIADO', amount_cop: 5_000, status: 'CONFIRMADO', balance_after_cop: 5_000, description: 'Fiado', source: 'MOSTRADOR', debtor_id: d.id },
    });
    expect((await json(fiar(d.id, 20_000, { description: 'Mercado de la semana' }))).movimiento).toMatchObject({ balance_after_cop: 25_000, description: 'Mercado de la semana' });
    expect((await json(abonar(d.id, 10_000))).movimiento).toMatchObject({ type: 'ABONO', balance_after_cop: 15_000, description: 'Abono' });
    expect((await json(mover(d.id, { type: 'AJUSTE_SUMA', amount_cop: 1_000 }))).movimiento.balance_after_cop).toBe(16_000);
    expect((await json(mover(d.id, { type: 'AJUSTE_RESTA', amount_cop: 6_000 }))).movimiento.balance_after_cop).toBe(10_000);
    expect(await ficha(d.id)).toMatchObject({ current_balance_cop: 10_000, estado: 'CON_SALDO' });
    const { movimientos } = await json(api(`/api/deudores/${d.id}/movimientos`));
    expect(movimientos.map((m: any) => m.balance_after_cop)).toEqual([10_000, 16_000, 15_000, 25_000, 5_000]); // lo más nuevo arriba
    expect(await descuadrados()).toEqual([]);
  });

  test('20 movimientos simultáneos dejan el saldo exacto', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    await fiar(d.id, 100_000);
    const respuestas = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? abonar(d.id, 3_000) : fiar(d.id, 5_000))));
    expect(respuestas.map((r) => r.status)).toEqual(Array(20).fill(201));
    expect((await ficha(d.id)).current_balance_cop).toBe(100_000 + 10 * 5_000 - 10 * 3_000);
    // Cada saldo resultante es distinto y la cadena cuadra: ninguno se calculó sobre un saldo viejo.
    const saldos = (await Promise.all(respuestas.map((r) => json(r)))).map((x) => x.movimiento.balance_after_cop);
    expect(new Set(saldos).size).toBe(20);
    expect(await descuadrados()).toEqual([]);
  });

  test('abonos simultáneos nunca dejan el saldo en negativo', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    await fiar(d.id, 10_000);
    const estados = (await Promise.all(Array.from({ length: 5 }, () => abonar(d.id, 4_000)))).map((r) => r.status);
    expect(estados.filter((s) => s === 201)).toHaveLength(2);
    expect(estados.filter((s) => s === 409)).toHaveLength(3);
    expect((await ficha(d.id)).current_balance_cop).toBe(2_000);
    expect(await descuadrados()).toEqual([]);
  });

  test('abono o ajuste mayor al saldo, rechazado sin escribir nada', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    await fiar(d.id, 5_000);
    for (const tipo of ['ABONO', 'AJUSTE_RESTA']) {
      const res = await mover(d.id, { type: tipo, amount_cop: 5_001 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'supera_saldo', saldo: 5_000 });
    }
    expect((await json(api(`/api/deudores/${d.id}/movimientos`))).movimientos).toHaveLength(1);
    expect((await abonar(d.id, 5_000)).status).toBe(201); // saldar todo sí
    expect(await ficha(d.id)).toMatchObject({ current_balance_cop: 0, estado: 'AL_DIA' });
  });
});

describe('idempotencia', () => {
  test('repetir request_id no crea otro movimiento ni mueve el saldo', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    const cuerpo = JSON.stringify({ request_id: 'toque-unico-0001', type: 'FIADO', amount_cop: 5_000 });
    const enviar = () => api(`/api/deudores/${d.id}/movimientos`, {}, { method: 'POST', body: cuerpo });
    const primero = await enviar();
    const segundo = await enviar();
    expect([primero.status, segundo.status]).toEqual([201, 200]);
    const a = await primero.json<any>();
    const b = await segundo.json<any>();
    expect(b.repetido).toBe(true);
    expect(b.movimiento.id).toBe(a.movimiento.id);
    expect((await ficha(d.id)).current_balance_cop).toBe(5_000);
  });

  test('el mismo toque enviado 10 veces a la vez cuenta una sola vez', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    const cuerpo = JSON.stringify({ request_id: 'toque-unico-0002', type: 'FIADO', amount_cop: 7_000 });
    const respuestas = await Promise.all(Array.from({ length: 10 }, () => api(`/api/deudores/${d.id}/movimientos`, {}, { method: 'POST', body: cuerpo })));
    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
    expect(respuestas.filter((r) => r.status === 200)).toHaveLength(9);
    expect((await ficha(d.id)).current_balance_cop).toBe(7_000);
    expect((await json(api(`/api/deudores/${d.id}/movimientos`))).movimientos).toHaveLength(1);
  });

  test('el request_id es por negocio: dos tiendas pueden usar el mismo', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    const a = await deudorNuevo('uid_1');
    const b = await deudorNuevo('uid_2');
    const cuerpo = JSON.stringify({ request_id: 'toque-compartido', type: 'FIADO', amount_cop: 1_000 });
    expect((await api(`/api/deudores/${a.id}/movimientos`, { uid: 'uid_1' }, { method: 'POST', body: cuerpo })).status).toBe(201);
    expect((await api(`/api/deudores/${b.id}/movimientos`, { uid: 'uid_2' }, { method: 'POST', body: cuerpo })).status).toBe(201);
  });

  test('un request_id ya usado con otro deudor no pasa por reintento', async () => {
    await sembrarNegocio();
    const a = await deudorNuevo();
    const b = await deudorNuevo('uid_1', { full_name: 'Otro' });
    const cuerpo = JSON.stringify({ request_id: 'toque-unico-0003', type: 'FIADO', amount_cop: 1_000 });
    await api(`/api/deudores/${a.id}/movimientos`, {}, { method: 'POST', body: cuerpo });
    const res = await api(`/api/deudores/${b.id}/movimientos`, {}, { method: 'POST', body: cuerpo });
    expect(res.status).toBe(409);
    expect((await ficha(b.id)).current_balance_cop).toBe(0);
  });
});

describe('tope de crédito', () => {
  test('fiar por encima del tope exige confirmar', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo('uid_1', { credit_limit_cop: 20_000 });
    expect((await fiar(d.id, 20_000)).status).toBe(201); // justo en el tope
    const res = await fiar(d.id, 1);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'supera_tope', saldo: 20_000, tope: 20_000 });
    expect((await ficha(d.id)).current_balance_cop).toBe(20_000);
    expect((await fiar(d.id, 5_000, { confirmar_tope: true })).status).toBe(201);
    expect((await ficha(d.id)).current_balance_cop).toBe(25_000);
    expect((await abonar(d.id, 1_000)).status).toBe(201); // abonar nunca choca con el tope
  });
});

describe('fecha de mora: los abonos cubren primero los fiados más antiguos', () => {
  const DIA = 86_400_000;
  const T0 = Date.parse('2026-10-01T10:00:00-05:00');
  const en = (deudor: string, tipo: 'FIADO' | 'ABONO' | 'AJUSTE_SUMA' | 'AJUSTE_RESTA', monto: number, cuando: number) =>
    registrarMovimiento(env, { business_id: 'bus_uid_1', debtor_id: deudor, request_id: rid(), type: tipo, amount_cop: monto, source: 'MOSTRADOR' }, cuando);

  test('avanza al siguiente fiado solo cuando el anterior queda cubierto del todo', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    await en(d.id, 'FIADO', 10_000, T0);
    await en(d.id, 'FIADO', 5_000, T0 + 10 * DIA);
    expect((await ficha(d.id)).oldest_unpaid_date).toBe(T0);
    await en(d.id, 'ABONO', 9_999, T0 + 11 * DIA);
    expect((await ficha(d.id)).oldest_unpaid_date).toBe(T0); // falta $1 del primero
    await en(d.id, 'ABONO', 1, T0 + 12 * DIA);
    expect((await ficha(d.id)).oldest_unpaid_date).toBe(T0 + 10 * DIA);
    await en(d.id, 'AJUSTE_RESTA', 4_000, T0 + 13 * DIA);
    expect((await ficha(d.id)).oldest_unpaid_date).toBe(T0 + 10 * DIA);
    await en(d.id, 'ABONO', 1_000, T0 + 14 * DIA);
    expect(await ficha(d.id)).toMatchObject({ oldest_unpaid_date: null, current_balance_cop: 0 });
    await en(d.id, 'FIADO', 2_000, T0 + 20 * DIA);
    expect((await ficha(d.id)).oldest_unpaid_date).toBe(T0 + 20 * DIA); // deuda nueva, reloj nuevo
  });

  test('un fiado viejo sin cubrir pone al deudor en mora; saldarlo lo deja al día y cumple la promesa', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    await en(d.id, 'FIADO', 10_000, Date.now() - 31 * DIA);
    expect((await ficha(d.id)).estado).toBe('EN_MORA');
    await api(`/api/deudores/${d.id}`, {}, { method: 'PATCH', body: JSON.stringify({ promised_payment_date: Date.now() + DIA }) });
    expect((await ficha(d.id)).estado).toBe('PROMESA_PAGO');
    await abonar(d.id, 10_000);
    expect(await ficha(d.id)).toMatchObject({ estado: 'AL_DIA', promised_payment_date: null, oldest_unpaid_date: null });
  });
});

describe('validación, aislamiento y permisos', () => {
  test.each([
    ['monto 0', { amount_cop: 0 }], ['monto negativo', { amount_cop: -5 }], ['monto con decimales', { amount_cop: 10.5 }],
    ['monto como texto', { amount_cop: '5000' }], ['monto absurdo', { amount_cop: 100_000_001 }], ['tipo desconocido', { type: 'REGALO' }],
    ['sin request_id', { request_id: undefined }], ['request_id corto', { request_id: 'x' }], ['descripción enorme', { description: 'x'.repeat(141) }],
  ])('%s → 400 sin mover el saldo', async (_caso, cambios) => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    const res = await api(`/api/deudores/${d.id}/movimientos`, {}, { method: 'POST', body: JSON.stringify({ request_id: rid(), type: 'FIADO', amount_cop: 5_000, ...cambios }) });
    expect(res.status).toBe(400);
    expect((await ficha(d.id)).current_balance_cop).toBe(0);
  });

  test('una tienda no puede mover ni ver el libro de un deudor ajeno', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    const d = await deudorNuevo('uid_1');
    await fiar(d.id, 5_000);
    expect((await mover(d.id, { type: 'ABONO', amount_cop: 5_000 }, 'uid_2')).status).toBe(404);
    expect((await mover(d.id, { type: 'FIADO', amount_cop: 5_000 }, 'uid_2')).status).toBe(404);
    expect((await json(api(`/api/deudores/${d.id}/movimientos`, { uid: 'uid_2' }))).movimientos).toEqual([]);
    expect((await ficha(d.id)).current_balance_cop).toBe(5_000);
  });

  test('lo que el navegador no puede fijar se ignora: estado, saldo resultante, origen, negocio', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    const { movimiento } = await json(fiar(d.id, 5_000, { status: 'RECHAZADO', balance_after_cop: 0, source: 'WHATSAPP_BOT', business_id: 'bus_x', created_at: 1 }));
    expect(movimiento).toMatchObject({ status: 'CONFIRMADO', balance_after_cop: 5_000, source: 'MOSTRADOR', business_id: 'bus_uid_1' });
    expect(movimiento.created_at).toBeGreaterThan(1);
  });

  test('vencido: ve el historial pero no puede fiar ni abonar', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    expect((await api('/api/deudores/deb_x/movimientos')).status).toBe(200);
    expect((await mover('deb_x', { type: 'FIADO', amount_cop: 1 })).status).toBe(403);
  });

  test('verificar:saldos detecta un saldo descuadrado', async () => {
    await sembrarNegocio();
    const d = await deudorNuevo();
    await fiar(d.id, 5_000);
    await env.DB.prepare('UPDATE debtors SET current_balance_cop = 4000 WHERE id = ?').bind(d.id).run();
    expect(await descuadrados()).toEqual([expect.objectContaining({ id: d.id, saldo_guardado: 4_000, saldo_calculado: 5_000 })]);
  });
});
