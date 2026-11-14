// Aprobar o rechazar un abono que llegó por WhatsApp (WAP-06, producto.md B4 «Doble aviso al dueño»). El comprobante
// crea un ABONO `PENDIENTE_VERIFICACION_WHATSAPP` (WAP-05, ./procesar.ts) que no mueve el saldo; aquí una persona lo
// confirma o lo rechaza con un toque (A1.3), desde la app (rutas/abonos.ts) o desde el WhatsApp VERIFICADO del dueño.
//
// El monto: sin IA nadie lee la imagen, así que el pendiente llega con el saldo completo como monto sugerido. Ningún
// camino confirma un monto que el dueño no haya visto, y por WhatsApp ninguno confirma en un solo paso ni con un monto
// que el dueño no escribió:
// - En la app ve la foto y el monto (editable) antes de tocar Aprobar, y la ruta recibe el monto final.
// - Por WhatsApp, el aviso no trae monto ni botón que confirme: «Escribir el monto» (solo explica cómo) y Rechazar.
// - `APROBAR <código> <monto>` no confirma: responde con UN botón final que nombra al deudor, su código y el monto
//   formateado (`tln.v1:aprobar:<mov>:<monto>`) y Cancelar. Solo ese botón, ofrecido en ese mensaje final a ese
//   teléfono y con ese mismo id, confirma. Con dos o tres pendientes del deudor, antes pregunta cuál (B4): elegir no
//   confirma, lleva al botón final. `APROBAR <código>` sin monto pide el monto. `RECHAZAR <código>` también pasa por
//   un botón final que nombra al deudor.
//
// Comprobado siempre en el servidor: el abono es del negocio, sigue pendiente, el monto cabe en el saldo de ESE momento
// y quien pulsa o escribe es el dueño con el teléfono VERIFICADO de ese negocio y permiso de escribir.
import { estadoEfectivo, PERMISOS } from '../../shared/acceso';
import { formatoCOP, MONTO_MAXIMO_COP } from '../../shared/dinero';
import type { businesses } from '../db/schema';
import { type Movimiento, SQL_MORA } from '../libro';
import { gatewayPara } from './index';

/** Botón final: aprueba ESE monto (el que escribió el dueño). Solo vale desde el mensaje final (`CB_CONFIRMAR`). */
export const PREFIJO_APROBAR = 'tln.v1:aprobar:';
/** Rechaza (el aviso o el mensaje final): rechazar no mueve dinero. */
export const PREFIJO_RECHAZAR = 'tln.v1:rechazar:';
/** Del aviso: solo explica cómo escribir el monto. */
export const PREFIJO_PEDIR_MONTO = 'tln.v1:abono-monto:';
/** Elección entre varios pendientes del mismo deudor: lleva al botón final, no confirma. */
export const PREFIJO_CUAL_APROBAR = 'tln.v1:abono-cual:';
export const PREFIJO_CUAL_RECHAZAR = 'tln.v1:rechazo-cual:';
export const PREFIJO_CANCELAR = 'tln.v1:cancelar:';
/** `callback_data` del mensaje final: el único desde el que un botón de aprobar vale. */
const CB_CONFIRMAR = 'dueno_confirmar';
/** Máximo de un título de botón (contrato-sarin.md, a). */
const TITULO_MAX = 20;
/** Marca de una sola transacción: un pendiente solo la lleva dentro del `db.batch` que lo aprueba (ver `aprobarAbono`). */
const MARCA = -1;
const PENDIENTE = 'PENDIENTE_VERIFICACION_WHATSAPP';
const DESFASE_BOGOTA_MS = 5 * 3_600_000;

export type ResultadoRevision =
  | { ok: true; movimiento: Movimiento }
  | { ok: false; error: 'no_encontrado' }
  | { ok: false; error: 'ya_revisado'; estado: Movimiento['status'] }
  | { ok: false; error: 'supera_saldo'; saldo: number };

const leer = (env: Env, negocio: string, id: string) =>
  env.DB.prepare("SELECT * FROM ledger_transactions WHERE id = ?1 AND business_id = ?2 AND type = 'ABONO'").bind(id, negocio).first<Movimiento>();

