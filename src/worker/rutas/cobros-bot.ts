// Cobro por el bot (WAP-03, fase 4): la plantilla fija del tono sale por `SarinGateway`. Mismas reglas que el cobro
// por el WhatsApp del tendero (POST /api/deudores/:id/cobros), más la cuota «cobros por bot» (B2).
// Con WHATSAPP_SEND_READY apagado, `gatewayPara` es siempre el simulador: nada sale a la red (A1.6).
//
// Qué pasa según responde el gateway (contrato-sarin.md, a: «ambiguo no se reintenta»):
// - `accepted` → 200. Cuota gastada y cobro anotado.
// - `rejected` → 502. No salió: se devuelve la cuota y se deshace la anotación, para que el tendero pueda cobrar por otra vía.
// - `unknown`  → 202. Pudo salir: la cuota queda gastada y el cobro anotado, así nadie le escribe dos veces el mismo día.
// - Si el envío lanza, también es ambiguo (pudo quedar a medias): se trata como `unknown`.
// Con el interruptor apagado solo funciona donde el simulador está habilitado a propósito (TEST_WHATSAPP_SIMULADO, solo
// desarrollo y pruebas; check:release prohíbe cualquier TEST_* en producción). En producción responde `bot_apagado`
// sin gastar cuota ni anotar nada: un envío simulado no puede bloquear el cobro real del tendero.
// El trabajo corre bajo waitUntil: si el cliente se desconecta a medias, la cuota, la anotación y el envío terminan igual.
//
// Cobro masivo (WAP-07, POST /lote): la MISMA función `cobrarUno` para cada deudor, uno tras otro, y un resumen de
// cuántos salieron y por qué quedó fuera cada uno. La cuota se gasta por deudor: si se acaba a mitad, los que siguen
// quedan «sin cuota». El request_id de cada deudor sale del del lote, así reintentar el lote no envía dos veces.
// Hasta MAX_LOTE deudores por petición: la pantalla envía las tandas una tras otra, cada una con un request_id derivado
// del del lote completo (`<toque>-t<n>`).
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { comoPagar, type Tono, TONOS } from '../../shared/cobro';
import { type MotivoBloqueo, puedeContactar } from '../../shared/contacto';
import { formatoCOP } from '../../shared/dinero';
import type { AppEnv } from '../auth';
import { conCuota } from '../cuotas';
import { bd } from '../db';
import { debtors, whatsapp_messages as wa } from '../db/schema';
import type { Negocio } from '../guardian';
import { cuerpo } from '../validar';
import { gatewayPara } from '../whatsapp';
import type { NombrePlantilla } from '../whatsapp/tipos';

const RequestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Pedido = z.object({ tono: z.enum(TONOS), request_id: RequestId });
/**
 * Máximo de deudores por lote. Cada uno son de 5 a 7 consultas a D1 en serie dentro de la misma invocación, y el plan
 * gratuito de Workers corta hacia las 50 consultas (y 10 ms de CPU): un corte a mitad dejaría deudores anotados y con
 * cuota gastada sin mensaje. Con 6 cabe en cualquier plan; la pantalla parte la selección en tandas de 6.
 */
export const MAX_LOTE = 6;
const Lote = Pedido.extend({ deudores: z.array(z.string().min(1).max(64)).min(1).max(MAX_LOTE) });

const YA_COBRADO = { error: 'contacto_bloqueado', motivo: 'YA_COBRADO_HOY', mensaje: 'Ya le cobraste hoy a este deudor. Solo se permite un cobro al día.' } as const;

/** Lo que pasó con el cobro de UN deudor. Cada error es, tal cual, el cuerpo que responde la ruta individual. */
type Cobro =
  | { estado: 'enviado' | 'sin_confirmar'; simulado: boolean; last_reminder_sent_at: number | null }
  | { error: 'no_encontrado' | 'sin_saldo' | 'sin_telefono' }
  | { error: 'contacto_bloqueado'; motivo: MotivoBloqueo; mensaje: string }
  | { error: 'sin_cuota'; mensaje: string }
  | { error: 'envio_rechazado'; codigo: string | null | undefined };

