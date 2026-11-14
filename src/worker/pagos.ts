// Reglas puras del pago por captura (B2): tipo de la imagen, desbloqueo preventivo y cuentas de pago.
import type { EstadoNegocio } from '../shared/acceso';
import type { ESTADOS_PAGO } from './db/schema';

export const MAX_CAPTURA_BYTES = 2 * 1024 * 1024;
export const DESBLOQUEO_MS = 24 * 3_600_000;

export type TipoImagen = { ext: 'jpg' | 'png' | 'webp'; contentType: 'image/jpeg' | 'image/png' | 'image/webp' };

const empieza = (bytes: Uint8Array, firma: number[], desde = 0) => firma.every((b, i) => bytes[desde + i] === b);

/** El tipo sale del contenido (firma de bytes), nunca de la extensión ni del `Content-Type` que declare el navegador. */
export function tipoDeImagen(bytes: Uint8Array): TipoImagen | null {
  if (empieza(bytes, [0xff, 0xd8, 0xff])) return { ext: 'jpg', contentType: 'image/jpeg' };
  if (empieza(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', contentType: 'image/png' };
  // RIFF....WEBP
  if (empieza(bytes, [0x52, 0x49, 0x46, 0x46]) && empieza(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { ext: 'webp', contentType: 'image/webp' };
  return null;
}

/**
 * Desbloqueo preventivo de 24 h al subir la captura: solo para un negocio vencido (quien ya puede operar no recibe nada,
 * y un suspendido tampoco) cuyo último pago revisado no fue rechazado. Sin pagos revisados (`null`) es elegible.
 */
export const elegibleDesbloqueo = (estado: EstadoNegocio, ultimoRevisado: (typeof ESTADOS_PAGO)[number] | null): boolean =>
  estado === 'EXPIRED_READONLY' && ultimoRevisado !== 'REJECTED';

/** Cuentas donde se paga (variable `PAYMENT_ACCOUNTS_JSON`). Si falta o no es una lista JSON, no hay cuentas. */
export function cuentasDePago(json: string | undefined): unknown[] {
  try {
    const cuentas: unknown = JSON.parse(json ?? '');
    return Array.isArray(cuentas) ? cuentas : [];
  } catch {
    return [];
  }
}