/**
 * Aprueba el pendiente con `monto` (entero, > 0, ≤ saldo de ese momento) en un solo `db.batch`: marca el pendiente,
 * baja el saldo, lo pasa a CONFIRMADO con su saldo corrido y recalcula la mora (la misma sentencia de ../libro.ts).
 * Cada paso exige la marca que puso el primero en ESTA transacción: si el primero no entró (ya revisado o supera el
 * saldo), nada cambia. Dos aprobaciones a la vez (o aprobar y rechazar): D1 las ejecuta una tras otra y la segunda ya
 * no encuentra el pendiente.
 */
export async function aprobarAbono(env: Env, negocio: string, id: string, monto: number, ahora: number): Promise<ResultadoRevision> {
  const previo = await leer(env, negocio, id);
  if (!previo) return { ok: false, error: 'no_encontrado' };
  if (previo.status !== PENDIENTE) return { ok: false, error: 'ya_revisado', estado: previo.status };
  if (!Number.isInteger(monto) || monto <= 0 || monto > MONTO_MAXIMO_COP) throw new Error('monto_invalido');
  const [, , confirmar] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ledger_transactions SET balance_after_cop = ?4
       WHERE id = ?1 AND business_id = ?2 AND type = 'ABONO' AND status = '${PENDIENTE}'
         AND EXISTS (SELECT 1 FROM debtors d WHERE d.id = ledger_transactions.debtor_id AND d.business_id = ?2 AND d.current_balance_cop >= ?3)`,
    ).bind(id, negocio, monto, MARCA),
    // Igual que un abono del mostrador: al quedar en cero, la promesa de pago se da por cumplida.
    env.DB.prepare(
      `UPDATE debtors SET current_balance_cop = current_balance_cop - ?3,
         promised_payment_date = CASE WHEN current_balance_cop - ?3 = 0 THEN NULL ELSE promised_payment_date END
       WHERE business_id = ?2 AND id = (SELECT debtor_id FROM ledger_transactions
         WHERE id = ?1 AND business_id = ?2 AND status = '${PENDIENTE}' AND balance_after_cop = ?4)`,
    ).bind(id, negocio, monto, MARCA),
    env.DB.prepare(
      `UPDATE ledger_transactions SET status = 'CONFIRMADO', amount_cop = ?3, confirmed_at = ?5,
         balance_after_cop = (SELECT current_balance_cop FROM debtors d WHERE d.id = ledger_transactions.debtor_id AND d.business_id = ?2)
       WHERE id = ?1 AND business_id = ?2 AND status = '${PENDIENTE}' AND balance_after_cop = ?4`,
    ).bind(id, negocio, monto, MARCA, ahora),
    env.DB.prepare(SQL_MORA).bind(previo.debtor_id, negocio, id),
  ]);
  const despues = (await leer(env, negocio, id))!;
  if (confirmar!.meta.changes === 1) return { ok: true, movimiento: despues };
  if (despues.status !== PENDIENTE) return { ok: false, error: 'ya_revisado', estado: despues.status };
  const deudor = await env.DB.prepare('SELECT current_balance_cop AS saldo FROM debtors WHERE id = ?1 AND business_id = ?2')
    .bind(despues.debtor_id, negocio).first<{ saldo: number }>();
  return { ok: false, error: 'supera_saldo', saldo: deudor?.saldo ?? 0 };
}

/** Rechaza el pendiente: pasa a RECHAZADO y el saldo no se toca. Una sola sentencia condicional. */
export async function rechazarAbono(env: Env, negocio: string, id: string): Promise<ResultadoRevision> {
  const { meta } = await env.DB.prepare(
    `UPDATE ledger_transactions SET status = 'RECHAZADO' WHERE id = ?1 AND business_id = ?2 AND type = 'ABONO' AND status = '${PENDIENTE}'`,
  ).bind(id, negocio).run();
  const despues = await leer(env, negocio, id);
  if (!despues) return { ok: false, error: 'no_encontrado' };
  return meta.changes === 1 ? { ok: true, movimiento: despues } : { ok: false, error: 'ya_revisado', estado: despues.status };
}

/** `14/11/2026 10:30`, hora de Bogotá. */
function fecha(ms: number, conAnio = true): string {
  const d = new Date(ms - DESFASE_BOGOTA_MS);
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${dos(d.getUTCDate())}/${dos(d.getUTCMonth() + 1)}${conAnio ? `/${d.getUTCFullYear()}` : ''} ${dos(d.getUTCHours())}:${dos(d.getUTCMinutes())}`;
}

