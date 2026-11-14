// Suscripción (B2): pases, pago por captura y desbloqueo preventivo de 24 h. Aprobar y rechazar son de la consola.
import { and, desc, eq, ne } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { nuevoId } from '../../shared/ids';
import type { AppEnv } from '../auth';
import { anotarLecturaDePago } from '../captura-pago';
import { bd } from '../db';
import { businesses, subscription_payments as pagos } from '../db/schema';
import { limitar } from '../limite';
import { cuentasDePago, DESBLOQUEO_MS, elegibleDesbloqueo, MAX_CAPTURA_BYTES, tipoDeImagen } from '../pagos';
import { DIA, PASES, PLANES } from '../planes';
import { esUnico } from '../validar';

export const suscripcion = new Hono<AppEnv>();

/** Lo que el formulario puede ocupar además de la captura: separadores, cabeceras de cada parte y el campo `plan`. */
const MARGEN_FORMULARIO = 64 * 1024;

/** El último pago revisado del negocio: el de `reviewed_at` más reciente, no el creado más tarde. */
const ultimoRevisado = (db: ReturnType<typeof bd>, negocioId: string) =>
  db.select({ status: pagos.status, review_note: pagos.review_note }).from(pagos)
    .where(and(eq(pagos.business_id, negocioId), ne(pagos.status, 'PENDING_REVIEW')))
    .orderBy(desc(pagos.reviewed_at), desc(pagos.id)).limit(1).get();

/** La nota de un rechazo le explica al tendero qué pasó; la de una aprobación es interna del superadministrador. */
const conNotaVisible = (r: { status: string; review_note: string | null } | undefined) =>
  r ? { status: r.status, review_note: r.status === 'REJECTED' ? r.review_note : null } : null;

suscripcion.get('/', async (c) => {
  const db = bd(c.env);
  const negocioId = c.var.negocio.id;
  const pendiente = await db.select({ id: pagos.id, plan: pagos.plan_requested, amount_cop: pagos.amount_cop, created_at: pagos.created_at }).from(pagos)
    .where(and(eq(pagos.business_id, negocioId), eq(pagos.status, 'PENDING_REVIEW'))).get();
  return c.json({
    pases: PASES.map((id) => ({ id, nombre: PLANES[id].nombre, dias: PLANES[id].duracion_ms / DIA, precio_cop: PLANES[id].precio_cop, cuotas: PLANES[id].cuotas })),
    cuentas: cuentasDePago(c.env.PAYMENT_ACCOUNTS_JSON),
    pago_pendiente: pendiente ?? null,
    ultimo_revisado: conNotaVisible(await ultimoRevisado(db, negocioId)),
  });
});

// Del navegador solo se leen `plan` y `captura`: monto, días, estado, id y negocio los pone el servidor.
suscripcion.post('/pagos', limitar('LIMITE_SUBIDAS', (c) => c.var.negocio.id), async (c) => {
  // El tamaño se decide ANTES de leer: un cuerpo de longitud desconocida o excesiva no llega a memoria.
  const largo = Number(c.req.header('Content-Length') || NaN);
  if (Number.isNaN(largo)) return c.json({ error: 'falta_content_length' }, 411);
  if (largo > MAX_CAPTURA_BYTES + MARGEN_FORMULARIO) return c.json({ error: 'captura_muy_grande' }, 413);

  const formulario = await c.req.formData().catch(() => null);
  const plan = z.enum(PASES).safeParse(formulario?.get('plan'));
  if (!plan.success) return c.json({ error: 'plan_invalido' }, 400);
  const captura = formulario?.get('captura');
  if (!(captura instanceof File)) return c.json({ error: 'captura_invalida' }, 400);
  if (captura.size > MAX_CAPTURA_BYTES) return c.json({ error: 'captura_muy_grande' }, 413);
  const bytes = new Uint8Array(await captura.arrayBuffer());
  const tipo = tipoDeImagen(bytes); // un archivo vacío tampoco tiene firma
  if (!tipo) return c.json({ error: 'captura_invalida' }, 400);

  const db = bd(c.env);
  const negocioId = c.var.negocio.id; // de la sesión verificada (A1.4)
  const ahora = Date.now();
  const id = nuevoId('pay', ahora);
  const clave = `negocios/${negocioId}/pagos/${id}.${tipo.ext}`;
  const amount_cop = PLANES[plan.data].precio_cop;
  const days_to_add = PLANES[plan.data].duracion_ms / DIA;

  let desbloqueo_hasta: number | null;
  await c.env.ARCHIVOS.put(clave, bytes, { httpMetadata: { contentType: tipo.contentType } });
  try {
    desbloqueo_hasta = elegibleDesbloqueo(c.var.estado, (await ultimoRevisado(db, negocioId))?.status ?? null) ? ahora + DESBLOQUEO_MS : null;
    const alta = db.insert(pagos).values({
      id, business_id: negocioId, plan_requested: plan.data, days_to_add, amount_cop, receipt_r2_key: clave,
      grace_started_at: desbloqueo_hasta ? ahora : null, status: 'PENDING_REVIEW', created_at: ahora,
    });
    // Pago y desbloqueo van en una sola transacción: o quedan los dos o ninguno. El desbloqueo solo escribe su fecha de fin.
    if (desbloqueo_hasta) await db.batch([alta, db.update(businesses).set({ grace_unlock_ends_at: desbloqueo_hasta }).where(eq(businesses.id, negocioId))]);
    else await alta;
  } catch (e) {
    // Sin fila no hay objeto: la captura recién subida se borra, sea cual sea el fallo.
    await c.env.ARCHIVOS.delete(clave);
    // El índice único es quien decide que ya había un pendiente; así dos subidas simultáneas no pasan las dos.
    if (esUnico(e, 'subscription_payments.business_id')) return c.json({ error: 'pago_pendiente_existe' }, 409);
    throw e;
  }
  // Lectura de la captura (IAS-03): corre después de responder, así un fallo o una demora de la IA no frena el pago.
  const lectura = anotarLecturaDePago(c.env, { id, business_id: negocioId }, bytes, tipo);
  try {
    c.executionCtx.waitUntil(lectura);
  } catch {
    await lectura; // sin contexto de ejecución (pruebas con app.request): se espera aquí; nunca lanza
  }
  return c.json({ pago: { id, plan: plan.data, amount_cop, days_to_add, status: 'PENDING_REVIEW', created_at: ahora }, desbloqueo_hasta }, 201);
});
