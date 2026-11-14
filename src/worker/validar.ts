// Validación de toda entrada con zod (B1). Un cuerpo inválido corta la petición con 400 y el detalle por campo.
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export async function cuerpo<T extends z.ZodType>(c: Context, esquema: T): Promise<z.infer<T>> {
  const resultado = esquema.safeParse(await c.req.json().catch(() => null));
  if (resultado.success) return resultado.data;
  const campos = z.flattenError(resultado.error).fieldErrors;
  throw new HTTPException(400, { res: c.json({ error: 'datos_invalidos', campos }, 400) });
}

/** ¿El error es una violación del índice único que toca esa columna? Drizzle envuelve el error de D1 en `cause`. */
export function esUnico(e: unknown, columna: string): boolean {
  for (let err = e; err instanceof Error; err = err.cause) {
    if (/UNIQUE constraint failed/.test(err.message) && err.message.includes(columna)) return true;
  }
  return false;
}