/** Corta el trabajo dentro de `conCuota` para que devuelva la unidad: el mensaje no salió. */
class SinEnvio extends Error {
  constructor(readonly cobro: Cobro & { error: string }) {
    super(cobro.error);
  }
}

type Desenlace = { status: string; code?: string | null };

/** Con el interruptor apagado, solo donde el simulador está habilitado a propósito (desarrollo y pruebas). */
const botApagado = (env: Env) => env.WHATSAPP_SEND_READY !== '1' && env.TEST_WHATSAPP_SIMULADO !== '1';

/** Corre el trabajo bajo waitUntil, para que un cliente que se desconecta no lo deje a medias. */
function sinCortes<T>(ctx: () => { waitUntil(p: Promise<unknown>): void }, trabajo: Promise<T>): Promise<T> {
  try {
    ctx().waitUntil(trabajo);
  } catch {
    // Sin contexto de ejecución (pruebas con app.request): nada que proteger de una cancelación.
  }
  return trabajo;
}

/**
 * Cobro por el bot a UN deudor de `negocio` (el de la sesión). `clave` distingue el toque: el `request_id` del cobro
 * suelto o el del lote con su prefijo. Lo usan la ruta individual y el lote: mismas reglas, cuota, anotación e idempotencia.
 */
async function cobrarUno(env: Env, negocio: Negocio, deudorId: string, tono: Tono, clave: string): Promise<Cobro> {
  const simulado = env.WHATSAPP_SEND_READY !== '1';
  const db = bd(env);
  // Un deudor archivado no se cobra: misma respuesta que uno que no existe.
  const suyo = and(eq(debtors.id, deudorId), eq(debtors.business_id, negocio.id), isNull(debtors.archived_at));
  const deudor = await db.select().from(debtors).where(suyo).get();
  if (!deudor) return { error: 'no_encontrado' };

  const desenlace = (r: Desenlace, anotado: number | null): Cobro =>
    r.status === 'rejected' || r.status === 'failed' ? { error: 'envio_rechazado', codigo: r.code }
      : { estado: r.status === 'unknown' ? 'sin_confirmar' : 'enviado', simulado, last_reminder_sent_at: anotado };

  // `request_id` es único en toda la tabla: lleva el negocio y el deudor delante, así ninguna otra tienda choca con él.
  const requestId = `cobro-bot:${negocio.id}:${deudor.id}:${clave}`;
  // Reintento del mismo toque: se responde lo que pasó la primera vez, sin enviar ni gastar otra vez.
  const previo = await db.select({ status: wa.status, code: wa.error_code }).from(wa).where(eq(wa.request_id, requestId)).get();
  if (previo) return desenlace(previo, deudor.last_reminder_sent_at);

  if (deudor.current_balance_cop === 0) return { error: 'sin_saldo' };
  if (!deudor.whatsapp_phone) return { error: 'sin_telefono' };
  const ahora = Date.now();
  const contacto = puedeContactar(deudor, ahora);
  if (!contacto.permitido) return { error: 'contacto_bloqueado', motivo: contacto.motivo, mensaje: contacto.mensaje };

  // Encendido sin gateway real, lanza aquí: antes de gastar o anotar nada. El envío queda con el negocio desde que se guarda.
  const gateway = gatewayPara(env, Date.now, negocio.id);
  // La misma anotación atómica que el cobro por enlace: dos toques a la vez no envían dos cobros. Además exige que
  // consentimiento, baja y teléfono sigan como se leyeron: un cambio de número o una baja en ese instante no se salta (B6).
  const anotar = () =>
    env.DB.prepare(
      `UPDATE debtors SET last_reminder_sent_at = ?1 WHERE id = ?2 AND business_id = ?3 AND last_reminder_sent_at IS ?4
         AND wa_opt_out_at IS NULL AND wa_consent_at IS ?5 AND whatsapp_phone IS ?6`,
    ).bind(ahora, deudor.id, negocio.id, deudor.last_reminder_sent_at, deudor.wa_consent_at, deudor.whatsapp_phone).run();
  // Deshace solo nuestra anotación (si nadie anotó otra después).
  const desanotar = () =>
    env.DB.prepare('UPDATE debtors SET last_reminder_sent_at = ?1 WHERE id = ?2 AND business_id = ?3 AND last_reminder_sent_at IS ?4')
      .bind(deudor.last_reminder_sent_at, deudor.id, negocio.id, ahora).run();

  try {
    const r = await conCuota(env, negocio, 'cobros', async () => {
      if ((await anotar()).meta.changes !== 1) throw new SinEnvio(YA_COBRADO);
      const envio = await gateway.sendTemplate({
        to: deudor.whatsapp_phone!,
        requestId,
        template: `cobro_${tono.toLowerCase()}` as NombrePlantilla,
        language: 'es_CO',
        variables: [deudor.full_name, negocio.name, formatoCOP(deudor.current_balance_cop), comoPagar(negocio.payment_methods_info)],
        callbackData: `cobro:${deudor.id}`, // vuelve en los estados de Meta; un id interno, sin datos personales
      }).catch((): Desenlace => ({ status: 'unknown' })); // lanzar a medias es ambiguo: pudo salir
      if (envio.status === 'rejected') {
        await desanotar(); // no salió: el tendero puede cobrar por otra vía
        throw new SinEnvio({ error: 'envio_rechazado', codigo: envio.code });
      }
      return envio;
    });
    if (!r.ok) return { error: r.error, mensaje: r.mensaje };
    return desenlace(r.valor, ahora);
  } catch (e) {
    if (e instanceof SinEnvio) return e.cobro;
    throw e;
  }
}

