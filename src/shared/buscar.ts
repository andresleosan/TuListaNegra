// Buscador del mostrador (MOS-01): nombre, apodo, código (`TLN-0042`, `tln0042` o `0042`) o últimos 4 del documento.
// Función pura sobre la copia local; sin mayúsculas ni tildes. Cada palabra escrita debe aparecer en algún campo.
import type { DeudorResumen } from './deudor';

/** `'Núñez'` → `'nunez'`. */
const normalizar = (texto: string) => texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// El texto en el que se busca, preparado una sola vez por deudor: las pulsaciones siguientes solo comparan.
const preparados = new WeakMap<DeudorResumen, string>();

function textoDe(d: DeudorResumen): string {
  let texto = preparados.get(d);
  if (texto === undefined) {
    const codigo = d.unique_code.toLowerCase();
    texto = normalizar([d.full_name, d.alias_reference ?? '', codigo, codigo.replace('-', ''), d.doc_last4 ?? ''].join(' '));
    preparados.set(d, texto);
  }
  return texto;
}

/** Los deudores que coinciden, en el orden en que llegaron. Sin texto, todos. */
export function buscar(deudores: DeudorResumen[], consulta: string): DeudorResumen[] {
  const palabras = normalizar(consulta).split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return deudores;
  return deudores.filter((d) => {
    const texto = textoDe(d);
    return palabras.every((p) => texto.includes(p));
  });
}

// «don Carlos» suele estar anotado como «Carlos». Pero «don» y «doña» también caben dentro de apellidos (Londoño,
// Maldonado): se busca con y sin el trato y se queda el resultado más amplio, para no elegir solo a uno por accidente.
const TRATOS = new Set(['don', 'dona', 'doña', 'senor', 'señor', 'senora', 'señora', 'seno', 'seño', 'sr', 'sra']);

/** Los deudores a los que puede referirse lo que entendió Sarin («don Carlos el del taller»). */
export function buscarCandidatos(deudores: DeudorResumen[], buscado: string): DeudorResumen[] {
  const todos = buscar(deudores, buscado);
  const sinTrato = buscado.split(/\s+/).filter((p) => !TRATOS.has(p.toLowerCase())).join(' ');
  if (!sinTrato || sinTrato === buscado) return todos;
  const amplia = buscar(deudores, sinTrato);
  return amplia.length > todos.length ? amplia : todos;
}
