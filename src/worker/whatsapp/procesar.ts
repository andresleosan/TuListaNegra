// Lo que escribe un DEUDOR (WAP-05, producto.md B4, fase 4): comprobante → abono pendiente, fecha de pago → propuesta
// que el deudor confirma con un botón, «SALIR» → baja. Corre justo después del enrutamiento (WAP-04), en el mismo `waitUntil`.
//
// Comprobante y fecha: solo entrantes ROUTED con negocio y deudor (reglas RESPUESTA, UNICO_72H y ELECCION). Las órdenes
// del dueño (ORDEN_DUENO) y aprobar o rechazar el abono son de WAP-06. El negocio y el deudor salen de lo que decidió
// el enrutador con datos nuestros, nunca del texto del mensaje.
// Baja sin un único deudor (UNROUTED, en espera de elección o ROUTED sin deudor): B6, lo más protector. El remitente
// viene firmado, así que la baja se aplica a TODOS los deudores con ese teléfono en las tiendas que ya le habían escrito
// (algún saliente a ese número); nunca a una tienda que no le escribió. La confirmación no nombra tiendas.
//
// A1.3: nada de lo que llega por WhatsApp se guarda en firme sin que una persona lo confirme con un toque.
// - Un comprobante crea un ABONO `PENDIENTE_VERIFICACION_WHATSAPP`, que no mueve el saldo (B3: el saldo solo cuenta
//   movimientos CONFIRMADO) y que el tendero aprueba o rechaza (WAP-06).
// - Una fecha reconocida no se guarda: se pregunta «¿Anotamos…? Sí / No» y solo el «Sí» de ese teléfono, citando esa
//   pregunta y con uno de los ids que ofrecimos, fija `promised_payment_date`.
//
// Idempotencia (un entrante repetido o reprocesado no hace nada dos veces):
// - comprobante: `request_id` = `wa:<wa_message_id>` (único por negocio; el disparador `ledger_no_replace` corta el repetido).
//   Además, la misma imagen (misma huella SHA-256) pendiente o confirmada en el negocio, de cualquier deudor, no crea otro.
// - baja: `wa_opt_out_at` solo se escribe la primera vez.
// - promesa: la pregunta y la confirmación son respuestas con clave propia; la segunda pulsación no cambia nada.
// - respuestas: `requestId` = `<tipo>:<id del entrante>`; el simulador (y el contrato) no envían dos veces la misma clave.
//
// Reintento: si algo falla (descarga, R2, D1), el siguiente evento del mismo teléfono reintenta, durante 7 días, los
// comprobantes y bajas que siguen sin efecto (sin movimiento ni respuesta registrada; deudor sin baja). Las fechas no se
// reintentan: una pregunta vieja podría llegar después de otra nueva.
import { MAX_CAPTURA_BYTES, tipoDeImagen } from '../pagos';
import { gatewayPara } from './index';
import { esBaja, fechaPrometida } from './promesa';

export const TEXTO_BAJA = 'Listo. No te enviaremos más recordatorios de cobro por este medio.';
export const TEXTO_NO_IMAGEN = 'No pudimos recibir ese archivo como comprobante. Si quieres enviar uno, mándalo como foto (JPG, PNG o WebP) de hasta 2 MB.';
/** Sin saldo, imagen ya recibida o demasiados pendientes: el mismo texto, que no dice cuál ni da datos. */
export const TEXTO_NO_REGISTRADO = 'Recibimos tu imagen, pero no la pudimos registrar como un comprobante nuevo. Si tienes dudas sobre tu pago, habla directamente con la tienda.';
/** Tope de abonos pendientes por deudor: por encima no se guarda la imagen ni se crea nada. */
export const MAX_PENDIENTES_POR_DEUDOR = 3;
/** Cuánto tiempo atrás se reintenta un comprobante o una baja que falló. */
export const REINTENTO_MS = 7 * 24 * 3_600_000;
/** Botones de la propuesta de fecha (molde `tln.v1:<accion>:<id>` de contrato-sarin.md, a). */
export const PREFIJO_PROMESA = 'tln.v1:promesa:';
export const PREFIJO_PROMESA_NO = 'tln.v1:promesa-no:';
/**
 * Monto sugerido (B4): sin lectura del comprobante (WAP-05 no usa IA), se sugiere el saldo del deudor al recibirlo, que
 * es lo máximo que admite un abono (B3). La descripción lo deja dicho; el monto se corrige mientras está pendiente.
 */
