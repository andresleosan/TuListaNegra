// Esquema D1 (docs/spec/producto.md, B3). Las propiedades usan el mismo nombre que la columna.
// Convenciones: dinero en enteros COP; tiempo en milisegundos UTC; ids ULID con prefijo.
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const PLANES_IDS = ['TRIAL_3D', 'PASS_7D', 'PASS_15D', 'PASS_30D'] as const;
export const ESTADOS_PAGO = ['PENDING_REVIEW', 'PAID', 'REJECTED'] as const;
export const TIPOS_MOVIMIENTO = ['FIADO', 'ABONO', 'AJUSTE_SUMA', 'AJUSTE_RESTA'] as const;
export const ESTADOS_MOVIMIENTO = ['CONFIRMADO', 'PENDIENTE_VERIFICACION_WHATSAPP', 'RECHAZADO'] as const;
export const ORIGENES_MOVIMIENTO = ['MOSTRADOR', 'SARIN_TEXT', 'SARIN_AUDIO', 'SARIN_IMAGE_OCR', 'WHATSAPP_BOT'] as const;

const en = (columna: string, valores: readonly string[]) =>
  sql.raw(`${columna} IN (${valores.map((v) => `'${v}'`).join(', ')})`);
// SQLite guarda lo que le den: sin esto, 0.5 o 'abc' entrarían en una columna de dinero.
const entero = (columna: string) => sql.raw(`typeof(${columna}) = 'integer'`);

export const businesses = sqliteTable(
  'businesses',
  {
    id: text().primaryKey(),
    owner_firebase_uid: text().notNull(),
    owner_email: text().notNull(),
    name: text().notNull(),
    doc_type: text(),
    doc_number: text(),
    whatsapp_phone: text(), // E.164
    whatsapp_verified_at: integer(),
    // Verificación del teléfono del dueño (WAP-02): solo la huella SHA-256 del código pendiente (nunca el código),
    // su vencimiento y los intentos fallidos. Cambiar `whatsapp_phone` borra todo esto y la verificación (disparador).
    whatsapp_code_hash: text(),
    whatsapp_code_expires_at: integer(),
    whatsapp_code_attempts: integer().notNull().default(0),
    payment_methods_info: text(),
    subscription_plan: text({ enum: PLANES_IDS }).notNull().default('TRIAL_3D'),
    subscription_expires_at: integer().notNull(),
    grace_unlock_ends_at: integer(),
    free_forever_at: integer(),
    suspended_at: integer(),
    quota_cycle_started_at: integer().notNull(),
    ai_ocr_used_count: integer().notNull().default(0),
    ai_chat_used_count: integer().notNull().default(0),
    wa_reminders_used_count: integer().notNull().default(0),
    default_alert_days: integer().notNull().default(30),
    sarin_settings_json: text(),
    terms_accepted_at: integer().notNull(),
    created_at: integer().notNull(),
  },
  (t) => [
    uniqueIndex('businesses_owner_uid_uq').on(t.owner_firebase_uid),
    // Único solo si existe: SQLite permite varios NULL en un índice único.
    uniqueIndex('businesses_whatsapp_phone_uq').on(t.whatsapp_phone),
    check('businesses_plan_ck', en('subscription_plan', PLANES_IDS)),
    check('businesses_contadores_ck', sql`${t.ai_ocr_used_count} >= 0 AND ${t.ai_chat_used_count} >= 0 AND ${t.wa_reminders_used_count} >= 0`),
    check('businesses_alert_days_ck', sql`${t.default_alert_days} > 0`),
  ],
);

export const subscription_payments = sqliteTable(
  'subscription_payments',
  {
    id: text().primaryKey(),
    business_id: text().notNull().references(() => businesses.id),
    plan_requested: text({ enum: PLANES_IDS }).notNull(),
    days_to_add: integer().notNull(),
    amount_cop: integer().notNull(),
    receipt_r2_key: text().notNull(),
    ocr_extracted_amount: integer(),
    ocr_reference_number: text(),
    grace_started_at: integer(),
    status: text({ enum: ESTADOS_PAGO }).notNull().default('PENDING_REVIEW'),
    reviewed_by_email: text(),
    review_note: text(),
    created_at: integer().notNull(),
    reviewed_at: integer(),
  },
  (t) => [
    // Un solo pago pendiente por negocio.
    uniqueIndex('payments_un_pendiente_uq').on(t.business_id).where(sql`status = 'PENDING_REVIEW'`),
    index('payments_business_idx').on(t.business_id, t.created_at),
    index('payments_ocr_ref_idx').on(t.ocr_reference_number), // no único: sirve para alertar repetidos
    check('payments_plan_ck', en('plan_requested', PLANES_IDS)),
    check('payments_status_ck', en('status', ESTADOS_PAGO)),
    check('payments_montos_ck', sql`${entero('amount_cop')} AND ${entero('days_to_add')} AND ${t.amount_cop} > 0 AND ${t.days_to_add} > 0`),
  ],
);

