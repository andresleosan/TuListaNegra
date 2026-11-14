// Estado de la suscripción y permisos (docs/spec/producto.md, B2). El estado NO se guarda: se calcula en cada petición.

export type EstadoNegocio = 'TRIAL' | 'ACTIVE' | 'GRACE_UNLOCK_24H' | 'EXPIRED_READONLY' | 'SUSPENDED_BY_ADMIN';

export type DatosDeEstado = {
  suspended_at: number | null;
  free_forever_at: number | null;
  subscription_plan: string;
  subscription_expires_at: number;
  grace_unlock_ends_at: number | null;
};

/** Función pura. El orden de las comprobaciones es el de B2 y no se cambia: la suspensión gana a todo. */
export function estadoEfectivo(negocio: DatosDeEstado, ahora: number): EstadoNegocio {
  if (negocio.suspended_at !== null) return 'SUSPENDED_BY_ADMIN';
  if (negocio.free_forever_at !== null) return 'ACTIVE';
  if (ahora < negocio.subscription_expires_at) return negocio.subscription_plan === 'TRIAL_3D' ? 'TRIAL' : 'ACTIVE';
  if (negocio.grace_unlock_ends_at !== null && ahora < negocio.grace_unlock_ends_at) return 'GRACE_UNLOCK_24H';
  return 'EXPIRED_READONLY';
}

export type Permisos = {
  /** Ver la cartera. */
  ver: boolean;
  /** Crear deudores, fiar, abonar. */
  escribir: boolean;
  /** IA y cobros por bot (además hace falta cuota). */
  ia: boolean;
};

const SI = { ver: true, escribir: true, ia: true };

export const PERMISOS: Record<EstadoNegocio, Permisos> = {
  TRIAL: SI,
  ACTIVE: SI,
  GRACE_UNLOCK_24H: SI, // la IA solo gasta la cuota que quedaba: el desbloqueo no reinicia contadores
  EXPIRED_READONLY: { ver: true, escribir: false, ia: false },
  SUSPENDED_BY_ADMIN: { ver: false, escribir: false, ia: false },
};
