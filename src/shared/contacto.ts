// Reglas de contacto para cobrar por WhatsApp (docs/spec/producto.md, B6).
// Módulo puro: sin I/O; lo usan igual el navegador y el Worker.
import festivos from './festivos-co.json';

export type MotivoBloqueo =
  | 'SIN_CONSENTIMIENTO'
  | 'BAJA'
  | 'DOMINGO'
  | 'FESTIVO'
  | 'FUERA_DE_HORARIO'
  | 'YA_COBRADO_HOY'
  | 'FRECUENCIA'
  | 'FESTIVOS_SIN_DATOS';

export type DeudorContactable = {
  wa_consent_at: number | null;
  wa_opt_out_at: number | null;
  last_reminder_sent_at: number | null;
};

export type ResultadoContacto =
  | { permitido: true }
  | { permitido: false; motivo: MotivoBloqueo; mensaje: string };

const HORA = 3_600_000;
const DIA = 24 * HORA;
// America/Bogota es UTC−5 fijo: Colombia no tiene horario de verano.
const DESFASE_BOGOTA = -5 * HORA;

const FESTIVOS: Record<string, string[]> = festivos.anios;

// Día de calendario de Bogotá, contado desde la época.
const diaBogota = (t: number) => Math.floor((t + DESFASE_BOGOTA) / DIA);

const bloqueo = (motivo: MotivoBloqueo, mensaje: string): ResultadoContacto => ({
  permitido: false,
  motivo,
  mensaje,
});

/**
 * Dice si se le puede cobrar a un deudor en el instante `ahora` (milisegundos UTC).
 *
 * Orden de evaluación, fijo: consentimiento → baja → domingo → festivo (o año sin
 * datos de festivos) → horario → ya cobrado hoy → frecuencia. Gana el primero que bloquea.
 *
 * Bordes:
 * - Horario cerrado por ambos lados: 7:00:00 y 19:00:00 en punto se permiten; un
 *   milisegundo después de las 19:00:00 ya no (sábados, igual con 8:00 y 15:00).
 * - Cualquier baja registrada bloquea, aunque el consentimiento sea posterior.
 * - «Hoy» es el día de calendario de Bogotá. La frecuencia cuenta tiempo transcurrido:
 *   a los `diasEntreCobros` × 24 h exactas ya se permite.
 * - `diasEntreCobros` menor que 1 se trata como 1.
 * - Año sin lista de festivos: bloquea (falla cerrado).
 */
export function puedeContactar(
  deudor: DeudorContactable,
  ahora: number,
  opciones?: { diasEntreCobros?: number },
): ResultadoContacto {
  if (deudor.wa_consent_at === null) {
    return bloqueo(
      'SIN_CONSENTIMIENTO',
      'Este deudor no ha autorizado que le escriban por WhatsApp. Pídele permiso y regístralo antes de cobrar.',
    );
  }
  if (deudor.wa_opt_out_at !== null) {
    return bloqueo('BAJA', 'Este deudor pidió que no le escriban más por WhatsApp.');
  }

  // Reloj de pared de Bogotá: se lee con los métodos UTC de un Date ya desplazado.
  const local = new Date(ahora + DESFASE_BOGOTA);
  const diaSemana = local.getUTCDay();
  if (diaSemana === 0) {
    return bloqueo('DOMINGO', 'Los domingos no se cobra. Podrás cobrar el siguiente día hábil.');
  }

  const fecha = local.toISOString().slice(0, 10);
  const festivosDelAnio = FESTIVOS[fecha.slice(0, 4)];
  if (!festivosDelAnio) {
    return bloqueo(
      'FESTIVOS_SIN_DATOS',
      'Todavía no tenemos el calendario de festivos de este año, así que por ahora no se puede cobrar.',
    );
  }
  if (festivosDelAnio.includes(fecha)) {
    return bloqueo('FESTIVO', 'Hoy es festivo en Colombia. Podrás cobrar el siguiente día hábil.');
  }

  const hora = (local.getTime() % DIA) / HORA;
  const [abre, cierra] = diaSemana === 6 ? [8, 15] : [7, 19];
  if (hora < abre || hora > cierra) {
    return bloqueo(
      'FUERA_DE_HORARIO',
      'Estás fuera del horario de cobro: lunes a viernes de 7:00 a 19:00 y sábados de 8:00 a 15:00.',
    );
  }

  const ultimo = deudor.last_reminder_sent_at;
  if (ultimo !== null) {
    if (diaBogota(ultimo) === diaBogota(ahora)) {
      return bloqueo('YA_COBRADO_HOY', 'Ya le cobraste hoy a este deudor. Solo se permite un cobro al día.');
    }
    const pedido = opciones?.diasEntreCobros ?? 7;
    const dias = pedido >= 1 ? pedido : 1; // también cubre NaN
    if (ahora - ultimo < dias * DIA) {
      return bloqueo(
        'FRECUENCIA',
        `Ya le cobraste hace poco a este deudor. Solo se permite un cobro cada ${dias === 1 ? 'día' : `${dias} días`}.`,
      );
    }
  }

  return { permitido: true };
}