export const debtors = sqliteTable(
  'debtors',
  {
    id: text().primaryKey(),
    business_id: text().notNull().references(() => businesses.id),
    unique_code: text().notNull(), // TLN-0001, consecutivo por negocio
    full_name: text().notNull(),
    alias_reference: text(),
    doc_type: text(),
    doc_number: text(),
    doc_last4: text(),
    whatsapp_phone: text(),
    wa_consent_at: integer(),
    wa_opt_out_at: integer(),
    credit_limit_cop: integer(), // NULL = sin tope
    current_balance_cop: integer().notNull().default(0),
    oldest_unpaid_date: integer(),
    promised_payment_date: integer(),
    blacklisted_at: integer(),
    archived_at: integer(),
    last_reminder_sent_at: integer(),
    created_at: integer().notNull(),
  },
  (t) => [
    uniqueIndex('debtors_code_uq').on(t.business_id, t.unique_code),
    uniqueIndex('debtors_negocio_id_uq').on(t.business_id, t.id), // destino de la FK compuesta del libro
    uniqueIndex('debtors_doc_uq').on(t.business_id, t.doc_type, t.doc_number).where(sql`doc_number IS NOT NULL`),
    index('debtors_name_idx').on(t.business_id, t.full_name),
    check('debtors_saldo_ck', sql`${entero('current_balance_cop')} AND ${t.current_balance_cop} >= 0`),
    check('debtors_doc_ck', sql`(${t.doc_number} IS NULL) = (${t.doc_type} IS NULL)`), // tipo y número: ambos o ninguno
    check('debtors_tope_ck', sql`${t.credit_limit_cop} IS NULL OR ${t.credit_limit_cop} >= 0`),
  ],
);

export const ledger_transactions = sqliteTable(
  'ledger_transactions',
  {
    id: text().primaryKey(),
    business_id: text().notNull().references(() => businesses.id),
    debtor_id: text().notNull(),
    request_id: text().notNull(), // idempotencia: repetirlo no crea otro movimiento
    type: text({ enum: TIPOS_MOVIMIENTO }).notNull(),
    amount_cop: integer().notNull(),
    status: text({ enum: ESTADOS_MOVIMIENTO }).notNull(),
    balance_after_cop: integer(), // vacío hasta confirmar
    description: text().notNull(),
    evidence_r2_key: text(),
    due_date: integer(),
    created_at: integer().notNull(),
    confirmed_at: integer(),
    source: text({ enum: ORIGENES_MOVIMIENTO }).notNull(),
  },
  (t) => [
    // El movimiento y su deudor son del mismo negocio: el aislamiento también vive en la base.
    foreignKey({ name: 'ledger_deudor_fk', columns: [t.business_id, t.debtor_id], foreignColumns: [debtors.business_id, debtors.id] }),
    uniqueIndex('ledger_request_uq').on(t.business_id, t.request_id),
    index('ledger_debtor_idx').on(t.business_id, t.debtor_id, t.created_at),
    check('ledger_amount_ck', sql`${entero('amount_cop')} AND ${t.amount_cop} > 0`),
    check('ledger_confirmado_ck', sql`${t.status} <> 'CONFIRMADO' OR (${t.balance_after_cop} IS NOT NULL AND ${t.confirmed_at} IS NOT NULL)`),
    check('ledger_type_ck', en('type', TIPOS_MOVIMIENTO)),
    check('ledger_status_ck', en('status', ESTADOS_MOVIMIENTO)),
    check('ledger_source_ck', en('source', ORIGENES_MOVIMIENTO)),
  ],
);

export const admin_audit_log = sqliteTable(
  'admin_audit_log',
  {
    id: text().primaryKey(),
    actor_email: text().notNull(),
    action: text().notNull(),
    business_id: text(),
    detail_json: text(),
    created_at: integer().notNull(),
  },
  (t) => [index('audit_business_idx').on(t.business_id, t.created_at)],
);

export const TIPOS_AVISO = ['TRES_DIAS', 'UN_DIA', 'VENCIDO'] as const;

/**
 * Avisos de vencimiento que el cron horario deja listos para el dueño (SUS-03). Uno por negocio, tipo y vencimiento:
 * el índice único hace que repetir el cron no duplique. `sent_at` lo rellena quien envíe por WhatsApp (fase 4).
 */
