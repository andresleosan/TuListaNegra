// BAS-03: la migración aplica sobre una base nueva (setup.ts) y las restricciones del esquema se cumplen.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';

const db = env.DB;
const T = 1_800_000_000_000;

const negocio = (id: string, extra: Record<string, unknown> = {}) => {
  const fila = {
    id, owner_firebase_uid: `uid_${id}`, owner_email: `${id}@ejemplo.test`, name: `Tienda ${id}`,
    subscription_expires_at: T, quota_cycle_started_at: T, terms_accepted_at: T, created_at: T, ...extra,
  };
  const cols = Object.keys(fila);
  return db.prepare(`INSERT INTO businesses (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...Object.values(fila));
};
const deudor = (id: string, negocioId: string, codigo: string, extra: Record<string, unknown> = {}) => {
  const fila = { id, business_id: negocioId, unique_code: codigo, full_name: `Deudor ${id}`, created_at: T, ...extra };
  const cols = Object.keys(fila);
  return db.prepare(`INSERT INTO debtors (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...Object.values(fila));
};
const movimiento = (id: string, extra: Record<string, unknown> = {}) => {
  const fila = {
    id, business_id: 'bus_a', debtor_id: 'deb_1', request_id: `req_${id}`, type: 'FIADO', amount_cop: 5000,
    status: 'CONFIRMADO', description: 'Fiado', created_at: T, source: 'MOSTRADOR', ...extra,
  };
  const cols = Object.keys(fila);
  return db.prepare(`INSERT INTO ledger_transactions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...Object.values(fila));
};
const pago = (id: string, extra: Record<string, unknown> = {}) => {
  const fila = { id, business_id: 'bus_a', plan_requested: 'PASS_7D', days_to_add: 7, amount_cop: 14900, receipt_r2_key: `k/${id}`, created_at: T, ...extra };
  const cols = Object.keys(fila);
  return db.prepare(`INSERT INTO subscription_payments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...Object.values(fila));
};

beforeEach(async () => {
  await db.batch([negocio('bus_a'), negocio('bus_b'), deudor('deb_1', 'bus_a', 'TLN-0001')]);
});

describe('migración inicial', () => {
  test('crea las cinco tablas', async () => {
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all();
    expect(results.map((r) => r.name).sort()).toEqual(['admin_audit_log', 'businesses', 'debtors', 'ledger_transactions', 'subscription_payments']);
  });

  test('valores por defecto del negocio', async () => {
    const fila = await db.prepare("SELECT * FROM businesses WHERE id = 'bus_a'").first();
    expect(fila).toMatchObject({ subscription_plan: 'TRIAL_3D', default_alert_days: 30, ai_ocr_used_count: 0, ai_chat_used_count: 0, wa_reminders_used_count: 0 });
  });
});

describe('únicos', () => {
  test('un negocio por cuenta de Firebase', async () => {
    await expect(negocio('bus_c', { owner_firebase_uid: 'uid_bus_a' }).run()).rejects.toThrow(/UNIQUE/);
  });

  test('teléfono del negocio único si existe; varios sin teléfono conviven', async () => {
    await negocio('bus_c', { whatsapp_phone: '+573001112233' }).run();
    await expect(negocio('bus_d', { whatsapp_phone: '+573001112233' }).run()).rejects.toThrow(/UNIQUE/);
    await negocio('bus_e').run(); // bus_a, bus_b y bus_e no tienen teléfono
  });

  test('código de deudor único por negocio, repetible entre negocios', async () => {
    await expect(deudor('deb_2', 'bus_a', 'TLN-0001').run()).rejects.toThrow(/UNIQUE/);
    await deudor('deb_3', 'bus_b', 'TLN-0001').run();
  });

  test('request_id único por negocio', async () => {
    await movimiento('mov_1', { request_id: 'r1' }).run();
    await expect(movimiento('mov_2', { request_id: 'r1' }).run()).rejects.toThrow(/UNIQUE/);
  });
});

describe('índices parciales', () => {
  test('documento duplicado rechazado; sin documento se permiten muchos', async () => {
    await deudor('deb_2', 'bus_a', 'TLN-0002', { doc_type: 'CC', doc_number: '123' }).run();
    await expect(deudor('deb_3', 'bus_a', 'TLN-0003', { doc_type: 'CC', doc_number: '123' }).run()).rejects.toThrow(/UNIQUE/);
    await deudor('deb_4', 'bus_a', 'TLN-0004').run();
    await deudor('deb_5', 'bus_a', 'TLN-0005').run();
    await deudor('deb_6', 'bus_b', 'TLN-0001', { doc_type: 'CC', doc_number: '123' }).run(); // otro negocio
  });

  test('un solo pago PENDING_REVIEW por negocio; los revisados no cuentan', async () => {
    await pago('pay_1').run();
    await expect(pago('pay_2').run()).rejects.toThrow(/UNIQUE/);
    await pago('pay_3', { status: 'PAID' }).run();
    await pago('pay_4', { status: 'REJECTED' }).run();
    await pago('pay_5', { business_id: 'bus_b' }).run();
  });
});

describe('restricciones de valores', () => {
  test.each([0, -1])('monto de movimiento %i rechazado', async (monto) => {
    await expect(movimiento('mov_x', { amount_cop: monto }).run()).rejects.toThrow(/CHECK/);
  });

  test('monto y días de un pago mayores que 0', async () => {
    await expect(pago('pay_x', { amount_cop: 0 }).run()).rejects.toThrow(/CHECK/);
    await expect(pago('pay_y', { days_to_add: 0 }).run()).rejects.toThrow(/CHECK/);
  });

  test('saldo del deudor nunca negativo', async () => {
    await expect(db.prepare("UPDATE debtors SET current_balance_cop = -1 WHERE id = 'deb_1'").run()).rejects.toThrow(/CHECK/);
  });

  test.each([
    ['type', 'REGALO'], ['status', 'BORRADOR'], ['source', 'CORREO'],
  ])('movimiento con %s = %s rechazado', async (columna, valor) => {
    await expect(movimiento('mov_x', { [columna]: valor }).run()).rejects.toThrow(/CHECK/);
  });

  test('plan desconocido rechazado', async () => {
    await expect(negocio('bus_z', { subscription_plan: 'PASS_99D' }).run()).rejects.toThrow(/CHECK/);
  });

  test('deudor o movimiento sin negocio existente rechazado', async () => {
    await expect(deudor('deb_9', 'bus_inexistente', 'TLN-0001').run()).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('el libro y la auditoría solo se añaden', () => {
  test('un movimiento confirmado no se edita ni se borra', async () => {
    await movimiento('mov_1').run();
    await expect(db.prepare("UPDATE ledger_transactions SET amount_cop = 1 WHERE id = 'mov_1'").run()).rejects.toThrow(/solo un pendiente/);
    await expect(db.prepare("DELETE FROM ledger_transactions WHERE id = 'mov_1'").run()).rejects.toThrow(/no se borran/);
  });

  test('un pendiente puede corregirse y confirmarse; después queda fijo', async () => {
    await movimiento('mov_1', { type: 'ABONO', status: 'PENDIENTE_VERIFICACION_WHATSAPP', source: 'WHATSAPP_BOT' }).run();
    await db.prepare("UPDATE ledger_transactions SET amount_cop = 7000 WHERE id = 'mov_1'").run();
    await db.prepare("UPDATE ledger_transactions SET status = 'CONFIRMADO', confirmed_at = ? WHERE id = 'mov_1'").bind(T).run();
    await expect(db.prepare("UPDATE ledger_transactions SET amount_cop = 1 WHERE id = 'mov_1'").run()).rejects.toThrow(/solo un pendiente/);
  });

  test('la auditoría no se edita ni se borra', async () => {
    await db.prepare("INSERT INTO admin_audit_log (id, actor_email, action, created_at) VALUES ('aud_1', 'admin@ejemplo.test', 'SUSPENDER', ?)").bind(T).run();
    await expect(db.prepare("UPDATE admin_audit_log SET action = 'x' WHERE id = 'aud_1'").run()).rejects.toThrow(/solo se añade/);
    await expect(db.prepare("DELETE FROM admin_audit_log WHERE id = 'aud_1'").run()).rejects.toThrow(/solo se añade/);
  });
});
