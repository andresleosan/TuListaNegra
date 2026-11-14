// Enrutamiento de los entrantes (WAP-04, producto.md B4, «Enrutamiento de mensajes entrantes»).
// El paso 1 (firma válida y `wa_message_id` no repetido) ya lo hicieron el webhook y `guardarEventos`: aquí solo llegan
// entrantes sin enrutar (los nuevos y los que un fallo dejó a medias), y `marcar` impide decidir dos veces el mismo.
// Este módulo decide los pasos 2 a 6, en su orden, y deja el entrante enrutado y clasificado.
// Lo que viene después (verificar el código del dueño, comprobante, promesa, baja, aprobar o rechazar) es de WAP-02,
// WAP-05 y WAP-06: aquí no se interpreta el texto ni se escribe dinero (A1.3).
//
// Aislamiento: el negocio sale de datos nuestros (el saliente citado, el teléfono verificado del dueño, los salientes de
// las últimas 72 h) o del teléfono del remitente, que viene firmado. Nada de lo que escribe el remitente asigna un negocio:
// un `context.id` solo cuenta si es un saliente nuestro enviado a ese mismo teléfono, y un botón de elección solo si está
// entre los que le ofrecimos.
import type { REGLAS_ENRUTAMIENTO } from '../db/schema';
import { gatewayPara } from './index';
import { VENTANA_MS } from './simulado';

/** Paso 4: cuánto tiempo hacia atrás cuenta que un negocio le haya escrito a ese número (límite incluido). */
export const VENTANA_ENRUTAMIENTO_MS = 72 * 3_600_000;
/** Identificador de los botones de elección (molde `tln.v1:<accion>:<id>` de contrato-sarin.md, a). */
export const PREFIJO_ELEGIR = 'tln.v1:elegir:';
/** `callback_data` de los salientes del enrutador: sin datos personales. */
const CB_ELEGIR = 'elegir';
const CB_NEUTRO = 'neutro';
/** Paso 4: Meta fecha los entrantes en segundos; un saliente de ese mismo segundo cuenta como anterior. */
const DESFASE_META_MS = 1000;
/** America/Bogota es UTC−5 fijo (como en src/shared/contacto.ts). */
const DESFASE_BOGOTA_MS = 5 * 3_600_000;
const MAX_BOTONES = 3; // límite de botones de una respuesta (contrato-sarin.md, a)
const TITULO_MAX = 20;

export const TEXTO_ELEGIR = 'Hola. Varios comercios te han escrito por este número. ¿Para cuál es tu mensaje?';
export const TEXTO_NEUTRO = 'Hola. No encontramos una conversación tuya en este número. Si un comercio te escribió por aquí, responde directamente a su mensaje.';

type Regla = (typeof REGLAS_ENRUTAMIENTO)[number];
type Entrante = {
  id: string; wa_message_id: string; phone: string; kind: string; content_json: string; reply_to_wa_message_id: string | null;
  occurred_at: number; created_at: number;
};
type Candidato = { id: string; name: string };

export type Decision =
  | { estado: 'ROUTED'; regla: Regla; negocio: string; deudor: string | null; pregunta?: string }
  | { estado: 'AWAITING_TENANT_SELECTION'; candidatos: Candidato[] }
  | { estado: 'UNROUTED' };

/** El deudor de ese negocio: el que dice nuestro propio `callback_data` (`cobro:<id>`) o el único con ese teléfono. */
async function deudorDe(env: Env, negocio: string, telefono: string, callback: string | null): Promise<string | null> {
  const porCallback = callback?.startsWith('cobro:') ? callback.slice('cobro:'.length) : null;
  if (porCallback) {
    const d = await env.DB.prepare('SELECT id FROM debtors WHERE id = ?1 AND business_id = ?2').bind(porCallback, negocio).first<{ id: string }>();
    if (d) return d.id;
  }
  const { results } = await env.DB.prepare('SELECT id FROM debtors WHERE business_id = ?1 AND whatsapp_phone = ?2 AND archived_at IS NULL LIMIT 2')
    .bind(negocio, telefono).all<{ id: string }>();
  return results.length === 1 ? results[0]!.id : null; // dos deudores con el mismo teléfono: no se adivina
}

