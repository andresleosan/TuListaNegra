// Guardián de acceso (AUT-03): carga el negocio de la sesión, calcula su estado y aplica la tabla de permisos de B2.
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { type EstadoNegocio, estadoEfectivo, PERMISOS, type Permisos } from '../shared/acceso';
import type { AppEnv } from './auth';
import { bd } from './db';
import { businesses } from './db/schema';

export type Negocio = typeof businesses.$inferSelect;

/** Qué hace falta para usar una ruta de negocio. */
export type Requisito = 'siempre' | 'no_suspendido' | keyof Permisos;

/**
 * El requisito sale de la ruta y el método, no de una anotación por ruta: una ruta nueva queda protegida sin acordarse de nada.
 * - `GET /api/negocio`: el estado propio se ve siempre (un suspendido necesita leer el aviso).
 * - `/api/suscripcion/*`: ver pases y subir la captura de pago; un vencido debe poder renovar.
 * - `/api/ia/*` y `/api/cobros-bot/*`: IA y cobros por bot.
 * - Lo demás: leer exige `ver`; cualquier otro método exige `escribir`.
 */
export function requisitoDeRuta(metodo: string, ruta: string): Requisito {
  const lectura = metodo === 'GET' || metodo === 'HEAD';
  if (ruta === '/api/negocio' && lectura) return 'siempre';
  if (ruta === '/api/suscripcion' || ruta.startsWith('/api/suscripcion/')) return 'no_suspendido';
  if (ruta.startsWith('/api/ia/') || ruta.startsWith('/api/cobros-bot/')) return 'ia';
  return lectura ? 'ver' : 'escribir';
}

export const cumple = (estado: EstadoNegocio, requisito: Requisito): boolean =>
  requisito === 'siempre' ? true : requisito === 'no_suspendido' ? estado !== 'SUSPENDED_BY_ADMIN' : PERMISOS[estado][requisito];

/** El negocio sale SIEMPRE de la sesión verificada (A1.4), nunca de lo que envía el navegador. */
export const requiereNegocio = createMiddleware<AppEnv>(async (c, next) => {
  const negocio = await bd(c.env).select().from(businesses).where(eq(businesses.owner_firebase_uid, c.var.sesion.uid)).get();
  if (!negocio) return c.json({ error: 'sin_negocio' }, 404);
  const estado = estadoEfectivo(negocio, Date.now());
  if (!cumple(estado, requisitoDeRuta(c.req.method, c.req.path))) return c.json({ error: 'acceso_denegado', estado }, 403);
  c.set('negocio', negocio);
  c.set('estado', estado);
  await next();
});
