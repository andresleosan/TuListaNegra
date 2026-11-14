// SUP-01: una prueba recorre TODAS las rutas /api/superadmin/*: correo no listado, no verificado o sin Google → 403.
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { app } from './index';
import { enLista } from './superadmin';
import { tokenDe } from './test/sesion';

const ADMIN = 'admin@ejemplo.test';
const entorno = { ...env, SUPERADMIN_EMAILS: `otro@ejemplo.test, ${ADMIN.toUpperCase()} ` };

type Claims = Parameters<typeof tokenDe>[0];
const pedir = async (metodo: string, ruta: string, claims: Claims | null) =>
  app.request(ruta, { method: metodo, headers: claims ? { Authorization: `Bearer ${await tokenDe(claims)}` } : {} }, entorno);

// Las rutas se sacan del enrutador: una ruta nueva de la consola entra sola en este recorrido.
const rutas = app.routes
  .filter((r) => r.path.startsWith('/api/superadmin') && r.method !== 'ALL')
  .map((r) => [r.method, r.path.replace(/:\w+/g, 'x')] as const);

const NO_AUTORIZADOS: [string, Claims][] = [
  ['correo no listado', { email: 'tendero@ejemplo.test' }],
  ['correo listado pero sin verificar', { email: ADMIN, email_verified: false }],
  ['correo listado pero sin sesión de Google', { email: ADMIN, proveedor: 'password' }],
  ['correo parecido', { email: `x${ADMIN}` }],
  ['sin correo', { email: '' }],
];

describe('todas las rutas de la consola', () => {
  test('hay rutas que recorrer', () => {
    expect(rutas.length).toBeGreaterThan(0);
    expect(rutas).toContainEqual(['GET', '/api/superadmin/yo']);
  });

  test.each(rutas)('%s %s', async (metodo, ruta) => {
    expect((await pedir(metodo, ruta, null)).status, 'sin sesión').toBe(401);
    for (const [caso, claims] of NO_AUTORIZADOS) {
      const res = await pedir(metodo, ruta, claims);
      expect(res.status, caso).toBe(403);
      expect(await res.json(), caso).toEqual({ error: 'acceso_denegado' });
    }
    expect((await pedir(metodo, ruta, { email: ADMIN })).status, 'superadministrador').not.toBe(403);
  });

  test.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])('%s a una ruta inexistente de la consola tampoco revela nada', async (metodo) => {
    expect((await pedir(metodo, '/api/superadmin/no-existe', { email: 'tendero@ejemplo.test' })).status).toBe(403);
    expect((await pedir(metodo, '/api/superadmin/no-existe', { email: ADMIN })).status).toBe(404);
  });
});

describe('acceso', () => {
  test('el superadministrador entra aunque no tenga negocio', async () => {
    const res = await pedir('GET', '/api/superadmin/yo', { email: ADMIN, uid: 'uid_admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: ADMIN });
  });

  test('sin SUPERADMIN_EMAILS configurado nadie entra', async () => {
    const res = await app.request('/api/superadmin/yo', { headers: { Authorization: `Bearer ${await tokenDe({ email: ADMIN })}` } }, { ...env, SUPERADMIN_EMAILS: undefined });
    expect(res.status).toBe(403);
  });

  test('/api/sesion dice si es superadministrador (solo para pintar el enlace)', async () => {
    expect(await (await pedir('GET', '/api/sesion', { email: ADMIN })).json()).toMatchObject({ es_superadmin: true });
    expect(await (await pedir('GET', '/api/sesion', { email: ADMIN, proveedor: 'password' })).json()).toMatchObject({ es_superadmin: false });
  });

  test.each<[string | undefined, string | null, boolean]>([
    ['a@x.test,b@x.test', 'b@x.test', true],
    [' A@X.test , b@x.test ', 'a@x.test', true],
    ['a@x.test', 'A@X.TEST', true],
    ['a@x.test', 'aa@x.test', false],
    ['a@x.test', 'a@x.tes', false],
    ['a@x.test,', '', false],
    [',,', '', false],
    ['', 'a@x.test', false],
    [undefined, 'a@x.test', false],
    ['a@x.test', null, false],
  ])('enLista(%j, %j) → %s', (lista, correo, esperado) => {
    expect(enLista(lista, correo)).toBe(esperado);
  });
});
