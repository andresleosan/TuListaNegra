// SUS-01: la captura solo la ve su dueño (el superadministrador usará `servirObjeto` desde su consola).
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { claveValida, servirObjeto } from '../archivos';
import type { AppEnv } from '../auth';
import { EN_ESTADO, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CLAVE_A = 'negocios/bus_uid_a/pagos/pay_1.png';
const A = { uid: 'uid_a' };
const B = { uid: 'uid_b' };

const guardar = (clave = CLAVE_A, contentType: string | null = 'image/png') =>
  env.ARCHIVOS.put(clave, PNG, contentType ? { httpMetadata: { contentType } } : undefined);

/** Estado de la respuesta, con el cuerpo siempre consumido. */
async function estadoDe(ruta: string, claims: Parameters<typeof api>[1]) {
  const res = await api(ruta, claims);
  await res.arrayBuffer();
  return res.status;
}

describe('GET /api/archivos/*', () => {
  test('el dueño ve su captura, con cabeceras de archivo privado', async () => {
    await sembrarNegocio('uid_a');
    await guardar();
    const res = await api(`/api/archivos/${CLAVE_A}`, A);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toBe('inline');
  });

  test('la captura subida por la API se lee con la clave que quedó en D1', async () => {
    await sembrarNegocio('uid_a', EN_ESTADO.EXPIRED_READONLY());
    const formulario = new FormData();
    formulario.append('plan', 'PASS_7D');
    formulario.append('captura', new File([PNG], 'captura.jpg', { type: 'image/jpeg' }));
    const serializado = new Response(formulario);
    const body = await serializado.arrayBuffer();
    const subida = await api('/api/suscripcion/pagos', A, {
      method: 'POST', body, headers: { 'Content-Type': serializado.headers.get('Content-Type')!, 'Content-Length': String(body.byteLength) },
    });
    expect(subida.status).toBe(201);
    const { pago } = (await subida.json()) as { pago: { id: string } };

    const res = await api(`/api/archivos/negocios/bus_uid_a/pagos/${pago.id}.png`, A);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png'); // el tipo detectado, no el declarado
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test('otro negocio recibe 404, igual que si el archivo no existiera', async () => {
    await sembrarNegocio('uid_a');
    await sembrarNegocio('uid_b');
    await guardar();
    const ajeno = await api(`/api/archivos/${CLAVE_A}`, B);
    const inexistente = await api('/api/archivos/negocios/bus_uid_a/pagos/no_existe.png', B);
    const propioInexistente = await api('/api/archivos/negocios/bus_uid_b/pagos/no_existe.png', B);
    expect([ajeno.status, inexistente.status, propioInexistente.status]).toEqual([404, 404, 404]);
    const cuerpos = [await ajeno.text(), await inexistente.text(), await propioInexistente.text()];
    expect(cuerpos).toEqual(Array(3).fill(JSON.stringify({ error: 'no_encontrado' })));
  });

  test.each([
    ['recorrido con ..', 'negocios/bus_uid_b/../bus_uid_a/pagos/pay_1.png'],
    ['recorrido con %2e%2e', 'negocios/bus_uid_b/%2e%2e/bus_uid_a/pagos/pay_1.png'],
    ['recorrido con %2E%2E y barra codificada', 'negocios/bus_uid_b%2F%2E%2E%2Fbus_uid_a/pagos/pay_1.png'],
    ['recorrido con barra codificada', 'negocios/bus_uid_b/..%2fbus_uid_a/pagos/pay_1.png'],
    ['doble codificación', 'negocios/bus_uid_b/%252e%252e/bus_uid_a/pagos/pay_1.png'],
    ['barra inicial', '/negocios/bus_uid_a/pagos/pay_1.png'],
    ['doble barra', 'negocios/bus_uid_b//../bus_uid_a/pagos/pay_1.png'],
    ['barra invertida', 'negocios/bus_uid_b/..\\bus_uid_a/pagos/pay_1.png'],
    ['prefijo parecido', 'negocios/bus_uid_a_/pagos/pay_1.png'],
    ['sin el prefijo de negocios', 'bus_uid_a/pagos/pay_1.png'],
    ['solo el prefijo del otro', 'negocios/bus_uid_a/'],
    ['mayúsculas', 'NEGOCIOS/bus_uid_a/pagos/pay_1.png'],
  ])('clave manipulada (%s) → 404 para el negocio B', async (_nombre, clave) => {
    await sembrarNegocio('uid_a');
    await sembrarNegocio('uid_b');
    await guardar();
    expect(await estadoDe(`/api/archivos/${clave}`, B)).toBe(404);
  });

  test('una clave propia con recorrido tampoco se sirve', async () => {
    await sembrarNegocio('uid_a');
    await guardar();
    // Objetos con claves raras que alguien hubiera logrado crear: la validación los niega aunque existan.
    await guardar('negocios/bus_uid_a/pagos//pay_1.png');
    await guardar('negocios/bus_uid_a/%2e%2e/pay_1.png');
    expect(await estadoDe('/api/archivos/negocios/bus_uid_a/pagos//pay_1.png', A)).toBe(404);
    expect(await estadoDe('/api/archivos/negocios/bus_uid_a/%252e%252e/pay_1.png', A)).toBe(404);
    expect(await estadoDe('/api/archivos/negocios/bus_uid_a/pagos/pay_1.png%00', A)).toBe(404);
    expect(await estadoDe('/api/archivos/', A)).toBe(404);
    expect(await estadoDe('/api/archivos', A)).toBe(404);
  });

  test('sin sesión → 401; sin negocio → 404; suspendido → 403', async () => {
    await sembrarNegocio('uid_a', EN_ESTADO.SUSPENDED_BY_ADMIN());
    await guardar();
    expect(await estadoDe(`/api/archivos/${CLAVE_A}`, null)).toBe(401);
    expect(await estadoDe(`/api/archivos/${CLAVE_A}`, { uid: 'uid_sin_negocio' })).toBe(404);
    expect(await estadoDe(`/api/archivos/${CLAVE_A}`, A)).toBe(403);
  });

  test('un vencido (solo lectura) sigue viendo su captura', async () => {
    await sembrarNegocio('uid_a', EN_ESTADO.EXPIRED_READONLY());
    await guardar();
    expect(await estadoDe(`/api/archivos/${CLAVE_A}`, A)).toBe(200);
  });

  test('no se puede escribir ni borrar por esta ruta', async () => {
    await sembrarNegocio('uid_a');
    await guardar();
    for (const method of ['PUT', 'POST', 'DELETE']) {
      const res = await api(`/api/archivos/${CLAVE_A}`, A, { method, body: 'x' });
      await res.arrayBuffer();
      expect(res.status).toBe(404);
    }
    expect((await env.ARCHIVOS.head(CLAVE_A))?.size).toBe(PNG.length);
  });
});

describe('servirObjeto: sin comprobación de dueño (para la consola del superadministrador)', () => {
  const app = new Hono<AppEnv>().get('/ver', (c) => servirObjeto(c, c.req.query('clave') ?? ''));
  const ver = (clave: string) => app.request(`/ver?clave=${encodeURIComponent(clave)}`, {}, env);

  test('sirve cualquier clave existente con las cabeceras de archivo privado', async () => {
    await guardar();
    const res = await ver(CLAVE_A);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline',
    });
  });

  test('un objeto sin tipo guardado sale como binario genérico', async () => {
    await guardar(CLAVE_A, null);
    const res = await ver(CLAVE_A);
    await res.arrayBuffer();
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
  });

  test('clave inexistente o inválida → 404', async () => {
    await guardar();
    await guardar('negocios/bus_uid_a/../pay_1.png');
    for (const clave of ['negocios/bus_uid_a/pagos/otro.png', 'negocios/bus_uid_a/../pay_1.png', '']) {
      const res = await ver(clave);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'no_encontrado' });
    }
  });
});

