// Datos ficticios para pruebas.
import { env } from 'cloudflare:workers';
import { bd } from '../db';
import { businesses } from '../db/schema';

export const HORA = 3_600_000;
export const DIA = 24 * HORA;

type NegocioNuevo = typeof businesses.$inferInsert;

/** Crea un negocio activo (pase de 7 días vigente) para el uid indicado; `cambios` ajusta lo que la prueba necesite. */
export async function sembrarNegocio(uid = 'uid_1', cambios: Partial<NegocioNuevo> = {}) {
  const ahora = Date.now();
  const fila: NegocioNuevo = {
    id: `bus_${uid}`, owner_firebase_uid: uid, owner_email: `${uid}@ejemplo.test`, name: `Tienda de ${uid}`,
    subscription_plan: 'PASS_7D', subscription_expires_at: ahora + 7 * DIA, quota_cycle_started_at: ahora,
    terms_accepted_at: ahora, created_at: ahora, ...cambios,
  };
  const [guardada] = await bd(env).insert(businesses).values(fila).returning();
  return guardada!; // tal como quedó en la base, con sus valores por defecto
}

/** Los cinco estados de B2, como cambios sobre un negocio sembrado. */
export const EN_ESTADO = {
  TRIAL: () => ({ subscription_plan: 'TRIAL_3D' as const, subscription_expires_at: Date.now() + 72 * HORA }),
  ACTIVE: () => ({}),
  GRACE_UNLOCK_24H: () => ({ subscription_expires_at: Date.now() - HORA, grace_unlock_ends_at: Date.now() + 23 * HORA }),
  EXPIRED_READONLY: () => ({ subscription_expires_at: Date.now() - HORA }),
  SUSPENDED_BY_ADMIN: () => ({ suspended_at: Date.now() - HORA }),
};
