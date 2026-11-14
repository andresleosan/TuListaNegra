// Interfaz `SarinGateway` tal como la fija docs/spec/contrato-sarin.md, sección (a).
// Única diferencia: el tono sale de src/shared/cobro.ts (los tonos reales de la app), así que la plantilla del
// segundo tono se llama `cobro_corte_de_quincena`. Los nombres son provisionales hasta que Meta los apruebe.
import type { Tono } from '../../shared/cobro';

export type E164 = string; // «+» y de 8 a 15 dígitos
export type WaMessageId = string; // «wamid.…» de Meta, o sintético en el simulador

export interface SarinGateway {
  /** Mensaje iniciado por el negocio. Único envío permitido fuera de la ventana. */
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  /** Mensaje libre. Falla con WINDOW_CLOSED si pasaron 24 h desde el último entrante. */
  sendReply(input: SendReplyInput): Promise<SendResult>;
  /** Verifica la firma sobre el cuerpo crudo y normaliza. Lanza `ErrorWebhook` si la firma o el cuerpo no valen. */
  parseWebhook(rawBody: ArrayBuffer, headers: Headers): Promise<SarinEvent[]>;
  /** Reto GET de alta del webhook; null si el modo o el token no coinciden. */
  verifyChallenge(url: URL): string | null;
  /** Descarga un medio entrante para guardarlo en R2. */
  fetchMedia(mediaId: string): Promise<{ bytes: ArrayBuffer; mimeType: string }>;
}

export interface SendBase {
  to: E164;
  /** Clave de idempotencia: reenviar la misma no manda dos mensajes. */
  requestId: string;
  /** Vuelve intacto en los eventos de estado, para conciliar. Sin datos personales. */
  callbackData?: string;
}
export type NombrePlantilla = `cobro_${Lowercase<Tono>}` | 'aviso_abono_pendiente' | 'codigo_verificacion' | 'aviso_vencimiento' | 'prueba_puente';
export interface SendTemplateInput extends SendBase {
  template: NombrePlantilla;
  language: 'es_CO';
  variables: string[]; // en el orden de la plantilla
  buttonPayloads?: string[]; // respuestas rápidas, máximo 3
}
export interface SendReplyInput extends SendBase {
  replyTo?: WaMessageId;
  content:
    | { kind: 'text'; text: string } // hasta 4096
    | { kind: 'buttons'; text: string; buttons: { id: string; title: string }[] } // 1 a 3, título ≤ 20
    | { kind: 'image'; r2Key: string; caption?: string }; // tirilla
}
export type CodigoRechazo = 'WINDOW_CLOSED' | 'INVALID_TEMPLATE' | 'RATE_LIMITED' | 'OTHER';
export type SendResult =
  | { status: 'accepted'; waMessageId: WaMessageId }
  | { status: 'rejected'; code: CodigoRechazo; retryable: boolean }
  | { status: 'unknown' }; // timeout o 5xx: pudo salir. No se reintenta solo.

export interface EventBase {
  waMessageId: WaMessageId; // clave de idempotencia (UNIQUE en whatsapp_messages)
  occurredAt: number; // ms UTC
  phoneNumberId: string; // número nuestro que lo recibió
}
export interface InboundBase extends EventBase {
  from: E164;
  profileName?: string;
  replyToWaMessageId?: WaMessageId; // paso 2 del enrutamiento de B4
}
export type SarinEvent =
  | (InboundBase & { kind: 'text'; text: string })
  | (InboundBase & { kind: 'button'; buttonId: string; title: string })
  | (InboundBase & { kind: 'image'; mediaId: string; mimeType: string; sha256?: string; caption?: string })
  | (EventBase & { kind: 'status'; status: 'sent' | 'delivered' | 'read' | 'failed'; errorCode?: number; callbackData?: string });

/** Por qué se rechaza un webhook: 401 si la firma no vale (o no hay secreto), 400 si el cuerpo firmado no es válido. */
export class ErrorWebhook extends Error {
  constructor(readonly estado: 400 | 401, motivo: string) {
    super(motivo);
  }
}
