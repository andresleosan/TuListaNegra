import { expect, test } from 'vitest';
import { nuevoId, ulid } from './ids';

test('ulid: 26 caracteres Crockford, ordenable por tiempo', () => {
  const a = ulid(1_000);
  const b = ulid(2_000);
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(a < b).toBe(true);
  expect(ulid(1_000)).not.toBe(a); // misma hora, distinto azar
});

test('ulid: vector conocido de la especificación', () => {
  expect(ulid(1469918176385).slice(0, 10)).toBe('01ARYZ6S41');
});

test('nuevoId antepone el prefijo', () => {
  expect(nuevoId('deb')).toMatch(/^deb_[0-9A-HJKMNP-TV-Z]{26}$/);
});
