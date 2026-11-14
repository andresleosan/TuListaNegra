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
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { comoPagar, TONOS } from '../../shared/cobro';
import { puedeContactar } from '../../shared/contacto';
import { formatoCOP } from '../../shared/dinero';
import type { AppEnv } from '../auth';
import { conCuota } from '../cuotas';
import { bd } from '../db';
import { debtors, whatsapp_messages as wa } from '../db/schema';
import { cuerpo } from '../validar';
import { gatewayPara } from '../whatsapp';
import type { NombrePlantilla } from '../whatsapp/tipos';

const Pedido = z.object({ tono: z.enum(TONOS), request_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });

const YA_COBRADO = { error: 'contacto_bloqueado', motivo: 'YA_COBRADO_HOY', mensaje: 'Ya le cobraste hoy a este deudor. Solo se permite un cobro al día.' };

/** Corta el trabajo dentro de `conCuota` para que devuelva la unidad: el mensaje no salió. */
class SinEnvio extends Error {
  constructor(readonly cuerpo: Record<string, unknown>, readonly estado: 409 | 502) {
    super(String(cuerpo.error));
  }
}

type Desenlace = { status: string; code?: string | null };

export const cobrosBot = new Hono<AppEnv>();

cobrosBot.post('/:id', async (c) => {
  const { tono, request_id } = await cuerpo(c, Pedido);
  const negocio = c.var.negocio;
  const simulado = c.env.WHATSAPP_SEND_READY !== '1';
  if (simulado && c.env.TEST_WHATSAPP_SIMULADO !== '1') return c.json({ error: 'bot_apagado' }, 409);
  const db = bd(c.env);
  const suyo = and(eq(debtors.id, c.req.param('id')), eq(debtors.business_id, negocio.id));
  const deudor = await db.select().from(debtors).where(suyo).get();
  if (!deudor) return c.json({ error: 'no_encontrado' }, 404);

  const responder = (r: Desenlace, anotado: number | null) =>
    r.status === 'rejected' || r.status === 'failed' ? c.json({ error: 'envio_rechazado', codigo: r.code }, 502)
      : r.status === 'unknown' ? c.json({ estado: 'sin_confirmar', simulado, last_reminder_sent_at: anotado }, 202)
      : c.json({ estado: 'enviado', simulado, last_reminder_sent_at: anotado }, 200);

  // `request_id` es único en toda la tabla: lleva el negocio y el deudor delante, así ninguna otra tienda choca con él.
  const requestId = `cobro-bot:${negocio.id}:${deudor.id}:${request_id}`;
  // Reintento del mismo toque: se responde lo que pasó la primera vez, sin enviar ni gastar otra vez.
  const previo = await db.select({ status: wa.status, code: wa.error_code }).from(wa).where(eq(wa.request_id, requestId)).get();
  if (previo) return responder(previo, deudor.last_reminder_sent_at);

  if (deudor.current_balance_cop === 0) return c.json({ error: 'sin_saldo' }, 409);
  if (!deudor.whatsapp_phone) return c.json({ error: 'sin_telefono' }, 409);
  const ahora = Date.now();
  const contacto = puedeContactar(deudor, ahora);
  if (!contacto.permitido) return c.json({ error: 'contacto_bloqueado', motivo: contacto.motivo, mensaje: contacto.mensaje }, 409);

  // Encendido sin gateway real, lanza aquí: antes de gastar o anotar nada. El envío queda con el negocio desde que se guarda.
  const gateway = gatewayPara(c.env, Date.now, negocio.id);
  // La misma anotación atómica que el cobro por enlace: dos toques a la vez no envían dos cobros. Además exige que
  // consentimiento, baja y teléfono sigan como se leyeron: un cambio de número o una baja en ese instante no se salta (B6).
  const anotar = () =>
    c.env.DB.prepare(
      `UPDATE debtors SET last_reminder_sent_at = ?1 WHERE id = ?2 AND business_id = ?3 AND last_reminder_sent_at IS ?4
         AND wa_opt_out_at IS NULL AND wa_consent_at IS ?5 AND whatsapp_phone IS ?6`,
    ).bind(ahora, deudor.id, negocio.id, deudor.last_reminder_sent_at, deudor.wa_consent_at, deudor.whatsapp_phone).run();
  // Deshace solo nuestra anotación (si nadie anotó otra después).
  const desanotar = () =>
    c.env.DB.prepare('UPDATE debtors SET last_reminder_sent_at = ?1 WHERE id = ?2 AND business_id = ?3 AND last_reminder_sent_at IS ?4')
      .bind(deudor.last_reminder_sent_at, deudor.id, negocio.id, ahora).run();

  const trabajo = (async () => {
    try {
      const r = await conCuota(c.env, negocio, 'cobros', async () => {
        if ((await anotar()).meta.changes !== 1) throw new SinEnvio(YA_COBRADO, 409);
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
          throw new SinEnvio({ error: 'envio_rechazado', codigo: envio.code }, 502);
        }
        return envio;
      });
      if (!r.ok) return c.json({ error: r.error, mensaje: r.mensaje }, 409);
      return responder(r.valor, ahora);
    } catch (e) {
      if (e instanceof SinEnvio) return c.json(e.cuerpo, e.estado);
      throw e;
    }
  })();
  try {
    c.executionCtx.waitUntil(trabajo);
  } catch {
    // Sin contexto de ejecución (pruebas con app.request): nada que proteger de una cancelación.
  }
  return trabajo;
});
