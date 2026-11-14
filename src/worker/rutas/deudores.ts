// Deudores (DEU-01). Toda consulta filtra por el negocio de la sesión (c.var.negocio.id).
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { type DeudorDetalle, type DeudorResumen, estadoDeudor, TIPOS_DOCUMENTO } from '../../shared/deudor';
import { MONTO_MAXIMO_COP } from '../../shared/dinero';
import { nuevoId } from '../../shared/ids';
import type { AppEnv } from '../auth';
import { bd } from '../db';
import { debtors } from '../db/schema';
import { cuotasDe } from '../planes';
import { cuerpo, esUnico } from '../validar';
import { movimientos } from './movimientos';

type Fila = typeof debtors.$inferSelect;

const texto = (max: number) => z.string().trim().min(1).max(max);
const opcional = <T extends z.ZodType>(t: T) => t.nullish();

const Datos = z.object({
  full_name: texto(80), // nombre o apodo: lo único obligatorio
  alias_reference: opcional(texto(80)),
  doc_type: opcional(z.enum(TIPOS_DOCUMENTO)),
  // Sin puntos ni espacios: «1.032.456.789» y «1032456789» son el mismo documento.
  doc_number: opcional(z.string().transform((v) => v.replace(/[\s.\-]/g, '').toUpperCase()).pipe(z.string().regex(/^[0-9A-Z]{4,15}$/))),
  // La app normaliza con src/shared/telefono.ts; aquí solo entra E.164.
  whatsapp_phone: opcional(z.string().regex(/^\+[1-9]\d{7,14}$/)),
  credit_limit_cop: opcional(z.number().int().min(0).max(MONTO_MAXIMO_COP)),
  promised_payment_date: opcional(z.number().int().positive()),
  /** true registra el consentimiento para escribirle por WhatsApp; false lo retira. */
  wa_consentimiento: z.boolean().optional(),
});

const Cambios = Datos.partial().extend({
  /** La baja solo se registra: la tienda no puede deshacer que alguien pidió no ser contactado. */
  wa_baja: z.literal(true).optional(),
  lista_negra: z.boolean().optional(),
  archivado: z.boolean().optional(),
});

const conDocumento = (d: { doc_type?: string | null; doc_number?: string | null }) => !d.doc_number || Boolean(d.doc_type);
const SIN_TIPO = { message: 'Indica el tipo de documento', path: ['doc_type'] };

const resumen = (f: Fila): DeudorResumen => ({
  id: f.id, unique_code: f.unique_code, full_name: f.full_name, alias_reference: f.alias_reference, doc_last4: f.doc_last4,
  current_balance_cop: f.current_balance_cop, credit_limit_cop: f.credit_limit_cop, oldest_unpaid_date: f.oldest_unpaid_date,
  promised_payment_date: f.promised_payment_date, blacklisted_at: f.blacklisted_at, archived_at: f.archived_at,
  wa_consent_at: f.wa_consent_at, wa_opt_out_at: f.wa_opt_out_at, last_reminder_sent_at: f.last_reminder_sent_at,
  tiene_whatsapp: f.whatsapp_phone !== null,
});

const detalle = (f: Fila, diasDeAlerta: number): DeudorDetalle & { estado: string } => ({
  ...resumen(f), doc_type: f.doc_type, doc_number: f.doc_number, whatsapp_phone: f.whatsapp_phone, created_at: f.created_at,
  estado: estadoDeudor(f, Date.now(), diasDeAlerta),
});

export const deudores = new Hono<AppEnv>();

deudores.route('/:id/movimientos', movimientos);

// Lista para la copia local de búsqueda: sin documento completo ni teléfono. `?archivados=1` incluye los archivados.
deudores.get('/', async (c) => {
  const delNegocio = eq(debtors.business_id, c.var.negocio.id);
  const filas = await bd(c.env).select().from(debtors)
    .where(c.req.query('archivados') === '1' ? delNegocio : and(delNegocio, isNull(debtors.archived_at)))
    .orderBy(debtors.full_name);
  return c.json({ deudores: filas.map(resumen) });
});

