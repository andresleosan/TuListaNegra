// Gateway real de la variante A (contrato-sarin.md, c) con `fetch` simulado: NUNCA se llama a Meta de verdad.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../index';
import { HORA, sembrarNegocio } from '../test/datos';
import { PHONE_NUMBER_ID, SECRETO_DEV, TOKEN_DEV, cuerpoMeta, estado, firmar, inyectar, postWebhook } from '../test/whatsapp';
import { guardarEventos } from './bandeja';
import { gatewayPara } from './index';
import { GRAPH_VERSION, MAX_MEDIO_BYTES, MetaCloudGateway, VARIABLES_META, WhatsappSinConfigurar } from './meta-gateway';
import { SimulatedGateway } from './simulado';
import type { NombrePlantilla, SendReplyInput, SendTemplateInput } from './tipos';

// Todo ficticio. El token tiene una marca fácil de buscar en registros y en la base.
const TOKEN = 'EAAficticio-TOKEN-QUE-NO-DEBE-VERSE';
const SECRETO = 'secreto-de-app-ficticio';
const VERIFICACION = 'token-de-verificacion-ficticio';
const CLIENTE = '+573001112233';
const URL_ENVIO = `https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`;

const real = (extra: Partial<Env> = {}): Env => ({
  ...env, WHATSAPP_SEND_READY: '1', WHATSAPP_APP_SECRET: SECRETO, WHATSAPP_VERIFY_TOKEN: VERIFICACION,
  WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_PHONE_NUMBER_ID: PHONE_NUMBER_ID, ...extra,
});
const filas = async () => (await env.DB.prepare('SELECT * FROM whatsapp_messages ORDER BY created_at, id').all<Record<string, unknown>>()).results;
const cobro = (extra: Partial<SendTemplateInput> = {}): SendTemplateInput => ({
  to: CLIENTE, requestId: 'req-1', template: 'cobro_vecino_amigable', language: 'es_CO',
  variables: ['don Carlos', 'Tienda La Esquina', '$ 49.900', 'Puede pagar en la tienda.'], ...extra,
});
const respuesta = (status: number, cuerpo?: unknown) =>
  new Response(cuerpo === undefined ? null : JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });
const aceptado = (wamid = 'wamid.HBgM123') => respuesta(200, { messaging_product: 'whatsapp', contacts: [{ input: '573001112233', wa_id: '573001112233' }], messages: [{ id: wamid }] });
const errorMeta = (status: number, code: number) => respuesta(status, { error: { message: 'x', type: 'OAuthException', code, fbtrace_id: 'f' } });
/** Abre la ventana de 24 h de CLIENTE con un entrante en `en`. */
const entranteEn = (en: number) => guardarEventos(env, [{ kind: 'text', waMessageId: `wamid.IN.${en}`, occurredAt: en, phoneNumberId: PHONE_NUMBER_ID, from: CLIENTE, text: 'Hola' }], en);

