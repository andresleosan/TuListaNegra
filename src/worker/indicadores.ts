// Indicadores globales de la consola (SUP-04). Los estados se calculan con la misma función que decide el acceso.
import { estadoEfectivo } from '../shared/acceso';
import type { businesses } from './db/schema';

type Negocio = typeof businesses.$inferSelect;
type Fila = Pick<Negocio, 'suspended_at' | 'free_forever_at' | 'subscription_plan' | 'subscription_expires_at' | 'grace_unlock_ends_at' | 'ai_ocr_used_count' | 'ai_chat_used_count' | 'wa_reminders_used_count'>;

const BOGOTA = -5 * 3_600_000; // UTC−5 fijo: Colombia no tiene horario de verano

/** Inicio (00:00 de Bogotá) del mes en curso, en ms UTC. */
export function inicioDelMes(ahora: number): number {
  const local = new Date(ahora + BOGOTA);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - BOGOTA;
}

// ponytail: recorre todos los negocios en cada consulta; con decenas de miles, pasar a un GROUP BY o a una tabla resumen.
export async function indicadores(env: Env, ahora = Date.now()) {
  const db = env.DB;
  const [negocios, pagos] = await db.batch([
    db.prepare(
      `SELECT suspended_at, free_forever_at, subscription_plan, subscription_expires_at, grace_unlock_ends_at,
         ai_ocr_used_count, ai_chat_used_count, wa_reminders_used_count FROM businesses`,
    ),
    db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'PAID' AND reviewed_at >= ?1 THEN amount_cop END), 0) AS ingresos_mes_cop,
         COUNT(CASE WHEN status = 'PAID' AND reviewed_at >= ?1 THEN 1 END) AS pagos_mes,
         COUNT(CASE WHEN status = 'PENDING_REVIEW' THEN 1 END) AS pagos_pendientes,
         COUNT(DISTINCT CASE WHEN status = 'PAID' THEN business_id END) AS negocios_que_pagaron
       FROM subscription_payments`,
    ).bind(inicioDelMes(ahora)),
  ]);

  const cuenta = { total: 0, prueba: 0, activos: { PASS_7D: 0, PASS_15D: 0, PASS_30D: 0, otros: 0 }, gratis: 0, desbloqueo: 0, vencidos: 0, suspendidos: 0 };
  const consumo = { ocr: 0, ia: 0, cobros: 0 };
  for (const n of negocios!.results as Fila[]) {
    cuenta.total++;
    consumo.ocr += n.ai_ocr_used_count;
    consumo.ia += n.ai_chat_used_count;
    consumo.cobros += n.wa_reminders_used_count;
    const estado = estadoEfectivo(n, ahora);
    if (estado === 'SUSPENDED_BY_ADMIN') cuenta.suspendidos++;
    else if (n.free_forever_at !== null) cuenta.gratis++; // aparte: no son clientes de pago
    else if (estado === 'TRIAL') cuenta.prueba++;
    else if (estado === 'GRACE_UNLOCK_24H') cuenta.desbloqueo++;
    else if (estado === 'EXPIRED_READONLY') cuenta.vencidos++;
    else if (n.subscription_plan === 'TRIAL_3D') cuenta.activos.otros++; // inalcanzable hoy: TRIAL vigente ya se contó arriba
    else cuenta.activos[n.subscription_plan]++;
  }

  const p = pagos!.results[0] as { ingresos_mes_cop: number; pagos_mes: number; pagos_pendientes: number; negocios_que_pagaron: number };
  // Conversión de prueba a pago: de los negocios que no son de cortesía, cuántos han pagado al menos un pase.
  const base = cuenta.total - cuenta.gratis;
  return {
    negocios: cuenta,
    ingresos_mes_cop: p.ingresos_mes_cop, // solo pagos confirmados; las cuentas gratis no suman
    pagos_mes: p.pagos_mes,
    pagos_pendientes: p.pagos_pendientes,
    conversion: { pagaron: p.negocios_que_pagaron, base, porcentaje: base ? Math.round((1000 * p.negocios_que_pagaron) / base) / 10 : 0 },
    consumo,
  };
}
