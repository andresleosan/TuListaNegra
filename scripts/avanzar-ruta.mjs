#!/usr/bin/env node
// Ruta de avance: lee las fichas de docs/roadmap/tasks y dice qué conviene cerrar ahora.
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../docs/roadmap/tasks/', import.meta.url);
const fichas = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')));

const vivas = fichas.filter((t) => t.estado !== 'descartado');
const abiertas = vivas.filter((t) => t.estado !== 'hecho');
const hechas = vivas.length - abiertas.length;
console.log(`Progreso: ${hechas} de ${vivas.length} · ${Math.round((100 * hechas) / vivas.length)} %`);

const esAbierta = new Set(abiertas.map((t) => t.id));
const depsAbiertas = (t) => t.dependencies.map((d) => d.id).filter((id) => esAbierta.has(id));

// desbloquea: cuántas tareas abiertas dependen de esta, directa o indirectamente.
function desbloquea(id) {
  const vistas = new Set();
  const cola = [id];
  while (cola.length) {
    const actual = cola.pop();
    for (const t of abiertas) {
      if (!vistas.has(t.id) && t.dependencies.some((d) => d.id === actual)) {
        vistas.add(t.id);
        cola.push(t.id);
      }
    }
  }
  return vistas.size;
}

const externa = (t) => t.responsable !== 'desarrollo' || t.estado === 'bloqueado' || Boolean(t.externalBlocker);
const cola = abiertas.filter(externa);
const propias = abiertas.filter((t) => !externa(t));
const ahora = propias.filter((t) => depsAbiertas(t).length === 0);
const idsAhora = new Set(ahora.map((t) => t.id));
const ola = propias.filter((t) => !idsAhora.has(t.id) && depsAbiertas(t).every((id) => idsAhora.has(id)));

function bloque(titulo, tareas) {
  console.log(`\n${titulo} (${tareas.length})`);
  const orden = tareas
    .map((t) => ({ t, n: desbloquea(t.id) }))
    .sort((a, b) => b.n - a.n || (a.t.estado === 'parcial' ? 0 : 1) - (b.t.estado === 'parcial' ? 0 : 1) || a.t.id.localeCompare(b.t.id));
  for (const { t, n } of orden) {
    const apagada = /migraci|interruptor/i.test(t.falta) ? ' · apagada' : '';
    const espera = depsAbiertas(t).length ? ` · espera ${depsAbiertas(t).join(', ')}` : '';
    const motivo = t.externalBlocker ? ` · ${t.externalBlocker}` : '';
    console.log(`  ${t.id}  [${t.estado}${apagada}]  desbloquea ${n}  ${t.titulo}${espera}${motivo}`);
  }
}

bloque('1. Cerrables ahora', ahora);
bloque('2. Siguiente ola', ola);
bloque('3. Cola del dueño o terceros', cola);
const resto = propias.length - ahora.length - ola.length;
if (resto) console.log(`\nMás adelante: ${resto} tareas esperan a olas posteriores.`);
