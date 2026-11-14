import { Hono } from 'hono';
import { servirObjeto } from '../archivos';
import type { AppEnv } from '../auth';

export const archivos = new Hono<AppEnv>();

const RUTA = '/api/archivos/';

// Un negocio solo lee lo que cuelga de su propia carpeta. Lo ajeno responde 404, igual que lo inexistente: no se confirma que exista.
archivos.get('/*', async (c) => {
  const clave = c.req.path.slice(RUTA.length);
  if (!clave.startsWith(`negocios/${c.var.negocio.id}/`)) return c.json({ error: 'no_encontrado' }, 404);
  return servirObjeto(c, clave);
});