type Deudor = { id: string; full_name: string; unique_code: string; whatsapp_phone: string | null; wa_consent_at: number | null; wa_opt_out_at: number | null; current_balance_cop: number };
const deudorDe = (env: Env, negocio: string, id: string) =>
  env.DB.prepare('SELECT id, full_name, unique_code, whatsapp_phone, wa_consent_at, wa_opt_out_at, current_balance_cop FROM debtors WHERE id = ?1 AND business_id = ?2')
    .bind(id, negocio).first<Deudor>();
type Tienda = Pick<typeof businesses.$inferSelect, 'id' | 'name' | 'payment_methods_info'>;

/** Texto de la tirilla (el mismo recibo que la ficha de la app comparte), sin datos que el deudor no conozca. */
export function textoTirilla(tienda: Tienda, deudor: Pick<Deudor, 'unique_code'>, m: Movimiento): string {
  const saldo = m.balance_after_cop ?? 0;
  return [
    tienda.name,
    `Recibo · Código ${deudor.unique_code}`,
    fecha(m.confirmed_at ?? m.created_at),
    `Saldo anterior: ${formatoCOP(saldo + m.amount_cop)}`,
    `Abono: ${formatoCOP(-m.amount_cop)}`,
    `Total: ${formatoCOP(saldo)}`,
    tienda.payment_methods_info ? `Medios de pago: ${tienda.payment_methods_info}` : null,
  ].filter(Boolean).join('\n');
}
export const textoRechazoDeudor = (tienda: string) =>
  `Revisamos el comprobante que enviaste y no lo pudimos registrar como pago. Si tienes dudas, habla directamente con ${tienda}.`;

/** Qué pasó con el mensaje al deudor tras aprobar (la tirilla) o rechazar (texto neutro). */
export type EnvioDeudor = 'enviado' | 'sin_telefono' | 'sin_permiso' | 'baja' | 'ventana_cerrada' | 'bot_apagado' | 'fallo' | 'sin_confirmar';

/**
 * Tirilla (aprobado) o texto neutro (rechazado) al deudor, como respuesta dentro de la ventana de 24 h: es un texto con
 * el formato de la tirilla, no una imagen (lo más simple: no hace falta dibujar ni guardar nada en R2). Solo con
 * consentimiento y sin baja (B6). Fuera de la ventana, Meta no deja enviarlo: queda en la app. Con el interruptor
 * apagado solo sale al simulador donde está habilitado a propósito (como el cobro por bot); si no, no se envía.
 *
 * Sin horario de cobro, a propósito (decidido en la revisión de WAP-06): no es un cobro sino la respuesta a un mensaje
 * que el propio deudor acaba de enviar (su comprobante), dentro de su ventana de 24 h. El horario de B6 (producto.md,
 * «Reglas de contacto») regula los cobros; el consentimiento y la baja, en cambio, se respetan aquí también.
 */
export async function avisarAlDeudor(env: Env, tienda: Tienda, m: Movimiento, ahora: () => number): Promise<EnvioDeudor> {
  if (env.WHATSAPP_SEND_READY !== '1' && env.TEST_WHATSAPP_SIMULADO !== '1') return 'bot_apagado';
  const d = await deudorDe(env, tienda.id, m.debtor_id);
  if (!d?.whatsapp_phone) return 'sin_telefono';
  if (d.wa_opt_out_at !== null) return 'baja';
  if (d.wa_consent_at === null) return 'sin_permiso';
  const aprobado = m.status === 'CONFIRMADO';
  try {
    const r = await gatewayPara(env, ahora, tienda.id).sendReply({
      to: d.whatsapp_phone, requestId: `${aprobado ? 'tirilla' : 'rechazo'}:${m.id}`, callbackData: aprobado ? 'tirilla' : 'rechazo',
      content: { kind: 'text', text: aprobado ? textoTirilla(tienda, d, m) : textoRechazoDeudor(tienda.name) },
    });
    return r.status === 'accepted' ? 'enviado' : r.status === 'unknown' ? 'sin_confirmar' : r.code === 'WINDOW_CLOSED' ? 'ventana_cerrada' : 'fallo';
  } catch {
    return 'fallo'; // p. ej. el interruptor encendido sin gateway real: el movimiento ya quedó; el mensaje no salió
  }
}

