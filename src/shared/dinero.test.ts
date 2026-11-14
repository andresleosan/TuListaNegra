import { expect, test } from 'vitest';
import { formatoCOP } from './dinero';

test('separa los miles con punto y deja un espacio tras el signo de pesos', () => {
  expect(formatoCOP(49900)).toBe('$ 49.900');
  expect(formatoCOP(0)).toBe('$ 0');
  expect(formatoCOP(999)).toBe('$ 999');
  expect(formatoCOP(1000)).toBe('$ 1.000');
  expect(formatoCOP(1234567)).toBe('$ 1.234.567');
});

test('los negativos llevan el signo menos tipográfico delante del signo de pesos', () => {
  expect(formatoCOP(-5000)).toBe('−$ 5.000');
  expect(formatoCOP(-0)).toBe('$ 0');
});
