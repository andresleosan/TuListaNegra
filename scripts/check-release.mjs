#!/usr/bin/env node
// Comprobaciones previas a publicar. Falla (exit 1) si algo de solo-pruebas o prohibido llegaría a producción.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const fallos = [];
const leer = (ruta) => readFileSync(new URL(`../${ruta}`, import.meta.url), 'utf8');
const existe = (ruta) => existsSync(new URL(`../${ruta}`, import.meta.url));

// A1.1: solo pnpm, con versión exacta.
for (const f of ['package-lock.json', 'yarn.lock']) if (existe(f)) fallos.push(`Existe ${f}: solo se usa pnpm.`);
if (!/^pnpm@\d+\.\d+\.\d+$/.test(JSON.parse(leer('package.json')).packageManager ?? '')) {
  fallos.push('packageManager debe fijar una versión exacta de pnpm.');
}

// A1.5: los secretos locales no se versionan.
const versionados = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
if (versionados.some((f) => /(^|\/)\.dev\.vars$|(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.example'))) {
  fallos.push('Hay un archivo de secretos (.dev.vars o .env) versionado.');
}

// B5: la configuración de pruebas no puede aparecer en producción.
// Claves prohibidas en `vars` del Worker (fuente y compilado). Se amplía con cada tarea que añada configuración de prueba.
const SOLO_PRUEBAS = [];
for (const ruta of ['wrangler.jsonc', 'dist/tulistanegra/wrangler.json']) {
  if (!existe(ruta)) {
    if (ruta.startsWith('dist/')) fallos.push(`Falta ${ruta}: ejecuta \`pnpm build\` antes.`);
    continue;
  }
  const texto = leer(ruta);
  for (const clave of SOLO_PRUEBAS) if (texto.includes(clave)) fallos.push(`${ruta} contiene ${clave} (solo pruebas).`);
}

if (fallos.length) {
  console.error('check:release FALLA\n' + fallos.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('check:release OK');
