// Estado del deudor (B3): se calcula, no se guarda. Función pura compartida por navegador y servidor.

export type EstadoDeudor = 'LISTA_NEGRA' | 'AL_DIA' | 'PROMESA_PAGO' | 'EN_MORA' | 'CON_SALDO';

export type DatosDeEstadoDeudor = {
  blacklisted_at: number | null;
  current_balance_cop: number;
  /** Fecha del fiado sin cubrir más antiguo. */
  oldest_unpaid_date: number | null;
  /** Inicio (00:00 de Bogotá, en ms UTC) del día en que prometió pagar. La promesa vale hasta que ese día termina. */
  promised_payment_date: number | null;
};

const DIA = 86_400_000;

/** Orden fijo de B3: lista negra → al día → promesa vigente → en mora → con saldo. */
export function estadoDeudor(d: DatosDeEstadoDeudor, ahora: number, diasDeAlerta: number): EstadoDeudor {
  if (d.blacklisted_at !== null) return 'LISTA_NEGRA'; // marca manual y privada del tendero
  if (d.current_balance_cop === 0) return 'AL_DIA';
  const promesa = d.promised_payment_date;
  if (promesa !== null && ahora < promesa + DIA) return 'PROMESA_PAGO';
  const promesaVencida = promesa !== null;
  const fiadoViejo = d.oldest_unpaid_date !== null && ahora - d.oldest_unpaid_date > diasDeAlerta * DIA;
  return promesaVencida || fiadoViejo ? 'EN_MORA' : 'CON_SALDO';
}

/** Lo que la app guarda en su copia local para buscar y pintar la lista. Nunca el documento completo ni el teléfono. */
export type DeudorResumen = DatosDeEstadoDeudor & {
  id: string;
  unique_code: string;
  full_name: string;
  alias_reference: string | null;
  doc_last4: string | null;
  credit_limit_cop: number | null;
  archived_at: number | null;
  wa_consent_at: number | null;
  wa_opt_out_at: number | null;
  last_reminder_sent_at: number | null;
  tiene_whatsapp: boolean;
};

/** La ficha completa: solo se pide al abrir un deudor. */
export type DeudorDetalle = DeudorResumen & {
  doc_type: string | null;
  doc_number: string | null;
  whatsapp_phone: string | null;
  created_at: number;
};

export const TIPOS_DOCUMENTO = ['CC', 'CE', 'TI', 'NIT', 'PA', 'PPT'] as const;
