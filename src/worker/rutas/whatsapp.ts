// Webhook de WhatsApp (WAP-01, contrato-sarin.md sección b). Ruta PÚBLICA: Meta no tiene sesión; la firma es la autenticación.
// Nada de registrar cuerpos ni teléfonos.
import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { ipDe, limitar } from '../limite';
import { guardarEventos } from '../whatsapp/bandeja';
import { gatewayPara } from '../whatsapp';
import { enrutarEntrantes } from '../whatsapp/enrutar';
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
whatsapp.post('/webhook', limitar('LIMITE_WEBHOOK', ipDe), async (c) => {
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_WEBHOOK_BYTES) return c.json({ error: 'cuerpo_muy_grande' }, 413);
  const crudo = await leerConTope(c.req.raw, MAX_WEBHOOK_BYTES);
  if (!crudo) return c.json({ error: 'cuerpo_muy_grande' }, 413);

  const ahora = Date.now();
  let porEnrutar: string[];
  try {
    const eventos = await gatewayPara(c.env).parseWebhook(crudo, c.req.raw.headers);
    porEnrutar = await guardarEventos(c.env, eventos, ahora);
  } catch (e) {
    if (e instanceof ErrorWebhook) return c.json({ error: e.message }, e.estado);
    throw e;
  }
  // Enrutamiento (WAP-04) de los entrantes sin enrutar: los nuevos y los que un fallo dejó a medias (un evento ya
  // enrutado no se enruta dos veces). En segundo plano (B5).
  if (porEnrutar.length > 0) {
    const trabajo = enrutarEntrantes(c.env, porEnrutar);
    try {
      c.executionCtx.waitUntil(trabajo);
    } catch {
      await trabajo; // sin contexto de ejecución (pruebas con app.request): se espera aquí
    }
  }
  return c.json({ ok: true });
});
