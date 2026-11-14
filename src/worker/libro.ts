// El libro (B3): cada movimiento y el saldo del deudor se escriben en una sola transacción (db.batch),
// con la aritmética en SQL. Nada de «leer el saldo, sumar en JS y guardar»: con dos toques a la vez se perdería dinero.
import type { ledger_transactions } from './db/schema';

export type Movimiento = typeof ledger_transactions.$inferSelect;

export type NuevoMovimiento = Pick<Movimiento, 'business_id' | 'debtor_id' | 'request_id' | 'type' | 'amount_cop' | 'source'> & {
  description?: string;
  due_date?: number | null;
  evidence_r2_key?: string | null;
  /** El tendero ya vio la alerta de tope excedido y confirmó. */
  confirmar_tope?: boolean;
};

export type ResultadoMovimiento =
  | { ok: true; movimiento: Movimiento; repetido: boolean }
  | { ok: false; error: 'no_encontrado' }
  | { ok: false; error: 'supera_saldo'; saldo: number }
  | { ok: false; error: 'supera_tope'; saldo: number; tope: number };

const DESCRIPCION = { FIADO: 'Fiado', ABONO: 'Abono', AJUSTE_SUMA: 'Ajuste (suma)', AJUSTE_RESTA: 'Ajuste (resta)' } as const;

/** FIADO y AJUSTE_SUMA aumentan la deuda; ABONO y AJUSTE_RESTA la reducen. */
export const signo = (tipo: Movimiento['type']) => (tipo === 'FIADO' || tipo === 'AJUSTE_SUMA' ? 1 : -1);

// Fecha del fiado sin cubrir más antiguo: los abonos pagan primero los fiados más viejos (B3).
// ponytail: recorre el historial del deudor en cada movimiento; si un deudor llega a miles de filas, guardar un cursor.
const SQL_MORA = `
  UPDATE debtors SET oldest_unpaid_date = (
    SELECT MIN(created_at) FROM (
      SELECT created_at, SUM(amount_cop) OVER (ORDER BY created_at, id) AS acumulado
      FROM ledger_transactions
      WHERE business_id = ?2 AND debtor_id = ?1 AND status = 'CONFIRMADO' AND type IN ('FIADO', 'AJUSTE_SUMA')
    ) WHERE acumulado > (
      SELECT COALESCE(SUM(amount_cop), 0) FROM ledger_transactions
      WHERE business_id = ?2 AND debtor_id = ?1 AND status = 'CONFIRMADO' AND type IN ('ABONO', 'AJUSTE_RESTA')
    )
  )
  WHERE id = ?1 AND business_id = ?2 AND EXISTS (SELECT 1 FROM ledger_transactions WHERE id = ?3)`;

/** Registra un movimiento confirmado. Repetir el mismo `request_id` devuelve el movimiento original sin crear otro. */
export async function registrarMovimiento(env: Env, m: NuevoMovimiento, ahora = Date.now()): Promise<ResultadoMovimiento> {
  const db = env.DB;
  const id = `mov_${crypto.randomUUID().replaceAll('-', '')}`;
  const delta = signo(m.type) * m.amount_cop;
  const existente = () =>
    db.prepare('SELECT * FROM ledger_transactions WHERE business_id = ? AND request_id = ?').bind(m.business_id, m.request_id).first<Movimiento>();

  let insertadas: number;
  try {
    const [insercion] = await db.batch([
      // 1. El movimiento solo entra si el deudor es de este negocio, el saldo no queda negativo y el tope se respeta (o se confirmó).
      db.prepare(
        `INSERT INTO ledger_transactions (id, business_id, debtor_id, request_id, type, amount_cop, status, balance_after_cop,
           description, evidence_r2_key, due_date, created_at, confirmed_at, source)
         SELECT ?1, business_id, id, ?4, ?5, ?6, 'CONFIRMADO', current_balance_cop + ?7, ?8, ?9, ?10, ?11, ?11, ?12
         FROM debtors
         WHERE id = ?3 AND business_id = ?2 AND current_balance_cop + ?7 >= 0
           AND (?13 = 1 OR ?5 <> 'FIADO' OR credit_limit_cop IS NULL OR current_balance_cop + ?7 <= credit_limit_cop)`,
      ).bind(
        id, m.business_id, m.debtor_id, m.request_id, m.type, m.amount_cop, delta, m.description || DESCRIPCION[m.type],
        m.evidence_r2_key ?? null, m.due_date ?? null, ahora, m.source, m.confirmar_tope ? 1 : 0,
      ),
      // 2. El saldo se mueve solo si el movimiento entró. Al quedar en cero, la promesa de pago se da por cumplida.
      db.prepare(
        `UPDATE debtors SET current_balance_cop = current_balance_cop + ?3,
           promised_payment_date = CASE WHEN current_balance_cop + ?3 = 0 THEN NULL ELSE promised_payment_date END
         WHERE id = ?1 AND business_id = ?2 AND EXISTS (SELECT 1 FROM ledger_transactions WHERE id = ?4)`,
      ).bind(m.debtor_id, m.business_id, delta, id),
      db.prepare(SQL_MORA).bind(m.debtor_id, m.business_id, id),
    ]);
    insertadas = insercion!.meta.changes;
  } catch (e) {
    // El disparador ledger_no_replace corta un request_id repetido: se devuelve el movimiento que ya existía.
    if (!(e instanceof Error && e.message.includes('movimiento repetido'))) throw e;
    const previo = await existente();
    if (!previo) throw e;
    return { ok: true, movimiento: previo, repetido: true };
  }

  if (insertadas === 1) return { ok: true, movimiento: (await existente())!, repetido: false };

  // No entró: se averigua por qué para explicárselo al tendero. Nada quedó escrito.
  const deudor = await db.prepare('SELECT current_balance_cop AS saldo, credit_limit_cop AS tope FROM debtors WHERE id = ? AND business_id = ?')
    .bind(m.debtor_id, m.business_id).first<{ saldo: number; tope: number | null }>();
  if (!deudor) return { ok: false, error: 'no_encontrado' };
  if (deudor.saldo + delta < 0) return { ok: false, error: 'supera_saldo', saldo: deudor.saldo };
  return { ok: false, error: 'supera_tope', saldo: deudor.saldo, tope: deudor.tope ?? 0 };
}
