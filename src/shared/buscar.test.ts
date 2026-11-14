import { describe, expect, it } from 'vitest';
import { buscar } from './buscar';
import type { DeudorResumen } from './deudor';

const NOMBRES = ['Carlos', 'María José', 'Yuleidy', 'Andrés', 'Rubiela', 'Jhon Fredy', 'Luz Dary', 'Ómar', 'Nelson', 'Sandra'];
const APELLIDOS = ['Pérez', 'Núñez', 'Gómez', 'Rodríguez', 'Cárdenas', 'Rincón', 'Muñoz', 'Patiño', 'Ospina', 'Quintero'];

const deudor = (i: number, extra: Partial<DeudorResumen> = {}): DeudorResumen => ({
  id: `deb_${i}`,
  unique_code: `TLN-${String(i + 1).padStart(4, '0')}`,
  full_name: `${NOMBRES[i % 10]} ${APELLIDOS[Math.floor(i / 10) % 10]} ${i}`,
  alias_reference: i % 3 === 0 ? `el de la cuadra ${i}` : null,
  doc_last4: i % 2 === 0 ? String(1000 + (i % 9000)).padStart(4, '0') : null,
  current_balance_cop: 0,
  credit_limit_cop: null,
  oldest_unpaid_date: null,
  promised_payment_date: null,
  blacklisted_at: null,
  archived_at: null,
  wa_consent_at: null,
  wa_opt_out_at: null,
  last_reminder_sent_at: null,
  tiene_whatsapp: false,
  ...extra,
});

// 5.000 deudores sintéticos y tres conocidos con nombres reconocibles para comprobar cada campo.
const cartera = [
  ...Array.from({ length: 4_997 }, (_, i) => deudor(i)),
  deudor(9_001, { id: 'carlos', unique_code: 'TLN-9001', full_name: 'Don Carlos Ramírez', alias_reference: 'El del taller', doc_last4: '6789' }),
  deudor(9_002, { id: 'yuli', unique_code: 'TLN-9002', full_name: 'Yuleidy Ñáñez', alias_reference: null, doc_last4: null }),
  deudor(9_003, { id: 'tienda', unique_code: 'TLN-9003', full_name: 'Señora Rubí', alias_reference: 'La del bus', doc_last4: '0042' }),
];
const ids = (consulta: string) => buscar(cartera, consulta).map((d) => d.id);

describe('buscar', () => {
  it('sin texto devuelve toda la cartera en el mismo orden', () => {
    expect(buscar(cartera, '   ')).toBe(cartera);
  });

  it('por nombre, sin importar mayúsculas ni tildes', () => {
    expect(ids('ramirez')).toEqual(['carlos']);
    expect(ids('RAMÍREZ')).toEqual(['carlos']);
    expect(ids('ñañez')).toEqual(['yuli']);
    expect(ids('nanez')).toEqual(['yuli']);
  });

  it('por apodo', () => {
    expect(ids('taller')).toEqual(['carlos']);
    expect(ids('la del BÚS')).toEqual(['tienda']);
  });

  it('varias palabras: todas deben aparecer, en cualquier campo', () => {
    expect(ids('carlos taller')).toEqual(['carlos']);
    expect(ids('taller carlos')).toEqual(['carlos']);
    expect(ids('carlos bus')).toEqual([]);
  });

  it('por código, con o sin prefijo y guion', () => {
    expect(ids('TLN-9001')).toEqual(['carlos']);
    expect(ids('tln9001')).toEqual(['carlos']);
    expect(ids('9001')).toEqual(['carlos']);
    expect(buscar(cartera, '0042').map((d) => d.unique_code)).toContain('TLN-0042');
  });

  it('por los últimos 4 del documento', () => {
    expect(ids('6789')).toEqual(['carlos']);
    expect(ids('0042')).toContain('tienda');
  });

  it('5.000 deudores: cada búsqueda en menos de 50 ms, incluida la primera', () => {
    const nueva = cartera.map((d) => ({ ...d })); // objetos nuevos: la primera búsqueda arranca sin nada preparado
    for (const consulta of ['c', 'carlos', 'maria jose', 'TLN-0042', '6789', 'cuadra 12', 'zzz']) {
      const inicio = performance.now();
      buscar(nueva, consulta);
      expect(performance.now() - inicio, consulta).toBeLessThan(50);
    }
  });
});
