import { describe, expect, test } from 'vitest';
import { puedeContactar, type DeudorContactable, type MotivoBloqueo } from './contacto';
import festivos from './festivos-co.json';

const t = (iso: string) => Date.parse(iso);

// Deudor con consentimiento, sin baja y sin cobros previos.
const BASE: DeudorContactable = {
  wa_consent_at: t('2026-01-15T09:00:00-05:00'),
  wa_opt_out_at: null,
  last_reminder_sent_at: null,
};

type Caso = {
  nombre: string;
  ahora: string;
  deudor?: Partial<DeudorContactable>;
  diasEntreCobros?: number;
  esperado: MotivoBloqueo | 'PERMITIDO';
};

// Referencias de calendario (Bogotá): 2026-11-15 domingo, 16 lunes festivo
// (Independencia de Cartagena trasladada), 17 martes, 20 viernes, 21 sábado, 24 martes.
const CASOS: Caso[] = [
  { nombre: 'martes a las 10:00', ahora: '2026-11-17T10:00:00-05:00', esperado: 'PERMITIDO' },

  // Consentimiento y baja
  { nombre: 'sin consentimiento', ahora: '2026-11-17T10:00:00-05:00', deudor: { wa_consent_at: null }, esperado: 'SIN_CONSENTIMIENTO' },
  { nombre: 'con baja', ahora: '2026-11-17T10:00:00-05:00', deudor: { wa_opt_out_at: t('2026-10-01T12:00:00-05:00') }, esperado: 'BAJA' },
  { nombre: 'sin consentimiento y con baja: gana el consentimiento', ahora: '2026-11-17T10:00:00-05:00', deudor: { wa_consent_at: null, wa_opt_out_at: t('2026-10-01T12:00:00-05:00') }, esperado: 'SIN_CONSENTIMIENTO' },
  { nombre: 'con baja en domingo: gana la baja', ahora: '2026-11-15T10:00:00-05:00', deudor: { wa_opt_out_at: t('2026-10-01T12:00:00-05:00') }, esperado: 'BAJA' },

  // Domingos y festivos
  { nombre: 'domingo a las 10:00', ahora: '2026-11-15T10:00:00-05:00', esperado: 'DOMINGO' },
  { nombre: 'lunes 03:00 en UTC, todavía domingo 22:00 en Bogotá', ahora: '2026-11-23T03:00:00Z', esperado: 'DOMINGO' },
  { nombre: 'festivo trasladado a lunes (Independencia de Cartagena)', ahora: '2026-11-16T10:00:00-05:00', esperado: 'FESTIVO' },
  { nombre: 'festivo de fecha fija (8 de diciembre, martes)', ahora: '2026-12-08T10:00:00-05:00', esperado: 'FESTIVO' },
  { nombre: 'Viernes Santo', ahora: '2026-04-03T10:00:00-05:00', esperado: 'FESTIVO' },
  { nombre: 'festivo fuera de horario: gana el festivo', ahora: '2026-11-16T22:00:00-05:00', esperado: 'FESTIVO' },

  // Año sin datos de festivos: falla cerrado
  { nombre: 'martes de 2031, año sin festivos cargados', ahora: '2031-03-04T10:00:00-05:00', esperado: 'FESTIVOS_SIN_DATOS' },
  { nombre: 'martes de 2025, año sin festivos cargados', ahora: '2025-11-18T10:00:00-05:00', esperado: 'FESTIVOS_SIN_DATOS' },
  { nombre: '1 de enero de 2031 en UTC, todavía 31 de diciembre de 2030 en Bogotá', ahora: '2031-01-01T03:00:00Z', esperado: 'FUERA_DE_HORARIO' },

  // Horario de lunes a viernes: 7:00–19:00, bordes incluidos
  { nombre: 'martes 06:59', ahora: '2026-11-17T06:59:00-05:00', esperado: 'FUERA_DE_HORARIO' },
  { nombre: 'martes 07:00 en punto', ahora: '2026-11-17T07:00:00-05:00', esperado: 'PERMITIDO' },
  { nombre: 'martes 19:00 en punto', ahora: '2026-11-17T19:00:00-05:00', esperado: 'PERMITIDO' },
  { nombre: 'martes 19:00:01', ahora: '2026-11-17T19:00:01-05:00', esperado: 'FUERA_DE_HORARIO' },
  { nombre: 'martes 19:01', ahora: '2026-11-17T19:01:00-05:00', esperado: 'FUERA_DE_HORARIO' },

  // Horario de sábado: 8:00–15:00, bordes incluidos
  { nombre: 'sábado 07:30', ahora: '2026-11-21T07:30:00-05:00', esperado: 'FUERA_DE_HORARIO' },
  { nombre: 'sábado 08:00 en punto', ahora: '2026-11-21T08:00:00-05:00', esperado: 'PERMITIDO' },
  { nombre: 'sábado 15:00 en punto', ahora: '2026-11-21T15:00:00-05:00', esperado: 'PERMITIDO' },
  { nombre: 'sábado 15:01', ahora: '2026-11-21T15:01:00-05:00', esperado: 'FUERA_DE_HORARIO' },

  // Un cobro al día (día de calendario de Bogotá)
  { nombre: 'segundo cobro el mismo día', ahora: '2026-11-17T16:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T08:00:00-05:00') }, esperado: 'YA_COBRADO_HOY' },
  { nombre: 'segundo cobro el mismo día con diasEntreCobros 0', ahora: '2026-11-17T16:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T08:00:00-05:00') }, diasEntreCobros: 0, esperado: 'YA_COBRADO_HOY' },
  { nombre: 'ya cobrado hoy pero fuera de horario: gana el horario', ahora: '2026-11-17T20:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T08:00:00-05:00') }, esperado: 'FUERA_DE_HORARIO' },

  // Frecuencia
  { nombre: 'segundo cobro en la semana (martes y viernes)', ahora: '2026-11-20T10:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T10:00:00-05:00') }, esperado: 'FRECUENCIA' },
  { nombre: 'un minuto antes de cumplir 7 días', ahora: '2026-11-24T09:59:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T10:00:00-05:00') }, esperado: 'FRECUENCIA' },
  { nombre: 'a los 7 días exactos', ahora: '2026-11-24T10:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T10:00:00-05:00') }, esperado: 'PERMITIDO' },
  { nombre: 'a los 3 días con diasEntreCobros 3', ahora: '2026-11-20T10:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T10:00:00-05:00') }, diasEntreCobros: 3, esperado: 'PERMITIDO' },
  { nombre: 'diasEntreCobros 0 vale 1: al día siguiente, antes de 24 h', ahora: '2026-11-18T08:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T18:00:00-05:00') }, diasEntreCobros: 0, esperado: 'FRECUENCIA' },
  { nombre: 'diasEntreCobros 0 vale 1: a las 24 h exactas', ahora: '2026-11-18T10:00:00-05:00', deudor: { last_reminder_sent_at: t('2026-11-17T10:00:00-05:00') }, diasEntreCobros: 0, esperado: 'PERMITIDO' },
];

