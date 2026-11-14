// AUT-02: alta del negocio con prueba de 72 h, una por cuenta y por teléfono, y puerta de registro.
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { bd } from '../db';
import { businesses } from '../db/schema';
import { HORA } from '../test/datos';
import { api } from '../test/sesion';

const PILOTO = 'piloto@ejemplo.test';
const ADMIN = 'admin@ejemplo.test';
// Entorno explícito: no depende de lo que haya en un `.dev.vars` local.
const CERRADO: Env = { ...env, SIGNUP_READY: '0', PILOT_EMAILS: ` otro@ejemplo.test , ${PILOTO.toUpperCase()} `, SUPERADMIN_EMAILS: ADMIN };
const ABIERTO: Env = { ...env, SIGNUP_READY: '1', PILOT_EMAILS: undefined, SUPERADMIN_EMAILS: undefined };

const DATOS = { name: 'Tienda La Esquina', whatsapp_phone: '300 123 4567', acepta_terminos: true };

type Sesion = Parameters<typeof api>[1];

const alta = (claims: Sesion = { uid: 'uid_1', email: PILOTO }, cuerpo: unknown = DATOS, entorno = CERRADO, init: RequestInit = {}) =>
  api('/api/negocio', claims, { method: 'POST', body: JSON.stringify(cuerpo), ...init }, entorno);

const filas = () => bd(env).select().from(businesses).all();