/**
 * Aviso por WhatsApp al dueño VERIFICADO al crearse un pendiente (el aviso en la app es la lista de pendientes). Dice de
 * quién es, que mire la foto en la app y cómo aprobar escribiendo el monto. Sin monto (el sugerido es el saldo, no lo
 * que dice la foto) ni botón que confirme: «Escribir el monto» solo lo explica, y Rechazar no mueve dinero. Sin
 * teléfono verificado, solo el aviso en la app.
 */
export async function avisarAlDueno(env: Env, negocio: string, id: string, ahora: () => number): Promise<void> {
  const f = await env.DB.prepare(
    `SELECT b.whatsapp_phone AS telefono, d.full_name, d.unique_code FROM ledger_transactions l
     JOIN businesses b ON b.id = l.business_id JOIN debtors d ON d.id = l.debtor_id AND d.business_id = l.business_id
     WHERE l.id = ?1 AND l.business_id = ?2 AND l.status = '${PENDIENTE}' AND b.whatsapp_phone IS NOT NULL AND b.whatsapp_verified_at IS NOT NULL`,
  ).bind(id, negocio).first<{ telefono: string; full_name: string; unique_code: string }>();
  if (!f) return;
  await gatewayPara(env, ahora, negocio).sendTemplate({
    to: f.telefono, requestId: `aviso_abono:${id}`, template: 'aviso_abono_pendiente', language: 'es_CO', callbackData: 'aviso_abono',
    variables: [f.full_name, f.unique_code],
    buttonPayloads: [`${PREFIJO_PEDIR_MONTO}${id}`, `${PREFIJO_RECHAZAR}${id}`],
  });
}

/* ───────────── Órdenes del dueño por WhatsApp ───────────── */

type AccionBoton = 'aprobar' | 'rechazar' | 'pedir_monto' | 'cual_aprobar' | 'cual_rechazar' | 'cancelar';
const ACCIONES: Record<string, AccionBoton> = {
  aprobar: 'aprobar', rechazar: 'rechazar', 'abono-monto': 'pedir_monto', 'abono-cual': 'cual_aprobar', 'rechazo-cual': 'cual_rechazar', cancelar: 'cancelar',
};
/** Las que llevan en el id el monto que escribió el dueño; las demás no llevan monto. */
const CON_MONTO: AccionBoton[] = ['aprobar', 'cual_aprobar'];

/**
 * Lo que el dueño puede pedir. Botones: los `PREFIJO_*` de arriba con el id del abono (y el monto, los de aprobar).
 * Texto: `APROBAR <código> [monto]` o `RECHAZAR <código>`; el código `TLN-0042`, `TLN0042` o de 4 a 6 cifras (`0042`;
 * nunca de 1 a 3, para que «2» no se lea como código) y el monto en pesos, con o sin puntos y signo (`50000`, `50.000`,
 * `$ 50.000`). Otro texto que empiece por APROBAR o RECHAZAR → `formato` (se le explica cómo escribirlo).
 */
export type Orden =
  | { tipo: 'boton'; accion: AccionBoton; id: string; monto: number | null; botonId: string }
  | { tipo: 'texto'; accion: 'aprobar' | 'rechazar'; codigo: string; monto: number | null }
  | { tipo: 'formato' };

const BOTON = /^tln\.v1:(aprobar|rechazar|abono-monto|abono-cual|rechazo-cual|cancelar):(mov_[0-9a-f]{32})(?::(\d{1,9}))?$/;
const TEXTO = /^(aprobar|rechazar)(?:\s+(.*))?$/i;
const ARGUMENTOS = /^(?:tln-?)?(\d{4,6})(?:\s+\$?\s*(\d{1,3}(?:\.\d{3})+|\d{1,9}))?$/i;
const valido = (monto: number) => monto > 0 && monto <= MONTO_MAXIMO_COP;

export function ordenDe(kind: string, content_json: string): Orden | null {
  const c = JSON.parse(content_json) as { text?: string; buttonId?: string };
  if (kind === 'button') {
    const m = BOTON.exec(c.buttonId ?? '');
    if (!m) return null;
    const accion = ACCIONES[m[1]!]!;
    const monto = m[3] === undefined ? null : Number(m[3]);
    if (CON_MONTO.includes(accion) !== (monto !== null) || (monto !== null && !valido(monto))) return null;
    return { tipo: 'boton', accion, id: m[2]!, monto, botonId: c.buttonId! };
  }
  if (kind !== 'text') return null;
  const t = TEXTO.exec((c.text ?? '').trim());
  if (!t) return null;
  const a = ARGUMENTOS.exec((t[2] ?? '').trim());
  const accion = t[1]!.toLowerCase() as 'aprobar' | 'rechazar';
  const monto = a?.[2] === undefined ? null : Number(a[2].replaceAll('.', ''));
  if (!a || (monto !== null && !valido(monto)) || (accion === 'rechazar' && monto !== null)) return { tipo: 'formato' };
  return { tipo: 'texto', accion, codigo: `TLN-${String(Number(a[1])).padStart(4, '0')}`, monto };
}

