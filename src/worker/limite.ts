// Límites de frecuencia (B5) con el binding nativo de Cloudflare.
// ponytail: ventanas de 10 o 60 s por ubicación de Cloudflare; si hace falta un tope diario exacto, contar en D1.
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from './auth';

type Limitador = 'LIMITE_ALTAS' | 'LIMITE_SUBIDAS';

export const ipDe = (c: Context<AppEnv>) => c.req.header('CF-Connecting-IP') ?? 'desconocida';

export const limitar = (limitador: Limitador, clave: (c: Context<AppEnv>) => string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const { success } = await c.env[limitador].limit({ key: clave(c) });
    if (!success) return c.json({ error: 'demasiadas_peticiones' }, 429);
    await next();
  });