describe('claveValida', () => {
  test.each([
    ['negocios/bus_01JABC/pagos/pay_01JABC.png', true],
    ['negocios/bus_uid_a/evidencias/mov_1.webp', true],
    ['a', true],
    ['', false],
    ['/negocios/bus_1/pagos/x.png', false],
    ['negocios/bus_1/pagos/x.png/', false],
    ['negocios//bus_1/pagos/x.png', false],
    ['negocios/bus_1/../bus_2/pagos/x.png', false],
    ['../negocios/bus_1/x.png', false],
    ['negocios/bus_1/..', false],
    ['negocios/bus_1/./x.png', false],
    ['negocios/bus_1/.oculto', false],
    ['negocios/bus_1/%2e%2e/bus_2/x.png', false],
    ['negocios/bus_1/%2E%2E/bus_2/x.png', false],
    ['negocios/bus_1%2fpagos/x.png', false],
    ['negocios/bus_1/..%2fbus_2/x.png', false],
    ['negocios\\bus_1\\x.png', false],
    ['negocios/bus_1/x.png?descargar=1', false],
    ['negocios/bus_1/x y.png', false],
    ['negocios/bus_1/x\u0000.png', false],
    ['negocios/bus_1/ñ.png', false],
  ])('%j → %s', (clave, esperado) => {
    expect(claveValida(clave)).toBe(esperado);
  });
});
