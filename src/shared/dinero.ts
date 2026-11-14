// Dinero en pesos colombianos: siempre enteros, sin centavos.
// Se formatea a mano (no con Intl 'es-CO') para que Node, Workers y navegador den exactamente lo mismo.

/** `49900` → `'$ 49.900'`. Los negativos llevan el signo menos tipográfico (U+2212) delante: `'−$ 5.000'`. */
export function formatoCOP(valor: number): string {
  const miles = String(Math.abs(valor)).replace(/\B(?=(\d{3})+$)/g, '.');
  return `${valor < 0 ? '−' : ''}$ ${miles}`;
}

/** Tope razonable para cualquier monto que entra al sistema (B5): cien millones de pesos. */
export const MONTO_MAXIMO_COP = 100_000_000;
