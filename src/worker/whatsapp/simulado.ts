// `SimulatedGateway` (contrato-sarin.md, d.1–d.5 y d.8): misma interfaz que el real y NUNCA sale a la red.
// Cada envío queda en `whatsapp_messages` (la bandeja de salida) con un `wa_message_id` sintético.
import { desc, and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { bd } from '../db';
import { whatsapp_messages as wa } from '../db/schema';
import { nuevoId, ulid } from '../../shared/ids';
import catalogo from './plantillas.json';
import { normalizar, verificarFirma, verificarReto } from './meta';
import type { CodigoRechazo, SarinEvent, SarinGateway, SendBase, SendReplyInput, SendResult, SendTemplateInput } from './tipos';

/** Ventana de atención de WhatsApp: fuera de ella solo se permite una plantilla. */
export const VENTANA_MS = 24 * 3_600_000;
const E164 = /^\+\d{8,15}$/;
const PLANTILLAS = new Map(catalogo.plantillas.map((p) => [p.nombre, p]));

const contenidoRespuesta = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(4096) }),
  z.object({
    kind: z.literal('buttons'), text: z.string().min(1).max(4096),
    buttons: z.array(z.object({ id: z.string().min(1), title: z.string().min(1).max(20) })).min(1).max(3),
  }),
  z.object({ kind: z.literal('image'), r2Key: z.string().min(1), caption: z.string().optional() }),
]);

/** Medios de muestra (d.8): imágenes mínimas reconocibles por su firma, y un archivo que no es imagen. */
const MEDIOS: Record<string, { bytes: number[]; mimeType: string }> = {
  'sim-png': { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0], mimeType: 'image/png' },
  'sim-jpeg': { bytes: [0xff, 0xd8, 0xff, 0xe0, 0, 0x10], mimeType: 'image/jpeg' },
  'sim-webp': { bytes: [0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], mimeType: 'image/webp' },
  'sim-no-imagen': { bytes: [...new TextEncoder().encode('no soy una imagen')], mimeType: 'image/jpeg' }, // miente en el tipo a propósito
};

type FilaEnvio = Pick<typeof wa.$inferSelect, 'status' | 'wa_message_id' | 'error_code'>;
const resultadoDe = (f: FilaEnvio): SendResult =>
  f.status === 'rejected' ? { status: 'rejected', code: f.error_code as CodigoRechazo, retryable: f.error_code === 'RATE_LIMITED' }
    : f.status === 'unknown' ? { status: 'unknown' }
    : { status: 'accepted', waMessageId: f.wa_message_id! };

type Envio = Pick<typeof wa.$inferInsert, 'kind' | 'template' | 'content_json' | 'buttons_json' | 'reply_to_wa_message_id'>;

/**
 * A1.6: con WHATSAPP_SEND_READY apagado no se recogen mensajes del público. El simulador solo acepta secretos de
 * desarrollo (prefijo que `check:release` impide en producción): con un secreto real de Meta, firma 401 y reto 403.
 */
export const PREFIJO_DEV = 'tln-dev-whatsapp-';
const soloDesarrollo = (valor: string | undefined) => (valor?.startsWith(PREFIJO_DEV) ? valor : undefined);

export class SimulatedGateway implements SarinGateway {
  /** `ahora` es el reloj inyectable (d.5): las pruebas mueven el tiempo sin esperar. */
  constructor(private readonly env: Env, private readonly ahora: () => number = Date.now) {}

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const p = PLANTILLAS.get(input.template);
    const valida = p && p.idioma === input.language && input.variables.length === p.variables && input.variables.every((v) => v.trim());
    const rechazo: CodigoRechazo | null = !valida ? 'INVALID_TEMPLATE' : (input.buttonPayloads?.length ?? 0) > 3 ? 'OTHER' : null;
    const texto = p ? p.texto.replace(/\{\{(\d+)\}\}/g, (_, n: string) => input.variables[Number(n) - 1] ?? '') : null;
    return this.guardar(input, rechazo, {
      kind: 'template', template: input.template,
      content_json: JSON.stringify({ language: input.language, variables: input.variables, texto: valida ? texto : null }),
      buttons_json: input.buttonPayloads ? JSON.stringify(input.buttonPayloads) : null,
    });
  }

  async sendReply(input: SendReplyInput): Promise<SendResult> {
    const contenido = contenidoRespuesta.safeParse(input.content);
    let rechazo: CodigoRechazo | null = contenido.success ? null : 'OTHER';
    if (!rechazo) {
      const ultimo = await bd(this.env).select({ occurred_at: wa.occurred_at }).from(wa)
        .where(and(eq(wa.phone, input.to), eq(wa.direction, 'ENTRANTE'))).orderBy(desc(wa.occurred_at)).limit(1).get();
      if (!ultimo || this.ahora() - ultimo.occurred_at >= VENTANA_MS) rechazo = 'WINDOW_CLOSED';
    }
    const { kind } = input.content;
    return this.guardar(input, rechazo, {
      kind,
      content_json: JSON.stringify(kind === 'buttons' ? { text: input.content.text } : { ...input.content, kind: undefined }),
      buttons_json: kind === 'buttons' ? JSON.stringify(input.content.buttons) : null,
      reply_to_wa_message_id: input.replyTo ?? null,
    });
  }

  async parseWebhook(rawBody: ArrayBuffer, headers: Headers): Promise<SarinEvent[]> {
    // primero la firma; después, y solo después, el JSON
    await verificarFirma(rawBody, headers, soloDesarrollo(this.env.WHATSAPP_APP_SECRET));
    return normalizar(rawBody);
  }

  verifyChallenge(url: URL): string | null {
    return verificarReto(url, soloDesarrollo(this.env.WHATSAPP_VERIFY_TOKEN));
  }

  async fetchMedia(mediaId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
    const medio = MEDIOS[mediaId];
    if (!medio) throw new Error('medio_desconocido');
    return { bytes: new Uint8Array(medio.bytes).buffer, mimeType: medio.mimeType };
  }

  /** Un `requestId` ya usado devuelve lo que pasó la primera vez, sin enviar otra vez (también con dos llamadas a la vez). */
  private async guardar(input: SendBase, rechazo: CodigoRechazo | null, envio: Envio): Promise<SendResult> {
    const db = bd(this.env);
    const ahora = this.ahora();
    if (!rechazo && !E164.test(input.to)) rechazo = 'OTHER';
    const [nueva] = await db.insert(wa).values({
      ...envio, id: nuevoId('wam', ahora), direction: 'SALIENTE', request_id: input.requestId, phone: input.to,
      wa_message_id: rechazo ? null : `wamid.SIM.${ulid(ahora)}`, status: rechazo ? 'rejected' : 'accepted', error_code: rechazo,
      callback_data: input.callbackData ?? null, occurred_at: ahora, created_at: ahora,
    }).onConflictDoNothing({ target: wa.request_id }).returning();
    const fila = nueva ?? await db.select().from(wa).where(eq(wa.request_id, input.requestId)).get();
    return resultadoDe(fila!);
  }
}
