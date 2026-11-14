// SEG-01 (B5): recorre TODAS las rutas de negocio con dos tiendas. Falla si una ve o cambia algo de la otra,
// o si aparece una ruta nueva que no tiene su ataque escrito aquí.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';
import { app, RUTAS_PUBLICAS, sinNegocio } from './index';
import { sembrarNegocio } from './test/datos';
import { api } from './test/sesion';

const A = { uid: 'uid_a' }; // la víctima
const B = { uid: 'uid_b' }; // la tienda curiosa
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

type Peticion = { ruta: string; init?: RequestInit };
const conJson = (ruta: string, method: string, cuerpo: unknown): Peticion => ({ ruta, init: { method, body: JSON.stringify(cuerpo) } });

async function conCaptura(ruta: string): Promise<Peticion> {
  const formulario = new FormData();
  formulario.set('plan', 'PASS_7D');
  formulario.set('captura', new File([PNG], 'captura.png', { type: 'image/png' }));
  const serializado = new Response(formulario);
  const body = await serializado.arrayBuffer();
  return { ruta, init: { method: 'POST', body, headers: { 'Content-Type': serializado.headers.get('Content-Type')!, 'Content-Length': String(body.byteLength) } } };
}

async function conFoto(ruta: string): Promise<Peticion> {
  const formulario = new FormData();
  formulario.set('foto', new File([PNG], 'cuaderno.png', { type: 'image/png' }));
  const serializado = new Response(formulario);
  const body = await serializado.arrayBuffer();
  return { ruta, init: { method: 'POST', body, headers: { 'Content-Type': serializado.headers.get('Content-Type')!, 'Content-Length': String(body.byteLength) } } };
}

/** Lo que la tienda A tiene sembrado: ids y textos que B nunca debe ver. */
type Victima = { negocio: string; deudor: string; movimiento: string; request_id: string; pago: string; captura: string; cuaderno: string };
let v: Victima;

/**
 * Un ataque por ruta: lo que haría B para leer o cambiar lo de A (ids ajenos en la URL, `business_id` ajeno en el cuerpo…).
 * La clave es `MÉTODO ruta` tal como la registra el enrutador. Al añadir una ruta de negocio hay que añadir su ataque.
 */
