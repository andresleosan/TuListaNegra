// Verificación del teléfono del dueño (WAP-02, producto.md B4: «El teléfono del dueño se verifica con un código antes de
// aceptar órdenes desde él»; contrato-sarin.md d.9). La app emite un código corto; el dueño lo envía por WhatsApp desde
// el número de su tienda. Sin `whatsapp_verified_at`, el paso 3 de ./enrutar.ts no toma sus mensajes como órdenes.
//
// - La base guarda solo la huella SHA-256 del código (con el id del negocio), su vencimiento y los intentos fallidos.
// - Emitir uno nuevo pisa la huella: el anterior deja de servir. Uno cada `ESPERA_CODIGO_MS` por negocio.
// - El entrante cuenta solo si su remitente (firmado por Meta) es el `whatsapp_phone` de un negocio sin verificar con un
//   código pendiente: el negocio sale de ese teléfono, nunca de lo que diga el texto. La huella se compara en tiempo
//   constante; vencido o con `MAX_INTENTOS_CODIGO` fallos, ni el correcto verifica.
// - Idempotente: ./enrutar.ts lo marca VERIFICACION antes de llamar aquí, y solo la llamada que lo marcó lo procesa.
import { gatewayPara } from './index';

export const VIGENCIA_CODIGO_MS = 10 * 60_000;
export const ESPERA_CODIGO_MS = 30_000;
export const MAX_INTENTOS_CODIGO = 5;

export const TEXTO_VERIFICADO = 'Listo: este número quedó verificado como el WhatsApp de tu tienda.';
export const TEXTO_CODIGO_NO_VALE = 'Ese código no sirve: está mal escrito, venció o tuvo demasiados intentos. Pide uno nuevo en Ajustes de la app.';

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const huella = async (negocio: string, codigo: string) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tln.v1:verificacion:${negocio}:${codigo}`)));

/** Compara dos huellas sin cortar en la primera diferencia. */
function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false; // las dos son SHA-256 en hex: el largo no dice nada
  let distinto = 0;
  for (let i = 0; i < a.length; i++) distinto |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return distinto === 0;
}

/** Seis dígitos uniformes (sin sesgo de módulo: 4.294.000.000 es múltiplo de un millón). */
function nuevoCodigo(): string {
  const n = new Uint32Array(1);
  do crypto.getRandomValues(n);
  while (n[0]! >= 4_294_000_000);
  return String(n[0]! % 1_000_000).padStart(6, '0');
}

/** El código que trae un texto («482913», « 482 913 »), o null. */
export const codigoDe = (texto: string) => {
  const limpio = texto.replace(/\s/g, '');
  return /^\d{6}$/.test(limpio) ? limpio : null;
};

/**
 * Emite un código para el negocio (sin verificar y con teléfono; lo comprueba la ruta). Una sola sentencia: pisa el
 * anterior y reinicia los intentos, salvo que el anterior se haya emitido hace menos de `ESPERA_CODIGO_MS` (null).
 */
export async function emitirCodigo(env: Env, negocio: string, ahora: number): Promise<{ codigo: string; vence_en: number } | null> {
  const codigo = nuevoCodigo();
  const vence = ahora + VIGENCIA_CODIGO_MS;
  const { meta } = await env.DB.prepare(
    `UPDATE businesses SET whatsapp_code_hash = ?1, whatsapp_code_expires_at = ?2, whatsapp_code_attempts = 0
     WHERE id = ?3 AND whatsapp_verified_at IS NULL AND whatsapp_phone IS NOT NULL
       AND (whatsapp_code_expires_at IS NULL OR whatsapp_code_expires_at <= ?4)`,
  ).bind(await huella(negocio, codigo), vence, negocio, vence - ESPERA_CODIGO_MS).run();
  return meta.changes === 1 ? { codigo, vence_en: vence } : null;
}

/**
 * El negocio sin verificar cuyo teléfono es `telefono` y que tiene un código VIGENTE y con intentos (para el enrutador).
 * Un código vencido o agotado ya no desvía los mensajes de 6 dígitos de ese teléfono: siguen los pasos 4 a 6 (p. ej. un
 * monto que esa persona escribe como deudora de otra tienda).
 */
export const pendienteDe = (env: Env, telefono: string, en: number) =>
  env.DB.prepare(
    `SELECT id FROM businesses WHERE whatsapp_phone = ?1 AND whatsapp_verified_at IS NULL AND whatsapp_code_hash IS NOT NULL
       AND whatsapp_code_expires_at > ?2 AND whatsapp_code_attempts < ?3`,
  ).bind(telefono, en, MAX_INTENTOS_CODIGO).first<{ id: string }>();

type Entrante = { id: string; wa_message_id: string; phone: string; content_json: string };

/** Comprueba el código de un entrante ya marcado VERIFICACION y responde con un texto neutro. */
export async function verificarCodigo(env: Env, e: Entrante, ahora: () => number): Promise<void> {
  const codigo = codigoDe((JSON.parse(e.content_json) as { text?: string }).text ?? '');
  const n = await env.DB.prepare(
    `SELECT id, whatsapp_code_hash AS hash, whatsapp_code_expires_at AS vence, whatsapp_code_attempts AS intentos FROM businesses
     WHERE whatsapp_phone = ?1 AND whatsapp_verified_at IS NULL AND whatsapp_code_hash IS NOT NULL`,
  ).bind(e.phone).first<{ id: string; hash: string; vence: number; intentos: number }>();
  if (!codigo || !n) return;
  const t = ahora();
  let verificado = false;
  if (iguales(await huella(n.id, codigo), n.hash) && n.vence > t && n.intentos < MAX_INTENTOS_CODIGO) {
    // Las mismas condiciones en la sentencia: si otro entrante cambió algo entretanto, no verifica.
    const { meta } = await env.DB.prepare(
      `UPDATE businesses SET whatsapp_verified_at = ?1, whatsapp_code_hash = NULL, whatsapp_code_expires_at = NULL, whatsapp_code_attempts = 0
       WHERE id = ?2 AND whatsapp_phone = ?3 AND whatsapp_verified_at IS NULL AND whatsapp_code_hash = ?4
         AND whatsapp_code_expires_at > ?1 AND whatsapp_code_attempts < ?5`,
    ).bind(t, n.id, e.phone, n.hash, MAX_INTENTOS_CODIGO).run();
    verificado = meta.changes === 1;
  } else {
    await env.DB.prepare('UPDATE businesses SET whatsapp_code_attempts = whatsapp_code_attempts + 1 WHERE id = ?1 AND whatsapp_code_hash = ?2')
      .bind(n.id, n.hash).run();
  }
  // Sin negocio en el envío: es la respuesta del bot, no un mensaje de la tienda (no cuenta para el paso 4).
  await gatewayPara(env, ahora).sendReply({
    to: e.phone, requestId: `verificacion:${e.id}`, replyTo: e.wa_message_id, callbackData: 'verificacion',
    content: { kind: 'text', text: verificado ? TEXTO_VERIFICADO : TEXTO_CODIGO_NO_VALE },
  });
}
