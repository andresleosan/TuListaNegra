// Revisión de pagos por el superadministrador (B2, pasos 6 y 7). Todo en un db.batch: o se aplica entero o nada.
import { nuevoId } from '../shared/ids';
import type { subscription_payments } from './db/schema';
import { DESBLOQUEO_MS } from './pagos';

type Pago = typeof subscription_payments.$inferSelect;

export type ResultadoRevision =
  | { ok: true; pago: Pago; aplicado: boolean } // aplicado = false: ya estaba revisado igual (idempotente)
  | { ok: false; error: 'no_encontrado' }
  | { ok: false; error: 'ya_revisado'; status: Pago['status'] };

type Revision = { pago_id: string; actor_email: string; nota: string | null };

const DIA = 86_400_000;

// Cada sentencia lleva la condición «el pago sigue PENDING_REVIEW»; la que lo saca de pendiente va al final.
// Así dos revisiones a la vez (o un doble toque) se serializan y la segunda no encuentra nada que aplicar.
const PENDIENTE = `FROM subscription_payments p WHERE p.id = ?1 AND p.status = 'PENDING_REVIEW'`;

const auditoria = (db: D1Database, accion: string, r: Revision, ahora: number) =>
  db.prepare(
    `INSERT INTO admin_audit_log (id, actor_email, action, business_id, detail_json, created_at)
     SELECT ?2, ?3, ?4, p.business_id,
       json_object('pago', p.id, 'plan', p.plan_requested, 'monto_cop', p.amount_cop, 'dias', p.days_to_add, 'nota', ?5), ?6 ${PENDIENTE}`,
  ).bind(r.pago_id, nuevoId('aud', ahora), r.actor_email, accion, r.nota, ahora);

const cerrar = (db: D1Database, estado: 'PAID' | 'REJECTED', r: Revision, ahora: number) =>
  db.prepare(
    `UPDATE subscription_payments SET status = ?2, reviewed_by_email = ?3, review_note = ?4, reviewed_at = ?5
     WHERE id = ?1 AND status = 'PENDING_REVIEW'`,
  ).bind(r.pago_id, estado, r.actor_email, r.nota, ahora);

async function resultado(db: D1Database, r: Revision, esperado: 'PAID' | 'REJECTED', cambios: number): Promise<ResultadoRevision> {
  const pago = await db.prepare('SELECT * FROM subscription_payments WHERE id = ?').bind(r.pago_id).first<Pago>();
  if (!pago) return { ok: false, error: 'no_encontrado' };
  if (pago.status !== esperado) return { ok: false, error: 'ya_revisado', status: pago.status };
  return { ok: true, pago, aplicado: cambios === 1 };
}

/**
 * Aprobar: nuevo_vencimiento = max(vencimiento_actual, aprobación) + días × 24 h − desbloqueo_consumido,
 * con desbloqueo_consumido = min(aprobación, fin_del_desbloqueo) − inicio_del_desbloqueo (0 si no hubo).
 * Además reinicia contadores, cambia el plan al solicitado y cierra el desbloqueo. Aprobar dos veces suma una sola vez.
 */
export async function aprobarPago(env: Env, r: Revision, ahora = Date.now()): Promise<ResultadoRevision> {
  const db = env.DB;
  const [, , cierre] = await db.batch([
    db.prepare(
      `UPDATE businesses SET
         subscription_expires_at = MAX(subscription_expires_at, ?2) + p.days_to_add * ${DIA}
           - CASE WHEN p.grace_started_at IS NULL THEN 0 ELSE MIN(?2, p.grace_started_at + ${DESBLOQUEO_MS}) - p.grace_started_at END,
         subscription_plan = p.plan_requested,
         grace_unlock_ends_at = NULL,
         quota_cycle_started_at = ?2, ai_ocr_used_count = 0, ai_chat_used_count = 0, wa_reminders_used_count = 0
       ${PENDIENTE} AND businesses.id = p.business_id`,
    ).bind(r.pago_id, ahora),
    auditoria(db, 'PAGO_APROBADO', r, ahora),
    cerrar(db, 'PAID', r, ahora),
  ]);
  return resultado(db, r, 'PAID', cierre!.meta.changes);
}

/** Rechazar: el desbloqueo termina en ese instante. El motivo queda en el pago para avisar al dueño en la app. */
export async function rechazarPago(env: Env, r: Revision & { nota: string }, ahora = Date.now()): Promise<ResultadoRevision> {
  const db = env.DB;
  const [, , cierre] = await db.batch([
    db.prepare(
      `UPDATE businesses SET grace_unlock_ends_at = MIN(grace_unlock_ends_at, ?2) ${PENDIENTE} AND businesses.id = p.business_id`,
    ).bind(r.pago_id, ahora),
    auditoria(db, 'PAGO_RECHAZADO', r, ahora),
    cerrar(db, 'REJECTED', r, ahora),
  ]);
  return resultado(db, r, 'REJECTED', cierre!.meta.changes);
}
