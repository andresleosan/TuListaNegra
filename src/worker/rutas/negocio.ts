import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { type EstadoNegocio, estadoEfectivo, PERMISOS } from '../../shared/acceso';
import { TONOS, type Tono } from '../../shared/cobro';
import { nuevoId } from '../../shared/ids';
import { normalizarTelefonoCO } from '../../shared/telefono';
import type { AppEnv, Sesion } from '../auth';
import { bd } from '../db';
import { businesses } from '../db/schema';
import type { Negocio } from '../guardian';
import { ipDe, limitar } from '../limite';
import { cuotasDe, PLANES } from '../planes';
import { enLista } from '../superadmin';
import { cuerpo } from '../validar';

export const negocio = new Hono<AppEnv>();

/** Tono de cobro por defecto de la tienda (vive en `sarin_settings_json`). */
function tonoDe(n: Negocio): Tono {
  try {
    const tono = JSON.parse(n.sarin_settings_json ?? '{}').tono_cobro;
    return TONOS.includes(tono) ? tono : 'VECINO_AMIGABLE';
  } catch {
    return 'VECINO_AMIGABLE';
  }
}

/** Lo que la app recibe de su negocio. Un suspendido solo recibe el aviso y cómo contactar (B2). */
function cuerpoNegocio(n: Negocio, estado: EstadoNegocio, env: Env) {
  const permisos = PERMISOS[estado];
  if (estado === 'SUSPENDED_BY_ADMIN') return { estado, permisos, contacto: env.SOPORTE_CONTACTO ?? null };
  const gratis = n.free_forever_at !== null;
  return {
    id: n.id,
    name: n.name,
    estado,
    permisos,
    plan: n.subscription_plan,
    gratis,
    // Una cuenta gratis no tiene fecha de fin ni aviso de renovación.
    vence_en: gratis ? null : n.subscription_expires_at,
    desbloqueo_hasta: estado === 'GRACE_UNLOCK_24H' ? n.grace_unlock_ends_at : null,
    limites: cuotasDe(n),
    usados: { ocr: n.ai_ocr_used_count, ia: n.ai_chat_used_count, cobros: n.wa_reminders_used_count },
    default_alert_days: n.default_alert_days,
    payment_methods_info: n.payment_methods_info,
    tono_cobro: tonoDe(n),
    whatsapp_phone: n.whatsapp_phone,
    // Apagado (A3), los cobros por bot van al simulador: la app los marca como de prueba.
    bot_whatsapp_activo: env.WHATSAPP_SEND_READY === '1',
    // Solo desarrollo: el botón del bot se ofrece contra el simulador. En producción con el interruptor apagado, no aparece.
    bot_whatsapp_simulado: env.WHATSAPP_SEND_READY !== '1' && env.TEST_WHATSAPP_SIMULADO === '1',
  };
}

// Estado propio del negocio.
negocio.get('/', (c) => c.json(cuerpoNegocio(c.var.negocio, c.var.estado, c.env)));

// Ajustes de la tienda (AJU-01): medios de pago, días de alerta y tono de cobro por defecto. Nada más se cambia por aquí.
const Ajustes = z
  .object({
    payment_methods_info: z.string().trim().max(300).transform((v) => v || null).nullable(),
    default_alert_days: z.number().int().min(1).max(365),
    tono_cobro: z.enum(TONOS),
  })
  .partial()
  .refine((d) => Object.keys(d).length > 0, { message: 'Nada que cambiar' });

negocio.patch('/', async (c) => {
  const d = await cuerpo(c, Ajustes);
  const { tono_cobro, ...columnas } = d;
  const [guardado] = await bd(c.env).update(businesses)
    .set({
      ...columnas,
      // El tono se guarda dentro del JSON de ajustes sin pisar lo demás que haya ahí.
      ...(tono_cobro && { sarin_settings_json: sql`json_set(COALESCE(${businesses.sarin_settings_json}, '{}'), '$.tono_cobro', ${tono_cobro})` }),
    })
    .where(eq(businesses.id, c.var.negocio.id)) // el negocio de la sesión, nunca uno que nombre el navegador
    .returning();
  return c.json(cuerpoNegocio(guardado!, c.var.estado, c.env));
});

// Solo esto llega del navegador. Plan, fechas, cuotas, dueño e ids los fija el servidor: lo demás se descarta.
const Alta = z.object({
  name: z.string().trim().min(2).max(80),
  whatsapp_phone: z.string().transform((valor, ctx) => {
    const telefono = normalizarTelefonoCO(valor);
    if (telefono) return telefono;
    ctx.issues.push({ code: 'custom', message: 'No es un celular de Colombia', input: valor });
    return z.NEVER;
  }),
  acepta_terminos: z.literal(true),
});

/** Puerta de registro (A3): con `SIGNUP_READY` apagado solo entran superadministradores y pilotos con el correo verificado. */
const registroAbierto = (env: Env, sesion: Sesion) =>
  env.SIGNUP_READY === '1' ||
  (sesion.email_verified && (enLista(env.SUPERADMIN_EMAILS, sesion.email) || enLista(env.PILOT_EMAILS, sesion.email)));

// Alta del negocio con prueba de 72 h. Una por cuenta y por teléfono (B2).
negocio.post('/', limitar('LIMITE_ALTAS', ipDe), async (c) => {
  const { sesion } = c.var;
  if (!registroAbierto(c.env, sesion)) return c.json({ error: 'registro_cerrado' }, 403);
  if (!sesion.email) return c.json({ error: 'correo_requerido' }, 403); // el negocio necesita el correo de su dueño

  const datos = Alta.safeParse(await c.req.json().catch(() => null));
  if (!datos.success) {
    return c.json({ error: 'datos_invalidos', campos: [...new Set(datos.error.issues.map((i) => String(i.path[0] ?? '')))] }, 400);
  }

  const ahora = Date.now();
  const db = bd(c.env);
  try {
    const [creado] = await db
      .insert(businesses)
      .values({
        id: nuevoId('bus', ahora),
        owner_firebase_uid: sesion.uid, // A1.4: el dueño sale de la sesión, nunca del cuerpo
        owner_email: sesion.email,
        name: datos.data.name,
        whatsapp_phone: datos.data.whatsapp_phone,
        subscription_plan: 'TRIAL_3D',
        subscription_expires_at: ahora + PLANES.TRIAL_3D.duracion_ms,
        quota_cycle_started_at: ahora,
        terms_accepted_at: ahora,
        created_at: ahora,
      })
      .returning();
    return c.json(cuerpoNegocio(creado!, estadoEfectivo(creado!, ahora), c.env), 201);
  } catch (e) {
    // Los índices únicos son la defensa (aguantan dos altas a la vez); aquí solo se traduce su rechazo.
    if (!/UNIQUE constraint failed/.test(`${e} ${(e as Error).cause ?? ''}`)) throw e;
    const propio = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.owner_firebase_uid, sesion.uid)).get();
    return c.json({ error: propio ? 'ya_tiene_negocio' : 'telefono_en_uso' }, 409);
  }
});
