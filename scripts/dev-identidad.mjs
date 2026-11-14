#!/usr/bin/env node
// Identidad local para desarrollo y e2e, mientras no haya proyecto de Firebase.
// NO salta la autenticación: genera una llave RSA local con la que el servidor de desarrollo de Vite firma
// ID tokens RS256 (plugin de `vite.config.ts`, `POST /__dev/token`). El Worker los verifica igual que los de
// Firebase porque `.dev.vars` le da el JWKS público de esa llave en `TEST_JWKS_JSON` (ver src/worker/auth.ts).
// Nada de esto existe en producción: `.dev.vars` y `.wrangler/` no se versionan y `check:release` vigila el resto.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';

const RAIZ = new URL('../', import.meta.url);
const DEV_VARS = new URL('.dev.vars', RAIZ);
const LLAVE = new URL('.wrangler/dev-identidad.json', RAIZ);

/** Valor de una variable de `.dev.vars` (formato dotenv), o `undefined`. */
function variable(texto, nombre) {
  const valor = new RegExp(`^${nombre}=(.*)$`, 'm').exec(texto)?.[1]?.trim();
  return valor?.replace(/^(['"])(.*)\1$/, '$2');
}

/**
 * La identidad local, solo si la llave privada guardada es la pareja del JWKS que el Worker local va a usar.
 * `null` si no hay simulador: falta la llave, o `.dev.vars` apunta a otra cosa (p. ej. el Firebase real del dueño).
 */
export function identidadLocal() {
  if (!existsSync(DEV_VARS) || !existsSync(LLAVE)) return null;
  try {
    const vars = readFileSync(DEV_VARS, 'utf8');
    const proyecto = variable(vars, 'FIREBASE_PROJECT_ID');
    const jwks = JSON.parse(variable(vars, 'TEST_JWKS_JSON') ?? 'null');
    const { kid, privada } = JSON.parse(readFileSync(LLAVE, 'utf8'));
    const publica = jwks?.keys?.find((k) => k.kid === kid);
    return proyecto && publica && publica.n === privada.n ? { proyecto, kid, privada } : null;
  } catch {
    return null;
  }
}

async function preparar() {
  if (existsSync(DEV_VARS)) {
    // No se toca: el dueño puede haber puesto ahí su Firebase real.
    if (variable(readFileSync(DEV_VARS, 'utf8'), 'TEST_JWKS_JSON') && !identidadLocal()) {
      console.warn(
        'dev-identidad: .dev.vars trae un TEST_JWKS_JSON, pero falta su llave privada (.wrangler/dev-identidad.json).\n' +
          '  El simulador local de ingreso no aparecerá. Para regenerarlo: borra .dev.vars (o guárdalo aparte) y ejecuta de nuevo `pnpm dev`.',
      );
    }
    return;
  }
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publica = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publica);
  const jwks = { keys: [{ ...publica, kid, alg: 'RS256', use: 'sig' }] };
  mkdirSync(new URL('.wrangler/', RAIZ), { recursive: true });
  writeFileSync(LLAVE, JSON.stringify({ kid, privada: await exportJWK(privateKey) }), { mode: 0o600 });
  writeFileSync(
    DEV_VARS,
    [
      '# Generado por scripts/dev-identidad.mjs. Solo desarrollo local; no se versiona. Ver .dev.vars.example.',
      'FIREBASE_PROJECT_ID=tln-local',
      `TEST_JWKS_JSON='${JSON.stringify(jwks)}'`,
      'PILOT_EMAILS=piloto@ejemplo.test,piloto2@ejemplo.test',
      'SUPERADMIN_EMAILS=admin@ejemplo.test',
      'TEST_WHATSAPP_SIMULADO=1',
      // Secreto del webhook de WhatsApp SOLO para el simulador local (prefijo que check:release prohíbe en producción).
      `WHATSAPP_APP_SECRET=tln-dev-whatsapp-${crypto.randomUUID()}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  console.log('dev-identidad: creé .dev.vars y una llave local de identidad (.wrangler/dev-identidad.json).');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await preparar();
