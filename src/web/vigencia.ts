// Aviso de días restantes del plan. Función pura: el vencimiento llega del servidor (`vence_en`).

const HORA = 3_600_000;
const DIA = 24 * HORA;
// America/Bogota es UTC−5 fijo: Colombia no tiene horario de verano.
const diaEnBogota = (ms: number) => Math.floor((ms - 5 * HORA) / DIA);

/**
 * «Te quedan 3 días», «Te queda 1 día», «Vence hoy» o «Vencido».
 * Los días se redondean hacia arriba (72 h recién estrenadas son 3 días, y 49 h también: aún no son 2).
 * «Vence hoy» manda cuando el vencimiento cae en el día de hoy del calendario de Colombia.
 */
export function avisoVigencia(venceEn: number, ahora: number): string {
  if (venceEn <= ahora) return 'Vencido';
  if (diaEnBogota(venceEn) === diaEnBogota(ahora)) return 'Vence hoy';
  const dias = Math.ceil((venceEn - ahora) / DIA);
  return dias === 1 ? 'Te queda 1 día' : `Te quedan ${dias} días`;
}

type Vigencia = { estado: string; gratis: boolean; vence_en: number | null };

/**
 * Aviso de estado para la cabecera: `null` si no hay nada que avisar (cuenta gratis: sin fecha ni renovación).
 * `tono` dice cómo pintarlo; el texto siempre lo explica por sí solo.
 */
export function avisoDeEstado(negocio: Vigencia, ahora: number): { texto: string; tono: 'normal' | 'atencion' | 'peligro' } | null {
  if (negocio.estado === 'EXPIRED_READONLY') return { texto: 'Plan vencido · solo puedes consultar', tono: 'peligro' };
  if (negocio.estado === 'GRACE_UNLOCK_24H') return { texto: 'Pago en revisión · desbloqueo de 24 horas', tono: 'atencion' };
  if (negocio.gratis || negocio.vence_en === null) return null;
  const aviso = avisoVigencia(negocio.vence_en, ahora);
  if (negocio.estado === 'TRIAL') return { texto: `Prueba · ${aviso}`, tono: 'atencion' };
  return { texto: aviso, tono: negocio.vence_en - ahora <= 3 * DIA ? 'atencion' : 'normal' };
}

/** «martes, 17 de noviembre, 4:23 p. m.», en hora de Colombia. */
export const fechaLarga = (ms: number) =>
  new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }).format(ms);