let red: ReturnType<typeof vi.fn<typeof fetch>>;
let registros: unknown[][];
beforeEach(() => {
  red = vi.fn<typeof fetch>(() => Promise.reject(new Error('fetch no preparado en esta prueba')));
  vi.stubGlobal('fetch', red);
  registros = [];
  for (const nivel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => void registros.push(args));
  }
});
afterEach(async () => {
  // El token nunca aparece en los registros ni en lo que se guarda; tampoco el teléfono en los registros.
  const vistos = JSON.stringify(registros);
  expect(vistos).not.toContain(TOKEN);
  expect(vistos).not.toContain('3001112233');
  expect(JSON.stringify(await filas())).not.toContain(TOKEN);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** La única llamada a Meta: URL, método, cabeceras y JSON. */
function llamada(i = 0) {
  const [url, init] = red.mock.calls[i]!;
  const cabeceras = new Headers(init?.headers);
  return { url: String(url), init: init!, cabeceras, json: init?.body ? JSON.parse(String(init.body)) : undefined };
}

describe('elección y configuración', () => {
  test('apagado sigue siendo el simulador; encendido y configurado, el gateway real', () => {
    expect(gatewayPara(real({ WHATSAPP_SEND_READY: '0' }))).toBeInstanceOf(SimulatedGateway);
    expect(gatewayPara(real())).toBeInstanceOf(MetaCloudGateway);
  });

  test.each(VARIABLES_META.map((v) => [v]))('sin %s falla cerrado, con un error que la nombra y sin llamar a Meta', (variable) => {
    let error: unknown;
    try {
      gatewayPara(real({ [variable]: '' }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WhatsappSinConfigurar);
    expect((error as WhatsappSinConfigurar).problemas).toEqual([`falta ${variable}`]);
    expect(red).not.toHaveBeenCalled();
  });

  test.each(VARIABLES_META.filter((v) => v !== 'WHATSAPP_PHONE_NUMBER_ID').map((v) => [v]))('%s con prefijo de desarrollo → falla cerrado', (variable) => {
    expect(() => gatewayPara(real({ [variable]: 'tln-dev-whatsapp-algo' }))).toThrow(WhatsappSinConfigurar);
    expect(red).not.toHaveBeenCalled();
  });

  test('los secretos de desarrollo de las pruebas, con el interruptor encendido → falla cerrado', () => {
    expect(() => gatewayPara(real({ WHATSAPP_APP_SECRET: SECRETO_DEV, WHATSAPP_VERIFY_TOKEN: TOKEN_DEV }))).toThrow('whatsapp_sin_configurar');
    expect(() => gatewayPara(real({ WHATSAPP_PHONE_NUMBER_ID: '123/../me' }))).toThrow(WhatsappSinConfigurar);
  });

  test('el error de configuración no lleva valores, solo nombres', () => {
    const error = (() => {
      try {
        new MetaCloudGateway(real({ WHATSAPP_APP_SECRET: 'tln-dev-whatsapp-valor-secreto', WHATSAPP_ACCESS_TOKEN: undefined }));
      } catch (e) {
        return e as WhatsappSinConfigurar;
      }
    })();
    expect(error?.problemas).toEqual(['WHATSAPP_APP_SECRET es de desarrollo (tln-dev-whatsapp-…)', 'falta WHATSAPP_ACCESS_TOKEN']);
    expect(JSON.stringify({ m: error?.message, p: error?.problemas, r: registros })).not.toContain('valor-secreto');
  });
});

describe('cuerpos de envío', () => {
  test('plantilla: URL, Bearer y JSON exactos; accepted guarda el wamid y el negocio', async () => {
    const negocio = await sembrarNegocio();
    red.mockResolvedValueOnce(aceptado('wamid.REAL.1'));
    const r = await new MetaCloudGateway(real(), Date.now, negocio.id).sendTemplate(cobro({ buttonPayloads: ['tln.v1:pague:x', 'tln.v1:salir:x'], callbackData: 'cobro:deb_1' }));
    expect(r).toEqual({ status: 'accepted', waMessageId: 'wamid.REAL.1' });
    const { url, init, cabeceras, json } = llamada();
    expect(url).toBe(URL_ENVIO);
    expect(init.method).toBe('POST');
    expect(cabeceras.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(cabeceras.get('Content-Type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(json).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233', biz_opaque_callback_data: 'cobro:deb_1',
      type: 'template',
      template: {
        name: 'cobro_vecino_amigable', language: { code: 'es_CO' },
        components: [
          { type: 'body', parameters: ['don Carlos', 'Tienda La Esquina', '$ 49.900', 'Puede pagar en la tienda.'].map((text) => ({ type: 'text', text })) },
          { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'tln.v1:pague:x' }] },
          { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'tln.v1:salir:x' }] },
        ],
      },
    });
    expect(await filas()).toMatchObject([{
      direction: 'SALIENTE', kind: 'template', template: 'cobro_vecino_amigable', status: 'accepted', wa_message_id: 'wamid.REAL.1',
      request_id: 'req-1', phone: CLIENTE, phone_number_id: PHONE_NUMBER_ID, business_id: negocio.id, callback_data: 'cobro:deb_1', error_code: null,
    }]);
    expect(JSON.parse(String((await filas())[0]!.content_json)).texto).toContain('Hola don Carlos, le saluda Tienda La Esquina.');
  });

  test('texto en ventana, como respuesta a un mensaje: JSON exacto con context', async () => {
    await entranteEn(Date.now() - HORA);
    red.mockResolvedValueOnce(aceptado('wamid.REAL.2'));
    const r = await new MetaCloudGateway(real()).sendReply({ to: CLIENTE, requestId: 'r-txt', replyTo: 'wamid.IN.1', content: { kind: 'text', text: 'Recibido' } });
    expect(r).toEqual({ status: 'accepted', waMessageId: 'wamid.REAL.2' });
    expect(llamada().url).toBe(URL_ENVIO);
    expect(llamada().json).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233',
      type: 'text', text: { preview_url: false, body: 'Recibido' }, context: { message_id: 'wamid.IN.1' },
    });
  });

  test('botones interactivos: JSON exacto', async () => {
    await entranteEn(Date.now() - HORA);
    red.mockResolvedValueOnce(aceptado());
    const content: SendReplyInput['content'] = { kind: 'buttons', text: '¿Cuál tienda?', buttons: [{ id: 'tln.v1:tienda:a', title: 'Tienda A' }, { id: 'tln.v1:tienda:b', title: 'Tienda B' }] };
    await new MetaCloudGateway(real()).sendReply({ to: CLIENTE, requestId: 'r-btn', content, callbackData: 'ambiguo' });
    expect(llamada().json).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233', biz_opaque_callback_data: 'ambiguo',
      type: 'interactive',
      interactive: {
        type: 'button', body: { text: '¿Cuál tienda?' },
        action: { buttons: [{ type: 'reply', reply: { id: 'tln.v1:tienda:a', title: 'Tienda A' } }, { type: 'reply', reply: { id: 'tln.v1:tienda:b', title: 'Tienda B' } }] },
      },
    });
    expect(await filas()).toMatchObject([{ direction: 'ENTRANTE' }, { kind: 'buttons', status: 'accepted', buttons_json: JSON.stringify(content.buttons) }]);
  });

  test('imagen saliente (tirilla): no está hecha → rejected OTHER sin llamar a Meta', async () => {
    await entranteEn(Date.now() - HORA);
    const r = await new MetaCloudGateway(real()).sendReply({ to: CLIENTE, requestId: 'r-img', content: { kind: 'image', r2Key: 'negocios/x/t.png' } });
    expect(r).toEqual({ status: 'rejected', code: 'OTHER', retryable: false });
    expect(red).not.toHaveBeenCalled();
  });
});