export const TEXTO_FORMATO = 'Para aprobar un comprobante, mira la foto en la app y escribe APROBAR, el código del deudor y lo que pagó según la foto, por ejemplo APROBAR TLN-0042 20000. Para rechazarlo: RECHAZAR TLN-0042.';
export const TEXTO_YA_REVISADO = 'Ese comprobante ya fue revisado. Mira la ficha del deudor en la app.';
export const TEXTO_SIN_PERMISO = 'Tu plan no permite anotar abonos ahora. Renueva tu pase en Suscripción, dentro de la app.';
const TEXTO_ENVIO: Record<EnvioDeudor, string> = {
  enviado: 'Le enviamos el mensaje por WhatsApp.',
  ventana_cerrada: 'No le pudimos escribir: pasaron más de 24 horas desde su último mensaje. Queda en la app.',
  sin_telefono: 'No le escribimos: no tiene WhatsApp anotado. Queda en la app.',
  sin_permiso: 'No le escribimos: no ha autorizado mensajes por WhatsApp. Queda en la app.',
  baja: 'No le escribimos: pidió no recibir mensajes. Queda en la app.',
  bot_apagado: 'No le escribimos: el bot de WhatsApp está apagado. Queda en la app.',
  fallo: 'No le pudimos escribir. Queda en la app.',
  sin_confirmar: 'No sabemos si le llegó el mensaje. Revisa la app.',
};
export const textoAprobado = (nombre: string, codigo: string, m: Movimiento, envio: EnvioDeudor) =>
  `Listo: aprobaste el abono de ${formatoCOP(m.amount_cop)} de ${nombre} (${codigo}). Saldo nuevo: ${formatoCOP(m.balance_after_cop ?? 0)}. Tirilla: ${TEXTO_ENVIO[envio]}`;
export const textoRechazado = (nombre: string, codigo: string, saldo: number, envio: EnvioDeudor) =>
  `Listo: rechazaste el comprobante de ${nombre} (${codigo}). Su saldo sigue en ${formatoCOP(saldo)}. Aviso al deudor: ${TEXTO_ENVIO[envio]}`;
export const textoSuperaSaldo = (monto: number, saldo: number, codigo: string) =>
  `No se aprobó: ${formatoCOP(monto)} es más de lo que debe hoy (${formatoCOP(saldo)}). Responde APROBAR ${codigo} y un monto de hasta ${formatoCOP(saldo)}.`;
export const textoSinPendientes = (codigo: string) => `${codigo} no tiene comprobantes por revisar.`;
export const textoCodigoDesconocido = (codigo: string) => `No encontramos el código ${codigo} en tu libro.`;
export const textoPedirMonto = (nombre: string, codigo: string) =>
  `¿Cuánto pagó ${nombre} (${codigo})? Mira la foto en la app y responde APROBAR ${codigo} y lo que pagó según la foto, por ejemplo APROBAR ${codigo} 20000.`;
export const textoCancelado = (nombre: string, codigo: string) => `No cambiamos nada: el comprobante de ${nombre} (${codigo}) sigue por revisar.`;

type Entrante = { id: string; wa_message_id: string; phone: string; kind: string; content_json: string; business_id: string | null };
/** Un abono pendiente con su deudor y el saldo de hoy. */
type Pendiente = { id: string; created_at: number; full_name: string; unique_code: string; saldo: number };
type Responder = (texto: string, botones?: { id: string; title: string }[], callbackData?: string) => Promise<unknown>;
const SQL_PENDIENTE = `SELECT l.id, l.created_at, d.full_name, d.unique_code, d.current_balance_cop AS saldo FROM ledger_transactions l
  JOIN debtors d ON d.id = l.debtor_id AND d.business_id = l.business_id
  WHERE l.business_id = ?1 AND l.type = 'ABONO' AND l.status = '${PENDIENTE}'`;