export const DESCRIPCION_COMPROBANTE = 'Comprobante por WhatsApp (monto sugerido: el saldo al recibirlo; verifícalo antes de aprobar)';

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DESFASE_BOGOTA_MS = 5 * 3_600_000;

/** El día en palabras («viernes 20 de noviembre»), sin montos ni datos. */
function enPalabras(inicioDia: number): string {
  const d = new Date(inicioDia - DESFASE_BOGOTA_MS);
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}
/** Propuesta de fecha que el deudor confirma con un botón. */
export const textoPregunta = (inicioDia: number) => `¿Anotamos que pagas el ${enPalabras(inicioDia)}?`;
/** Confirmación de la promesa, tras el «Sí». */
export const textoPromesa = (inicioDia: number) => `Anotamos tu fecha de pago: ${enPalabras(inicioDia)}.`;
/** AAAA-MM-DD del día de Bogotá que empieza en `inicioDia`. */
const isoDe = (inicioDia: number) => new Date(inicioDia - DESFASE_BOGOTA_MS).toISOString().slice(0, 10);

const REGLAS_DEUDOR = ['RESPUESTA', 'UNICO_72H', 'ELECCION'];
const SQL_REGLAS_DEUDOR = REGLAS_DEUDOR.map((r) => `'${r}'`).join(', ');
type Entrante = {
  id: string; wa_message_id: string; phone: string; kind: string; content_json: string; business_id: string | null; debtor_id: string | null;
  routing_state: string; routing_rule: string | null; reply_to_wa_message_id: string | null; occurred_at: number; created_at: number;
};
type DeDeudor = Entrante & { business_id: string; debtor_id: string };
const esDeDeudor = (e: Entrante): e is DeDeudor =>
  e.routing_state === 'ROUTED' && REGLAS_DEUDOR.includes(e.routing_rule ?? '') && e.business_id !== null && e.debtor_id !== null;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Respuesta dentro de la ventana de 24 h, en nombre de la tienda (si la hay). Una por entrante y tipo. */
function responder(env: Env, e: Entrante, ahora: () => number, tipo: string, texto: string, botones?: { id: string; title: string }[]) {
  return gatewayPara(env, ahora, e.business_id).sendReply({
    to: e.phone, requestId: `${tipo}:${e.id}`, replyTo: e.wa_message_id, callbackData: tipo,
    content: botones ? { kind: 'buttons', text: texto, buttons: botones } : { kind: 'text', text: texto },
  });
}

/** Abonos pendientes de un deudor (con los parámetros de su negocio y su id): los cuentan la lectura previa y el INSERT. */
const pendientes = (negocio: string, deudor: string) =>
  `(SELECT COUNT(*) FROM ledger_transactions WHERE business_id = ${negocio} AND debtor_id = ${deudor} AND status = 'PENDIENTE_VERIFICACION_WHATSAPP')`;

