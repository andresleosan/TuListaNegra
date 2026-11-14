// WAP-08: panel del puente en la consola. El estado no lleva secretos, teléfonos ni textos; la salud sale de reglas
// fijas; el envío de prueba solo va al teléfono VERIFICADO de la tienda del propio superadministrador. Nada sale a la red.
// (El 403 a quien no es superadministrador lo cubre el recorrido de todas las rutas en ../superadmin.test.ts.)
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';
import { cuerpoMeta, entornoWa, entrante, estado, inyectar, SECRETO_DEV, TOKEN_DEV } from '../test/whatsapp';
import { ESPERA_PRUEBA_MS, saludDe } from './puente';
import { SimulatedGateway } from './simulado';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00');
const HORA = 3_600_000;
const ADMIN = { email: 'admin@ejemplo.test', uid: 'uid_admin' };
const TEL_ADMIN = '+573109990011'; // ficticio
const TEL_OTRO = '+573109990022'; // ficticio
const CLIENTE = '+573001234567'; // ficticio
const entorno = (extra: Partial<Env> = {}) => entornoWa({ SUPERADMIN_EMAILS: ADMIN.email, ...extra });
const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;
const estadoPuente = (e: Env = entorno()) => api('/api/superadmin/puente', ADMIN, {}, e);
const probar = (cuerpo: unknown = {}, e: Env = entorno()) => api('/api/superadmin/puente/prueba', ADMIN, { method: 'POST', body: JSON.stringify(cuerpo) }, e);
const salientes = async () =>
  (await env.DB.prepare("SELECT phone, template, business_id, status, callback_data FROM whatsapp_messages WHERE direction = 'SALIENTE' ORDER BY created_at, id").all()).results;

let red: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES_10);
  red = vi.fn(() => Promise.reject(new Error('el puente no debe salir a la red')));
  vi.stubGlobal('fetch', red);
});
afterEach(() => {
  try {
    expect(red).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

describe('estado del puente', () => {
  test('sin secreto de la app → sin_configurar', async () => {
    const r = await json(estadoPuente(entorno({ WHATSAPP_APP_SECRET: undefined, WHATSAPP_VERIFY_TOKEN: undefined })));
    expect(r).toMatchObject({ salud: 'sin_configurar', configuracion: { envio_real: false, secreto_app: false, token_verificacion: false } });
  });

  test('con el simulador, un secreto que no es de desarrollo no sirve (el webhook lo rechaza): sin_configurar', async () => {
    const r = await json(estadoPuente(entorno({ WHATSAPP_APP_SECRET: 'secreto-real-de-meta', WHATSAPP_VERIFY_TOKEN: 'token-real' })));
    expect(r).toMatchObject({ salud: 'sin_configurar', configuracion: { secreto_app: false, token_verificacion: false } });
  });

  test('con el envío real encendido, un secreto de desarrollo no sirve: sin_configurar', async () => {
    expect(await json(estadoPuente(entorno({ WHATSAPP_SEND_READY: '1' })))).toMatchObject({
      salud: 'sin_configurar', configuracion: { envio_real: true, secreto_app: false, token_verificacion: false },
    });
  });

  test('sin eventos → sin_eventos; un entrante firmado → ok, con su fecha y los contadores', async () => {
    expect(await json(estadoPuente())).toEqual({
      salud: 'sin_eventos',
      configuracion: { envio_real: false, secreto_app: true, token_verificacion: true },
      ultimo_evento: null,
      ultimo_saliente: null,
      ultimas_24h: { entrantes: 0, sin_enrutar: 0, en_eleccion: 0, salientes: { accepted: 0, rejected: 0, unknown: 0, sent: 0, delivered: 0, read: 0, failed: 0 } },
    });
    expect((await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: CLIENTE, texto: 'Hola, ya le pagué' })] }), entorno())).status).toBe(200);
    const r = await json(estadoPuente());
    expect(r).toMatchObject({ salud: 'ok', ultimo_evento: { en: MARTES_10, tipo: 'mensaje' }, ultimas_24h: { entrantes: 1, sin_enrutar: 1 } });
  });

  test('un estado firmado de un envío también es un evento; pasadas 24 h sin nada vuelve a sin_eventos', async () => {
    const r = await new SimulatedGateway(env).sendTemplate({ to: CLIENTE, requestId: 'req-1', template: 'codigo_verificacion', language: 'es_CO', variables: ['123456'] });
    expect(await json(estadoPuente())).toMatchObject({ salud: 'sin_eventos', ultimo_evento: null, ultimo_saliente: { en: MARTES_10, estado: 'accepted' } });
    vi.setSystemTime(MARTES_10 + HORA);
    await inyectar(cuerpoMeta({ estados: [estado(r.status === 'accepted' ? r.waMessageId : '', 'delivered')] }), entorno());
    expect(await json(estadoPuente())).toMatchObject({
      salud: 'ok', ultimo_evento: { en: MARTES_10 + HORA, tipo: 'estado' }, ultimo_saliente: { en: MARTES_10, estado: 'delivered' },
      ultimas_24h: { salientes: { delivered: 1, accepted: 0 } },
    });
    vi.setSystemTime(MARTES_10 + 26 * HORA);
    expect(await json(estadoPuente())).toMatchObject({ salud: 'sin_eventos', ultimo_evento: { en: MARTES_10 + HORA }, ultimas_24h: { salientes: { delivered: 0 } } });
  });

  test('la respuesta no lleva secretos, teléfonos ni textos de personas', async () => {
    await sembrarNegocio('uid_t', { name: 'Tienda Rubi', whatsapp_phone: TEL_OTRO, whatsapp_verified_at: MARTES_10 });
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: CLIENTE, texto: 'Hola don Pacho, ya le pagué' })] }), entorno());
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: TEL_OTRO, texto: 'Mensaje del dueño' })] }), entorno());
    await new SimulatedGateway(env).sendTemplate({ to: CLIENTE, requestId: 'req-2', template: 'codigo_verificacion', language: 'es_CO', variables: ['654321'] });
    const texto = await (await estadoPuente()).text();
    for (const prohibido of [SECRETO_DEV, TOKEN_DEV, 'tln-dev', CLIENTE.slice(1), TEL_OTRO.slice(1), '3001234567', 'Hola', 'pagué', 'dueño', '654321', 'Rubi', 'uid_t', 'bus_']) {
      expect(texto, prohibido).not.toContain(prohibido);
    }
  });
});

