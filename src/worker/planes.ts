// Constante única de planes (B2). Vive en el servidor: el navegador nunca envía precio ni días.
import type { businesses } from './db/schema';

type Negocio = typeof businesses.$inferSelect;

export type Cuotas = {
  /** Máximo de deudores; null = sin límite. */
  deudores: number | null;
  ocr: number;
  ia: number;
  cobros: number;
};

const HORA = 3_600_000;
export const DIA = 24 * HORA;

export const PLANES = {
  TRIAL_3D: { nombre: 'Prueba de 3 días', duracion_ms: 72 * HORA, precio_cop: 0, cuotas: { deudores: 15, ocr: 3, ia: 10, cobros: 5 } },
  PASS_7D: { nombre: 'Pase de 7 días', duracion_ms: 7 * DIA, precio_cop: 14_900, cuotas: { deudores: null, ocr: 10, ia: 50, cobros: 40 } },
  PASS_15D: { nombre: 'Pase de 15 días', duracion_ms: 15 * DIA, precio_cop: 27_900, cuotas: { deudores: null, ocr: 25, ia: 120, cobros: 100 } },
  PASS_30D: { nombre: 'Pase de 30 días', duracion_ms: 30 * DIA, precio_cop: 49_900, cuotas: { deudores: null, ocr: 60, ia: 300, cobros: 250 } },
} as const satisfies Record<Negocio['subscription_plan'], { nombre: string; duracion_ms: number; precio_cop: number; cuotas: Cuotas }>;

/** Suscripción gratis (cortesía): sin vencimiento; sus contadores se reinician cada 30 días. */
export const CUOTAS_GRATIS: Cuotas = { deudores: null, ocr: 60, ia: 300, cobros: 250 };
export const CICLO_GRATIS_MS = 30 * DIA;

/** Los pases que se pueden comprar (la prueba no se compra). */
export const PASES = ['PASS_7D', 'PASS_15D', 'PASS_30D'] as const;

export const cuotasDe = (negocio: Pick<Negocio, 'free_forever_at' | 'subscription_plan'>): Cuotas =>
  negocio.free_forever_at !== null ? CUOTAS_GRATIS : PLANES[negocio.subscription_plan].cuotas;
