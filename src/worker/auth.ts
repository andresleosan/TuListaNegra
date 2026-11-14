// Sesión: el Worker verifica el ID token de Firebase (B1). Nada de lo que diga el navegador se cree sin esto.
import { createMiddleware } from 'hono/factory';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const JWKS_FIREBASE = new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
let llavesGoogle: JWTVerifyGetKey | undefined; // jose las cachea y las renueva cuando rotan

export type Sesion = {
  uid: string;
  email: string | null;
  email_verified: boolean;
  /** `google.com`, `password`… (claim firebase.sign_in_provider) */
  proveedor: string | null;
};

export type AppEnv = { Bindings: Env; Variables: { sesion: Sesion } };

export class AuthNoConfigurada extends Error {}

export async function verificarToken(token: string, env: Env): Promise<Sesion> {
  const proyecto = env.FIREBASE_PROJECT_ID;
  if (!proyecto) throw new AuthNoConfigurada();
  const llaves = env.TEST_JWKS_JSON
    ? createLocalJWKSet(JSON.parse(env.TEST_JWKS_JSON))
    : (llavesGoogle ??= createRemoteJWKSet(JWKS_FIREBASE));
  const { payload } = await jwtVerify(token, llaves, {
    algorithms: ['RS256'],
    issuer: `https://securetoken.google.com/${proyecto}`,
    audience: proyecto,
    requiredClaims: ['exp', 'sub'],
  });
  if (!payload.sub) throw new Error('sub vacío');
  const firebase = payload.firebase as { sign_in_provider?: unknown } | undefined;
  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email.toLowerCase() : null,
    email_verified: payload.email_verified === true,
    proveedor: typeof firebase?.sign_in_provider === 'string' ? firebase.sign_in_provider : null,
  };
}

/** Exige `Authorization: Bearer <ID token>` válido y deja la sesión en `c.var.sesion`. */
export const requiereSesion = createMiddleware<AppEnv>(async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return c.json({ error: 'sin_sesion' }, 401);
  try {
    c.set('sesion', await verificarToken(token, c.env));
  } catch (e) {
    if (e instanceof AuthNoConfigurada) return c.json({ error: 'auth_no_configurada' }, 503);
    return c.json({ error: 'sesion_invalida' }, 401); // sin detalle: no se le explica al atacante qué falló
  }
  await next();
});