/** Opciones de una lista: letras, que no se leen como un código ni como un monto. */
const LETRAS = ['A', 'B', 'C'];

/**
 * Atiende una orden de un entrante enrutado a un negocio (orden del dueño o respuesta a un mensaje nuestro). Devuelve
 * false, sin responder nada, si quien escribe no es el dueño con el teléfono VERIFICADO de ese negocio (./procesar.ts
 * sigue entonces con el flujo de deudor). Una respuesta por entrante.
 */
export async function atenderDueno(env: Env, e: Entrante, orden: Orden, ahora: () => number): Promise<boolean> {
  if (!e.business_id) return false;
  const n = await env.DB.prepare('SELECT * FROM businesses WHERE id = ?1 AND whatsapp_phone = ?2 AND whatsapp_verified_at IS NOT NULL')
    .bind(e.business_id, e.phone).first<typeof businesses.$inferSelect>();
  if (!n) return false;
  const gateway = gatewayPara(env, ahora, n.id);
  const responder: Responder = (text, botones, callbackData = 'dueno') =>
    gateway.sendReply({
      to: e.phone, requestId: `dueno:${e.id}`, replyTo: e.wa_message_id, callbackData,
      content: botones ? { kind: 'buttons', text, buttons: botones } : { kind: 'text', text },
    });
  if (orden.tipo === 'formato') await responder(TEXTO_FORMATO);
  else if (!PERMISOS[estadoEfectivo(n, ahora())].escribir) await responder(TEXTO_SIN_PERMISO);
  else if (orden.tipo === 'boton') await boton(env, n, e.phone, orden, ahora, responder);
  else await texto(env, n, orden, responder);
  return true;
}

async function boton(env: Env, n: Tienda, telefono: string, orden: Extract<Orden, { tipo: 'boton' }>, ahora: () => number, responder: Responder) {
  // El botón vale solo si se lo ofrecimos a este teléfono en nombre de este negocio, con este mismo id (y monto); el que
  // aprueba, además, solo desde el mensaje final.
  const ofrecido = await env.DB.prepare(
    `SELECT 1 FROM whatsapp_messages w, json_each(w.buttons_json) j
     WHERE w.direction = 'SALIENTE' AND w.phone = ?1 AND w.business_id = ?2 AND w.buttons_json IS NOT NULL
       AND (?4 IS NULL OR w.callback_data = ?4)
       AND (CASE j.type WHEN 'object' THEN json_extract(j.value, '$.id') ELSE j.value END) = ?3 LIMIT 1`,
  ).bind(telefono, n.id, orden.botonId, orden.accion === 'aprobar' ? CB_CONFIRMAR : null).first();
  if (!ofrecido) return;
  if (orden.accion === 'aprobar' || orden.accion === 'rechazar') return revisar(env, n, orden.accion, orden.id, orden.monto ?? 0, ahora, responder);
  const p = await env.DB.prepare(`${SQL_PENDIENTE} AND l.id = ?2`).bind(n.id, orden.id).first<Pendiente>();
  if (!p) return responder(TEXTO_YA_REVISADO);
  if (orden.accion === 'pedir_monto') return responder(textoPedirMonto(p.full_name, p.unique_code));
  if (orden.accion === 'cancelar') return responder(textoCancelado(p.full_name, p.unique_code));
  return ofrecerFinal(p, orden.accion === 'cual_aprobar' ? 'aprobar' : 'rechazar', orden.monto, responder);
}

