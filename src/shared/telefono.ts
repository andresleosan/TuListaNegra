// Teléfonos móviles de Colombia. Módulo puro: lo usan igual el navegador (alta) y el Worker (validación).

/**
 * Normaliza a E.164 (`+573XXXXXXXXX`) un celular de Colombia escrito como lo escriba la gente:
 * `3001234567`, `300 123 4567`, `(300) 123-4567`, `57 300 123 4567`, `+57 300 123 4567`.
 * Devuelve `null` si no es un celular colombiano (10 dígitos que empiezan por 3).
 */
export function normalizarTelefonoCO(entrada: string): string | null {
  const celular = /^(?:\+?57)?(3\d{9})$/.exec(entrada.replace(/[\s().-]/g, ''))?.[1];
  return celular ? `+57${celular}` : null;
}
