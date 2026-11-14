// Panel del puente de WhatsApp en la consola (WAP-08, producto.md B4): «salud del webhook, último evento firmado y envío
// de prueba solo al teléfono verificado del propio superadministrador».
//
// El estado no lleva secretos (solo si están puestos), ni teléfonos, ni textos, ni negocios: solo fechas y cuentas.
// «Evento firmado» = lo que el webhook aceptó tras comprobar la firma: un entrante guardado o un estado aplicado a un
// envío nuestro (`status_updated_at` solo lo escribe ./bandeja.ts, que corre después de la firma).
//
// Salud, en este orden (la primera que se cumple):
// 1. `sin_configurar`: el gateway actual no puede comprobar firmas. Con el simulador, falta el secreto de la app o no es
//    de desarrollo (./simulado.ts rechaza uno real a propósito, A1.6); con el envío real, `gatewayPara` no puede armar el
//    gateway de Meta (falta algo o hay un secreto de desarrollo). En los dos casos el webhook responde 401 a todo.
// 2. `atencion`: en las últimas 24 h, de `MUESTRA_MINIMA` envíos en adelante, 1 de cada 4 o más se rechazó o falló; o, de
//    `MUESTRA_MINIMA` entrantes en adelante, la mitad o más quedó sin enrutar (nadie sabe de qué tienda son).
// 3. `sin_eventos`: ningún evento firmado en las últimas 24 h.
// 4. `ok`: hubo eventos firmados en las últimas 24 h y nada de lo anterior.
import type { ESTADOS_WA } from '../db/schema';
import { gatewayPara } from './index';
import { PREFIJO_DEV } from './simulado';
import type { NombrePlantilla } from './tipos';

export const VENTANA_SALUD_MS = 24 * 3_600_000;
export const MUESTRA_MINIMA = 3;
/** Una prueba por minuto y por superadministrador. */
export const ESPERA_PRUEBA_MS = 60_000;
/** Pruebas por teléfono en 24 h. */
export const MAX_PRUEBAS_DIA = 10;
const PLANTILLA_PRUEBA: NombrePlantilla = 'prueba_puente';
const MARCA_PRUEBA = 'prueba-puente'; // callback_data: sin datos personales, vuelve en los estados

type EstadoWa = (typeof ESTADOS_WA)[number];
export type Salud = 'sin_configurar' | 'atencion' | 'sin_eventos' | 'ok';
type Cuentas = { configurado: boolean; evento_reciente: boolean; entrantes: number; sin_enrutar: number; salientes: Record<EstadoWa, number> };

export function saludDe(d: Cuentas): Salud {
  if (!d.configurado) return 'sin_configurar';
  const enviados = Object.values(d.salientes).reduce((a, b) => a + b, 0);
  // `unknown`: Meta no confirmó (timeout, 5xx). Si todos quedan así, el puente no está sano aunque nada se haya rechazado.
  const fallidos = d.salientes.rejected + d.salientes.failed + d.salientes.unknown;
  if (enviados >= MUESTRA_MINIMA && fallidos * 4 >= enviados) return 'atencion';
  if (d.entrantes >= MUESTRA_MINIMA && d.sin_enrutar * 2 >= d.entrantes) return 'atencion';
  return d.evento_reciente ? 'ok' : 'sin_eventos';
}

/** Con el simulador solo vale un secreto de desarrollo; con el gateway real, solo uno que no lo sea. Nunca se devuelve el valor. */
function puesto(env: Env, valor: string | undefined): boolean {
  if (!valor) return false;
  const deDesarrollo = valor.startsWith(PREFIJO_DEV);
  return env.WHATSAPP_SEND_READY === '1' ? !deDesarrollo : deDesarrollo;
}

/** El gateway real comprueba toda su configuración al armarse (y lanza si falta algo): se le pregunta a él. */
function gatewayListo(env: Env): boolean {
  try {
    gatewayPara(env);
    return true;
  } catch {
    return false;
  }
}

