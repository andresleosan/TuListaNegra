// Avisos de vencimiento (SUS-03). El cron horario solo los deja listos: nunca cambia el negocio ni decide el acceso.
// El envío al WhatsApp del dueño llega con el bot (fase 4) y está detrás de WHATSAPP_SEND_READY.
import { estadoEfectivo, type DatosDeEstado } from '../shared/acceso';
import type { TIPOS_AVISO } from './db/schema';
import { DIA } from './planes';

export type TipoAviso = (typeof TIPOS_AVISO)[number];

/** Un vencido se avisa durante 3 días desde que perdió el acceso; más viejo no (evita avisos rancios al estrenar el cron). */
const VENTANA_VENCIDO = 3 * DIA;

/** Qué aviso toca ahora, o `null`. Función pura; el índice único de `subscription_notices` evita repetirlo. */
export function avisoQueToca(negocio: DatosDeEstado, ahora: number): TipoAviso | null {
  const estado = estadoEfectivo(negocio, ahora);
  if (estado === 'SUSPENDED_BY_ADMIN' || negocio.free_forever_at !== null || estado === 'GRACE_UNLOCK_24H') return null;
  const falta = negocio.subscription_expires_at - ahora;
  if (estado === 'EXPIRED_READONLY') {
    const perdioAcceso = Math.max(negocio.subscription_expires_at, negocio.grace_unlock_ends_at ?? 0);
    return ahora - perdioAcceso < VENTANA_VENCIDO ? 'VENCIDO' : null;
  }
  if (falta <= DIA) return 'UN_DIA';
  // La prueba nace con 72 h: un «te quedan 3 días» al registrarse no le dice nada al tendero.
  if (falta <= 3 * DIA && negocio.subscription_plan !== 'TRIAL_3D') return 'TRES_DIAS';
  return null;
}

/** Recorre los negocios cerca de vencer o recién vencidos y deja sus avisos. Devuelve cuántos avisos nuevos dejó. */
export async function registrarAvisos(db: D1Database, ahora: number): Promise<number> {
  // ponytail: escaneo acotado por fecha sin índice; añadir uno sobre subscription_expires_at si los negocios pasan de miles.
  const { results } = await db
    .prepare(
      `SELECT id, suspended_at, free_forever_at, subscription_plan, subscription_expires_at, grace_unlock_ends_at
       FROM businesses
       WHERE suspended_at IS NULL AND free_forever_at IS NULL
         AND subscription_expires_at <= ?1 AND MAX(subscription_expires_at, IFNULL(grace_unlock_ends_at, 0)) > ?2`,
    )
    .bind(ahora + 3 * DIA, ahora - VENTANA_VENCIDO)
    .all<DatosDeEstado & { id: string }>();
  const nuevos = results.flatMap((n) => {
    const tipo = avisoQueToca(n, ahora);
    return tipo
      ? [db.prepare('INSERT OR IGNORE INTO subscription_notices (business_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(n.id, tipo, n.subscription_expires_at, ahora)]
      : [];
  });
  if (nuevos.length === 0) return 0;
  return (await db.batch(nuevos)).reduce((total, r) => total + r.meta.changes, 0);
}
