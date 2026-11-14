// SUP-02: los tres casos de la fórmula; aprobar dos veces suma una vez; rechazar termina el desbloqueo; queda auditoría.
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { estadoEfectivo } from '../shared/acceso';
import { aprobarPago, rechazarPago } from './revision';
import { sembrarNegocio } from './test/datos';

const HORA = 3_600_000;
const DIA = 24 * HORA;
const t = (iso: string) => Date.parse(`${iso}:00-05:00`); // hora de Bogotá
const LUNES_10 = t('2026-11-09T10:00');
const ADMIN = 'admin@ejemplo.test';

async function pagoPendiente(extra: Record<string, unknown> = {}, id = 'pay_1') {
  const fila = { id, business_id: 'bus_uid_1', plan_requested: 'PASS_7D', days_to_add: 7, amount_cop: 14_900, receipt_r2_key: `k/${id}`, created_at: LUNES_10, ...extra };
  const cols = Object.keys(fila);
  await env.DB.prepare(`INSERT INTO subscription_payments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...Object.values(fila)).run();
}
const negocio = () => env.DB.prepare("SELECT * FROM businesses WHERE id = 'bus_uid_1'").first<any>();
const auditoria = async () => (await env.DB.prepare('SELECT actor_email, action, business_id, detail_json FROM admin_audit_log ORDER BY created_at, id').all<any>()).results;
const aprobar = (cuando: number, id = 'pay_1') => aprobarPago(env, { pago_id: id, actor_email: ADMIN, nota: null }, cuando);

/** Negocio vencido el domingo, que subió captura el lunes 10:00 y recibió desbloqueo hasta el martes 10:00. */
const vencidoConDesbloqueo = async () => {
  await sembrarNegocio('uid_1', { subscription_plan: 'TRIAL_3D', subscription_expires_at: LUNES_10 - DIA, grace_unlock_ends_at: LUNES_10 + DIA, ai_ocr_used_count: 3, ai_chat_used_count: 9, wa_reminders_used_count: 5 });
  await pagoPendiente({ grace_started_at: LUNES_10 });
};

describe('fórmula de aprobación: los tres casos de B2 (pase de 7 días)', () => {
  test('vencido; sube lunes 10:00, aprobado lunes 16:00 → vence el lunes siguiente 10:00', async () => {
    await vencidoConDesbloqueo();
    await aprobar(t('2026-11-09T16:00'));
    expect((await negocio()).subscription_expires_at).toBe(t('2026-11-16T10:00'));
  });

  test('vencido; sube lunes 10:00, aprobado miércoles 10:00 (el desbloqueo acabó el martes 10:00) → vence el martes siguiente 10:00', async () => {
    await vencidoConDesbloqueo();
    await aprobar(t('2026-11-11T10:00'));
    expect((await negocio()).subscription_expires_at).toBe(t('2026-11-17T10:00'));
  });

  test('activo con 2 días restantes → vence 2 + 7 días después; no hay desbloqueo', async () => {
    const aprobacion = t('2026-11-09T16:00');
    await sembrarNegocio('uid_1', { subscription_expires_at: aprobacion + 2 * DIA });
    await pagoPendiente();
    await aprobar(aprobacion);
    expect((await negocio()).subscription_expires_at).toBe(aprobacion + 9 * DIA);
  });

  test('vencido sin desbloqueo (venía de un rechazo): cuenta 7 días completos desde la aprobación', async () => {
    await sembrarNegocio('uid_1', { subscription_expires_at: LUNES_10 - DIA });
    await pagoPendiente();
    await aprobar(t('2026-11-10T08:00'));
    expect((await negocio()).subscription_expires_at).toBe(t('2026-11-17T08:00'));
  });
});

describe('aprobar', () => {
  test('cambia el plan, reinicia contadores y ciclo, cierra el desbloqueo y deja el negocio activo', async () => {
    await vencidoConDesbloqueo();
    const cuando = t('2026-11-09T16:00');
    const r = await aprobar(cuando);
    expect(r).toMatchObject({ ok: true, aplicado: true, pago: { status: 'PAID', reviewed_by_email: ADMIN, reviewed_at: cuando } });
    const n = await negocio();
    expect(n).toMatchObject({ subscription_plan: 'PASS_7D', grace_unlock_ends_at: null, quota_cycle_started_at: cuando, ai_ocr_used_count: 0, ai_chat_used_count: 0, wa_reminders_used_count: 0 });
    expect(estadoEfectivo(n, cuando)).toBe('ACTIVE');
  });

  test('aprobar dos veces suma una sola vez (también dos a la vez) y audita una sola vez', async () => {
    await vencidoConDesbloqueo();
    const cuando = t('2026-11-09T16:00');
    const [a, b] = await Promise.all([aprobar(cuando), aprobar(cuando + 5)]);
    const c = await aprobar(cuando + HORA);
    expect([a, b, c].map((r) => r.ok)).toEqual([true, true, true]);
    expect([a, b, c].filter((r) => r.ok && r.aplicado)).toHaveLength(1);
    expect((await negocio()).subscription_expires_at).toBe(t('2026-11-16T10:00'));
    expect(await auditoria()).toHaveLength(1);
  });

  test('queda auditoría con quién, qué y sobre qué negocio', async () => {
    await vencidoConDesbloqueo();
    await aprobarPago(env, { pago_id: 'pay_1', actor_email: ADMIN, nota: 'Transferencia verificada' }, LUNES_10 + HORA);
    const [fila] = await auditoria();
    expect(fila).toMatchObject({ actor_email: ADMIN, action: 'PAGO_APROBADO', business_id: 'bus_uid_1' });
    expect(JSON.parse(fila.detail_json)).toEqual({ pago: 'pay_1', plan: 'PASS_7D', monto_cop: 14_900, dias: 7, nota: 'Transferencia verificada' });
  });

  test('un pago inexistente o ya rechazado no se puede aprobar ni toca el negocio', async () => {
    await vencidoConDesbloqueo();
    expect(await aprobar(LUNES_10, 'pay_inexistente')).toEqual({ ok: false, error: 'no_encontrado' });
    await rechazarPago(env, { pago_id: 'pay_1', actor_email: ADMIN, nota: 'Monto incompleto' }, LUNES_10 + HORA);
    const antes = await negocio();
    expect(await aprobar(LUNES_10 + 2 * HORA)).toEqual({ ok: false, error: 'ya_revisado', status: 'REJECTED' });
    expect(await negocio()).toEqual(antes);
  });

  test('solo se toca el negocio del pago', async () => {
    await vencidoConDesbloqueo();
    await sembrarNegocio('uid_2', { subscription_expires_at: LUNES_10 - DIA, ai_chat_used_count: 7 });
    const otro = () => env.DB.prepare("SELECT * FROM businesses WHERE id = 'bus_uid_2'").first();
    const antes = await otro();
    await aprobar(LUNES_10 + HORA);
    expect(await otro()).toEqual(antes);
  });
});

describe('rechazar', () => {
  test('termina el desbloqueo en ese instante, guarda el motivo y no cambia plan, vencimiento ni contadores', async () => {
    await vencidoConDesbloqueo();
    const antes = await negocio();
    const cuando = LUNES_10 + 3 * HORA;
    expect(estadoEfectivo(antes, cuando)).toBe('GRACE_UNLOCK_24H');
    const r = await rechazarPago(env, { pago_id: 'pay_1', actor_email: ADMIN, nota: 'La captura no corresponde' }, cuando);
    expect(r).toMatchObject({ ok: true, aplicado: true, pago: { status: 'REJECTED', review_note: 'La captura no corresponde', reviewed_by_email: ADMIN } });
    const despues = await negocio();
    expect(despues).toEqual({ ...antes, grace_unlock_ends_at: cuando });
    expect(estadoEfectivo(despues, cuando)).toBe('EXPIRED_READONLY');
    expect(await auditoria()).toEqual([expect.objectContaining({ action: 'PAGO_RECHAZADO', business_id: 'bus_uid_1' })]);
  });

  test('rechazar cuando el desbloqueo ya había terminado no lo alarga; sin desbloqueo sigue vacío', async () => {
    await vencidoConDesbloqueo();
    await rechazarPago(env, { pago_id: 'pay_1', actor_email: ADMIN, nota: 'Tarde' }, LUNES_10 + 3 * DIA);
    expect((await negocio()).grace_unlock_ends_at).toBe(LUNES_10 + DIA);
    await sembrarNegocio('uid_3', { id: 'bus_uid_3' });
    await pagoPendiente({ business_id: 'bus_uid_3' }, 'pay_3');
    await rechazarPago(env, { pago_id: 'pay_3', actor_email: ADMIN, nota: 'No' }, LUNES_10);
    expect((await env.DB.prepare("SELECT grace_unlock_ends_at AS g FROM businesses WHERE id = 'bus_uid_3'").first<any>()).g).toBeNull();
  });

  test('rechazar dos veces es idempotente; un pago ya aprobado no se puede rechazar', async () => {
    await vencidoConDesbloqueo();
    const a = await rechazarPago(env, { pago_id: 'pay_1', actor_email: ADMIN, nota: 'No' }, LUNES_10 + HORA);
    const b = await rechazarPago(env, { pago_id: 'pay_1', actor_email: ADMIN, nota: 'No' }, LUNES_10 + 2 * HORA);
    expect([a.ok && a.aplicado, b.ok && b.aplicado]).toEqual([true, false]);
    expect((await negocio()).grace_unlock_ends_at).toBe(LUNES_10 + HORA);
    await pagoPendiente({}, 'pay_2');
    await aprobar(LUNES_10 + 3 * HORA, 'pay_2');
    expect(await rechazarPago(env, { pago_id: 'pay_2', actor_email: ADMIN, nota: 'No' }, LUNES_10 + 4 * HORA)).toEqual({ ok: false, error: 'ya_revisado', status: 'PAID' });
    expect(await auditoria()).toHaveLength(2);
  });
});
