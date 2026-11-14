// Ayudas de prueba: firma ID tokens como lo haría Firebase, con la llave RSA local de vitest.config.ts.
import { env } from 'cloudflare:workers';
import { importJWK, SignJWT } from 'jose';
import { app } from '../index';

export const PROYECTO = 'tln-pruebas';

let ipSiguiente = 1;

type Claims = { uid?: string; email?: string; email_verified?: boolean; proveedor?: string };

export async function tokenDe({ uid = 'uid_1', email = 'tendero@ejemplo.test', email_verified = true, proveedor = 'google.com' }: Claims = {}) {
  const llave = await importJWK(JSON.parse(env.TEST_PRIVATE_JWK), 'RS256');
  return new SignJWT({ email, email_verified, firebase: { sign_in_provider: proveedor } })
    .setProtectedHeader({ alg: 'RS256', kid: 'prueba' })
    .setIssuer(`https://securetoken.google.com/${PROYECTO}`)
    .setAudience(PROYECTO)
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(llave);
}

/** Petición a la API con la sesión indicada (o sin sesión si `claims` es null). `entorno` sustituye al de pruebas. */
export async function api(ruta: string, claims: Claims | null = {}, init: RequestInit = {}, entorno: Env = env) {
  const headers = new Headers(init.headers);
  if (claims) headers.set('Authorization', `Bearer ${await tokenDe(claims)}`);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // IP distinta en cada petición para no tropezar con los límites de frecuencia; la prueba que los ejercita fija la suya.
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', `203.0.113.${ipSiguiente++ % 250}`);
  return app.request(ruta, { ...init, headers }, entorno);
}