/** Paso 2 para un botón de elección: vale solo si es uno de los que ofrecimos en ese saliente. */
function eleccion(e: Entrante, botonesOfrecidos: string | null): string | null {
  if (e.kind !== 'button' || !botonesOfrecidos) return null;
  const { buttonId } = JSON.parse(e.content_json) as { buttonId?: string };
  const ofrecidos = (JSON.parse(botonesOfrecidos) as { id: string }[]).map((b) => b.id);
  return buttonId?.startsWith(PREFIJO_ELEGIR) && ofrecidos.includes(buttonId) ? buttonId.slice(PREFIJO_ELEGIR.length) : null;
}

/** Decide a qué negocio va un entrante, siguiendo los pasos 2 a 6 de B4 en su orden. Solo lee. */
export async function decidir(env: Env, e: Entrante): Promise<Decision> {
  // 2. Respuesta a un mensaje o botón nuestro → negocio y deudor exactos. Solo si el citado es un saliente nuestro a ESTE teléfono.
  if (e.reply_to_wa_message_id) {
    const citado = await env.DB.prepare(
      "SELECT id, business_id, callback_data, buttons_json FROM whatsapp_messages WHERE wa_message_id = ?1 AND direction = 'SALIENTE' AND phone = ?2",
    ).bind(e.reply_to_wa_message_id, e.phone).first<{ id: string; business_id: string | null; callback_data: string | null; buttons_json: string | null }>();
    if (citado?.business_id) {
      return { estado: 'ROUTED', regla: 'RESPUESTA', negocio: citado.business_id, deudor: await deudorDe(env, citado.business_id, e.phone, citado.callback_data) };
    }
    // Respuesta a nuestra pregunta del paso 5: el botón pulsado elige el negocio entre los ofrecidos.
    const elegido = citado?.callback_data === CB_ELEGIR ? eleccion(e, citado.buttons_json) : null;
    if (elegido) {
      return { estado: 'ROUTED', regla: 'ELECCION', negocio: elegido, deudor: await deudorDe(env, elegido, e.phone, null), pregunta: citado!.id };
    }
  }

  // 3. Teléfono VERIFICADO de un dueño → orden del dueño. Sin `whatsapp_verified_at` no cuenta (lo verifica WAP-02).
  const dueno = await env.DB.prepare('SELECT id FROM businesses WHERE whatsapp_phone = ?1 AND whatsapp_verified_at IS NOT NULL')
    .bind(e.phone).first<{ id: string }>();
  if (dueno) return { estado: 'ROUTED', regla: 'ORDEN_DUENO', negocio: dueno.id, deudor: null };

  // 4 y 5. Negocios que le escribieron a este número en las 72 h ANTERIORES al entrante (un envío rechazado o fallido no
  // llegó; uno posterior, como en una reentrega tardía, no es al que responde).
  const { results: candidatos } = await env.DB.prepare(
    `SELECT b.id, b.name FROM whatsapp_messages w JOIN businesses b ON b.id = w.business_id
     WHERE w.phone = ?1 AND w.direction = 'SALIENTE' AND w.status NOT IN ('rejected', 'failed') AND w.occurred_at >= ?2 AND w.occurred_at <= ?3
     GROUP BY b.id, b.name ORDER BY MAX(w.occurred_at) DESC`,
  ).bind(e.phone, e.occurred_at - VENTANA_ENRUTAMIENTO_MS, e.occurred_at + DESFASE_META_MS).all<Candidato>();
  if (candidatos.length === 1) {
    const negocio = candidatos[0]!.id;
    return { estado: 'ROUTED', regla: 'UNICO_72H', negocio, deudor: await deudorDe(env, negocio, e.phone, null) };
  }
  if (candidatos.length > 1) return { estado: 'AWAITING_TENANT_SELECTION', candidatos: candidatos.slice(0, MAX_BOTONES) };

  // 6. Desconocido.
  return { estado: 'UNROUTED' };
}

/*
 * Preguntas del paso 5. Cada pregunta que pudo llegar (no rechazada ni fallida) cubre un tramo de entrantes de ese
 * teléfono, por su `created_at`: desde que se cerró la anterior hasta que se cierra ella. Se cierra con la primera
 * elección válida o a las 24 h. Un entrante ambiguo sin pregunta abierta que lo cubra abre una nueva; la elección de una
 * pregunta solo enruta los entrantes de su tramo (así una pregunta vieja no se lleva mensajes de una posterior, que pudo
 * ofrecer otras tiendas), y un entrante que llega a una pregunta ya contestada se va con esa elección.
 */
