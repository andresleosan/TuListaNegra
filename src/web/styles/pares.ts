// Colores del sistema y pares texto/fondo que las piezas usan de verdad.
// contraste.test.ts comprueba que `colores` coincide con tokens.css y que cada par alcanza AA.

export const colores = {
  papel: '#F6F4EE',
  blanco: '#FFFFFF',
  crema: '#EFECE6',
  tinta: '#141413',
  verde: '#166534',
  ambar: '#D97706',
  rojo: '#DC2626',
} as const;

type Color = keyof typeof colores;
type Par = { uso: string; texto: Color; fondo: Color };

export const pares: Par[] = [
  { uso: 'Texto sobre papel', texto: 'tinta', fondo: 'papel' },
  { uso: 'Texto sobre tarjeta blanca y tirilla', texto: 'tinta', fondo: 'blanco' },
  { uso: 'Texto sobre tarjeta crema', texto: 'tinta', fondo: 'crema' },
  { uso: 'Botón primario', texto: 'blanco', fondo: 'tinta' },
  { uso: 'Botón secundario', texto: 'tinta', fondo: 'blanco' },
  { uso: 'Botón de peligro', texto: 'blanco', fondo: 'rojo' },
  { uso: 'Botón deshabilitado', texto: 'tinta', fondo: 'crema' },
  { uso: 'Sello AL_DIA', texto: 'verde', fondo: 'blanco' },
  { uso: 'Sello PROMESA_PAGO', texto: 'tinta', fondo: 'ambar' },
  { uso: 'Sello EN_MORA', texto: 'rojo', fondo: 'blanco' },
  { uso: 'Sello LISTA_NEGRA', texto: 'blanco', fondo: 'rojo' },
  { uso: 'Sello CON_SALDO', texto: 'tinta', fondo: 'blanco' },
  { uso: 'Monto verde sobre papel', texto: 'verde', fondo: 'papel' },
  { uso: 'Monto verde sobre tarjeta blanca', texto: 'verde', fondo: 'blanco' },
  { uso: 'Monto verde sobre tarjeta crema', texto: 'verde', fondo: 'crema' },
  { uso: 'Monto rojo sobre tarjeta blanca', texto: 'rojo', fondo: 'blanco' },
];

// Combinaciones prohibidas en DESIGN.md porque no alcanzan AA.
export const prohibidos: Par[] = [
  { uso: 'Ámbar como texto sobre papel', texto: 'ambar', fondo: 'papel' },
  { uso: 'Ámbar como texto sobre tarjeta blanca', texto: 'ambar', fondo: 'blanco' },
  { uso: 'Rojo como texto sobre papel', texto: 'rojo', fondo: 'papel' },
  { uso: 'Rojo como texto sobre tarjeta crema', texto: 'rojo', fondo: 'crema' },
];

// Luminancia relativa WCAG 2 de un color `#RRGGBB`.
function luminancia(hex: string): number {
  const canal = (desde: number) => {
    const c = parseInt(hex.slice(desde, desde + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5);
}

/** Razón de contraste WCAG 2 entre dos colores `#RRGGBB` (de 1 a 21). */
export function contraste(a: string, b: string): number {
  const [clara, oscura] = [luminancia(a), luminancia(b)].sort((x, y) => y - x) as [number, number];
  return (clara + 0.05) / (oscura + 0.05);
}
