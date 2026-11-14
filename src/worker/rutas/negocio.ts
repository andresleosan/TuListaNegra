import { Hono } from 'hono';
import { PERMISOS } from '../../shared/acceso';
import type { AppEnv } from '../auth';
import { cuotasDe } from '../planes';

export const negocio = new Hono<AppEnv>();

// Estado propio del negocio. Un suspendido solo recibe el aviso y cómo contactar (B2).
negocio.get('/', (c) => {
  const { negocio: n, estado } = c.var;
  const permisos = PERMISOS[estado];
  if (estado === 'SUSPENDED_BY_ADMIN') return c.json({ estado, permisos, contacto: c.env.SOPORTE_CONTACTO ?? null });
  const gratis = n.free_forever_at !== null;
  return c.json({
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
    whatsapp_phone: n.whatsapp_phone,
  });
});