type Pregunta = { id: string; occurred_at: number; respondida: number | null; elegido: string | null };
/** Elección válida de la pregunta `q`: un botón que cita `q`, desde su teléfono, y llevó a la tienda de ese botón. */
const RESPUESTA = `FROM whatsapp_messages r WHERE r.direction = 'ENTRANTE' AND r.phone = q.phone AND r.reply_to_wa_message_id = q.wa_message_id
  AND r.kind = 'button' AND r.routing_rule = 'ELECCION' AND json_extract(r.content_json, '$.buttonId') = '${PREFIJO_ELEGIR}' || r.business_id
  ORDER BY r.created_at, r.id LIMIT 1`;
const PREGUNTAS = `SELECT q.id, q.occurred_at, (SELECT r.created_at ${RESPUESTA}) AS respondida, (SELECT r.business_id ${RESPUESTA}) AS elegido
  FROM whatsapp_messages q WHERE q.phone = ?1 AND q.direction = 'SALIENTE' AND q.callback_data = '${CB_ELEGIR}' AND q.status NOT IN ('rejected', 'failed')`;
/** Último `created_at` (incluido) de los entrantes que cubre la pregunta. */
const cierre = (p: Pregunta) => Math.min(p.occurred_at + VENTANA_MS - 1, p.respondida ?? Infinity);

/** La pregunta que cubre un entrante creado en `creado`: la primera que no se había cerrado todavía. */
async function preguntaDe(env: Env, telefono: string, creado: number): Promise<Pregunta | undefined> {
  const { results } = await env.DB.prepare(`${PREGUNTAS} AND q.occurred_at > ?2 ORDER BY q.occurred_at, q.id`)
    .bind(telefono, creado - VENTANA_MS).all<Pregunta>();
  return results.find((p) => creado <= cierre(p));
}

/** Tramo de entrantes de la pregunta `id` para la elección hecha en `creado`; null si no es una pregunta que pudo llegar. */
async function tramoDe(env: Env, telefono: string, id: string, creado: number): Promise<{ desde: number; hasta: number } | null> {
  const q = await env.DB.prepare(`${PREGUNTAS} AND q.id = ?2`).bind(telefono, id).first<Pregunta>();
  if (!q) return null;
  const previa = await env.DB.prepare(`${PREGUNTAS} AND (q.occurred_at < ?2 OR (q.occurred_at = ?2 AND q.id < ?3)) ORDER BY q.occurred_at DESC, q.id DESC LIMIT 1`)
    .bind(telefono, q.occurred_at, q.id).first<Pregunta>();
  return { desde: previa ? cierre(previa) + 1 : 0, hasta: Math.min(cierre(q), creado) };
}

/**
 * `requestId` de una respuesta del enrutador: uno por teléfono y día de Bogotá, más un contador de los intentos de ese
 * día. Dos entrantes a la vez calculan la misma clave y el índice único de `request_id` deja un solo envío; tras un
 * intento rechazado (o una pregunta ya cerrada) la clave cambia y se puede volver a enviar.
 */
async function claveRespuesta(env: Env, tipo: typeof CB_ELEGIR | typeof CB_NEUTRO, telefono: string, ahora: number): Promise<string> {
  const prefijo = `${tipo}:${telefono}:${new Date(ahora - DESFASE_BOGOTA_MS).toISOString().slice(0, 10)}:`;
  const previos = await env.DB.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE phone = ?1 AND direction = 'SALIENTE' AND request_id LIKE ?2")
    .bind(telefono, `${prefijo}%`).first<{ n: number }>();
  return `${prefijo}${previos?.n ?? 0}`;
}

/** Marca el entrante solo si nadie lo enrutó antes (la sentencia; `changes` dice si la marcó esta llamada). */
function marcar(env: Env, id: string, d: Decision) {
  const enrutado = d.estado === 'ROUTED';
  return env.DB.prepare(
    'UPDATE whatsapp_messages SET routing_state = ?1, routing_rule = ?2, business_id = ?3, debtor_id = ?4 WHERE id = ?5 AND routing_state IS NULL',
  ).bind(d.estado, enrutado ? d.regla : null, enrutado ? d.negocio : null, enrutado ? d.deudor : null, id);
}