export const subscription_notices = sqliteTable(
  'subscription_notices',
  {
    business_id: text().notNull().references(() => businesses.id),
    kind: text({ enum: TIPOS_AVISO }).notNull(),
    expires_at: integer().notNull(),
    created_at: integer().notNull(),
    sent_at: integer(),
  },
  (t) => [
    uniqueIndex('notices_uq').on(t.business_id, t.kind, t.expires_at),
    check('notices_kind_ck', en('kind', TIPOS_AVISO)),
  ],
);

export const DIRECCIONES_WA = ['ENTRANTE', 'SALIENTE'] as const;
export const TIPOS_WA = ['template', 'text', 'buttons', 'image', 'button'] as const;
/** Resultado del envío (`accepted`, `rejected`, `unknown`) y, después, los estados que avisa Meta. */
export const ESTADOS_WA = ['accepted', 'rejected', 'unknown', 'sent', 'delivered', 'read', 'failed'] as const;
/**
 * Enrutamiento de un entrante (WAP-04, producto.md B4). Vacío mientras no se enruta, y siempre en los salientes.
 * `ROUTED`: tiene negocio. `AWAITING_TENANT_SELECTION`: se preguntó con botones a qué comercio va. `UNROUTED`: desconocido.
 */
export const ESTADOS_ENRUTAMIENTO = ['ROUTED', 'AWAITING_TENANT_SELECTION', 'UNROUTED'] as const;
/**
 * Por qué paso de B4 se asignó el negocio: respuesta a un mensaje nuestro, orden del dueño verificado, único negocio en
 * 72 h o elegido con botón. `VERIFICACION` (WAP-02): el código que envía el dueño aún sin verificar desde su teléfono.
 */
export const REGLAS_ENRUTAMIENTO = ['RESPUESTA', 'ORDEN_DUENO', 'UNICO_72H', 'ELECCION', 'VERIFICACION'] as const;

/**
 * Bandeja de WhatsApp (WAP-01, docs/spec/contrato-sarin.md): entrantes y salientes, del simulador o de Meta.
 * `wa_message_id` único = un evento repetido no se procesa dos veces; `request_id` único = un envío repetido no sale dos veces.
 * Un envío rechazado no tiene `wa_message_id` (SQLite permite varios NULL en un índice único).
 */
export const whatsapp_messages = sqliteTable(
  'whatsapp_messages',
  {
    id: text().primaryKey(), // wam_…
    direction: text({ enum: DIRECCIONES_WA }).notNull(),
    wa_message_id: text(),
    request_id: text(), // solo salientes
    phone: text().notNull(), // E.164 del otro lado
    phone_number_id: text(), // número nuestro, si se conoce
    business_id: text().references(() => businesses.id), // vacío hasta el enrutamiento (WAP-04)
    kind: text({ enum: TIPOS_WA }).notNull(),
    template: text(),
    content_json: text().notNull(), // variables y texto resuelto, o el contenido del entrante
    buttons_json: text(),
    reply_to_wa_message_id: text(),
    status: text({ enum: ESTADOS_WA }).notNull(),
    error_code: text(), // código de rechazo (WINDOW_CLOSED…) o de error de Meta
    callback_data: text(),
    occurred_at: integer().notNull(), // envío o fecha del entrante según Meta
    created_at: integer().notNull(),
    status_updated_at: integer(),
    // WAP-04. Columnas añadidas con ALTER TABLE: sin CHECK (exigiría reconstruir la tabla); los valores los fija el enrutador.
    debtor_id: text().references(() => debtors.id), // vacío si no se sabe qué deudor es
    routing_state: text({ enum: ESTADOS_ENRUTAMIENTO }),
    routing_rule: text({ enum: REGLAS_ENRUTAMIENTO }), // solo con ROUTED
  },
  (t) => [
    uniqueIndex('wa_message_id_uq').on(t.wa_message_id),
    uniqueIndex('wa_request_id_uq').on(t.request_id),
    index('wa_phone_idx').on(t.phone, t.direction, t.occurred_at), // último entrante de un teléfono (ventana de 24 h)
    check('wa_direction_ck', en('direction', DIRECCIONES_WA)),
    check('wa_kind_ck', en('kind', TIPOS_WA)),
    check('wa_status_ck', en('status', ESTADOS_WA)),
    // Entrante: siempre trae su id de Meta. Saliente: siempre lleva su clave de idempotencia.
    check('wa_ids_ck', sql`(${t.direction} = 'ENTRANTE' AND ${t.wa_message_id} IS NOT NULL) OR (${t.direction} = 'SALIENTE' AND ${t.request_id} IS NOT NULL)`),
  ],
);