describe('alta correcta', () => {
  test('crea el negocio en prueba de 72 h exactas y responde como GET /api/negocio', async () => {
    const antes = Date.now();
    const res = await alta();
    const despues = Date.now();
    expect(res.status).toBe(201);
    const cuerpo = await res.json<{ id: string; vence_en: number }>();
    expect(cuerpo).toMatchObject({
      name: 'Tienda La Esquina', estado: 'TRIAL', plan: 'TRIAL_3D', gratis: false, whatsapp_phone: '+573001234567',
      permisos: { ver: true, escribir: true, ia: true }, limites: { deudores: 15, ocr: 3, ia: 10, cobros: 5 }, usados: { ocr: 0, ia: 0, cobros: 0 },
    });
    expect(cuerpo.id).toMatch(/^bus_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(cuerpo.vence_en).toBeGreaterThanOrEqual(antes + 72 * HORA);
    expect(cuerpo.vence_en).toBeLessThanOrEqual(despues + 72 * HORA);

    const [fila] = await filas();
    expect(fila).toMatchObject({ owner_firebase_uid: 'uid_1', owner_email: PILOTO, subscription_plan: 'TRIAL_3D', free_forever_at: null, suspended_at: null });
    // Un solo «ahora»: vencimiento, ciclo de cuotas, términos y creación salen del mismo instante.
    expect(fila!.subscription_expires_at - fila!.created_at).toBe(72 * HORA);
    expect([fila!.quota_cycle_started_at, fila!.terms_accepted_at]).toEqual([fila!.created_at, fila!.created_at]);

    expect(await (await api('/api/negocio', { uid: 'uid_1', email: PILOTO })).json()).toEqual(cuerpo);
  });

  test('el dueño, el plan y las fechas los fija el servidor aunque el cuerpo traiga otros', async () => {
    const res = await alta({ uid: 'uid_1', email: PILOTO }, {
      ...DATOS, id: 'bus_ajeno', owner_firebase_uid: 'uid_victima', owner_email: 'victima@ejemplo.test', business_id: 'bus_ajeno',
      subscription_plan: 'PASS_30D', subscription_expires_at: Date.now() + 9_999 * HORA, free_forever_at: 1, quota_cycle_started_at: 1,
      ai_ocr_used_count: -50, terms_accepted_at: 1, created_at: 1, whatsapp_verified_at: 1,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ estado: 'TRIAL', plan: 'TRIAL_3D', gratis: false, usados: { ocr: 0 } });
    const [fila, ...resto] = await filas();
    expect(resto).toEqual([]);
    expect(fila).toMatchObject({ owner_firebase_uid: 'uid_1', owner_email: PILOTO, subscription_plan: 'TRIAL_3D', free_forever_at: null, whatsapp_verified_at: null });
    expect(fila!.id).not.toBe('bus_ajeno');
    expect(fila!.subscription_expires_at - fila!.created_at).toBe(72 * HORA);
    expect(fila!.created_at).toBeGreaterThan(1);
  });

  test('dice si el bot de WhatsApp envía de verdad: con WHATSAPP_SEND_READY apagado, no', async () => {
    await alta();
    expect(await (await api('/api/negocio', { uid: 'uid_1', email: PILOTO }, {}, CERRADO)).json()).toMatchObject({ bot_whatsapp_activo: false });
    const encendido = { ...CERRADO, WHATSAPP_SEND_READY: '1' };
    expect(await (await api('/api/negocio', { uid: 'uid_1', email: PILOTO }, {}, encendido)).json()).toMatchObject({ bot_whatsapp_activo: true, bot_whatsapp_simulado: false });
    // Producción con el interruptor apagado (sin el simulador de desarrollo): el botón del bot no se ofrece.
    const produccion = { ...CERRADO, TEST_WHATSAPP_SIMULADO: undefined };
    expect(await (await api('/api/negocio', { uid: 'uid_1', email: PILOTO }, {}, produccion)).json()).toMatchObject({ bot_whatsapp_activo: false, bot_whatsapp_simulado: false });
  });

  test('recorta el nombre', async () => {
    const res = await alta(undefined, { ...DATOS, name: '  Tienda Rubi  ' });
    expect(await res.json()).toMatchObject({ name: 'Tienda Rubi' });
  });
});

describe('una prueba por cuenta y por teléfono', () => {
  test('la misma cuenta no crea un segundo negocio', async () => {
    expect((await alta()).status).toBe(201);
    const res = await alta(undefined, { ...DATOS, name: 'Otra tienda', whatsapp_phone: '3109998877' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ya_tiene_negocio' });
    // Con el mismo teléfono también manda la cuenta: es su propio negocio.
    expect(await (await alta()).json()).toEqual({ error: 'ya_tiene_negocio' });
    expect(await filas()).toHaveLength(1);
  });

  test.each(['3001234567', '+57 300 123 4567', '(300) 123-4567'])('otra cuenta con el mismo teléfono escrito «%s» se rechaza', async (telefono) => {
    expect((await alta()).status).toBe(201);
    const res = await alta({ uid: 'uid_2', email: PILOTO }, { ...DATOS, whatsapp_phone: telefono });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'telefono_en_uso' });
    expect(await filas()).toHaveLength(1);
  });

  test('dos altas simultáneas de la misma cuenta: exactamente una entra', async () => {
    const respuestas = await Promise.all([
      alta(undefined, { ...DATOS, whatsapp_phone: '3001110001' }),
      alta(undefined, { ...DATOS, whatsapp_phone: '3001110002' }),
      alta(undefined, { ...DATOS, whatsapp_phone: '3001110003' }),
    ]);
    expect(respuestas.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await filas()).toHaveLength(1);
  });

  test('dos altas simultáneas con el mismo teléfono desde cuentas distintas: exactamente una entra', async () => {
    const respuestas = await Promise.all([alta({ uid: 'uid_1', email: PILOTO }), alta({ uid: 'uid_2', email: PILOTO })]);
    expect(respuestas.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await filas()).toHaveLength(1);
  });
});

describe('puerta de registro', () => {
  test('el entorno de pruebas trae SIGNUP_READY apagado', () => {
    expect(env.SIGNUP_READY).toBe('0');
  });

  test.each<[string, Sesion, number]>([
    ['correo no listado', { email: 'cualquiera@ejemplo.test' }, 403],
    ['correo piloto', { email: PILOTO }, 201],
    ['correo piloto con otras mayúsculas', { email: 'Piloto@Ejemplo.Test' }, 201],
    ['correo de superadministrador', { email: ADMIN }, 201],
    ['correo piloto sin verificar', { email: PILOTO, email_verified: false }, 403],
    ['superadministrador sin verificar', { email: ADMIN, email_verified: false }, 403],
    ['coincidencia parcial por delante', { email: `x${PILOTO}` }, 403],
    ['coincidencia parcial por detrás', { email: `${PILOTO}.co` }, 403],
    ['solo el dominio', { email: 'ejemplo.test' }, 403],
  ])('SIGNUP_READY=0 · %s → %i', async (_caso, claims, esperado) => {
    const res = await alta({ uid: 'uid_1', ...claims });
    expect(res.status).toBe(esperado);
    if (esperado === 403) expect(await res.json()).toEqual({ error: 'registro_cerrado' });
    expect(await filas()).toHaveLength(esperado === 201 ? 1 : 0);
  });

  test('sin listas configuradas no entra nadie', async () => {
    const res = await alta({ uid: 'uid_1', email: PILOTO }, DATOS, { ...env, SIGNUP_READY: '0', PILOT_EMAILS: undefined, SUPERADMIN_EMAILS: undefined });
    expect(res.status).toBe(403);
  });

  test('solo «1» abre el registro', async () => {
    for (const valor of ['true', '01', ' 1', '']) {
      const res = await alta({ uid: 'uid_1', email: 'cualquiera@ejemplo.test' }, DATOS, { ...ABIERTO, SIGNUP_READY: valor });
      expect(res.status, `SIGNUP_READY=«${valor}»`).toBe(403);
    }
  });

  test("SIGNUP_READY='1': entra cualquiera con sesión válida", async () => {
    const res = await alta({ uid: 'uid_9', email: 'cualquiera@ejemplo.test', email_verified: false, proveedor: 'password' }, DATOS, ABIERTO);
    expect(res.status).toBe(201);
    expect(await bd(env).select().from(businesses).where(eq(businesses.owner_firebase_uid, 'uid_9')).get()).toMatchObject({ owner_email: 'cualquiera@ejemplo.test' });
  });
});

describe('validación: 400 sin crear nada', () => {
  test.each<[string, object, string[]]>([
    ['sin aceptar términos', { ...DATOS, acepta_terminos: false }, ['acepta_terminos']],
    ['términos ausentes', { name: DATOS.name, whatsapp_phone: DATOS.whatsapp_phone }, ['acepta_terminos']],
    ['términos como texto', { ...DATOS, acepta_terminos: 'true' }, ['acepta_terminos']],
    ['nombre vacío', { ...DATOS, name: '' }, ['name']],
    ['nombre de solo espacios', { ...DATOS, name: '    ' }, ['name']],
    ['nombre de una letra', { ...DATOS, name: 'A' }, ['name']],
    ['nombre de 81 caracteres', { ...DATOS, name: 'a'.repeat(81) }, ['name']],
    ['teléfono ausente', { name: DATOS.name, acepta_terminos: true }, ['whatsapp_phone']],
    ['teléfono corto', { ...DATOS, whatsapp_phone: '300123456' }, ['whatsapp_phone']],
    ['teléfono fijo', { ...DATOS, whatsapp_phone: '6012345678' }, ['whatsapp_phone']],
    ['teléfono de otro país', { ...DATOS, whatsapp_phone: '+1 300 123 4567' }, ['whatsapp_phone']],
    ['teléfono numérico en vez de texto', { ...DATOS, whatsapp_phone: 3001234567 }, ['whatsapp_phone']],
    ['todo mal', { name: '', whatsapp_phone: 'x', acepta_terminos: false }, ['name', 'whatsapp_phone', 'acepta_terminos']],
  ])('%s', async (_caso, cuerpo, campos) => {
    const res = await alta(undefined, cuerpo);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'datos_invalidos', campos });
    expect(await filas()).toEqual([]);
  });

  test.each([['no es JSON', '{'], ['null', 'null'], ['una lista', '[]'], ['un texto', '"hola"']])('cuerpo que %s', async (_caso, body) => {
    const res = await alta(undefined, DATOS, CERRADO, { body });
    expect(res.status).toBe(400);
    expect(await filas()).toEqual([]);
  });

  test('el nombre admite 2 y 80 caracteres', async () => {
    expect((await alta({ uid: 'uid_1', email: PILOTO }, { ...DATOS, name: 'Ñú' })).status).toBe(201);
    expect((await alta({ uid: 'uid_2', email: PILOTO }, { ...DATOS, name: 'a'.repeat(80), whatsapp_phone: '3109998877' })).status).toBe(201);
  });
});

