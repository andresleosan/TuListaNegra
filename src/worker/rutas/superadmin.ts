// Consola del superadministrador: /api/superadmin/*
import { Hono } from 'hono';
import { z } from 'zod';
import { servirObjeto } from '../archivos';
import type { AppEnv } from '../auth';
import { ESTADOS_PAGO } from '../db/schema';
import { aprobarPago, rechazarPago, type ResultadoRevision } from '../revision';
import { requiereSuperadmin } from '../superadmin';
import { cuerpo } from '../validar';

export const superadmin = new Hono<AppEnv>();

// Va primero y cubre todo lo que se registre en este archivo, exista o no la ruta.
superadmin.use('*', requiereSuperadmin);

superadmin.get('/yo', (c) => c.json({ email: c.var.sesion.email }));

/** Toda acción de la consola pide un motivo (B4) y queda en admin_audit_log. */
const motivo = z.string().trim().min(3).max(300);

// --- Pagos (SUP-02) ---

// Bandeja: por defecto los pendientes, del más antiguo al más nuevo. Las alertas son sugerencias: nunca se aprueba solo.
// ponytail: tope de 200 filas sin paginar.
superadmin.get('/pagos', async (c) => {
  const estado = z.enum(ESTADOS_PAGO).catch('PENDING_REVIEW').parse(c.req.query('estado'));
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.business_id, b.name AS negocio, b.owner_email, p.plan_requested, p.days_to_add, p.amount_cop,
       p.receipt_r2_key, p.ocr_extracted_amount, p.ocr_reference_number, p.grace_started_at, p.status,
       p.review_note, p.reviewed_by_email, p.created_at, p.reviewed_at,
       (p.ocr_extracted_amount IS NOT NULL AND p.ocr_extracted_amount <> p.amount_cop) AS monto_no_coincide,
       (p.ocr_reference_number IS NOT NULL AND EXISTS (
          SELECT 1 FROM subscription_payments o WHERE o.ocr_reference_number = p.ocr_reference_number AND o.id <> p.id
       )) AS referencia_repetida
     FROM subscription_payments p JOIN businesses b ON b.id = p.business_id
     WHERE p.status = ? ORDER BY p.created_at, p.id LIMIT 200`,
  ).bind(estado).all();
  return c.json({ pagos: results.map((p) => ({ ...p, monto_no_coincide: Boolean(p.monto_no_coincide), referencia_repetida: Boolean(p.referencia_repetida) })) });
});

// La captura de cualquier negocio: solo llega aquí quien pasó requiereSuperadmin.
superadmin.get('/archivos/*', (c) => servirObjeto(c, c.req.path.slice('/api/superadmin/archivos/'.length)));

const responder = (r: ResultadoRevision) =>
  r.ok ? Response.json({ pago: r.pago, aplicado: r.aplicado }) : Response.json(r, { status: r.error === 'no_encontrado' ? 404 : 409 });

superadmin.post('/pagos/:id/aprobar', async (c) => {
  const { nota } = await cuerpo(c, z.object({ nota: motivo.nullish() }));
  return responder(await aprobarPago(c.env, { pago_id: c.req.param('id'), actor_email: c.var.sesion.email!, nota: nota ?? null }));
});

superadmin.post('/pagos/:id/rechazar', async (c) => {
  const d = await cuerpo(c, z.object({ motivo }));
  return responder(await rechazarPago(c.env, { pago_id: c.req.param('id'), actor_email: c.var.sesion.email!, nota: d.motivo }));
});
