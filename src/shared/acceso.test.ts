import { describe, expect, test } from 'vitest';
import { type DatosDeEstado, estadoEfectivo, PERMISOS } from './acceso';

const AHORA = 1_800_000_000_000;
const HORA = 3_600_000;
const base: DatosDeEstado = {
  suspended_at: null, free_forever_at: null, subscription_plan: 'PASS_7D',
  subscription_expires_at: AHORA + HORA, grace_unlock_ends_at: null,
};

describe('estadoEfectivo: los seis casos de B2', () => {
  test.each<[string, Partial<DatosDeEstado>, string]>([
    ['suspendido', { suspended_at: AHORA - 1 }, 'SUSPENDED_BY_ADMIN'],
    ['gratis sin vencimiento, aunque sus fechas estén vencidas', { free_forever_at: AHORA - 1, subscription_expires_at: AHORA - 99 * HORA }, 'ACTIVE'],
    ['prueba vigente', { subscription_plan: 'TRIAL_3D' }, 'TRIAL'],
    ['pase vigente', {}, 'ACTIVE'],
    ['vencido con desbloqueo de 24 h vigente', { subscription_expires_at: AHORA - HORA, grace_unlock_ends_at: AHORA + HORA }, 'GRACE_UNLOCK_24H'],
    ['vencido sin desbloqueo', { subscription_expires_at: AHORA - HORA }, 'EXPIRED_READONLY'],
  ])('%s', (_caso, cambios, esperado) => {
    expect(estadoEfectivo({ ...base, ...cambios }, AHORA)).toBe(esperado);
  });
});

describe('estadoEfectivo: orden y bordes', () => {
  test.each<[string, Partial<DatosDeEstado>, string]>([
    ['la suspensión gana a la gratuidad', { suspended_at: AHORA, free_forever_at: AHORA }, 'SUSPENDED_BY_ADMIN'],
    ['la suspensión gana a un pase vigente', { suspended_at: AHORA }, 'SUSPENDED_BY_ADMIN'],
    ['gratis con plan de prueba es ACTIVE, no TRIAL', { free_forever_at: AHORA, subscription_plan: 'TRIAL_3D' }, 'ACTIVE'],
    ['en el instante exacto del vencimiento ya está vencido', { subscription_expires_at: AHORA }, 'EXPIRED_READONLY'],
    ['un milisegundo antes sigue activo', { subscription_expires_at: AHORA + 1 }, 'ACTIVE'],
    ['prueba vencida no es TRIAL', { subscription_plan: 'TRIAL_3D', subscription_expires_at: AHORA - 1 }, 'EXPIRED_READONLY'],
    ['desbloqueo terminado', { subscription_expires_at: AHORA - 2 * HORA, grace_unlock_ends_at: AHORA }, 'EXPIRED_READONLY'],
    ['un pase vigente gana a un desbloqueo viejo', { grace_unlock_ends_at: AHORA + HORA }, 'ACTIVE'],
  ])('%s', (_caso, cambios, esperado) => {
    expect(estadoEfectivo({ ...base, ...cambios }, AHORA)).toBe(esperado);
  });
});

test('permisos por estado: la tabla de B2', () => {
  expect(PERMISOS).toEqual({
    TRIAL: { ver: true, escribir: true, ia: true },
    ACTIVE: { ver: true, escribir: true, ia: true },
    GRACE_UNLOCK_24H: { ver: true, escribir: true, ia: true },
    EXPIRED_READONLY: { ver: true, escribir: false, ia: false },
    SUSPENDED_BY_ADMIN: { ver: false, escribir: false, ia: false },
  });
});