deudores.post('/', async (c) => {
  const d = await cuerpo(c, Datos.refine(conDocumento, SIN_TIPO));
  const negocio = c.var.negocio;
  const limite = cuotasDe(negocio).deudores; // null = sin límite; los archivados también cuentan
  const ahora = Date.now();
  const doc = d.doc_number ?? null;
  // Una sola sentencia: el consecutivo TLN y el límite del plan se resuelven de forma atómica, sin carreras.
  const sentencia = c.env.DB.prepare(
    `INSERT INTO debtors (id, business_id, unique_code, full_name, alias_reference, doc_type, doc_number, doc_last4,
       whatsapp_phone, wa_consent_at, credit_limit_cop, promised_payment_date, created_at)
     SELECT ?1, ?2, printf('TLN-%04d', COALESCE(MAX(CAST(substr(unique_code, 5) AS INTEGER)), 0) + 1), ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
     FROM debtors WHERE business_id = ?2
     HAVING ?13 IS NULL OR COUNT(*) < ?13
     RETURNING *`,
  ).bind(
    nuevoId('deb', ahora), negocio.id, d.full_name, d.alias_reference ?? null, doc ? d.doc_type : null, doc, doc ? doc.slice(-4) : null,
    d.whatsapp_phone ?? null, d.wa_consentimiento ? ahora : null, d.credit_limit_cop ?? null, d.promised_payment_date ?? null, ahora, limite,
  );
  try {
    const fila = await sentencia.first<Fila>();
    if (!fila) return c.json({ error: 'limite_deudores', limite }, 409);
    return c.json(detalle(fila, negocio.default_alert_days), 201);
  } catch (e) {
    if (esUnico(e, 'doc_number')) return c.json({ error: 'documento_duplicado' }, 409);
    throw e;
  }
});

deudores.get('/:id', async (c) => {
  const fila = await bd(c.env).select().from(debtors)
    .where(and(eq(debtors.id, c.req.param('id')), eq(debtors.business_id, c.var.negocio.id))).get();
  if (!fila) return c.json({ error: 'no_encontrado' }, 404);
  return c.json(detalle(fila, c.var.negocio.default_alert_days));
});

deudores.patch('/:id', async (c) => {
  const d = await cuerpo(c, Cambios);
  const ahora = Date.now();
  const suyo = and(eq(debtors.id, c.req.param('id')), eq(debtors.business_id, c.var.negocio.id));
  const actual = await bd(c.env).select().from(debtors).where(suyo).get();
  if (!actual) return c.json({ error: 'no_encontrado' }, 404);

  const { wa_consentimiento, wa_baja, lista_negra, archivado, ...campos } = d;
  const cambios: Partial<Fila> = { ...campos };
  if ('doc_number' in d) cambios.doc_last4 = d.doc_number ? d.doc_number.slice(-4) : null;
  if ('doc_number' in d && !d.doc_number) cambios.doc_type = null;
  if (!conDocumento({ ...actual, ...cambios })) {
    return c.json({ error: 'datos_invalidos', campos: { doc_type: [SIN_TIPO.message] } }, 400);
  }
  // Las marcas guardan la fecha de la primera vez; volver a marcar no la mueve.
  if (wa_consentimiento !== undefined) cambios.wa_consent_at = wa_consentimiento ? (actual.wa_consent_at ?? ahora) : null;
  if (wa_baja) cambios.wa_opt_out_at = actual.wa_opt_out_at ?? ahora;
  if (lista_negra !== undefined) cambios.blacklisted_at = lista_negra ? (actual.blacklisted_at ?? ahora) : null;
  if (archivado !== undefined) cambios.archived_at = archivado ? (actual.archived_at ?? ahora) : null;
  if (Object.keys(cambios).length === 0) return c.json(detalle(actual, c.var.negocio.default_alert_days));

  try {
    const [fila] = await bd(c.env).update(debtors).set(cambios).where(suyo).returning();
    return c.json(detalle(fila!, c.var.negocio.default_alert_days));
  } catch (e) {
    if (esUnico(e, 'doc_number')) return c.json({ error: 'documento_duplicado' }, 409);
    throw e;
  }
});
