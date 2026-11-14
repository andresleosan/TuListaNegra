import { expect, test } from 'vitest';
import { normalizarTelefonoCO } from './telefono';

test.each([
  ['3001234567', '+573001234567'],
  ['300 123 4567', '+573001234567'],
  ['+57 300 123 4567', '+573001234567'],
  ['+573001234567', '+573001234567'],
  ['57 300 123 4567', '+573001234567'],
  ['(300) 123-4567', '+573001234567'],
  ['300.123.4567', '+573001234567'],
  ['  321 555 0199 ', '+573215550199'],
])('acepta «%s» y lo deja en E.164', (entrada, esperado) => {
  expect(normalizarTelefonoCO(entrada)).toBe(esperado);
});

test.each([
  ['', 'vacío'],
  ['300123456', 'le falta un dígito'],
  ['30012345678', 'le sobra un dígito'],
  ['6012345678', 'fijo de Bogotá, no celular'],
  ['2001234567', 'no empieza por 3'],
  ['+1 300 123 4567', 'otro país'],
  ['+58 300 123 4567', 'otro país'],
  ['++573001234567', 'dos signos +'],
  ['57+3001234567', 'el + en mal sitio'],
  ['300 123 456a', 'con letras'],
  ['３００１２３４５６７', 'dígitos de ancho completo'],
])('rechaza «%s» (%s)', (entrada) => {
  expect(normalizarTelefonoCO(entrada)).toBeNull();
});