const ATAQUES: Record<string, () => (Peticion | Promise<Peticion>)[]> = {
  'GET /api/negocio': () => [{ ruta: `/api/negocio?business_id=${v.negocio}` }],
  'PATCH /api/negocio': () => [conJson(`/api/negocio?business_id=${v.negocio}`, 'PATCH', { payment_methods_info: 'Nequi del intruso', default_alert_days: 1, tono_cobro: 'AVISO_FIRME', id: v.negocio, business_id: v.negocio })],
  // El código es de la tienda de la sesión: B nunca emite (ni pisa) el código de A, aunque nombre su negocio.
  'POST /api/negocio/whatsapp/codigo': () => [conJson(`/api/negocio/whatsapp/codigo?business_id=${v.negocio}`, 'POST', {})],
  'GET /api/deudores': () => [{ ruta: `/api/deudores?archivados=1&business_id=${v.negocio}` }],
  'POST /api/deudores': () => [conJson('/api/deudores', 'POST', { full_name: 'Intruso', business_id: v.negocio, id: v.deudor })],
  'GET /api/deudores/:id': () => [{ ruta: `/api/deudores/${v.deudor}` }],
  'PATCH /api/deudores/:id': () => [
    conJson(`/api/deudores/${v.deudor}`, 'PATCH', { full_name: 'Robado', lista_negra: true, archivado: true, credit_limit_cop: 1, business_id: 'bus_uid_b' }),
  ],
  'GET /api/deudores/:id/movimientos': () => [{ ruta: `/api/deudores/${v.deudor}/movimientos` }],
  'POST /api/deudores/:id/movimientos': () => [
    conJson(`/api/deudores/${v.deudor}/movimientos`, 'POST', { request_id: 'ataque-0001', type: 'ABONO', amount_cop: 1_000 }),
    conJson(`/api/deudores/${v.deudor}/movimientos`, 'POST', { request_id: 'ataque-0002', type: 'FIADO', amount_cop: 1_000, business_id: v.negocio }),
    conJson(`/api/deudores/${v.deudor}/movimientos`, 'POST', { request_id: v.request_id, type: 'FIADO', amount_cop: 5_000 }), // el request_id de A
  ],
  'POST /api/deudores/:id/cobros': () => [conJson(`/api/deudores/${v.deudor}/cobros`, 'POST', { tono: 'AVISO_FIRME' })],
  'POST /api/cobros-bot/:id': () => [
    conJson(`/api/cobros-bot/${v.deudor}`, 'POST', { tono: 'AVISO_FIRME', request_id: 'ataque-bot-0001', business_id: v.negocio }),
  ],
  // Sarin solo interpreta la frase de quien la envía: el negocio y la cuota salen de la sesión de B, nunca del cuerpo.
  'POST /api/ia/orden': () => [conJson(`/api/ia/orden?business_id=${v.negocio}`, 'POST', { frase: 'abónale veinte mil a don Carlos el del taller', business_id: v.negocio })],
  'GET /api/suscripcion': () => [{ ruta: `/api/suscripcion?business_id=${v.negocio}` }],
  'POST /api/suscripcion/pagos': () => [conCaptura(`/api/suscripcion/pagos?business_id=${v.negocio}`)],
  'POST /api/cuadernos/fotos': () => [conFoto(`/api/cuadernos/fotos?business_id=${v.negocio}`)],
  'POST /api/cuadernos/importar': () => [
    // La foto de A como evidencia, o la captura de pago de A: B no puede usarlas ni escribir en el libro de A.
    conJson('/api/cuadernos/importar', 'POST', { foto: v.cuaderno, request_id: 'ataque-cuaderno', filas: [{ full_name: 'Intruso', saldo_cop: 1_000 }], business_id: v.negocio }),
    conJson('/api/cuadernos/importar', 'POST', { foto: v.captura, request_id: 'ataque-cuaderno2', filas: [{ full_name: 'Intruso', saldo_cop: 1_000 }] }),
  ],
  'GET /api/archivos/*': () => [
    { ruta: `/api/archivos/${v.captura}` },
    { ruta: `/api/archivos/negocios/bus_uid_b/../${v.negocio}/pagos/${v.pago}.png` },
    { ruta: `/api/archivos/negocios/bus_uid_b/%2e%2e/${v.negocio}/pagos/${v.pago}.png` },
  ],
};

const rutasDeNegocio = [...new Set(
  app.routes
    .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api/') && !RUTAS_PUBLICAS.has(r.path) && !sinNegocio(r.method, r.path))
    .map((r) => `${r.method} ${r.path}`),
)].sort();

/** Todo lo que A tiene guardado, para comprobar que no cambió ni un byte. */
async function fotoDeA() {
  const filas = async (tabla: string, columna = 'business_id') =>
    (await env.DB.prepare(`SELECT * FROM ${tabla} WHERE ${columna} = ? ORDER BY id`).bind(v.negocio).all()).results;
  return JSON.stringify({
    negocio: await filas('businesses', 'id'),
    deudores: await filas('debtors'),
    libro: await filas('ledger_transactions'),
    pagos: await filas('subscription_payments'),
    mensajes: await filas('whatsapp_messages'),
    archivos: (await env.ARCHIVOS.list({ prefix: `negocios/${v.negocio}/` })).objects.map((o) => `${o.key}:${o.size}`),
  });
}