async function comprobante(env: Env, e: DeDeudor, ahora: () => number): Promise<void> {
  const { mediaId } = JSON.parse(e.content_json) as { mediaId?: string };
  const requestId = `wa:${e.wa_message_id}`;
  if (!mediaId) return;
  const ya = await env.DB.prepare('SELECT 1 FROM ledger_transactions WHERE business_id = ?1 AND request_id = ?2').bind(e.business_id, requestId).first();
  if (ya) return;
  // Sin saldo no cabe ningún abono (B3), y con el tope de pendientes tampoco: ni se descarga ni se guarda nada.
  const deudor = await env.DB.prepare(`SELECT current_balance_cop AS saldo, ${pendientes('?1', '?2')} AS pendientes FROM debtors WHERE id = ?2 AND business_id = ?1`)
    .bind(e.business_id, e.debtor_id).first<{ saldo: number; pendientes: number }>();
  if (!deudor) return;
  if (deudor.saldo <= 0 || deudor.pendientes >= MAX_PENDIENTES_POR_DEUDOR) {
    await responder(env, e, ahora, 'comprobante_no_registrado', TEXTO_NO_REGISTRADO);
    return;
  }

  const medio = await gatewayPara(env, ahora, e.business_id).fetchMedia(mediaId);
  const bytes = new Uint8Array(medio.bytes);
  // El tipo lo decide la firma de los bytes, no el `mimeType` que declara el remitente.
  const tipo = bytes.byteLength <= MAX_CAPTURA_BYTES ? tipoDeImagen(bytes) : null;
  if (!tipo) {
    await responder(env, e, ahora, 'comprobante_invalido', TEXTO_NO_IMAGEN);
    return;
  }

  // Clave por huella: la misma imagen ocupa un solo objeto y delata el comprobante reutilizado.
  const clave = `negocios/${e.business_id}/comprobantes/${hex(await crypto.subtle.digest('SHA-256', bytes))}.${tipo.ext}`;
  await env.ARCHIVOS.put(clave, bytes, { httpMetadata: { contentType: tipo.contentType } });
  let entro = false;
  try {
    // Una sola sentencia: el deudor es de este negocio, tiene saldo, no llegó al tope de pendientes y nadie del negocio
    // tiene ya un abono pendiente o confirmado con esta misma imagen.
    const { meta } = await env.DB.prepare(
      `INSERT INTO ledger_transactions (id, business_id, debtor_id, request_id, type, amount_cop, status, balance_after_cop,
         description, evidence_r2_key, due_date, created_at, confirmed_at, source)
       SELECT ?1, business_id, id, ?4, 'ABONO', current_balance_cop, 'PENDIENTE_VERIFICACION_WHATSAPP', NULL, ?5, ?6, NULL, ?7, NULL, 'WHATSAPP_BOT'
       FROM debtors
       WHERE id = ?3 AND business_id = ?2 AND current_balance_cop > 0 AND ${pendientes('?2', '?3')} < ?8 AND NOT EXISTS (
         SELECT 1 FROM ledger_transactions WHERE business_id = ?2 AND type = 'ABONO'
           AND status IN ('PENDIENTE_VERIFICACION_WHATSAPP', 'CONFIRMADO') AND evidence_r2_key = ?6)`,
    ).bind(`mov_${crypto.randomUUID().replaceAll('-', '')}`, e.business_id, e.debtor_id, requestId, DESCRIPCION_COMPROBANTE, clave, ahora(), MAX_PENDIENTES_POR_DEUDOR).run();
    entro = meta.changes === 1;
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('movimiento repetido'))) throw err;
    return; // otro proceso ya lo creó (y usa el objeto)
  }
  if (entro) return;
  // No entró: el objeto solo se queda si algún movimiento de este negocio lo usa como evidencia.
  const usado = await env.DB.prepare('SELECT 1 FROM ledger_transactions WHERE business_id = ?1 AND evidence_r2_key = ?2 LIMIT 1').bind(e.business_id, clave).first();
  if (!usado) await env.ARCHIVOS.delete(clave);
  await responder(env, e, ahora, 'comprobante_no_registrado', TEXTO_NO_REGISTRADO);
}

/**
 * Baja (B4, B6): desde aquí `puedeContactar` bloquea el cobro por enlace y por bot. La fecha, solo la primera vez.
 * Con un único deudor, solo ese. Si no, todos los deudores con ese teléfono en las tiendas que le habían escrito antes
 * de este mensaje (así un reintento no alcanza a una tienda que le escribió después).
 */
async function baja(env: Env, e: Entrante, ahora: () => number): Promise<void> {
  if (esDeDeudor(e)) {
    await env.DB.prepare('UPDATE debtors SET wa_opt_out_at = ?1 WHERE id = ?2 AND business_id = ?3 AND wa_opt_out_at IS NULL')
      .bind(ahora(), e.debtor_id, e.business_id).run();
  } else {
    await env.DB.prepare(
      `UPDATE debtors SET wa_opt_out_at = ?1 WHERE whatsapp_phone = ?2 AND wa_opt_out_at IS NULL AND business_id IN (
         SELECT business_id FROM whatsapp_messages WHERE direction = 'SALIENTE' AND phone = ?2 AND business_id IS NOT NULL AND created_at <= ?3)`,
    ).bind(ahora(), e.phone, e.created_at).run();
  }
  await responder(env, e, ahora, 'baja', TEXTO_BAJA);
}

