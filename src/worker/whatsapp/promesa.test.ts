// WAP-05: frases de fecha y de baja reconocidas sin IA (conjunto explícito de ./promesa.ts), en días de Bogotá.
import { describe, expect, test } from 'vitest';
import { esBaja, fechaPrometida } from './promesa';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00');
const dia = (iso: string) => Date.parse(`${iso}T00:00:00-05:00`); // 00:00 de Bogotá

describe('fechaPrometida (escrito el martes 17 de noviembre de 2026, 10:00 de Bogotá)', () => {
  test.each([
    ['Le pago el viernes', '2026-11-20'],
    ['EL VIERNES sin falta', '2026-11-20'],
    ['el viernes en la mañana le pago', '2026-11-20'],
    ['Este sábado le abono', '2026-11-21'],
    ['el miércoles', '2026-11-18'],
    ['el martes', '2026-11-24'], // dicho un martes: el de la otra semana
    ['mañana le pago', '2026-11-18'],
    ['Mañana en la mañana', '2026-11-18'],
    ['pasado mañana', '2026-11-19'],
    ['le pago el 15', '2026-12-15'],
    ['el 17', '2026-12-17'], // hoy no cuenta: el próximo 17
    ['el 31', '2026-12-31'], // noviembre no tiene 31
    ['el 20 de noviembre', '2026-11-20'],
    ['20 de noviembre', '2026-11-20'],
    ['15 de enero', '2027-01-15'],
    ['el 1 de setiembre', null], // fuera del horizonte de 90 días
    // revisión de WAP-05: día de la semana con número, horas y «hasta»
    ['el viernes 27', '2026-11-27'],
    ['el sábado 21', '2026-11-21'],
    ['Le pago el viernes 27 de noviembre', '2026-11-27'],
    ['el viernes a las 5', '2026-11-20'],
    ['el viernes 5 de la tarde', '2026-11-20'],
    ['hasta el viernes le pago', '2026-11-20'],
  ])('%j → %s', (texto, esperado) => {
    expect(fechaPrometida(texto, MARTES_10)).toBe(esperado === null ? null : dia(esperado));
  });

  test.each([
    'el 15 de noviembre', // ya pasó
    'el 17 de noviembre', // es hoy: no es futuro
    'hoy le pago',
    'la otra semana',
    'el próximo viernes',
    'esta mañana pagué',
    'Hola, ya pagué',
    'el viernes o el lunes', // dos fechas: no se adivina
    'le abono el 20 mil',
    'el 50%',
    'el 1.500',
    'el 30 de febrero',
    'el 0',
    'el 45',
    '',
    // revisión de WAP-05
    'el viernes 26', // el 26 es jueves
    'el viernes 26 de noviembre',
    'el 2 millones',
    'le abono el 1 millón',
    'el 15 000',
    'el 5 de la tarde',
    'el 5:30',
    'a las 5',
    'ya le pagué el viernes',
    'le consigné el lunes',
    'le transferí el 15',
    'mañana no puedo',
    'el viernes no alcanzo',
    'hasta mañana',
    'Gracias, hasta mañana',
  ])('%j → nada', (texto) => {
    expect(fechaPrometida(texto, MARTES_10)).toBeNull();
  });

  test('el día es el de Bogotá: a las 23:30 del martes (04:30 UTC del miércoles), «mañana» es el miércoles', () => {
    expect(fechaPrometida('mañana', Date.parse('2026-11-17T23:30:00-05:00'))).toBe(dia('2026-11-18'));
    expect(fechaPrometida('mañana', Date.parse('2026-11-18T00:00:00-05:00'))).toBe(dia('2026-11-19'));
  });
});

describe('esBaja: el mensaje entero', () => {
  test.each(['SALIR', 'salir', ' Salir. ', '¡SALIR!', 'No más mensajes', 'no mas  mensajes.'])('%j → baja', (texto) => {
    expect(esBaja(texto)).toBe(true);
  });
  test.each(['salir por favor', 'Salir, gracias', 'salir porfa', 'STOP', 'Baja.', 'No me escriban más', 'no me escriban mas'])('%j → baja', (texto) => {
    expect(esBaja(texto)).toBe(true);
  });
  test.each(['quiero salir', 'salir de esto', 'SALIRR', 'no', 'no más', '', 'quiero salir de la deuda', 'salir de la deuda', 'baja el precio', 'stop ya pague'])('%j → no', (texto) => {
    expect(esBaja(texto)).toBe(false);
  });
});
