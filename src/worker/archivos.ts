// Archivos privados de R2 (B5): nunca hay URL pública; solo se sirven por rutas autenticadas.
import type { Context } from 'hono';
import type { AppEnv } from './auth';

/**
 * Clave tal como las genera el servidor: segmentos de letras, dígitos, `_`, `-` y `.` separados por una sola `/`.
 * Ningún segmento empieza por punto, así que no caben `.` ni `..`; tampoco `%` (nada codificado), barra inicial ni `//`.
 */
export const claveValida = (clave: string): boolean => /^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/.test(clave);

/**
 * Sirve un objeto de R2 SIN comprobar de quién es: quien la llame responde de que la sesión puede verlo
 * (su dueño en `/api/archivos/*`, o el superadministrador desde su consola).
 */
export async function servirObjeto(c: Context<AppEnv>, clave: string): Promise<Response> {
  const objeto = claveValida(clave) ? await c.env.ARCHIVOS.get(clave) : null;
  if (!objeto) return c.json({ error: 'no_encontrado' }, 404);
  return new Response(objeto.body, {
    headers: {
      'Content-Type': objeto.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}
