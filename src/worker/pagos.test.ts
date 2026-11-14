// SUS-01 y SUS-02: reglas puras del pago por captura.
import { describe, expect, test } from 'vitest';
import type { EstadoNegocio } from '../shared/acceso';
import { cuentasDePago, elegibleDesbloqueo, tipoDeImagen } from './pagos';

const bytes = (...b: number[]) => new Uint8Array(b);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));

describe('elegibleDesbloqueo', () => {
  test.each<[EstadoNegocio, 'PAID' | 'REJECTED' | null, boolean]>([
    // Solo un vencido cuyo último pago revisado no fue rechazado.
    ['EXPIRED_READONLY', null, true],
    ['EXPIRED_READONLY', 'PAID', true],
    ['EXPIRED_READONLY', 'REJECTED', false],
    // Quien ya puede operar no recibe nada.
    ['TRIAL', null, false],
    ['TRIAL', 'PAID', false],
    ['ACTIVE', null, false],
    ['ACTIVE', 'PAID', false],
    ['ACTIVE', 'REJECTED', false],
    ['GRACE_UNLOCK_24H', null, false],
    ['GRACE_UNLOCK_24H', 'PAID', false],
    // El guardián ya impide que un suspendido llegue; la regla lo niega igual.
    ['SUSPENDED_BY_ADMIN', null, false],
    ['SUSPENDED_BY_ADMIN', 'PAID', false],
  ])('%s con último revisado %s → %s', (estado, ultimo, esperado) => {
    expect(elegibleDesbloqueo(estado, ultimo)).toBe(esperado);
  });
});

describe('tipoDeImagen: por firma de bytes', () => {
  test.each<[string, Uint8Array, string | null]>([
    ['JPEG', bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0), 'image/jpeg'],
    ['PNG', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'image/png'],
    ['WebP', bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')), 'image/webp'],
    ['RIFF que no es WebP (WAV)', bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVE')), null],
    ['PNG con la firma cortada', bytes(0x89, 0x50, 0x4e, 0x47), null],
    ['JPEG con la firma cortada', bytes(0xff, 0xd8), null],
    ['GIF', bytes(...ascii('GIF89a')), null],
    ['PDF', bytes(...ascii('%PDF-1.7')), null],
    ['SVG', bytes(...ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')), null],
    ['texto', bytes(...ascii('hola, esto no es una imagen')), null],
    ['vacío', bytes(), null],
  ])('%s', (_nombre, contenido, esperado) => {
    expect(tipoDeImagen(contenido)?.contentType ?? null).toBe(esperado);
  });

  test('la extensión sale del tipo detectado', () => {
    expect(tipoDeImagen(bytes(0xff, 0xd8, 0xff))).toEqual({ ext: 'jpg', contentType: 'image/jpeg' });
    expect(tipoDeImagen(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ ext: 'png', contentType: 'image/png' });
    expect(tipoDeImagen(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')))).toEqual({ ext: 'webp', contentType: 'image/webp' });
  });
});

describe('cuentasDePago', () => {
  test.each<[string, string | undefined, unknown]>([
    ['sin variable', undefined, []],
    ['vacía', '', []],
    ['JSON inválido', '{no es json', []],
    ['JSON que no es una lista', '{"banco":"X"}', []],
    ['lista', '[{"banco":"Banco de prueba","numero":"000"}]', [{ banco: 'Banco de prueba', numero: '000' }]],
  ])('%s', (_nombre, json, esperado) => {
    expect(cuentasDePago(json)).toEqual(esperado);
  });
});
