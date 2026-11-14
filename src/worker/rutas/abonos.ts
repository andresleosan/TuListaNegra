// Abonos que llegaron por WhatsApp y esperan revisión (WAP-06): /api/abonos
// La lista es el aviso en la app; aprobar o rechazar, el toque de una persona (A1.3). El negocio sale de la sesión (A1.4).
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { MONTO_MAXIMO_COP } from '../../shared/dinero';
import type { AppEnv } from '../auth';
import { cuerpo } from '../validar';
import { aprobarAbono, avisarAlDeudor, rechazarAbono, type ResultadoRevision } from '../whatsapp/abonos';

/** El monto que el tendero vio (y pudo corregir) junto a la foto. Que no pase del saldo lo comprueba la transacción. */
const Aprobacion = z.object({ amount_cop: z.number().int().positive().max(MONTO_MAXIMO_COP) });

export const abonos = new Hono<AppEnv>();

// Pendientes del negocio, lo más viejo primero, con el deudor y su saldo de hoy.
abonos.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.debtor_id, l.amount_cop, l.created_at, l.evidence_r2_key, d.full_name, d.unique_code, d.current_balance_cop
     FROM ledger_transactions l JOIN debtors d ON d.id = l.debtor_id AND d.business_id = l.business_id
     WHERE l.business_id = ?1 AND l.type = 'ABONO' AND l.status = 'PENDIENTE_VERIFICACION_WHATSAPP'
     ORDER BY l.created_at, l.id LIMIT 100`,
  ).bind(c.var.negocio.id).all();
  return c.json({ pendientes: results });
});

/** Tras revisar: el movimiento, el deudor como quedó y qué pasó con el mensaje al deudor (tirilla o aviso neutro). */
async function respuesta(c: Context<AppEnv>, r: ResultadoRevision) {
  if (!r.ok) return c.json(r.error === 'no_encontrado' ? { error: r.error } : { ...r, ok: undefined }, r.error === 'no_encontrado' ? 404 : 409);
  const negocio = c.var.negocio;
  const envio = await avisarAlDeudor(c.env, negocio, r.movimiento, Date.now);
  const deudor = await c.env.DB.prepare(
    'SELECT current_balance_cop, oldest_unpaid_date, promised_payment_date FROM debtors WHERE id = ?1 AND business_id = ?2',
  ).bind(r.movimiento.debtor_id, negocio.id).first();
  return c.json({ movimiento: r.movimiento, deudor, envio });
}

abonos.post('/:id/aprobar', async (c) => {
  const { amount_cop } = await cuerpo(c, Aprobacion);
  return respuesta(c, await aprobarAbono(c.env, c.var.negocio.id, c.req.param('id'), amount_cop, Date.now()));
});

abonos.post('/:id/rechazar', async (c) => respuesta(c, await rechazarAbono(c.env, c.var.negocio.id, c.req.param('id'))));
