// Acceso del superadministrador (B4): correo en SUPERADMIN_EMAILS, verificado y con sesión de Google.
// Se comprueba en el servidor en cada ruta; lo que oculte la interfaz es solo cosmético.
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Sesion } from './auth';

/** ¿`correo` está en la lista separada por comas? Comparación exacta, sin mayúsculas ni espacios. */
export function enLista(lista: string | undefined, correo: string | null): boolean {
  if (!lista || !correo) return false;
  return lista.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean).includes(correo.toLowerCase());
}

export const esSuperadmin = (sesion: Sesion, env: Env) =>
  sesion.email_verified && sesion.proveedor === 'google.com' && enLista(env.SUPERADMIN_EMAILS, sesion.email);

export const requiereSuperadmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!esSuperadmin(c.var.sesion, c.env)) return c.json({ error: 'acceso_denegado' }, 403);
  await next();
});
