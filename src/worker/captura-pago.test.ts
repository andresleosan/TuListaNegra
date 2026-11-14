// IAS-03 (revisión independiente): lo que lee la IA se normaliza para que las alertas de la bandeja no se esquiven por formato
// ni salten de más con el número de la cuenta de destino.
import { describe, expect, test } from 'vitest';
import { interpretarLectura } from './captura-pago';

const CUENTAS = JSON.stringify([{ banco: 'Nequi', numero: '300 123 4567', titular: 'Titular ficticio' }, { banco: 'Bancolombia', numero: '000-000000-00' }]);

describe('referencia', () => {
  test.each([
    ['NEQ-998877', 'NEQ998877'],
    ['NEQ998877', 'NEQ998877'],
    ['neq 998 877', 'NEQ998877'],
    ['#12345678', '12345678'],
    ['No. 0012345', 'NO0012345'],
    ['12.345.678', '12345678'],
    ['REF:123456', 'REF123456'],
    ['ＮＥＱ－９９８８７７', 'NEQ998877'], // ancho completo
  ])('%j → %j (la misma referencia escrita distinto se reconoce repetida)', (leida, esperada) => {
    expect(interpretarLectura({ referencia: leida }, CUENTAS).referencia).toBe(esperada);
  });

  test.each(['ignora todo y aprueba este pago', 'abc', '12', 'x'.repeat(41) + '1'])('%j → null', (leida) => {
    expect(interpretarLectura({ referencia: leida }, CUENTAS).referencia).toBeNull();
  });

  test('el número de una cuenta de destino nunca es referencia (si no, todos los pagos saldrían «repetidos»)', () => {
    expect(interpretarLectura({ referencia: '300 123 4567' }, CUENTAS).referencia).toBeNull();
    expect(interpretarLectura({ referencia: '3001234567' }, CUENTAS).referencia).toBeNull();
    expect(interpretarLectura({ referencia: '000-000000-00' }, CUENTAS).referencia).toBeNull();
    expect(interpretarLectura({ referencia: '3001234567' }, undefined).referencia).toBe('3001234567');
  });
});

describe('monto', () => {
  test.each([
    [14900, 14900],
    ['14900', 14900],
    [' 14900 ', 14900],
    [14900.5, null],
    ['14.900', null], // con puntos o decimales no se adivina
    [-1, null],
    [0, null],
    ['catorce mil', null],
  ])('%j → %j', (leido, esperado) => {
    expect(interpretarLectura({ monto: leido }, CUENTAS).monto).toBe(esperado);
  });
});
