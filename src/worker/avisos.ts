// Avisos de vencimiento (SUS-03). El cron horario solo los deja listos: nunca cambia el negocio ni decide el acceso.
// Después los envía al WhatsApp VERIFICADO del dueño (WAP-07), detrás de WHATSAPP_SEND_READY como el resto del bot.
import { estadoEfectivo, type DatosDeEstado } from '../shared/acceso';
import type { TIPOS_AVISO } from './db/schema';
import { DIA } from './planes';
import { gatewayPara } from './whatsapp';

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

/**
 * Franja en que salen los avisos al dueño, en hora de Bogotá (UTC−5 fijo): de 7:00 a 19:00, todos los días. Es la franja
 * de cobro de lunes a viernes de B6; sin quitar domingos ni festivos porque no es un cobro a un tercero sino un aviso
 * de servicio al propio dueño sobre su cuenta. Lo que se registra de noche sale con el primer cron de las 7:00.
 */
const HORA = 3_600_000;
const ABRE = 7;
const CIERRA = 19;
const enFranja = (ahora: number) => {
  const hora = new Date(ahora - 5 * HORA).getUTCHours();
  return hora >= ABRE && hora < CIERRA;
};

const QUE_PASA: Record<TipoAviso, string> = {
  TRES_DIAS: 'vence en menos de 3 días',
  UN_DIA: 'vence en menos de un día',
  VENCIDO: 'ya venció',
};
const fecha = new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', timeZone: 'America/Bogota' });

type Pendiente = DatosDeEstado & { id: string; kind: TipoAviso; expires_at: number; telefono: string };

/**
 * Envía los avisos con `sent_at` NULL al WhatsApp verificado de su dueño y marca `sent_at`. Devuelve cuántos envió.
 * - Nada en producción con el interruptor apagado (A1.6), ni fuera de la franja de arriba.
 * - Solo los registrados en los últimos 3 días y que TODAVÍA tocan: mismo vencimiento que el negocio (no renovó) y el
 *   mismo tipo que `avisoQueToca` (un «te queda 1 día» que se quedó de noche no sale si ya venció: sale el de vencido).
 *   Los demás quedan como están.
 * - Reserva antes de enviar: marca `sent_at` y solo envía quien lo marcó. Dos crons a la vez envían un solo mensaje
 *   aunque el gateway no deduplique por requestId.
 * - Una vez reservado no se reintenta: ni si WhatsApp lo rechaza (el mismo requestId daría el mismo rechazo) ni si es
 *   ambiguo (`unknown` o el envío lanza; pudo salir), como los cobros.
 * - Acotado: hasta 20 por ejecución, los más viejos primero; el resto sale en el cron siguiente. Un fallo en un aviso
 *   (de D1, por ejemplo) no corta los demás.
 */
export async function enviarAvisos(env: Env, ahora: number): Promise<number> {
  if (env.WHATSAPP_SEND_READY !== '1' && env.TEST_WHATSAPP_SIMULADO !== '1') return 0;
  if (!enFranja(ahora)) return 0;
  const { results } = await env.DB.prepare(
    `SELECT n.business_id AS id, n.kind, n.expires_at, b.whatsapp_phone AS telefono,
       b.suspended_at, b.free_forever_at, b.subscription_plan, b.subscription_expires_at, b.grace_unlock_ends_at
     FROM subscription_notices n JOIN businesses b ON b.id = n.business_id
     WHERE n.sent_at IS NULL AND n.created_at > ?1 AND n.expires_at = b.subscription_expires_at
       AND b.whatsapp_phone IS NOT NULL AND b.whatsapp_verified_at IS NOT NULL
     ORDER BY n.created_at LIMIT 20`,
  ).bind(ahora - 3 * DIA).all<Pendiente>();
  let enviados = 0;
  for (const a of results) {
    if (avisoQueToca(a, ahora) !== a.kind) continue;
    try {
      // Antes de reservar: si no hay gateway (encendido sin el real), el aviso queda pendiente en vez de perderse.
      const gateway = gatewayPara(env, () => ahora, a.id);
      const { meta } = await env.DB.prepare(
        'UPDATE subscription_notices SET sent_at = ?1 WHERE business_id = ?2 AND kind = ?3 AND expires_at = ?4 AND sent_at IS NULL',
      ).bind(ahora, a.id, a.kind, a.expires_at).run();
      if (meta.changes !== 1) continue; // otro cron lo reservó
      await gateway.sendTemplate({
        to: a.telefono, requestId: `aviso_vencimiento:${a.id}:${a.kind}:${a.expires_at}`, template: 'aviso_vencimiento', language: 'es_CO',
        variables: [QUE_PASA[a.kind], fecha.format(a.expires_at)], callbackData: 'aviso_vencimiento',
      }).catch(() => ({ status: 'unknown' as const }));
      enviados += 1;
    } catch (e) {
      // B5: sin teléfonos ni textos en los registros; solo qué aviso falló y el tipo de error.
      console.error('aviso_vencimiento_fallo', a.id, a.kind, e instanceof Error ? e.name : 'error');
    }
  }
  return enviados;
}
