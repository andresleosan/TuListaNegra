// Texto de los cobros (A2 n.º 6, B6): plantillas FIJAS con variables. La IA no redacta cobros.
// Cada mensaje dice quién cobra, cuánto, cómo pagar y cómo darse de baja. Nunca amenaza, avergüenza ni menciona listas o reportes.
import { formatoCOP } from './dinero';

export const TONOS = ['VECINO_AMIGABLE', 'CORTE_DE_QUINCENA', 'AVISO_FIRME'] as const;
export type Tono = (typeof TONOS)[number];

export const NOMBRE_TONO: Record<Tono, string> = {
  VECINO_AMIGABLE: 'Vecino amigable',
  CORTE_DE_QUINCENA: 'Corte de quincena',
  AVISO_FIRME: 'Aviso firme',
};

export type DatosDeCobro = { tienda: string; nombre: string; saldo_cop: number; medios_de_pago: string | null };

const PLANTILLAS: Record<Tono, (d: DatosDeCobro & { saldo: string }) => string> = {
  VECINO_AMIGABLE: (d) => `Hola ${d.nombre}, le saluda ${d.tienda}. Le recordamos con mucho gusto que tiene un saldo pendiente de ${d.saldo}.`,
  CORTE_DE_QUINCENA: (d) => `Hola ${d.nombre}, le escribe ${d.tienda}. Llegó la quincena y su saldo pendiente con nosotros es de ${d.saldo}.`,
  AVISO_FIRME: (d) => `${d.nombre}, le escribe ${d.tienda}. Su saldo pendiente es de ${d.saldo} y ya pasó el plazo acordado. Le pedimos ponerse al día o decirnos qué día puede pagar.`,
};

/** La frase de cómo pagar, con un solo punto final. La usan el cobro por enlace y la plantilla del bot. */
export const comoPagar = (medios: string | null | undefined) =>
  // Una sola línea: Meta rechaza variables de plantilla con saltos de línea, tabuladores o espacios repetidos.
  medios?.trim() ? `Puede pagar así: ${medios.replace(/\s+/g, ' ').replace(/[.\s]*$/, '')}.` : 'Puede pagar directamente en la tienda.';

export function textoDeCobro(tono: Tono, d: DatosDeCobro): string {
  return [
    PLANTILLAS[tono]({ ...d, saldo: formatoCOP(d.saldo_cop) }),
    comoPagar(d.medios_de_pago),
    'Si ya pagó, no tenga en cuenta este mensaje. Si no quiere recibir más recordatorios, responda SALIR.',
  ].join(' ');
}

/** Enlace que abre el WhatsApp del propio tendero con el mensaje ya escrito (fase 1). `telefono` en E.164. */
export const enlaceWhatsApp = (telefono: string, texto: string) => `https://wa.me/${telefono.replace(/\D/g, '')}?text=${encodeURIComponent(texto)}`;
