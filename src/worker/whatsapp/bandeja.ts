// Guarda en `whatsapp_messages` lo que llega por el webhook, ya con la firma comprobada (contrato-sarin.md, b.6).
import { nuevoId } from '../../shared/ids';
import type { SarinEvent } from './tipos';

/** Entrantes fechados más de 5 min en el futuro se descartan (referencia). */
export const FUTURO_MAX_MS = 5 * 60_000;

/** Orden de los estados: uno nuevo solo se aplica si avanza. `read` y `failed` son finales. */
const RANGO = { sent: 1, delivered: 2, read: 3, failed: 3 } as const;
const RANGO_ACTUAL = "(CASE status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN 3 ELSE 0 END)";

const contenido = (e: Exclude<SarinEvent, { kind: 'status' }>) =>
  e.kind === 'text' ? { text: e.text }
    : e.kind === 'button' ? { buttonId: e.buttonId, title: e.title }
    : { mediaId: e.mediaId, mimeType: e.mimeType, sha256: e.sha256, caption: e.caption };

/**
 * Inserta los entrantes por `wa_message_id` (si ya existía, no pasa nada) y aplica los estados a los salientes.
 * Todo en una transacción. Devuelve los ids de los entrantes por enrutar de los teléfonos de este lote: los nuevos y
 * los que siguen sin enrutar porque un fallo los dejó a medias (una reentrega de Meta o el siguiente mensaje de ese
 * teléfono los retoma). Uno ya enrutado no vuelve.
 */
export async function guardarEventos(env: Env, eventos: SarinEvent[], ahora: number): Promise<string[]> {
  const consultas = eventos.flatMap((e) => {
    if (e.kind === 'status') {
      return [env.DB.prepare(
        `UPDATE whatsapp_messages SET status = ?1, error_code = ?2, status_updated_at = ?3
         WHERE wa_message_id = ?4 AND direction = 'SALIENTE' AND ${RANGO_ACTUAL} < ?5`,
      ).bind(e.status, e.status === 'failed' && e.errorCode !== undefined ? String(e.errorCode) : null, ahora, e.waMessageId, RANGO[e.status])];
    }
    if (e.occurredAt > ahora + FUTURO_MAX_MS) return [];
    // Un entrante ya nos llegó: su estado es `delivered`. Repetido → ON CONFLICT no hace nada.
    return [env.DB.prepare(
      `INSERT INTO whatsapp_messages (id, direction, wa_message_id, phone, phone_number_id, kind, content_json, reply_to_wa_message_id, status, occurred_at, created_at)
       VALUES (?1, 'ENTRANTE', ?2, ?3, ?4, ?5, ?6, ?7, 'delivered', ?8, ?9)
       ON CONFLICT (wa_message_id) DO NOTHING`,
    ).bind(nuevoId('wam', ahora), e.waMessageId, e.from, e.phoneNumberId, e.kind, JSON.stringify(contenido(e)), e.replyToWaMessageId ?? null, e.occurredAt, ahora)];
  });
  const telefonos = [...new Set(eventos.flatMap((e) => (e.kind === 'status' ? [] : [e.from])))];
  const porEnrutar = telefonos.length === 0 ? [] : [env.DB.prepare(
    `SELECT id FROM whatsapp_messages WHERE direction = 'ENTRANTE' AND routing_state IS NULL
     AND phone IN (${telefonos.map((_, i) => `?${i + 1}`).join(', ')}) ORDER BY created_at, id`,
  ).bind(...telefonos)];
  if (consultas.length + porEnrutar.length === 0) return [];
  const resultados = await env.DB.batch<{ id: string }>([...consultas, ...porEnrutar]);
  return porEnrutar.length === 0 ? [] : resultados.at(-1)!.results.map((f) => f.id);
}