/** Por qué quedó fuera un deudor del lote (o `null` si salió). Los motivos de B6 van tal cual. */
export type MotivoFuera = MotivoBloqueo | 'SIN_SALDO' | 'SIN_TELEFONO' | 'SIN_CUOTA' | 'RECHAZADO' | 'NO_ENCONTRADO';
const MOTIVO: Record<Exclude<Exclude<Cobro, { estado: string }>['error'], 'contacto_bloqueado'>, MotivoFuera> = {
  no_encontrado: 'NO_ENCONTRADO', // también el archivado y el de otra tienda: la misma respuesta, sin revelar que existe
  sin_saldo: 'SIN_SALDO',
  sin_telefono: 'SIN_TELEFONO',
  sin_cuota: 'SIN_CUOTA',
  envio_rechazado: 'RECHAZADO',
};

export const cobrosBot = new Hono<AppEnv>();

// Antes que `/:id`: si no, «lote» se tomaría por el id de un deudor.
cobrosBot.post('/lote', async (c) => {
  const { tono, request_id, deudores } = await cuerpo(c, Lote);
  if (botApagado(c.env)) return c.json({ error: 'bot_apagado' }, 409);
  const trabajo = (async () => {
    const resumen = { simulado: c.env.WHATSAPP_SEND_READY !== '1', enviados: 0, sin_confirmar: 0, fuera: {} as Partial<Record<MotivoFuera, number>> };
    // Uno tras otro: la cuota y la regla de «un cobro al día» se aplican igual que con toques sueltos.
    for (const id of new Set(deudores)) {
      const r = await cobrarUno(c.env, c.var.negocio, id, tono, `lote:${request_id}`);
      if ('estado' in r) {
        resumen[r.estado === 'enviado' ? 'enviados' : 'sin_confirmar'] += 1;
      } else {
        const motivo = r.error === 'contacto_bloqueado' ? r.motivo : MOTIVO[r.error];
        resumen.fuera[motivo] = (resumen.fuera[motivo] ?? 0) + 1;
      }
    }
    return c.json(resumen);
  })();
  return sinCortes(() => c.executionCtx, trabajo);
});

cobrosBot.post('/:id', async (c) => {
  const { tono, request_id } = await cuerpo(c, Pedido);
  if (botApagado(c.env)) return c.json({ error: 'bot_apagado' }, 409);
  const trabajo = cobrarUno(c.env, c.var.negocio, c.req.param('id'), tono, request_id).then((r) =>
    'estado' in r ? c.json(r, r.estado === 'enviado' ? 200 : 202)
      : c.json(r, r.error === 'no_encontrado' ? 404 : r.error === 'envio_rechazado' ? 502 : 409),
  );
  return sinCortes(() => c.executionCtx, trabajo);
});