describe('sesión y límites', () => {
  test('sin sesión → 401', async () => {
    const res = await alta(null);
    expect(res.status).toBe(401);
    expect(await filas()).toEqual([]);
  });

  test('una sesión sin correo no crea negocio ni con el registro abierto', async () => {
    // tokenDe pone un correo por defecto: se firma el token con un correo que no es texto.
    const res = await alta({ uid: 'uid_1', email: 123 as unknown as string }, DATOS, ABIERTO);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'correo_requerido' });
    expect(await filas()).toEqual([]);
  });

  test('límite de altas por IP: 429 al superar 5 en un minuto', async () => {
    const desde = (ip: string, n: number) => alta({ uid: `uid_ip_${n}`, email: PILOTO }, { ...DATOS, whatsapp_phone: `30011122${String(n).padStart(2, '0')}` }, CERRADO, { headers: { 'CF-Connecting-IP': ip } });
    const estados: number[] = [];
    for (let n = 0; n < 7; n++) estados.push((await desde('198.51.100.7', n)).status);
    expect(estados).toEqual([201, 201, 201, 201, 201, 429, 429]);
    expect(await filas()).toHaveLength(5);
    // El límite es por IP: otra dirección sigue entrando.
    expect((await desde('198.51.100.8', 7)).status).toBe(201);
  });

  test('el límite cuenta también los intentos rechazados', async () => {
    const intento = () => alta({ uid: 'uid_1', email: 'cualquiera@ejemplo.test' }, DATOS, CERRADO, { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
    const estados: number[] = [];
    for (let n = 0; n < 6; n++) estados.push((await intento()).status);
    expect(estados).toEqual([403, 403, 403, 403, 403, 429]);
  });
});