/** Fecha reconocida → pregunta con botones; nada se guarda hasta el «Sí» (A1.3). Solo con saldo. */
async function proponerFecha(env: Env, e: DeDeudor, texto: string, ahora: () => number): Promise<void> {
  const dia = fechaPrometida(texto, e.occurred_at);
  if (dia === null) return;
  const conSaldo = await env.DB.prepare('SELECT 1 FROM debtors WHERE id = ?1 AND business_id = ?2 AND current_balance_cop > 0').bind(e.debtor_id, e.business_id).first();
  if (!conSaldo) return;
  await responder(env, e, ahora, 'promesa', textoPregunta(dia), [
    { id: `${PREFIJO_PROMESA}${e.id}:${isoDe(dia)}`, title: 'Sí' },
    { id: `${PREFIJO_PROMESA_NO}${e.id}`, title: 'No' },
  ]);
}

/**
 * «Sí» a una propuesta de fecha. Vale solo si cita NUESTRA pregunta a este teléfono y de este negocio, el id es uno de
 * los que ofrecimos en ella, el entrante que la originó es de este mismo deudor, el día sigue siendo futuro y hay saldo.
 * Una vez confirmada (hay respuesta `promesa_ok`), otra pulsación no cambia nada.
 */
async function confirmarFecha(env: Env, e: DeDeudor, ahora: () => number): Promise<void> {
  const { buttonId } = JSON.parse(e.content_json) as { buttonId?: string };
  const m = /^tln\.v1:promesa:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(buttonId ?? '');
  if (!m || e.routing_rule !== 'RESPUESTA' || !e.reply_to_wa_message_id) return;
  const [origen, iso] = [m[1]!, m[2]!];
  const pregunta = await env.DB.prepare(
    `SELECT q.buttons_json FROM whatsapp_messages q JOIN whatsapp_messages o ON o.id = ?4
     WHERE q.wa_message_id = ?1 AND q.direction = 'SALIENTE' AND q.phone = ?2 AND q.business_id = ?3 AND q.request_id = 'promesa:' || o.id
       AND o.direction = 'ENTRANTE' AND o.phone = ?2 AND o.business_id = ?3 AND o.debtor_id = ?5`,
  ).bind(e.reply_to_wa_message_id, e.phone, e.business_id, origen, e.debtor_id).first<{ buttons_json: string | null }>();
  const ofrecidos = pregunta?.buttons_json ? (JSON.parse(pregunta.buttons_json) as { id: string }[]).map((b) => b.id) : [];
  if (!ofrecidos.includes(buttonId!)) return;
  const dia = Date.parse(`${iso}T00:00:00-05:00`);
  if (!(dia > ahora()) || isoDe(dia) !== iso) return;
  // Solo si aún no se confirmó esta propuesta (la respuesta `promesa_ok:<origen>` lo marca) y hay saldo.
  const claveOk = `promesa_ok:${origen}`;
  const { meta } = await env.DB.prepare(
    `UPDATE debtors SET promised_payment_date = ?1 WHERE id = ?2 AND business_id = ?3 AND current_balance_cop > 0
       AND NOT EXISTS (SELECT 1 FROM whatsapp_messages WHERE request_id = ?4)`,
  ).bind(dia, e.debtor_id, e.business_id, claveOk).run();
  if (meta.changes !== 1) return;
  await gatewayPara(env, ahora, e.business_id).sendReply({
    to: e.phone, requestId: claveOk, replyTo: e.wa_message_id, callbackData: 'promesa_ok', content: { kind: 'text', text: textoPromesa(dia) },
  });
}

