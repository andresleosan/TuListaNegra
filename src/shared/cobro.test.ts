import { describe, expect, test } from 'vitest';
import { enlaceWhatsApp, textoDeCobro, TONOS } from './cobro';

const datos = { tienda: 'La Esquina de Rubi', nombre: 'don Carlos', saldo_cop: 84_900, medios_de_pago: 'Nequi 300 123 4567 a nombre de Rubiela.' };

describe('los tres tonos', () => {
  test('texto exacto de cada tono', () => {
    const cola = 'Puede pagar así: Nequi 300 123 4567 a nombre de Rubiela. Si ya pagó, no tenga en cuenta este mensaje. Si no quiere recibir más recordatorios, responda SALIR.';
    expect(textoDeCobro('VECINO_AMIGABLE', datos)).toBe(`Hola don Carlos, le saluda La Esquina de Rubi. Le recordamos con mucho gusto que tiene un saldo pendiente de $ 84.900. ${cola}`);
    expect(textoDeCobro('CORTE_DE_QUINCENA', datos)).toBe(`Hola don Carlos, le escribe La Esquina de Rubi. Llegó la quincena y su saldo pendiente con nosotros es de $ 84.900. ${cola}`);
    expect(textoDeCobro('AVISO_FIRME', datos)).toBe(`don Carlos, le escribe La Esquina de Rubi. Su saldo pendiente es de $ 84.900 y ya pasó el plazo acordado. Le pedimos ponerse al día o decirnos qué día puede pagar. ${cola}`);
  });

  test.each(TONOS)('%s dice quién cobra, cuánto, cómo pagar y cómo darse de baja; nada de amenazas ni listas', (tono) => {
    const texto = textoDeCobro(tono, datos);
    for (const obligatorio of ['La Esquina de Rubi', '$ 84.900', 'Nequi', 'SALIR']) expect(texto).toContain(obligatorio);
    expect(texto).not.toMatch(/lista negra|report|datacr[eé]dito|central(es)? de riesgo|demanda|abogad|embarg|jur[ií]dic|moros|deudor|vergüenza|última advertencia|consecuencias/i);
  });

  test('los medios de pago terminan en un solo punto, los escriba el tendero con punto o sin él', () => {
    for (const medios of ['Nequi 300 123 4567', 'Nequi 300 123 4567.', 'Nequi 300 123 4567 . ', 'Nequi 300 123 4567...']) {
      expect(textoDeCobro('VECINO_AMIGABLE', { ...datos, medios_de_pago: medios })).toContain('Puede pagar así: Nequi 300 123 4567. Si ya pagó');
    }
  });

  test('sin medios de pago configurados, se paga en la tienda', () => {
    expect(textoDeCobro('VECINO_AMIGABLE', { ...datos, medios_de_pago: null })).toContain('Puede pagar directamente en la tienda.');
  });
});

test('enlace de WhatsApp con el mensaje escrito', () => {
  const url = new URL(enlaceWhatsApp('+573001234567', 'Hola don Carlos, saldo $ 84.900 ¿sí?'));
  expect(url.origin + url.pathname).toBe('https://wa.me/573001234567');
  expect(url.searchParams.get('text')).toBe('Hola don Carlos, saldo $ 84.900 ¿sí?');
});
