// Webhook de WhatsApp (WAP-01, contrato-sarin.md sección b). Ruta PÚBLICA: Meta no tiene sesión; la firma es la autenticación.
// Nada de registrar cuerpos ni teléfonos.
import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { guardarEventos } from '../whatsapp/bandeja';
import { gatewayPara } from '../whatsapp';
import { MAX_WEBHOOK_BYTES } from '../whatsapp/meta';
import { ErrorWebhook } from '../whatsapp/tipos';

export const whatsapp = new Hono<AppEnv>();

/** Lee el cuerpo una sola vez y corta en cuanto pasa del tope, aunque `Content-Length` mienta o no venga. */
async function leerConTope(peticion: Request, tope: number): Promise<ArrayBuffer | null> {
  if (!peticion.body) return new ArrayBuffer(0);
  const lector = peticion.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > tope) {
      await lector.cancel();
      return null;
    }
    partes.push(value);
  }
  const todo = new Uint8Array(total);
  let i = 0;
  for (const parte of partes) {
    todo.set(parte, i);
    i += parte.byteLength;
  }
  return todo.buffer;
}

// Reto de alta (solo variante A, pero no estorba): 200 con `hub.challenge` tal cual, o 403.
whatsapp.get('/webhook', (c) => {
  const reto = gatewayPara(c.env).verifyChallenge(new URL(c.req.url));
  return reto === null ? c.text('', 403) : c.text(reto, 200);
});

// Orden obligatorio: tamaño → bytes crudos → firma → JSON + zod → guardar por wa_message_id → 200.
whatsapp.post('/webhook', async (c) => {
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_WEBHOOK_BYTES) return c.json({ error: 'cuerpo_muy_grande' }, 413);
  const crudo = await leerConTope(c.req.raw, MAX_WEBHOOK_BYTES);
  if (!crudo) return c.json({ error: 'cuerpo_muy_grande' }, 413);

  const ahora = Date.now();
  try {
    const eventos = await gatewayPara(c.env).parseWebhook(crudo, c.req.raw.headers);
    await guardarEventos(c.env, eventos, ahora);
    // Aquí, con ctx.waitUntil y solo para los entrantes NUEVOS que devuelve guardarEventos, irá el enrutamiento (WAP-04).
  } catch (e) {
    if (e instanceof ErrorWebhook) return c.json({ error: e.message }, e.estado);
    throw e;
  }
  return c.json({ ok: true });
});
