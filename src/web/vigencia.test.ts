import { expect, test } from 'vitest';
import { avisoDeEstado, avisoVigencia, fechaLarga } from './vigencia';

const HORA = 3_600_000;
const DIA = 24 * HORA;
// Sábado 14 de noviembre de 2026, 10:00 a. m. en Colombia (15:00 UTC).
const AHORA = Date.UTC(2026, 10, 14, 15, 0);

test('una prueba recién creada (72 h) dice exactamente «Te quedan 3 días»', () => {
  expect(avisoVigencia(AHORA + 72 * HORA, AHORA)).toBe('Te quedan 3 días');
  // …y lo sigue diciendo segundos después, cuando la app lo pinta.
  expect(avisoVigencia(AHORA + 72 * HORA, AHORA + 5_000)).toBe('Te quedan 3 días');
});

test.each([
  [30 * DIA, 'Te quedan 30 días'],
  [72 * HORA + 1, 'Te quedan 4 días'],
  [48 * HORA + 1, 'Te quedan 3 días'],
  [48 * HORA, 'Te quedan 2 días'],
  [24 * HORA + 1, 'Te quedan 2 días'],
  [24 * HORA, 'Te queda 1 día'],
  [15 * HORA, 'Te queda 1 día'], // vence mañana a la 1:00 a. m.
  [14 * HORA, 'Te queda 1 día'], // vence mañana a las 12:00 a. m. en punto
  [14 * HORA - 1, 'Vence hoy'], // vence hoy a las 11:59 p. m.
  [1, 'Vence hoy'],
  [0, 'Vencido'],
  [-DIA, 'Vencido'],
])('faltando %i ms → %s', (falta, esperado) => {
  expect(avisoVigencia(AHORA + falta, AHORA)).toBe(esperado);
});

test('«hoy» es el día de Colombia, no el de UTC', () => {
  // 9:00 p. m. del sábado en Colombia ya es domingo en UTC; vence a las 11:00 p. m. del mismo sábado.
  const noche = Date.UTC(2026, 10, 15, 2, 0);
  expect(avisoVigencia(noche + 2 * HORA, noche)).toBe('Vence hoy');
  // 11:00 p. m. del sábado; vence a la 1:00 a. m. del domingo: ya no es hoy.
  const tarde = Date.UTC(2026, 10, 15, 4, 0);
  expect(avisoVigencia(tarde + 2 * HORA, tarde)).toBe('Te queda 1 día');
});

test('fechaLarga escribe la fecha en hora de Colombia', () => {
  expect(fechaLarga(AHORA + 72 * HORA)).toMatch(/^martes,? 17 de noviembre,? 10:00\sa/);
});

test('cabecera: la prueba recién creada lleva «Te quedan 3 días»', () => {
  expect(avisoDeEstado({ estado: 'TRIAL', gratis: false, vence_en: AHORA + 72 * HORA }, AHORA + 2_000)).toEqual({ texto: 'Prueba · Te quedan 3 días', tono: 'atencion' });
});

test('cabecera: una cuenta gratis no muestra vigencia', () => {
  expect(avisoDeEstado({ estado: 'ACTIVE', gratis: true, vence_en: null }, AHORA)).toBeNull();
  // Aunque llegara una fecha, la gratuidad manda.
  expect(avisoDeEstado({ estado: 'ACTIVE', gratis: true, vence_en: AHORA + DIA }, AHORA)).toBeNull();
});

test.each([
  [{ estado: 'ACTIVE', gratis: false, vence_en: AHORA + 20 * DIA }, { texto: 'Te quedan 20 días', tono: 'normal' }],
  [{ estado: 'ACTIVE', gratis: false, vence_en: AHORA + 3 * DIA }, { texto: 'Te quedan 3 días', tono: 'atencion' }],
  [{ estado: 'ACTIVE', gratis: false, vence_en: AHORA + HORA }, { texto: 'Vence hoy', tono: 'atencion' }],
  [{ estado: 'GRACE_UNLOCK_24H', gratis: false, vence_en: AHORA - HORA }, { texto: 'Pago en revisión · desbloqueo de 24 horas', tono: 'atencion' }],
  [{ estado: 'EXPIRED_READONLY', gratis: false, vence_en: AHORA - HORA }, { texto: 'Plan vencido · solo puedes consultar', tono: 'peligro' }],
])('cabecera: %o', (negocio, esperado) => {
  expect(avisoDeEstado(negocio, AHORA)).toEqual(esperado);
});
