// Consola del superadministrador: /api/superadmin/*
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { estadoEfectivo } from '../../shared/acceso';
import { nuevoId } from '../../shared/ids';
import { servirObjeto } from '../archivos';
import type { AppEnv } from '../auth';
import { type businesses, ESTADOS_PAGO } from '../db/schema';
import { indicadores } from '../indicadores';
import { DIA } from '../planes';
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

// --- Negocios (SUP-03) ---

type Negocio = typeof businesses.$inferSelect;

const vistaNegocio = (n: Negocio, ahora: number) => ({
  id: n.id, name: n.name, owner_email: n.owner_email, whatsapp_phone: n.whatsapp_phone, created_at: n.created_at,
  estado: estadoEfectivo(n, ahora), plan: n.subscription_plan, gratis: n.free_forever_at !== null, suspendido: n.suspended_at !== null,
  // Una cuenta gratis no tiene fecha de fin.
  vence_en: n.free_forever_at !== null ? null : n.subscription_expires_at,
  usados: { ocr: n.ai_ocr_used_count, ia: n.ai_chat_used_count, cobros: n.wa_reminders_used_count },
});

// Buscador por nombre, correo, teléfono o id. ponytail: 50 resultados sin paginar.
superadmin.get('/negocios', async (c) => {
  const q = `%${(c.req.query('q') ?? '').trim().replace(/[%_\\]/g, '\\$&')}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM businesses
     WHERE name LIKE ?1 ESCAPE '\\' OR owner_email LIKE ?1 ESCAPE '\\' OR whatsapp_phone LIKE ?1 ESCAPE '\\' OR id LIKE ?1 ESCAPE '\\'
     ORDER BY created_at DESC LIMIT 50`,
  ).bind(q).all<Negocio>();
  const ahora = Date.now();
  return c.json({ negocios: results.map((n) => vistaNegocio(n, ahora)) });
});

/**
 * Acciones sobre un negocio: cada una es un UPDATE fijo (ningún texto del navegador entra en el SQL).
 * El cambio y su fila de auditoría van en un solo batch: no hay acción sin rastro ni rastro sin acción.
 */
const actualizar = (c: Context<AppEnv>, cambio: string, ...parametros: unknown[]) =>
  c.env.DB.prepare(`UPDATE businesses SET ${cambio} WHERE id = ?1 RETURNING *`).bind(c.req.param('id'), ...parametros);

const ACCIONES = {
  cortesia: {
    accion: 'DIAS_CORTESIA',
    datos: z.object({ dias: z.union([z.literal(3), z.literal(7), z.literal(15), z.literal(30)]), motivo }),
    sentencia: (c: Context<AppEnv>, ahora: number, d: { dias?: number }) =>
      actualizar(c, `subscription_expires_at = MAX(subscription_expires_at, ?2) + ?3 * ${DIA}`, ahora, d.dias),
  },
  gratis: {
    accion: 'SUSCRIPCION_GRATIS',
    datos: z.object({ activar: z.boolean(), motivo }),
    // Marcarla empieza un ciclo de cuotas (solo la primera vez); desmarcarla devuelve el negocio a sus fechas.
    sentencia: (c: Context<AppEnv>, ahora: number, d: { activar?: boolean }) =>
      d.activar
        ? actualizar(c, `ai_ocr_used_count = IIF(free_forever_at IS NULL, 0, ai_ocr_used_count),
             ai_chat_used_count = IIF(free_forever_at IS NULL, 0, ai_chat_used_count),
             wa_reminders_used_count = IIF(free_forever_at IS NULL, 0, wa_reminders_used_count),
             quota_cycle_started_at = IIF(free_forever_at IS NULL, ?2, quota_cycle_started_at),
             free_forever_at = COALESCE(free_forever_at, ?2)`, ahora)
        : actualizar(c, 'free_forever_at = NULL'),
  },
  'reiniciar-contadores': {
    accion: 'REINICIAR_CONTADORES',
    datos: z.object({ motivo }),
    sentencia: (c: Context<AppEnv>, ahora: number) =>
      actualizar(c, 'ai_ocr_used_count = 0, ai_chat_used_count = 0, wa_reminders_used_count = 0, quota_cycle_started_at = ?2', ahora),
  },
  suspender: {
    accion: 'SUSPENDER',
    datos: z.object({ motivo }),
    sentencia: (c: Context<AppEnv>, ahora: number) => actualizar(c, 'suspended_at = COALESCE(suspended_at, ?2)', ahora),
  },
  reactivar: {
    accion: 'REACTIVAR',
    datos: z.object({ motivo }),
    sentencia: (c: Context<AppEnv>) => actualizar(c, 'suspended_at = NULL'),
  },
};

superadmin.post('/negocios/:id/:accion', async (c) => {
  const nombre = c.req.param('accion');
  // Object.hasOwn: «constructor» o «__proto__» no son acciones aunque el objeto los herede.
  const definicion = Object.hasOwn(ACCIONES, nombre) ? ACCIONES[nombre as keyof typeof ACCIONES] : undefined;
  if (!definicion) return c.json({ error: 'no_encontrado' }, 404);
  const d: { motivo: string; dias?: number; activar?: boolean } = await cuerpo(c, definicion.datos);
  const ahora = Date.now();
  const [, cambio] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO admin_audit_log (id, actor_email, action, business_id, detail_json, created_at)
       SELECT ?1, ?2, ?3, id, ?4, ?5 FROM businesses WHERE id = ?6`,
    ).bind(nuevoId('aud', ahora), c.var.sesion.email, definicion.accion, JSON.stringify(d), ahora, c.req.param('id')),
    definicion.sentencia(c, ahora, d),
  ]);
  const negocio = (cambio!.results as Negocio[])[0];
  if (!negocio) return c.json({ error: 'no_encontrado' }, 404);
  return c.json(vistaNegocio(negocio, ahora));
});

// --- Indicadores (SUP-04) ---

superadmin.get('/indicadores', async (c) => c.json(await indicadores(c.env)));
