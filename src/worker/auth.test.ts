// AUT-01: con llaves locales, un token válido pasa; vencido, de otro proyecto o con firma inválida se rechaza.
import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { app } from './index';
import { api, PROYECTO, tokenDe } from './test/sesion';

const conToken = (token: string, entorno: Env = env) =>
  app.request('/api/sesion', { headers: { Authorization: `Bearer ${token}` } }, entorno);

/** Token a medida, firmado por defecto con la llave buena. */
async function firmar(claims: { iss?: string; aud?: string; sub?: string; exp?: number | string }, llave?: CryptoKey) {
  const clave = llave ?? (await importJWK(JSON.parse(env.TEST_PRIVATE_JWK), 'RS256'));
  const jwt = new SignJWT({ email: 'x@ejemplo.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'prueba' })
    .setIssuer(claims.iss ?? `https://securetoken.google.com/${PROYECTO}`)
    .setAudience(claims.aud ?? PROYECTO)
    .setIssuedAt();
  if (claims.sub !== undefined) jwt.setSubject(claims.sub);
  if (claims.exp !== undefined) jwt.setExpirationTime(claims.exp);
  return jwt.sign(clave);
}

describe('token válido', () => {
  test('pasa y expone la sesión', async () => {
    const res = await api('/api/sesion', { uid: 'uid_42', email: 'Tendero@Ejemplo.test', proveedor: 'google.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: 'uid_42', email: 'tendero@ejemplo.test', email_verified: true, proveedor: 'google.com', es_superadmin: false });
  });
});

describe('se rechaza con 401', () => {
  test('sin cabecera Authorization', async () => {
    const res = await api('/api/sesion', null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sin_sesion' });
  });

  test.each([
    ['vencido', () => firmar({ sub: 'u', exp: Math.floor(Date.now() / 1000) - 60 })],
    ['sin exp', () => firmar({ sub: 'u' })],
    ['de otro proyecto (aud)', () => firmar({ sub: 'u', exp: '1h', aud: 'otro-proyecto' })],
    ['de otro proyecto (iss)', () => firmar({ sub: 'u', exp: '1h', iss: 'https://securetoken.google.com/otro-proyecto' })],
    ['sin sub', () => firmar({ exp: '1h' })],
    ['con sub vacío', () => firmar({ sub: '', exp: '1h' })],
    ['firmado con otra llave RSA', async () => firmar({ sub: 'u', exp: '1h' }, (await generateKeyPair('RS256')).privateKey)],
    ['con la firma alterada', async () => (await tokenDe()).slice(0, -4) + 'AAAA'],
    ['con el cuerpo alterado', async () => {
      const [h, , f] = (await tokenDe({ uid: 'uid_1' })).split('.');
      return `${h}.${btoa(JSON.stringify({ sub: 'uid_admin', aud: PROYECTO, iss: `https://securetoken.google.com/${PROYECTO}`, exp: 9999999999 })).replace(/=+$/, '')}.${f}`;
    }],
    ['alg none', async () => {
      const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
      return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u', aud: PROYECTO, iss: `https://securetoken.google.com/${PROYECTO}`, exp: 9999999999 })}.`;
    }],
    ['HS256 firmado con la llave pública como secreto', async () => {
      const publica = JSON.parse(env.TEST_JWKS_JSON!).keys[0];
      return new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'prueba' }).setSubject('u').setAudience(PROYECTO)
        .setIssuer(`https://securetoken.google.com/${PROYECTO}`).setExpirationTime('1h').sign(new TextEncoder().encode(JSON.stringify(publica)));
    }],
    ...(['RS384', 'RS512', 'PS256'] as const).map((alg) => [`${alg} con la misma llave (solo vale RS256)`, async () => {
      const llave = await importJWK(JSON.parse(env.TEST_PRIVATE_JWK), alg);
      return new SignJWT({}).setProtectedHeader({ alg, kid: 'prueba' }).setSubject('u').setAudience(PROYECTO)
        .setIssuer(`https://securetoken.google.com/${PROYECTO}`).setExpirationTime('1h').sign(llave);
    }] as [string, () => Promise<string>]),
    ['basura', async () => 'no-es-un-jwt'],
  ])('token %s', async (_caso, crear) => {
    const res = await conToken(await crear());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sesion_invalida' });
  });
});

describe('configuración', () => {
  test('sin FIREBASE_PROJECT_ID falla cerrado con 503', async () => {
    const res = await conToken(await tokenDe(), { ...env, FIREBASE_PROJECT_ID: undefined });
    expect(res.status).toBe(503);
  });

  // El orden importa: jose guarda en caché el JWKS que logra descargar.
  describe('JWKS de Google', () => {
    afterEach(() => vi.unstubAllGlobals());

    test('si Google no responde es 503, no una sesión inválida', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('red caída'); }));
      const token = await firmar({ sub: 'u', exp: '1h', aud: 'tienda-real-2', iss: 'https://securetoken.google.com/tienda-real-2' });
      const res = await conToken(token, { ...env, FIREBASE_PROJECT_ID: 'tienda-real-2' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'servicio_no_disponible' });
    });

    test('el JWKS local solo vale con un proyecto ficticio: con uno real se usan las llaves de Google', async () => {
      const pedido = vi.fn(async (_url: unknown) => Response.json({ keys: [] }));
      vi.stubGlobal('fetch', pedido);
      const token = await firmar({ sub: 'u', exp: '1h', aud: 'tienda-real', iss: 'https://securetoken.google.com/tienda-real' });
      const res = await conToken(token, { ...env, FIREBASE_PROJECT_ID: 'tienda-real' });
      expect(res.status).toBe(401); // la llave local no está entre las de Google
      expect(String(pedido.mock.calls[0]?.[0])).toContain('securetoken@system.gserviceaccount.com');
    });
  });

  test('la llave pública de prueba no sirve si el JWKS es otro', async () => {
    const otro = await generateKeyPair('RS256', { extractable: true });
    const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(otro.publicKey)), kid: 'prueba', alg: 'RS256', use: 'sig' }] });
    const res = await conToken(await tokenDe(), { ...env, TEST_JWKS_JSON: jwks });
    expect(res.status).toBe(401);
  });

  test('/api/health sigue siendo pública; cualquier otra ruta de /api exige sesión', async () => {
    expect((await api('/api/health', null)).status).toBe(200);
    expect((await api('/api/no-existe', null)).status).toBe(401);
  });
});
