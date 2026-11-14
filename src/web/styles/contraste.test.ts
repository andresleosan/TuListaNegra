// @ts-expect-error La prueba corre en Node, pero tsconfig.web.json no incluye los tipos de Node.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { colores, contraste, pares, prohibidos } from './pares';

// Se lee del disco: vitest vacía los CSS importados, también con `?raw`.
const tokensCss: string = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

test('la fórmula de contraste da los extremos conocidos', () => {
  expect(contraste('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
  expect(contraste('#777777', '#777777')).toBe(1);
});

test('los colores del módulo son los de tokens.css', () => {
  const delCss = Object.fromEntries(
    [...tokensCss.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\b/g)].map((m) => [m[1], m[2]]),
  );
  expect(delCss).toEqual(colores);
  expect(tokensCss).toContain(`--sombra-dura: 2px 2px 0 ${colores.tinta};`);
});

test.each(pares)('$uso ($texto sobre $fondo) alcanza AA para texto normal', ({ texto, fondo }) => {
  expect(contraste(colores[texto], colores[fondo])).toBeGreaterThanOrEqual(4.5);
});

test.each(prohibidos)('$uso sigue sin alcanzar AA (por eso está prohibido)', ({ texto, fondo }) => {
  expect(contraste(colores[texto], colores[fondo])).toBeLessThan(4.5);
});
