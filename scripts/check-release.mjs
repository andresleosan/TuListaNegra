#!/usr/bin/env node
// Comprobaciones previas a publicar. Falla (exit 1) si algo de solo-pruebas o prohibido llegaría a producción.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import vm from 'node:vm';

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
if (versionados.some((f) => /(^|\/)\.(dev\.vars|env)(\.|$)/.test(f) && !f.endsWith('.example'))) {
  fallos.push('Hay un archivo de secretos (.dev.vars o .env) versionado.');
}

// B5: la configuración de pruebas no puede aparecer en producción.
// Ninguna variable TEST_* (p. ej. TEST_JWKS_JSON, que cambia las llaves de sesión) en la config del Worker.
for (const ruta of ['wrangler.jsonc', 'dist/tulistanegra/wrangler.json']) {
  if (!existe(ruta)) {
    if (ruta.startsWith('dist/')) fallos.push(`Falta ${ruta}: ejecuta \`pnpm build\` antes.`);
    continue;
  }
  const contenido = leer(ruta);
  const prohibidas = contenido.match(/"TEST_[A-Z0-9_]*"/g);
  if (prohibidas) fallos.push(`${ruta} contiene configuración de pruebas: ${[...new Set(prohibidas)].join(', ')}.`);
  // WAP-01 (contrato-sarin.md, d.10): el secreto de desarrollo de WhatsApp (src/worker/test/whatsapp.ts y .dev.vars) empieza
  // por este prefijo y no puede llegar a producción. Los secretos reales van en Cloudflare, nunca en la configuración versionada.
  if (contenido.includes('tln-dev-whatsapp')) fallos.push(`${ruta} contiene el secreto de desarrollo de WhatsApp.`);
  const secretosWa = contenido.match(/"WHATSAPP_(APP_SECRET|VERIFY_TOKEN)"/g);
  if (secretosWa) fallos.push(`${ruta} declara secretos de WhatsApp en la configuración: ${[...new Set(secretosWa)].join(', ')}; van como secretos de Cloudflare.`);
}

// A1.7: el simulador local de ingreso (src/web/sesion/simulador.ts) es solo de desarrollo y no puede ir en el bundle.
const MARCAS_SIMULADOR = ['/__dev/token', 'Simulador local de ingreso', 'tln-simulador'];
if (!existe('dist/client')) {
  fallos.push('Falta dist/client: ejecuta `pnpm build` antes.');
} else {
  for (const archivo of readdirSync(new URL('../dist/client', import.meta.url), { recursive: true, withFileTypes: true })) {
    if (!archivo.isFile() || !/\.(js|mjs|html|css|json|map)$/.test(archivo.name)) continue;
    const ruta = `${archivo.parentPath}/${archivo.name}`;
    const contenido = readFileSync(ruta, 'utf8');
    const halladas = MARCAS_SIMULADOR.filter((marca) => contenido.includes(marca));
    if (halladas.length) fallos.push(`${ruta.slice(ruta.indexOf('dist/client'))} contiene el simulador de ingreso de desarrollo: ${halladas.join(', ')}.`);
  }
}

// MOS-05: el service worker nunca guarda la API ni la sesión de desarrollo (datos privados): se prueba su filtro `seGuarda`.
const seGuarda = vm.runInNewContext(`${leer('public/sw.js')}\n;seGuarda`, { self: { addEventListener() {} }, location: { origin: 'https://tln.test' }, URL, Set });
for (const ruta of ['/api', '/api/deudores', '/api/negocio', '/__dev/token']) {
  if (seGuarda(new URL(ruta, 'https://tln.test'))) fallos.push(`public/sw.js guardaría ${ruta} en la caché: /api y /__dev van siempre a la red.`);
}

if (fallos.length) {
  console.error('check:release FALLA\n' + fallos.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('check:release OK');