describe('puedeContactar', () => {
  test.each(CASOS)('$nombre → $esperado', ({ ahora, deudor, diasEntreCobros, esperado }) => {
    const opciones = diasEntreCobros === undefined ? undefined : { diasEntreCobros };
    const resultado = puedeContactar({ ...BASE, ...deudor }, t(ahora), opciones);

    if (resultado.permitido) {
      expect(esperado).toBe('PERMITIDO');
      return;
    }
    expect(resultado.motivo).toBe(esperado);
    expect(resultado.mensaje.length).toBeGreaterThan(10);
    expect(resultado.mensaje).not.toMatch(/lista\s+negra/i);
  });
});

describe('festivos-co.json', () => {
  // Fecha fija: no se trasladan y pueden caer en cualquier día de la semana.
  const FIJOS = ['01-01', '05-01', '07-20', '08-07', '12-08', '12-25'];
  const diaSemana = (fecha: string) => new Date(`${fecha}T00:00:00Z`).getUTCDay();

  test('cubre de 2026 a 2030 y declara su fuente', () => {
    expect(Object.keys(festivos.anios)).toEqual(['2026', '2027', '2028', '2029', '2030']);
    expect(festivos.fuente).toMatch(/Ley 51 de 1983/);
  });

  // 19 festivos al año (los 18 de la Ley 51 de 1983 más el de la Ley 2578 de 2026).
  // En 2030 son 18 fechas: San Pedro y San Pablo y el Sagrado Corazón caen el 1 de julio.
  test.each([
    ['2026', 19],
    ['2027', 19],
    ['2028', 19],
    ['2029', 19],
    ['2030', 18],
  ] as const)('%s tiene %i fechas, del año, ordenadas y sin repetir', (anio, cuantas) => {
    const fechas = festivos.anios[anio];
    expect(fechas).toHaveLength(cuantas);
    expect(fechas).toEqual([...new Set(fechas)].sort());
    for (const fecha of fechas) expect(fecha).toMatch(new RegExp(`^${anio}-\\d{2}-\\d{2}$`));
  });

  test.each(Object.entries(festivos.anios))('%s: están los fijos y el resto cae en lunes, salvo Jueves y Viernes Santo', (anio, fechas) => {
    for (const fijo of FIJOS) expect(fechas).toContain(`${anio}-${fijo}`);

    const movibles = fechas.filter((fecha) => !FIJOS.includes(fecha.slice(5)));
    const noLunes = movibles.filter((fecha) => diaSemana(fecha) !== 1);

    // Los únicos que no son lunes: Jueves Santo y, al día siguiente, Viernes Santo.
    expect(noLunes.map(diaSemana)).toEqual([4, 5]);
    expect(Date.parse(noLunes[1]!) - Date.parse(noLunes[0]!)).toBe(86_400_000);
  });
});