describe('reglas de salud', () => {
  const vacio = { accepted: 0, rejected: 0, unknown: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  const base = { configurado: true, evento_reciente: true, entrantes: 10, sin_enrutar: 0, salientes: { ...vacio, delivered: 10 } };
  test.each([
    ['sin secreto gana a todo', { ...base, configurado: false, sin_enrutar: 10 }, 'sin_configurar'],
    ['todo en orden', base, 'ok'],
    ['sin eventos en 24 h', { ...base, evento_reciente: false, entrantes: 0 }, 'sin_eventos'],
    ['3 de 12 envíos rechazados o fallidos (25 %)', { ...base, salientes: { ...vacio, delivered: 9, rejected: 2, failed: 1 } }, 'atencion'],
    ['2 de 2 rechazados: muestra pequeña', { ...base, salientes: { ...vacio, rejected: 2 } }, 'ok'],
    ['3 de 13 fallidos (menos del 25 %)', { ...base, salientes: { ...vacio, delivered: 10, failed: 3 } }, 'ok'],
    ['5 de 10 entrantes sin enrutar (50 %)', { ...base, sin_enrutar: 5 }, 'atencion'],
    ['4 de 10 sin enrutar', { ...base, sin_enrutar: 4 }, 'ok'],
    ['2 de 2 sin enrutar: muestra pequeña', { ...base, entrantes: 2, sin_enrutar: 2 }, 'ok'],
    ['3 de 10 envíos sin confirmar (Meta no respondió): cuentan como fallo', { ...base, salientes: { ...vacio, delivered: 7, unknown: 3 } }, 'atencion'],
    ['fallos sin eventos recientes: atención antes que sin eventos', { ...base, evento_reciente: false, entrantes: 0, salientes: { ...vacio, rejected: 3 } }, 'atencion'],
  ])('%s', (_, datos, esperado) => {
    expect(saludDe(datos)).toBe(esperado);
  });
});

describe('envío de prueba', () => {
  test('va solo al teléfono verificado de la tienda del superadministrador; un número en el cuerpo se ignora', async () => {
    await sembrarNegocio(ADMIN.uid, { owner_email: ADMIN.email, whatsapp_phone: TEL_ADMIN, whatsapp_verified_at: MARTES_10 - HORA });
    await sembrarNegocio('uid_t', { whatsapp_phone: TEL_OTRO, whatsapp_verified_at: MARTES_10 - HORA });
    const res = await probar({ to: TEL_OTRO, telefono: TEL_OTRO, phone: CLIENTE, whatsapp_phone: CLIENTE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resultado: 'enviada', simulado: true, en: MARTES_10 });
    expect(await salientes()).toEqual([{ phone: TEL_ADMIN, template: 'prueba_puente', business_id: null, status: 'accepted', callback_data: 'prueba-puente' }]);
    const fila = await env.DB.prepare("SELECT content_json FROM whatsapp_messages WHERE template = 'prueba_puente'").first<{ content_json: string }>();
    expect(JSON.parse(fila!.content_json).texto).toMatch(/^Prueba del puente de TuListaNegra/);
  });

  test('sin tienda, o con el teléfono sin verificar → 409 con la explicación, sin escribir nada', async () => {
    await sembrarNegocio('uid_t', { whatsapp_phone: TEL_OTRO, whatsapp_verified_at: MARTES_10 }); // de otro: no cuenta
    const sinTienda = await probar();
    expect(sinTienda.status).toBe(409);
    expect(await sinTienda.json()).toEqual({ error: 'sin_telefono_verificado' });
    await sembrarNegocio(ADMIN.uid, { owner_email: ADMIN.email, whatsapp_phone: TEL_ADMIN });
    expect((await probar()).status).toBe(409);
    expect(await salientes()).toEqual([]);
  });

  test('tope diario: 10 pruebas en 24 h; la 11.ª → 429 tope_diario sin enviar', async () => {
    await sembrarNegocio(ADMIN.uid, { owner_email: ADMIN.email, whatsapp_phone: TEL_ADMIN, whatsapp_verified_at: MARTES_10 });
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(MARTES_10 + i * ESPERA_PRUEBA_MS);
      expect((await probar()).status).toBe(200);
    }
    vi.setSystemTime(MARTES_10 + 10 * ESPERA_PRUEBA_MS);
    const once = await probar();
    expect(once.status).toBe(429);
    expect(await once.json()).toMatchObject({ error: 'tope_diario' });
    expect(await salientes()).toHaveLength(10);
  });

  test('una prueba por minuto', async () => {
    await sembrarNegocio(ADMIN.uid, { owner_email: ADMIN.email, whatsapp_phone: TEL_ADMIN, whatsapp_verified_at: MARTES_10 });
    expect((await probar()).status).toBe(200);
    vi.setSystemTime(MARTES_10 + 30_000);
    const otra = await probar();
    expect(otra.status).toBe(429);
    expect(await otra.json()).toEqual({ error: 'espera_prueba', reintentar_en: MARTES_10 + ESPERA_PRUEBA_MS });
    vi.setSystemTime(MARTES_10 + ESPERA_PRUEBA_MS);
    expect((await probar()).status).toBe(200);
    expect(await salientes()).toHaveLength(2);
  });

  test('con el interruptor apagado y sin simulador habilitado (producción) → bot_apagado, sin escribir nada', async () => {
    await sembrarNegocio(ADMIN.uid, { owner_email: ADMIN.email, whatsapp_phone: TEL_ADMIN, whatsapp_verified_at: MARTES_10 });
    const res = await probar({}, entorno({ TEST_WHATSAPP_SIMULADO: undefined }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'bot_apagado' });
    expect(await salientes()).toEqual([]);
  });

  test('encendido sin configuración completa de Meta → puente_sin_configurar, sin escribir nada', async () => {
    await sembrarNegocio(ADMIN.uid, { owner_email: ADMIN.email, whatsapp_phone: TEL_ADMIN, whatsapp_verified_at: MARTES_10 });
    const res = await probar({}, entorno({ WHATSAPP_SEND_READY: '1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'puente_sin_configurar' });
    expect(await salientes()).toEqual([]);
  });

  test('un tendero no superadministrador no puede pedir la prueba', async () => {
    await sembrarNegocio('uid_t', { whatsapp_phone: TEL_OTRO, whatsapp_verified_at: MARTES_10 });
    const res = await api('/api/superadmin/puente/prueba', { uid: 'uid_t', email: 'uid_t@ejemplo.test' }, { method: 'POST', body: '{}' }, entorno());
    expect(res.status).toBe(403);
    expect(await salientes()).toEqual([]);
  });
});