async function texto(env: Env, n: Tienda, orden: Extract<Orden, { tipo: 'texto' }>, responder: Responder) {
  const d = await env.DB.prepare('SELECT id, full_name, unique_code, current_balance_cop AS saldo FROM debtors WHERE business_id = ?1 AND unique_code = ?2')
    .bind(n.id, orden.codigo).first<{ id: string; full_name: string; unique_code: string; saldo: number }>();
  if (!d) return responder(textoCodigoDesconocido(orden.codigo));
  const { results: pendientes } = await env.DB.prepare(`${SQL_PENDIENTE} AND l.debtor_id = ?2 ORDER BY l.created_at, l.id LIMIT 3`)
    .bind(n.id, d.id).all<Pendiente>();
  if (pendientes.length === 0) return responder(textoSinPendientes(d.unique_code));
  // Sin monto escrito no hay nada que aprobar: el sugerido es el saldo, no lo que dice la foto.
  if (orden.accion === 'aprobar' && orden.monto === null) return responder(textoPedirMonto(d.full_name, d.unique_code));
  if (orden.accion === 'aprobar' && orden.monto! > d.saldo) return responder(textoSuperaSaldo(orden.monto!, d.saldo, d.unique_code));
  if (pendientes.length === 1) return ofrecerFinal(pendientes[0]!, orden.accion, orden.monto, responder);

  // Varios: primero cuál. Elegir no confirma: lleva al botón final de ese comprobante.
  const aprobar = orden.accion === 'aprobar';
  const lineas = pendientes.map((p, i) => `${LETRAS[i]}. Recibido el ${fecha(p.created_at, false)}`);
  const pregunta = aprobar ? `¿A cuál corresponde el abono de ${formatoCOP(orden.monto!)}?` : '¿Cuál quieres rechazar?';
  await responder(
    `${d.full_name} (${d.unique_code}) tiene ${pendientes.length} comprobantes por revisar:\n${lineas.join('\n')}\n${pregunta} Mira las fotos en la app.`,
    pendientes.map((p, i) => ({
      id: aprobar ? `${PREFIJO_CUAL_APROBAR}${p.id}:${orden.monto}` : `${PREFIJO_CUAL_RECHAZAR}${p.id}`, title: `Comprobante ${LETRAS[i]}`,
    })),
  );
}

/** El paso final: UN botón que aprueba ESE monto (o rechaza) ESE comprobante, con el deudor y su código a la vista, y Cancelar. */
function ofrecerFinal(p: Pendiente, accion: 'aprobar' | 'rechazar', monto: number | null, responder: Responder) {
  const cancelar = { id: `${PREFIJO_CANCELAR}${p.id}`, title: 'Cancelar' };
  const recibido = fecha(p.created_at, false);
  if (accion === 'rechazar') {
    return responder(
      `¿Rechazar el comprobante de ${p.full_name} (${p.unique_code}) que envió el ${recibido}? Su saldo no cambia.`,
      [{ id: `${PREFIJO_RECHAZAR}${p.id}`, title: 'Sí, rechazar' }, cancelar], CB_CONFIRMAR,
    );
  }
  const m = monto!;
  if (m > p.saldo) return responder(textoSuperaSaldo(m, p.saldo, p.unique_code));
  // El título lleva el monto formateado («Aprobar $ 20»); el nombre y el código no caben en 20 caracteres: van en el texto.
  const titulo = `Aprobar ${formatoCOP(m)}`;
  return responder(
    `¿Aprobar ${formatoCOP(m)} a ${p.full_name} (${p.unique_code})? Es por el comprobante que envió el ${recibido}. Su saldo pasa de ${formatoCOP(p.saldo)} a ${formatoCOP(p.saldo - m)}. Si el monto no es el de la foto, toca Cancelar.`,
    [{ id: `${PREFIJO_APROBAR}${p.id}:${m}`, title: titulo.length <= TITULO_MAX ? titulo : 'Sí, aprobar' }, cancelar], CB_CONFIRMAR,
  );
}

async function revisar(
  env: Env, n: Tienda, accion: 'aprobar' | 'rechazar', id: string, monto: number, ahora: () => number, responder: Responder,
): Promise<void> {
  const r = accion === 'aprobar' ? await aprobarAbono(env, n.id, id, monto, ahora()) : await rechazarAbono(env, n.id, id);
  if (!r.ok) {
    if (r.error === 'no_encontrado') return;
    if (r.error === 'ya_revisado') return void (await responder(TEXTO_YA_REVISADO));
    const d = await env.DB.prepare('SELECT d.unique_code FROM ledger_transactions l JOIN debtors d ON d.id = l.debtor_id AND d.business_id = l.business_id WHERE l.id = ?1 AND l.business_id = ?2')
      .bind(id, n.id).first<{ unique_code: string }>();
    return void (await responder(textoSuperaSaldo(monto, r.saldo, d!.unique_code)));
  }
  const envio = await avisarAlDeudor(env, n, r.movimiento, ahora);
  const d = (await deudorDe(env, n.id, r.movimiento.debtor_id))!;
  await responder(r.movimiento.status === 'CONFIRMADO'
    ? textoAprobado(d.full_name, d.unique_code, r.movimiento, envio)
    : textoRechazado(d.full_name, d.unique_code, d.current_balance_cop, envio));
}
