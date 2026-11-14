import { expect, test } from 'vitest';
import { type DatosDeEstadoDeudor, estadoDeudor } from './deudor';

const DIA = 86_400_000;
const AHORA = Date.parse('2026-11-17T10:00:00-05:00');
const HOY = Date.parse('2026-11-17T00:00:00-05:00');
const base: DatosDeEstadoDeudor = { blacklisted_at: null, current_balance_cop: 20_000, oldest_unpaid_date: AHORA - 5 * DIA, promised_payment_date: null };

test.each<[string, Partial<DatosDeEstadoDeudor>, string]>([
  ['saldo 0', { current_balance_cop: 0, oldest_unpaid_date: null }, 'AL_DIA'],
  ['saldo reciente', {}, 'CON_SALDO'],
  ['fiado de exactamente 30 días aún no es mora', { oldest_unpaid_date: AHORA - 30 * DIA }, 'CON_SALDO'],
  ['fiado de más de 30 días', { oldest_unpaid_date: AHORA - 30 * DIA - 1 }, 'EN_MORA'],
  ['promesa para mañana', { promised_payment_date: HOY + DIA }, 'PROMESA_PAGO'],
  ['promesa para hoy: vale hasta que termina el día', { promised_payment_date: HOY }, 'PROMESA_PAGO'],
  ['promesa de ayer, vencida', { promised_payment_date: HOY - DIA }, 'EN_MORA'],
  ['promesa vigente gana a un fiado viejo', { oldest_unpaid_date: AHORA - 90 * DIA, promised_payment_date: HOY + DIA }, 'PROMESA_PAGO'],
  ['saldo 0 con promesa vieja sigue al día', { current_balance_cop: 0, promised_payment_date: HOY - DIA }, 'AL_DIA'],
  ['lista negra gana a todo, incluso a saldo 0', { blacklisted_at: 1, current_balance_cop: 0 }, 'LISTA_NEGRA'],
  ['lista negra gana a promesa', { blacklisted_at: 1, promised_payment_date: HOY + DIA }, 'LISTA_NEGRA'],
])('%s', (_caso, cambios, esperado) => {
  expect(estadoDeudor({ ...base, ...cambios }, AHORA, 30)).toBe(esperado);
});

test('los días de alerta son los de la tienda', () => {
  const d = { ...base, oldest_unpaid_date: AHORA - 10 * DIA };
  expect(estadoDeudor(d, AHORA, 7)).toBe('EN_MORA');
  expect(estadoDeudor(d, AHORA, 15)).toBe('CON_SALDO');
});