describe('respuestas de Meta', () => {
  test.each([
    ['ventana vencida (131047)', errorMeta(400, 131047), 'WINDOW_CLOSED', false],
    ['plantilla inexistente (132001)', errorMeta(404, 132001), 'INVALID_TEMPLATE', false],
    ['parámetros que no cuadran (132000)', errorMeta(400, 132000), 'INVALID_TEMPLATE', false],
    ['límite de envío (130429)', errorMeta(400, 130429), 'RATE_LIMITED', true],
    ['límite por par (131056)', errorMeta(400, 131056), 'RATE_LIMITED', true],
    ['HTTP 429 sin cuerpo', respuesta(429), 'RATE_LIMITED', true],
    ['parámetro inválido (100)', errorMeta(400, 100), 'OTHER', false],
    ['token vencido (190)', errorMeta(401, 190), 'OTHER', false],
    ['4xx sin cuerpo', respuesta(403), 'OTHER', false],
  ] as const)('%s → rejected %s', async (_, res, code, retryable) => {
    red.mockResolvedValueOnce(res);
    const gw = new MetaCloudGateway(real());
    expect(await gw.sendTemplate(cobro())).toEqual({ status: 'rejected', code, retryable });
    expect(await filas()).toMatchObject([{ status: 'rejected', error_code: code, wa_message_id: null }]);
    // memorizado bajo su requestId, como el simulador: repetirlo no vuelve a llamar a Meta
    expect(await gw.sendTemplate(cobro())).toEqual({ status: 'rejected', code, retryable });
    expect(red).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
    ['error de red', () => Promise.reject(new TypeError('Network connection lost.'))],
    ['500', () => Promise.resolve(respuesta(500, { error: { code: 1 } }))],
    ['503 sin cuerpo', () => Promise.resolve(respuesta(503))],
    ['2xx sin messages[0].id', () => Promise.resolve(respuesta(200, { messages: [] }))],
    ['2xx que no es JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
  ] as const)('%s → unknown, sin reintento', async (_, falla) => {
    red.mockImplementationOnce(falla);
    const gw = new MetaCloudGateway(real());
    expect(await gw.sendTemplate(cobro())).toEqual({ status: 'unknown' });
    expect(await gw.sendTemplate(cobro())).toEqual({ status: 'unknown' }); // ambiguo: no se reintenta
    expect(red).toHaveBeenCalledTimes(1);
    expect(await filas()).toMatchObject([{ status: 'unknown', wa_message_id: null, error_code: null }]);
    expect(registros.some((r) => r[0] === 'whatsapp_envio_ambiguo')).toBe(true);
  });
});

describe('idempotencia y validación local', () => {
  test('el mismo requestId dos veces → un solo fetch y el mismo resultado', async () => {
    red.mockResolvedValueOnce(aceptado('wamid.UNO'));
    const gw = new MetaCloudGateway(real());
    expect(await gw.sendTemplate(cobro())).toEqual({ status: 'accepted', waMessageId: 'wamid.UNO' });
    expect(await gw.sendTemplate(cobro({ variables: ['otro', 'b', 'c', 'd'] }))).toEqual({ status: 'accepted', waMessageId: 'wamid.UNO' });
    expect(red).toHaveBeenCalledTimes(1);
    expect(await filas()).toHaveLength(1);
  });

  test('dos llamadas A LA VEZ con el mismo requestId → un solo fetch (la fila se reserva antes)', async () => {
    let soltar!: (r: Response) => void;
    red.mockImplementation(() => new Promise<Response>((r) => (soltar = r)));
    const gw = new MetaCloudGateway(real());
    const primera = gw.sendTemplate(cobro());
    const segunda = gw.sendTemplate(cobro());
    await vi.waitFor(() => expect(red).toHaveBeenCalled());
    expect(await segunda).toEqual({ status: 'unknown' }); // la otra está en vuelo: ambiguo, no se manda otra vez
    soltar(aceptado('wamid.CARRERA'));
    expect(await primera).toEqual({ status: 'accepted', waMessageId: 'wamid.CARRERA' });
    expect(red).toHaveBeenCalledTimes(1);
    expect(await filas()).toMatchObject([{ status: 'accepted', wa_message_id: 'wamid.CARRERA' }]);
  });

  test('ventana de 24 h cerrada → WINDOW_CLOSED sin fetch (sin entrante, y con uno de hace 24 h)', async () => {
    const gw = new MetaCloudGateway(real());
    const texto = { kind: 'text', text: 'Hola' } as const;
    expect(await gw.sendReply({ to: CLIENTE, requestId: 'a', content: texto })).toEqual({ status: 'rejected', code: 'WINDOW_CLOSED', retryable: false });
    const t0 = Date.now() - 24 * HORA;
    await entranteEn(t0);
    expect(await new MetaCloudGateway(real(), () => t0 + 24 * HORA).sendReply({ to: CLIENTE, requestId: 'b', content: texto })).toMatchObject({ code: 'WINDOW_CLOSED' });
    expect(red).not.toHaveBeenCalled();
  });

  test.each([
    ['plantilla desconocida', cobro({ template: 'cobro_amenaza' as NombrePlantilla }), 'INVALID_TEMPLATE'],
    ['variables de menos', cobro({ variables: ['a', 'b'] }), 'INVALID_TEMPLATE'],
    ['más de 3 botones', cobro({ buttonPayloads: ['a', 'b', 'c', 'd'] }), 'OTHER'],
    ['teléfono que no es E.164', cobro({ to: '3001112233' }), 'OTHER'],
  ] as const)('%s → %s sin fetch', async (_, input, code) => {
    expect(await new MetaCloudGateway(real()).sendTemplate(input)).toEqual({ status: 'rejected', code, retryable: false });
    expect(red).not.toHaveBeenCalled();
    expect(await filas()).toMatchObject([{ status: 'rejected', error_code: code }]);
  });
});

describe('fetchMedia', () => {
  const URL_TEMPORAL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&ext=1';
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);

  test('dos pasos: id → URL temporal → bytes, los dos con el token', async () => {
    red.mockResolvedValueOnce(respuesta(200, { url: URL_TEMPORAL, mime_type: 'image/jpeg', sha256: 'x', file_size: JPEG.byteLength, id: '4455', messaging_product: 'whatsapp' }))
      .mockResolvedValueOnce(new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
    const medio = await new MetaCloudGateway(real()).fetchMedia('4455');
    expect(new Uint8Array(medio.bytes)).toEqual(JPEG);
    expect(medio.mimeType).toBe('image/jpeg');
    expect(red).toHaveBeenCalledTimes(2);
    expect(llamada(0).url).toBe(`https://graph.facebook.com/${GRAPH_VERSION}/4455?phone_number_id=${PHONE_NUMBER_ID}`);
    expect(llamada(1).url).toBe(URL_TEMPORAL);
    for (const i of [0, 1]) {
      expect(llamada(i).cabeceras.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(llamada(i).init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('tope: por el tamaño que declara Meta (sin descargar) y por los bytes reales', async () => {
    const gw = new MetaCloudGateway(real());
    red.mockResolvedValueOnce(respuesta(200, { url: URL_TEMPORAL, mime_type: 'image/jpeg', file_size: MAX_MEDIO_BYTES + 1 }));
    await expect(gw.fetchMedia('1')).rejects.toThrow('medio_muy_grande');
    expect(red).toHaveBeenCalledTimes(1);

    const grande = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(MAX_MEDIO_BYTES));
        c.enqueue(new Uint8Array(1));
        c.close();
      },
    });
    red.mockResolvedValueOnce(respuesta(200, { url: URL_TEMPORAL, mime_type: 'image/jpeg' })).mockResolvedValueOnce(new Response(grande, { status: 200 }));
    await expect(gw.fetchMedia('2')).rejects.toThrow('medio_muy_grande');
  });

  test('URL temporal fuera de Meta, id raro o 4xx → lanza sin mandar el token a otro sitio', async () => {
    const gw = new MetaCloudGateway(real());
    red.mockResolvedValueOnce(respuesta(200, { url: 'https://atacante.example/x', mime_type: 'image/jpeg' }));
    await expect(gw.fetchMedia('1')).rejects.toThrow('medio_url_no_confiable');
    expect(red).toHaveBeenCalledTimes(1);
    await expect(gw.fetchMedia('../me')).rejects.toThrow('medio_invalido');
    red.mockResolvedValueOnce(errorMeta(404, 100));
    await expect(gw.fetchMedia('3')).rejects.toThrow('medio_no_disponible');
    expect(red).toHaveBeenCalledTimes(2);
  });
});

describe('webhook real con el interruptor encendido', () => {
  const lote = () => cuerpoMeta({ estados: [estado('wamid.DESCONOCIDO', 'delivered')] });

  test('firmado con el secreto real → 200; con otro secreto → 401', async () => {
    expect((await inyectar(lote(), real())).status).toBe(200);
    const bytes = new TextEncoder().encode(JSON.stringify(lote()));
    expect((await postWebhook(bytes, await firmar(bytes, 'otro-secreto'), real())).status).toBe(401);
    expect(red).not.toHaveBeenCalled();
  });

  test('con el secreto de desarrollo (firma buena para él) → 401', async () => {
    const res = await inyectar(lote(), real({ WHATSAPP_APP_SECRET: SECRETO_DEV }));
    expect(res.status).toBe(401);
    expect(await filas()).toHaveLength(0);
  });

  test('reto GET: token real → challenge; token equivocado → 403; token de desarrollo → no se acepta', async () => {
    const reto = (token: string, entorno: Env) => app.request(`/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=abc123`, {}, entorno);
    const ok = await reto(VERIFICACION, real());
    expect([ok.status, await ok.text()]).toEqual([200, 'abc123']);
    expect((await reto('otro', real())).status).toBe(403);
    const dev = await reto(TOKEN_DEV, real({ WHATSAPP_VERIFY_TOKEN: TOKEN_DEV }));
    expect(dev.status).toBe(403); // falla cerrado
    expect(await dev.text()).not.toBe('abc123');
  });
});

describe('revisión independiente: gateway real', () => {
  test('solo cuentan los eventos de NUESTRO número: los de otro número de la misma cuenta de Meta se descartan', async () => {
    const otro = real({ WHATSAPP_PHONE_NUMBER_ID: '999999999999999' });
    const bytes = new TextEncoder().encode(JSON.stringify(cuerpoMeta({ mensajes: [{ id: 'wamid.OTRO', from: CLIENTE.slice(1), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } }] })));
    const cabeceras = new Headers({ 'X-Hub-Signature-256': await firmar(bytes, SECRETO) });
    expect(await new MetaCloudGateway(otro).parseWebhook(bytes.buffer as ArrayBuffer, cabeceras)).toEqual([]);
    expect(await new MetaCloudGateway(real()).parseWebhook(bytes.buffer as ArrayBuffer, cabeceras)).toHaveLength(1);
  });

  test('los valores de configuración se usan recortados (un salto de línea al final del token no rompe la cabecera)', async () => {
    const pedidos: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (entrada: RequestInfo, init?: RequestInit) => {
      pedidos.push(new Request(entrada, init));
      return Response.json({ messages: [{ id: 'wamid.OK' }] });
    }));
    const r = await new MetaCloudGateway(real({ WHATSAPP_ACCESS_TOKEN: `${TOKEN}\n`, WHATSAPP_PHONE_NUMBER_ID: ` ${PHONE_NUMBER_ID} ` })).sendTemplate(cobro({ requestId: 'req-recorte' }));
    expect(r.status).toBe('accepted');
    expect(pedidos[0]!.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(pedidos[0]!.url).toBe(URL_ENVIO);
  });
});