// ponytail: recorre whatsapp_messages sin índice por fecha; si la tabla crece, índice en (direction, created_at).
export async function estadoPuente(env: Env, ahora: number) {
  const desde = ahora - VENTANA_SALUD_MS;
  const [totales, porEstado, ultimo] = await env.DB.batch<Record<string, number | string | null>>([
    env.DB.prepare(
      `SELECT MAX(IIF(direction = 'ENTRANTE', created_at, NULL)) AS ultimo_entrante,
         MAX(IIF(direction = 'SALIENTE', status_updated_at, NULL)) AS ultimo_estado,
         COALESCE(SUM(direction = 'ENTRANTE' AND created_at >= ?1), 0) AS entrantes,
         COALESCE(SUM(direction = 'ENTRANTE' AND created_at >= ?1 AND routing_state = 'UNROUTED'), 0) AS sin_enrutar,
         COALESCE(SUM(direction = 'ENTRANTE' AND created_at >= ?1 AND routing_state = 'AWAITING_TENANT_SELECTION'), 0) AS en_eleccion
       FROM whatsapp_messages`,
    ).bind(desde),
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM whatsapp_messages WHERE direction = 'SALIENTE' AND created_at >= ?1 GROUP BY status`).bind(desde),
    env.DB.prepare(`SELECT created_at AS en, status AS estado FROM whatsapp_messages WHERE direction = 'SALIENTE' ORDER BY created_at DESC, id DESC LIMIT 1`),
  ]);
  const t = totales!.results[0] as { ultimo_entrante: number | null; ultimo_estado: number | null; entrantes: number; sin_enrutar: number; en_eleccion: number };
  const salientes: Record<EstadoWa, number> = { accepted: 0, rejected: 0, unknown: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const f of porEstado!.results as { status: EstadoWa; n: number }[]) salientes[f.status] = f.n;
  const ultimo_evento =
    t.ultimo_entrante === null && t.ultimo_estado === null ? null
      : (t.ultimo_estado ?? 0) > (t.ultimo_entrante ?? 0) ? { en: t.ultimo_estado!, tipo: 'estado' as const }
      : { en: t.ultimo_entrante!, tipo: 'mensaje' as const };
  const configuracion = { envio_real: env.WHATSAPP_SEND_READY === '1', secreto_app: puesto(env, env.WHATSAPP_APP_SECRET), token_verificacion: puesto(env, env.WHATSAPP_VERIFY_TOKEN) };
  const configurado = configuracion.envio_real ? gatewayListo(env) : configuracion.secreto_app;
  return {
    salud: saludDe({ configurado, evento_reciente: (ultimo_evento?.en ?? 0) >= desde, entrantes: t.entrantes, sin_enrutar: t.sin_enrutar, salientes }),
    configuracion,
    ultimo_evento,
    ultimo_saliente: (ultimo!.results[0] as { en: number; estado: EstadoWa } | undefined) ?? null,
    ultimas_24h: { entrantes: t.entrantes, sin_enrutar: t.sin_enrutar, en_eleccion: t.en_eleccion, salientes },
  };
}

const HORA_BOGOTA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export type ResultadoPrueba =
  | { error: 'bot_apagado' | 'sin_telefono_verificado' | 'puente_sin_configurar' }
  | { error: 'espera_prueba'; reintentar_en: number }
  | { error: 'tope_diario' }
  | { resultado: 'enviada' | 'rechazada' | 'sin_confirmar'; simulado: boolean; en: number; codigo?: string };

/**
 * Envío de prueba. El destino es SIEMPRE el `whatsapp_phone` VERIFICADO (WAP-02) de la tienda cuyo dueño es la cuenta
 * de la sesión (`owner_firebase_uid`, único por cuenta); nada del cuerpo de la petición entra aquí.
 */
export async function enviarPrueba(env: Env, uid: string, ahora: number): Promise<ResultadoPrueba> {
  // Igual que el cobro por bot: apagado, solo donde el simulador está habilitado a propósito (desarrollo y pruebas).
  if (env.WHATSAPP_SEND_READY !== '1' && env.TEST_WHATSAPP_SIMULADO !== '1') return { error: 'bot_apagado' };
  const tienda = await env.DB.prepare(
    'SELECT id, whatsapp_phone AS telefono FROM businesses WHERE owner_firebase_uid = ?1 AND whatsapp_phone IS NOT NULL AND whatsapp_verified_at IS NOT NULL',
  ).bind(uid).first<{ id: string; telefono: string }>();
  if (!tienda) return { error: 'sin_telefono_verificado' };
  const previa = await env.DB.prepare(
    `SELECT MAX(created_at) AS en FROM whatsapp_messages WHERE direction = 'SALIENTE' AND callback_data = ?1 AND phone = ?2 AND created_at > ?3`,
  ).bind(MARCA_PRUEBA, tienda.telefono, ahora - ESPERA_PRUEBA_MS).first<{ en: number | null }>();
  if (previa?.en) return { error: 'espera_prueba', reintentar_en: previa.en + ESPERA_PRUEBA_MS };
  // Tope diario: aun al propio teléfono, cada plantilla real cuesta.
  const hoy = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM whatsapp_messages WHERE direction = 'SALIENTE' AND callback_data = ?1 AND phone = ?2 AND created_at > ?3`,
  ).bind(MARCA_PRUEBA, tienda.telefono, ahora - 24 * 3_600_000).first<{ n: number }>();
  if ((hoy?.n ?? 0) >= MAX_PRUEBAS_DIA) return { error: 'tope_diario' };

  // Sin negocio en el envío: lo manda TuListaNegra, no la tienda (no cuenta para el paso 4 del enrutamiento).
  // El minuto en la clave: dos toques a la vez no envían dos pruebas.
  let gateway: ReturnType<typeof gatewayPara>;
  try {
    gateway = gatewayPara(env, () => ahora);
  } catch {
    return { error: 'puente_sin_configurar' }; // encendido sin configuración completa: falla cerrado, no se escribe nada
  }
  const simulado = env.WHATSAPP_SEND_READY !== '1';
  try {
    const r = await gateway.sendTemplate({
      to: tienda.telefono, requestId: `${MARCA_PRUEBA}:${tienda.id}:${Math.floor(ahora / ESPERA_PRUEBA_MS)}`, callbackData: MARCA_PRUEBA,
      template: PLANTILLA_PRUEBA, language: 'es_CO', variables: [HORA_BOGOTA.format(ahora)],
    });
    if (r.status === 'rejected') return { resultado: 'rechazada', simulado, en: ahora, codigo: r.code };
    return { resultado: r.status === 'accepted' ? 'enviada' : 'sin_confirmar', simulado, en: ahora };
  } catch {
    return { resultado: 'sin_confirmar', simulado, en: ahora }; // pudo quedar a medias: ambiguo, no se reintenta solo
  }
}