/** Enruta un entrante sin enrutar. Si otro proceso ya lo marcó, no hace nada. */
async function enrutarUno(env: Env, id: string, ahora: () => number): Promise<void> {
  const e = await env.DB.prepare(
    `SELECT id, wa_message_id, phone, kind, content_json, reply_to_wa_message_id, occurred_at, created_at FROM whatsapp_messages
     WHERE id = ?1 AND direction = 'ENTRANTE' AND routing_state IS NULL`,
  ).bind(id).first<Entrante>();
  if (!e) return;
  let d = await decidir(env, e);

  if (d.estado === 'ROUTED' && d.pregunta) {
    // La elección y los entrantes del tramo de su pregunta, en una sola transacción: o todo o nada (y se reintenta).
    // Si otro proceso ya marcó este botón, repetir el tramo no cambia nada: es la misma elección.
    const tramo = await tramoDe(env, e.phone, d.pregunta, e.created_at);
    await env.DB.batch([
      marcar(env, e.id, d),
      ...(tramo ? [env.DB.prepare(
        `UPDATE whatsapp_messages SET routing_state = 'ROUTED', routing_rule = 'ELECCION', business_id = ?1, debtor_id = ?2
         WHERE phone = ?3 AND direction = 'ENTRANTE' AND routing_state = 'AWAITING_TENANT_SELECTION' AND created_at BETWEEN ?4 AND ?5`,
      ).bind(d.negocio, d.deudor, e.phone, tramo.desde, tramo.hasta)] : []),
    ]);
    return;
  }

  const pregunta = d.estado === 'AWAITING_TENANT_SELECTION' ? await preguntaDe(env, e.phone, e.created_at) : undefined;
  if (pregunta?.elegido) {
    // Ya contestaron la pregunta que cubre este entrante: va con esa elección.
    d = { estado: 'ROUTED', regla: 'ELECCION', negocio: pregunta.elegido, deudor: await deudorDe(env, pregunta.elegido, e.phone, null) };
  }
  if ((await marcar(env, e.id, d).run()).meta.changes !== 1) return;

  if (d.estado === 'AWAITING_TENANT_SELECTION' && !pregunta) {
    await gatewayPara(env, ahora).sendReply({
      to: e.phone, requestId: await claveRespuesta(env, CB_ELEGIR, e.phone, ahora()), replyTo: e.wa_message_id, callbackData: CB_ELEGIR,
      content: { kind: 'buttons', text: TEXTO_ELEGIR, buttons: d.candidatos.map((n) => ({ id: `${PREFIJO_ELEGIR}${n.id}`, title: n.name.slice(0, TITULO_MAX) })) },
    });
  } else if (d.estado === 'UNROUTED') {
    // Respuesta neutra, sin datos; una sola por teléfono cada 24 h, para no contestar en bucle.
    const respondido = await env.DB.prepare(
      "SELECT 1 FROM whatsapp_messages WHERE phone = ?1 AND direction = 'SALIENTE' AND callback_data = ?2 AND status <> 'rejected' AND occurred_at >= ?3 LIMIT 1",
    ).bind(e.phone, CB_NEUTRO, ahora() - VENTANA_MS).first();
    if (respondido) return;
    await gatewayPara(env, ahora).sendReply({
      to: e.phone, requestId: await claveRespuesta(env, CB_NEUTRO, e.phone, ahora()), replyTo: e.wa_message_id, callbackData: CB_NEUTRO,
      content: { kind: 'text', text: TEXTO_NEUTRO },
    });
  }
}

/**
 * Enruta, uno por uno y en orden, los entrantes sin enrutar que devolvió `guardarEventos`. Un fallo en uno no corta los
 * demás: ese queda sin enrutar (lo retoma la reentrega de Meta o el siguiente mensaje de ese teléfono) o, si ya quedó en
 * espera sin que saliera la pregunta, la hace el siguiente mensaje ambiguo. Nada se registra en consola (B5).
 */
export async function enrutarEntrantes(env: Env, ids: string[], ahora: () => number = Date.now): Promise<void> {
  for (const id of ids) {
    try {
      await enrutarUno(env, id, ahora);
    } catch {
      // sigue con el siguiente
    }
  }
}
