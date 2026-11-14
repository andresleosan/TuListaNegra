// SUP-04: las cifras coinciden con una base de prueba conocida; los gratis van aparte y no suman ingresos.
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { indicadores, inicioDelMes } from './indicadores';
import { sembrarNegocio } from './test/datos';
import { api } from './test/sesion';

const HORA = 3_600_000;
const DIA = 24 * HORA;
const AHORA = Date.parse('2026-11-14T12:00:00-05:00');
const NOV_1 = Date.parse('2026-11-01T00:00:00-05:00');

async function pago(id: string, negocio: string, status: string, monto: number, revisado: number | null) {
  await env.DB.prepare(
    `INSERT INTO subscription_payments (id, business_id, plan_requested, days_to_add, amount_cop, receipt_r2_key, status, created_at, reviewed_at)
     VALUES (?, ?, 'PASS_7D', 7, ?, ?, ?, ?, ?)`,
  ).bind(id, negocio, monto, `k/${id}`, status, AHORA - 40 * DIA, revisado).run();
}

test('inicio del mes en hora de Bogotá', () => {
  expect(inicioDelMes(AHORA)).toBe(NOV_1);
  expect(inicioDelMes(Date.parse('2026-11-01T02:00:00Z'))).toBe(Date.parse('2026-10-01T00:00:00-05:00')); // en Bogotá aún es 31 de octubre
  expect(inicioDelMes(NOV_1)).toBe(NOV_1);
});

test('base conocida: negocios por estado, ingresos del mes, conversión y consumo', async () => {
  const vigente = { subscription_expires_at: AHORA + 5 * DIA };
  const vencido = { subscription_expires_at: AHORA - 5 * DIA };
  const uso = (n: number) => ({ ai_ocr_used_count: n, ai_chat_used_count: 10 * n, wa_reminders_used_count: 2 * n });
  await sembrarNegocio('p1', { subscription_plan: 'TRIAL_3D', ...vigente, ...uso(1) });
  await sembrarNegocio('p2', { subscription_plan: 'TRIAL_3D', ...vigente });
  await sembrarNegocio('a7', { subscription_plan: 'PASS_7D', ...vigente, ...uso(2) });
  await sembrarNegocio('a15', { subscription_plan: 'PASS_15D', ...vigente });
  await sembrarNegocio('a30a', { subscription_plan: 'PASS_30D', ...vigente });
  await sembrarNegocio('a30b', { subscription_plan: 'PASS_30D', ...vigente, ...uso(3) });
  await sembrarNegocio('g1', { subscription_plan: 'TRIAL_3D', ...vencido, free_forever_at: AHORA - DIA, ...uso(4) }); // gratis, con fechas vencidas
  await sembrarNegocio('d1', { subscription_plan: 'PASS_7D', ...vencido, grace_unlock_ends_at: AHORA + HORA });
  await sembrarNegocio('v1', { subscription_plan: 'TRIAL_3D', ...vencido });
  await sembrarNegocio('v2', { subscription_plan: 'PASS_7D', ...vencido, grace_unlock_ends_at: AHORA - HORA });
  await sembrarNegocio('s1', { subscription_plan: 'PASS_30D', ...vigente, suspended_at: AHORA - DIA });
  await sembrarNegocio('s2', { subscription_plan: 'TRIAL_3D', ...vencido, free_forever_at: AHORA, suspended_at: AHORA }); // suspendido gana a gratis

  await pago('pay_1', 'bus_a7', 'PAID', 14_900, NOV_1); // justo al empezar el mes: cuenta
  await pago('pay_2', 'bus_a30a', 'PAID', 49_900, AHORA - DIA);
  await pago('pay_3', 'bus_a30a', 'PAID', 49_900, NOV_1 - 1); // octubre: no cuenta como ingreso del mes, sí como negocio que pagó
  await pago('pay_4', 'bus_v2', 'PAID', 14_900, NOV_1 - 20 * DIA);
  await pago('pay_5', 'bus_a15', 'REJECTED', 27_900, AHORA - DIA); // rechazado: no es ingreso
  await pago('pay_6', 'bus_d1', 'PENDING_REVIEW', 14_900, null); // pendiente: aún no es ingreso
  await pago('pay_7', 'bus_v1', 'PENDING_REVIEW', 14_900, null);

  expect(await indicadores(env, AHORA)).toEqual({
    negocios: { total: 12, prueba: 2, activos: { PASS_7D: 1, PASS_15D: 1, PASS_30D: 2, otros: 0 }, gratis: 1, desbloqueo: 1, vencidos: 2, suspendidos: 2 },
    ingresos_mes_cop: 14_900 + 49_900,
    pagos_mes: 2,
    pagos_pendientes: 2,
    conversion: { pagaron: 3, base: 11, porcentaje: 27.3 },
    consumo: { ocr: 10, ia: 100, cobros: 20 },
  });
});

test('sin datos no divide por cero; la ruta de la consola responde lo mismo', async () => {
  const vacio = { negocios: { total: 0, prueba: 0, activos: { PASS_7D: 0, PASS_15D: 0, PASS_30D: 0, otros: 0 }, gratis: 0, desbloqueo: 0, vencidos: 0, suspendidos: 0 }, ingresos_mes_cop: 0, pagos_mes: 0, pagos_pendientes: 0, conversion: { pagaron: 0, base: 0, porcentaje: 0 }, consumo: { ocr: 0, ia: 0, cobros: 0 } };
  expect(await indicadores(env, AHORA)).toEqual(vacio);
  const res = await api('/api/superadmin/indicadores', { email: 'admin@ejemplo.test' }, {}, { ...env, SUPERADMIN_EMAILS: 'admin@ejemplo.test' });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(vacio);
});

test('un negocio que pagó y hoy es gratis no cuenta en la conversión: su base lo excluye', async () => {
  await sembrarNegocio('g1', { subscription_expires_at: AHORA + DIA, free_forever_at: AHORA - DIA });
  await sembrarNegocio('n1', { subscription_expires_at: AHORA + DIA });
  await pago('pay_g1', 'bus_g1', 'PAID', 14_900, AHORA - HORA);
  const r = await indicadores(env, AHORA);
  expect(r.conversion).toEqual({ pagaron: 0, base: 1, porcentaje: 0 });
  expect(r.ingresos_mes_cop).toBe(14_900); // el dinero que entró sí cuenta
});