beforeEach(async () => {
  await sembrarNegocio(A.uid, { name: 'SECRETO tienda A', whatsapp_phone: '+573009990001' });
  await sembrarNegocio(B.uid);
  const pedir = async (p: Peticion | Promise<Peticion>) => { const { ruta, init } = await p; return (await api(ruta, A, init)).json<any>(); };
  const deudor = await pedir(conJson('/api/deudores', 'POST', { full_name: 'SECRETO don Carlos', alias_reference: 'SECRETO el del taller', doc_type: 'CC', doc_number: '1032456789', whatsapp_phone: '+573001112233' }));
  const { movimiento } = await pedir(conJson(`/api/deudores/${deudor.id}/movimientos`, 'POST', { request_id: 'toque-de-a-0001', type: 'FIADO', amount_cop: 50_000, description: 'SECRETO mercado' }));
  const { pago } = await pedir(conCaptura('/api/suscripcion/pagos'));
  const { foto: cuaderno } = await pedir(conFoto('/api/cuadernos/fotos'));
  v = { negocio: `bus_${A.uid}`, deudor: deudor.id, movimiento: movimiento.id, request_id: 'toque-de-a-0001', pago: pago.id, captura: `negocios/bus_${A.uid}/pagos/${pago.id}.png`, cuaderno };
});

describe('cobertura', () => {
  test('cada ruta de negocio tiene su ataque, y no sobra ninguno', () => {
    expect(rutasDeNegocio.length).toBeGreaterThan(5);
    expect(rutasDeNegocio.filter((r) => !(r in ATAQUES)), 'rutas nuevas sin cubrir: añade su ataque en ATAQUES').toEqual([]);
    expect(Object.keys(ATAQUES).filter((r) => !rutasDeNegocio.includes(r)), 'ataques de rutas que ya no existen').toEqual([]);
  });
});

describe('B no ve ni cambia nada de A', () => {
  test.each(Object.keys(ATAQUES))('%s', async (clave) => {
    const antes = await fotoDeA();
    const secretos = ['SECRETO', v.negocio, v.deudor, v.movimiento, v.pago, '1032456789', '3001112233', '3009990001', 'toque-de-a-0001'];
    for (const peticion of ATAQUES[clave]!()) {
      const { ruta, init } = await peticion;
      const res = await api(ruta, B, init);
      expect(res.status, `${init?.method ?? 'GET'} ${ruta}`).toBeLessThan(500);
      const texto = await res.text();
      for (const secreto of secretos) expect(texto, `${ruta} filtró «${secreto}»`).not.toContain(secreto);
      // Con un id ajeno en la URL la respuesta es la misma que si no existiera.
      if (ruta.includes(v.deudor) && !ruta.endsWith('/movimientos')) expect(res.status, ruta).toBe(404);
      if (ruta.startsWith('/api/archivos/')) expect(res.status, ruta).toBe(404);
    }
    expect(await fotoDeA(), `${clave} cambió algo de la tienda A`).toBe(antes);
  });

  test('A sí ve lo suyo (el recorrido no pasa por estar todo roto)', async () => {
    expect(await (await api(`/api/deudores/${v.deudor}`, A)).json()).toMatchObject({ full_name: 'SECRETO don Carlos', current_balance_cop: 50_000 });
    expect((await api(`/api/archivos/${v.captura}`, A)).status).toBe(200);
    expect((await (await api(`/api/deudores/${v.deudor}/movimientos`, A)).json<any>()).movimientos).toHaveLength(1);
  });
});

describe('validación de entradas: la basura nunca rompe ni escribe', () => {
  const BASURA = ['', 'no es json', '[]', 'null', '{"__proto__":{"admin":true}}', JSON.stringify({ full_name: { $ne: '' }, amount_cop: '1e9', type: ['FIADO'] })];
  const escrituras = Object.keys(ATAQUES).filter((r) => !r.startsWith('GET '));

  test.each(escrituras)('%s', async (clave) => {
    const [metodo, patron] = clave.split(' ') as [string, string];
    const ruta = patron.replace(':id', v.deudor);
    const antes = await fotoDeA();
    for (const cuerpo of BASURA) {
      const res = await api(ruta, A, { method: metodo, body: cuerpo, headers: { 'Content-Type': 'application/json', 'Content-Length': String(cuerpo.length) } });
      expect(res.status, `${clave} con ${JSON.stringify(cuerpo)}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${clave} con ${JSON.stringify(cuerpo)}`).toBeLessThan(500);
    }
    expect(await fotoDeA(), `${clave} escribió algo con una entrada inválida`).toBe(antes);
  });
});