async function procesarUno(env: Env, id: string, ahora: () => number): Promise<void> {
  const e = await env.DB.prepare(
    `SELECT id, wa_message_id, phone, kind, content_json, business_id, debtor_id, routing_state, routing_rule, reply_to_wa_message_id,
       occurred_at, created_at
     FROM whatsapp_messages WHERE id = ?1 AND direction = 'ENTRANTE' AND routing_state IS NOT NULL`,
  ).bind(id).first<Entrante>();
  if (!e || e.routing_rule === 'ORDEN_DUENO') return;
  const texto = e.kind === 'text' ? (JSON.parse(e.content_json) as { text?: string }).text ?? '' : '';
  if (texto && esBaja(texto)) return baja(env, e, ahora);
  if (!esDeDeudor(e)) return;
  if (e.kind === 'image') await comprobante(env, e, ahora);
  else if (e.kind === 'text' && texto) await proponerFecha(env, e, texto, ahora);
  else if (e.kind === 'button') await confirmarFecha(env, e, ahora);
}

/**
 * Comprobantes y bajas de estos teléfonos, de los últimos 7 días, que siguen sin efecto: imagen de un deudor sin
 * movimiento `wa:<wa_message_id>` ni respuesta registrada; baja de un deudor que sigue sin `wa_opt_out_at`; baja sin
 * deudor único sin su respuesta. El texto de una baja es corto: el filtro de largo deja fuera la conversación normal.
 */
async function pendientesDeReintento(env: Env, ids: string[], ahora: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.kind, w.content_json FROM whatsapp_messages w
     WHERE w.direction = 'ENTRANTE' AND w.occurred_at >= ?2 AND w.routing_state IS NOT NULL AND w.routing_rule IS NOT 'ORDEN_DUENO'
       AND w.phone IN (SELECT phone FROM whatsapp_messages WHERE id IN (SELECT value FROM json_each(?1)))
       AND (
         (w.kind = 'image' AND w.routing_state = 'ROUTED' AND w.routing_rule IN (${SQL_REGLAS_DEUDOR}) AND w.debtor_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ledger_transactions l WHERE l.business_id = w.business_id AND l.request_id = 'wa:' || w.wa_message_id)
           AND NOT EXISTS (SELECT 1 FROM whatsapp_messages r WHERE r.request_id IN ('comprobante_invalido:' || w.id, 'comprobante_no_registrado:' || w.id)))
         OR (w.kind = 'text' AND length(json_extract(w.content_json, '$.text')) <= 60 AND (
           (w.routing_state = 'ROUTED' AND w.routing_rule IN (${SQL_REGLAS_DEUDOR}) AND w.debtor_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM debtors d WHERE d.id = w.debtor_id AND d.business_id = w.business_id AND d.wa_opt_out_at IS NULL))
           OR (NOT (w.routing_state = 'ROUTED' AND w.routing_rule IN (${SQL_REGLAS_DEUDOR}) AND w.debtor_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM whatsapp_messages r WHERE r.request_id = 'baja:' || w.id)))))
     ORDER BY w.created_at, w.id LIMIT 50`,
  ).bind(JSON.stringify(ids), ahora - REINTENTO_MS).all<{ id: string; kind: string; content_json: string }>();
  return results.filter((f) => f.kind === 'image' || esBaja((JSON.parse(f.content_json) as { text?: string }).text ?? '')).map((f) => f.id);
}

/**
 * Procesa los entrantes del lote (`ids`: los recién guardados y los que el enrutamiento acaba de dejar ROUTED), después
 * de reintentar, en orden de llegada, lo que falló antes en esos mismos teléfonos. Cada entrante en su propio intento:
 * un fallo en uno no corta los demás. Nada se registra en consola (B5).
 */
export async function procesarEntrantes(env: Env, ids: string[], ahora: () => number = Date.now): Promise<void> {
  if (ids.length === 0) return;
  let reintentos: string[] = [];
  try {
    reintentos = await pendientesDeReintento(env, ids, ahora());
  } catch {
    // sin reintentos esta vez; el lote sigue
  }
  for (const id of new Set([...reintentos, ...ids])) {
    try {
      await procesarUno(env, id, ahora);
    } catch {
      // sigue con el siguiente
    }
  }
}
