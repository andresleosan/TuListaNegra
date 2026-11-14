// Cuotas del plan (B2, B5): se descuentan con UNA sentencia condicional, para que llamadas simultáneas no se pasen.
import type { Negocio } from './guardian';
import { CICLO_GRATIS_MS, cuotasDe } from './planes';

export type TipoCuota = 'ocr' | 'ia' | 'cobros';

export const SIN_CUOTA: Record<TipoCuota, string> = {
  ocr: 'Ya usaste todas las fotos de tu plan. Renueva tu pase para seguir leyendo fotos.',
  ia: 'Ya usaste todas las interacciones de Sarin de tu plan. Renueva tu pase para seguir usándola.',
  cobros: 'Ya usaste todos los cobros por bot de tu plan. Renueva tu pase para seguir enviándolos.',
};

const COLUMNA = `CASE ?3 WHEN 'ocr' THEN ai_ocr_used_count WHEN 'ia' THEN ai_chat_used_count ELSE wa_reminders_used_count END`;
// En la suscripción gratis los contadores se reinician cada 30 días, justo al usar la primera cuota del ciclo nuevo.
const CICLO_NUEVO = `(free_forever_at IS NOT NULL AND ?2 - quota_cycle_started_at >= ${CICLO_GRATIS_MS})`;

type DeQuien = Pick<Negocio, 'id' | 'free_forever_at' | 'subscription_plan'>;

/** Gasta una unidad si queda cuota. Devuelve false (sin tocar nada) si ya no queda. */
export async function consumirCuota(env: Env, negocio: DeQuien, tipo: TipoCuota, ahora = Date.now()): Promise<boolean> {
  const { meta } = await env.DB.prepare(
    `UPDATE businesses SET
       ai_ocr_used_count = IIF(${CICLO_NUEVO}, 0, ai_ocr_used_count) + (?3 = 'ocr'),
       ai_chat_used_count = IIF(${CICLO_NUEVO}, 0, ai_chat_used_count) + (?3 = 'ia'),
       wa_reminders_used_count = IIF(${CICLO_NUEVO}, 0, wa_reminders_used_count) + (?3 = 'cobros'),
       quota_cycle_started_at = IIF(${CICLO_NUEVO}, ?2, quota_cycle_started_at)
     WHERE id = ?1 AND (${CICLO_NUEVO} OR ${COLUMNA} < ?4)`,
  ).bind(negocio.id, ahora, tipo, cuotasDe(negocio)[tipo]).run();
  return meta.changes === 1;
}

/** Devuelve una unidad cuando el servicio falló: el tendero no paga por un error que no es suyo. */
export async function devolverCuota(env: Env, negocio: DeQuien, tipo: TipoCuota): Promise<void> {
  await env.DB.prepare(
    `UPDATE businesses SET
       ai_ocr_used_count = MAX(ai_ocr_used_count - (?2 = 'ocr'), 0),
       ai_chat_used_count = MAX(ai_chat_used_count - (?2 = 'ia'), 0),
       wa_reminders_used_count = MAX(wa_reminders_used_count - (?2 = 'cobros'), 0)
     WHERE id = ?1`,
  ).bind(negocio.id, tipo).run();
}

export type ConCuota<T> = { ok: true; valor: T } | { ok: false; error: 'sin_cuota'; mensaje: string };

/** Ejecuta `trabajo` gastando una unidad. Sin cuota no se ejecuta; si falla, la unidad se devuelve. */
export async function conCuota<T>(env: Env, negocio: DeQuien, tipo: TipoCuota, trabajo: () => Promise<T>): Promise<ConCuota<T>> {
  if (!(await consumirCuota(env, negocio, tipo))) return { ok: false, error: 'sin_cuota', mensaje: SIN_CUOTA[tipo] };
  try {
    return { ok: true, valor: await trabajo() };
  } catch (e) {
    await devolverCuota(env, negocio, tipo);
    throw e;
  }
}
