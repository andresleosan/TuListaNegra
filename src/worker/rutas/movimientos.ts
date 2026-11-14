// Movimientos de un deudor (LIB-01): /api/deudores/:id/movimientos
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { MONTO_MAXIMO_COP } from '../../shared/dinero';
import type { AppEnv } from '../auth';
import { bd } from '../db';
import { debtors, ledger_transactions, TIPOS_MOVIMIENTO } from '../db/schema';
import { registrarMovimiento } from '../libro';
import { cuerpo } from '../validar';

const Nuevo = z.object({
  /** Lo genera la app una vez por toque; reintentar con el mismo no duplica el movimiento. */
  request_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  type: z.enum(TIPOS_MOVIMIENTO),
  amount_cop: z.number().int().positive().max(MONTO_MAXIMO_COP),
  description: z.string().trim().max(140).optional(),
  due_date: z.number().int().positive().nullish(),
  confirmar_tope: z.boolean().optional(),
  /** Quién lo propuso: el tendero en el mostrador, o Sarin por texto (y el tendero lo confirmó). Los demás orígenes no entran por aquí. */
  origen: z.enum(['MOSTRADOR', 'SARIN_TEXT']).optional(),
});

export const movimientos = new Hono<AppEnv>();

// Historial con saldo corrido (balance_after_cop), lo más nuevo arriba.
// ponytail: tope de 500 filas sin paginar; añadir cursor cuando una ficha lo necesite.
movimientos.get('/', async (c) => {
  const filas = await bd(c.env).select().from(ledger_transactions)
    .where(and(eq(ledger_transactions.business_id, c.var.negocio.id), eq(ledger_transactions.debtor_id, c.req.param('id')!)))
    .orderBy(desc(ledger_transactions.created_at), desc(ledger_transactions.id)).limit(500);
  return c.json({ movimientos: filas });
});

movimientos.post('/', async (c) => {
  const d = await cuerpo(c, Nuevo);
  const negocio = c.var.negocio;
  const debtor_id = c.req.param('id')!;
  const { origen, ...datos } = d;
  const r = await registrarMovimiento(c.env, { ...datos, business_id: negocio.id, debtor_id, source: origen ?? 'MOSTRADOR' });
  if (!r.ok) return c.json(r.error === 'no_encontrado' ? { error: r.error } : { ...r, ok: undefined }, r.error === 'no_encontrado' ? 404 : 409);
  // Un request_id repetido que apuntaba a otro deudor no es un reintento: es un error del cliente.
  if (r.movimiento.debtor_id !== debtor_id) return c.json({ error: 'request_id_usado' }, 409);
  const deudor = await bd(c.env).select({
    current_balance_cop: debtors.current_balance_cop, oldest_unpaid_date: debtors.oldest_unpaid_date,
    promised_payment_date: debtors.promised_payment_date, credit_limit_cop: debtors.credit_limit_cop,
  }).from(debtors).where(and(eq(debtors.id, debtor_id), eq(debtors.business_id, negocio.id))).get();
  return c.json({ movimiento: r.movimiento, deudor, repetido: r.repetido }, r.repetido ? 200 : 201);
});
