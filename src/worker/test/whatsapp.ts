// Inyector de entrantes (contrato-sarin.md, d.4): arma el cuerpo en el formato de Meta, lo FIRMA con el secreto de
// desarrollo y lo manda al webhook real. No hay atajo que salte la firma (A1.7): sin firma buena, el webhook dice 401.
import { env } from 'cloudflare:workers';
import { app } from '../index';

/** Secreto de desarrollo. El prefijo `tln-dev-whatsapp` lo vigila `pnpm check:release` (d.10): nunca en producción. */
export const SECRETO_DEV = 'tln-dev-whatsapp-secreto-de-pruebas';
export const TOKEN_DEV = 'tln-dev-whatsapp-token-de-verificacion';
export const PHONE_NUMBER_ID = '100000000000001'; // ficticio

/** El entorno de pruebas con los secretos de WhatsApp de desarrollo. */
export const entornoWa = (extra: Partial<Env> = {}): Env => ({ ...env, WHATSAPP_APP_SECRET: SECRETO_DEV, WHATSAPP_VERIFY_TOKEN: TOKEN_DEV, ...extra });

const segundos = (ms: number) => String(Math.floor(ms / 1000));
const sinMas = (telefono: string) => telefono.replace(/^\+/, '');
let siguiente = 1;
const wamid = () => `wamid.PRUEBA.${Date.now()}.${siguiente++}`;

type Comun = { de: string; id?: string; en?: number; respondeA?: string };
const base = ({ de, id = wamid(), en = Date.now(), respondeA }: Comun) => ({
  id, from: sinMas(de), timestamp: segundos(en), ...(respondeA ? { context: { id: respondeA } } : {}),
});

/** Mensajes entrantes en el formato de Meta (sección b). */
export const entrante = {
  texto: (c: Comun & { texto: string }) => ({ ...base(c), type: 'text', text: { body: c.texto } }),
  /** Botón de un mensaje interactivo nuestro. */
  boton: (c: Comun & { botonId: string; titulo: string }) => ({
    ...base(c), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: c.botonId, title: c.titulo } },
  }),
  /** Respuesta rápida de una plantilla. */
  botonPlantilla: (c: Comun & { payload: string; texto: string }) => ({ ...base(c), type: 'button', button: { payload: c.payload, text: c.texto } }),
  imagen: (c: Comun & { mediaId: string; mimeType?: string; caption?: string }) => ({
    ...base(c), type: 'image', image: { id: c.mediaId, mime_type: c.mimeType ?? 'image/jpeg', ...(c.caption ? { caption: c.caption } : {}) },
  }),
};

/** Estado de un mensaje nuestro. */
export const estado = (id: string, status: string, { en = Date.now(), codigo, callbackData }: { en?: number; codigo?: number; callbackData?: string } = {}) => ({
  id, status, timestamp: segundos(en),
  ...(callbackData ? { biz_opaque_callback_data: callbackData } : {}),
  ...(codigo !== undefined ? { errors: [{ code: codigo }] } : {}),
});

/** Cuerpo completo de Meta con los mensajes y estados indicados. */
export function cuerpoMeta({ mensajes = [], estados = [] }: { mensajes?: ({ from: string } & Record<string, unknown>)[]; estados?: object[] }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '200000000000002', // WABA ficticia
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          ...(mensajes.length ? { contacts: mensajes.map((m) => ({ wa_id: m.from, profile: { name: 'Cliente de prueba' } })), messages: mensajes } : {}),
          ...(estados.length ? { statuses: estados } : {}),
        },
      }],
    }],
  };
}

/** `sha256=<hex>`: HMAC-SHA-256 de los bytes exactos con el secreto. */
export async function firmar(bytes: Uint8Array, secreto = SECRETO_DEV): Promise<string> {
  const clave = await crypto.subtle.importKey('raw', new TextEncoder().encode(secreto), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = new Uint8Array(await crypto.subtle.sign('HMAC', clave, bytes));
  return `sha256=${[...firma].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** POST al webhook real con estos bytes y esta cabecera de firma (`null` = sin cabecera). */
export function postWebhook(bytes: Uint8Array, firma: string | null, entorno: Env = entornoWa()) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Content-Length': String(bytes.byteLength) });
  if (firma !== null) headers.set('X-Hub-Signature-256', firma);
  return app.request('/api/whatsapp/webhook', { method: 'POST', body: bytes, headers }, entorno);
}

/** Serializa, firma con el secreto de desarrollo y envía al webhook: lo que haría Meta. */
export async function inyectar(cuerpo: unknown, entorno: Env = entornoWa()) {
  const bytes = new TextEncoder().encode(JSON.stringify(cuerpo));
  return postWebhook(bytes, await firmar(bytes, entorno.WHATSAPP_APP_SECRET ?? SECRETO_DEV), entorno);
}
