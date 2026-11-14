#!/usr/bin/env node
// pnpm verificar:saldos [--remote]: comprueba que el saldo de cada deudor = suma de sus movimientos confirmados.
// Solo lee. Por defecto mira la D1 local; con --remote, la de producción.
import { execFileSync } from 'node:child_process';

const destino = process.argv.includes('--remote') ? '--remote' : '--local';
const salida = execFileSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'execute', 'tulistanegra', destino, '--json', '--file', 'scripts/verificar-saldos.sql'],
  { encoding: 'utf8', cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] },
);
const filas = JSON.parse(salida.slice(salida.indexOf('['))).flatMap((r) => r.results ?? []);
if (filas.length) {
  console.error(`verificar:saldos FALLA (${destino}): ${filas.length} deudor(es) con saldo descuadrado`);
  console.table(filas);
  process.exit(1);
}
console.log(`verificar:saldos OK (${destino}): todos los saldos coinciden con sus movimientos confirmados.`);
