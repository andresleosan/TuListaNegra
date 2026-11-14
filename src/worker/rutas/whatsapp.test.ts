// WAP-01: webhook de WhatsApp. Firma inválida → 401; evento repetido no se procesa dos veces; orden de la sección (b).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../index';
import { cuerpoMeta, entornoWa, entrante, estado, firmar, inyectar, postWebhook, SECRETO_DEV, TOKEN_DEV } from '../test/whatsapp';
import { SimulatedGateway } from '../whatsapp/simulado';

const CLIENTE = '+573001112233'; // ficticio
const filas = async () => (await env.DB.prepare('SELECT * FROM whatsapp_messages ORDER BY created_at, id').all<Record<string, unknown>>()).results;
// Desde WAP-04 un entrante de un número desconocido recibe una respuesta neutra (un saliente): aquí solo cuentan los entrantes.
const entrantes = async () => (await filas()).filter((f) => f.direction === 'ENTRANTE');
const bytesDe = (cuerpo: unknown) => new TextEncoder().encode(JSON.stringify(cuerpo));
const unTexto = (extra: Partial<Parameters<typeof entrante.texto>[0]> = {}) => cuerpoMeta({ mensajes: [entrante.texto({ de: CLIENTE, texto: 'Hola, ya pagué', ...extra })] });

let registros: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  registros = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
});
afterEach(() => {
  // B5: nada de cuerpos ni teléfonos en los registros. El webhook no escribe nada en consola.
  try {
    for (const r of registros) expect(r).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe('firma: sin firma buena no se escribe nada (401)', () => {
  test('cabecera ausente', async () => {
    expect((await postWebhook(bytesDe(unTexto()), null)).status).toBe(401);
    expect(await filas()).toEqual([]);
  });

  test.each([
    ['vacía', ''],
    ['sin prefijo', 'a'.repeat(64)],
    ['otro algoritmo', `sha1=${'a'.repeat(64)}`],
    ['corta', `sha256=${'a'.repeat(63)}`],
    ['larga', `sha256=${'a'.repeat(65)}`],
    ['mayúsculas', `sha256=${'A'.repeat(64)}`],
    ['no hex', `sha256=${'g'.repeat(64)}`],
  ])('mal formada: %s', async (_, firma) => {
    expect((await postWebhook(bytesDe(unTexto()), firma)).status).toBe(401);
    expect(await filas()).toEqual([]);
  });

  test('hecha con otro secreto', async () => {
    const bytes = bytesDe(unTexto());
    expect((await postWebhook(bytes, await firmar(bytes, 'otro-secreto'))).status).toBe(401);
    expect(await filas()).toEqual([]);
  });

  test('de otro cuerpo (cuerpo alterado tras firmar)', async () => {
    const firma = await firmar(bytesDe(unTexto({ texto: 'original' })));
    expect((await postWebhook(bytesDe(unTexto({ texto: 'alterado' })), firma)).status).toBe(401);
    expect(await filas()).toEqual([]);
  });

  test.each([undefined, ''])('sin secreto configurado (%j): ni con una firma "buena" del secreto de desarrollo', async (secreto) => {
    const bytes = bytesDe(unTexto());
    const res = await postWebhook(bytes, await firmar(bytes, SECRETO_DEV), entornoWa({ WHATSAPP_APP_SECRET: secreto }));
    expect(res.status).toBe(401);
    expect(await filas()).toEqual([]);
  });

  test('la firma se comprueba antes que el JSON: basura sin firma buena es 401, no 400', async () => {
    expect((await postWebhook(new TextEncoder().encode('no es json'), `sha256=${'0'.repeat(64)}`)).status).toBe(401);
  });

  test('no pide sesión: es pública, pero la firma manda', async () => {
    expect((await inyectar(unTexto())).status).toBe(200);
  });
});

describe('tamaño (413)', () => {
  test('Content-Length de más de 1 MiB, sin leer', async () => {
    const res = await app.request('/api/whatsapp/webhook', {
      method: 'POST', body: '{}', headers: { 'Content-Length': String(1024 * 1024 + 1), 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` },
    }, entornoWa());
    expect(res.status).toBe(413);
  });

  test('cuerpo real de más de 1 MiB aunque no diga su largo, aun firmado', async () => {
    const cuerpo = unTexto({ texto: 'x'.repeat(1024 * 1024) });
    const bytes = bytesDe(cuerpo);
    const firma = await firmar(bytes);
    const flujo = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.byteLength; i += 64 * 1024) c.enqueue(bytes.slice(i, i + 64 * 1024));
        c.close();
      },
    });
    const res = await app.request('/api/whatsapp/webhook', { method: 'POST', body: flujo, headers: { 'X-Hub-Signature-256': firma } }, entornoWa());
    expect(res.status).toBe(413);
    expect(await filas()).toEqual([]);
  });

  test('justo por debajo del tope pasa a la firma', async () => {
    const bytes = new Uint8Array(1024 * 1024).fill(0x20);
    expect((await postWebhook(bytes, null)).status).toBe(401);
  });
});

describe('cuerpo firmado pero inválido (400, sin escribir)', () => {
  const firmadoYEnviado = async (bytes: Uint8Array) => postWebhook(bytes, await firmar(bytes));

  test.each([
    ['no es JSON', 'no es json'],
    ['vacío', ''],
    ['null', 'null'],
    ['otro objeto', JSON.stringify({ object: 'page', entry: [] })],
  ])('%s', async (_, texto) => {
    const res = await firmadoYEnviado(new TextEncoder().encode(texto));
    expect(res.status).toBe(400);
    expect(await filas()).toEqual([]);
  });

  // Un mensaje mal formado dentro de un sobre bueno se descarta (200, nada guardado): Meta no lo reentrega.
  test.each([
    ['mensaje de texto sin cuerpo', JSON.stringify(cuerpoMeta({ mensajes: [{ ...entrante.texto({ de: CLIENTE, texto: 'x' }), text: undefined }] }))],
    ['timestamp numérico', JSON.stringify(cuerpoMeta({ mensajes: [{ ...entrante.texto({ de: CLIENTE, texto: 'x' }), timestamp: 1_800_000_000 }] }))],
    ['teléfono con letras', JSON.stringify(cuerpoMeta({ mensajes: [{ ...entrante.texto({ de: CLIENTE, texto: 'x' }), from: '57300abc' }] }))],
  ])('%s → se descarta sin escribir', async (_, texto) => {
    const res = await firmadoYEnviado(new TextEncoder().encode(texto));
    expect(res.status).toBe(200);
    expect(await filas()).toEqual([]);
  });

  test('UTF-8 inválido', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('{"object":"'), 0xff, 0xfe, ...new TextEncoder().encode('"}')]);
    expect((await firmadoYEnviado(bytes)).status).toBe(400);
  });

  test('lote de más de 100 eventos rechazado entero; 100 pasan', async () => {
    const mensajes = (n: number) => Array.from({ length: n }, (_, i) => entrante.texto({ de: CLIENTE, texto: `m${i}` }));
    expect((await inyectar(cuerpoMeta({ mensajes: mensajes(101) }))).status).toBe(400);
    expect(await filas()).toEqual([]);
    expect((await inyectar(cuerpoMeta({ mensajes: mensajes(100) }))).status).toBe(200);
    expect(await entrantes()).toHaveLength(100);
  });
});

describe('entrantes', () => {
  test('texto, botón interactivo, botón de plantilla e imagen se normalizan y se guardan', async () => {
    const res = await inyectar(cuerpoMeta({
      mensajes: [
        entrante.texto({ de: CLIENTE, id: 'wamid.T', texto: 'Hola', respondeA: 'wamid.NUESTRO' }),
        entrante.boton({ de: CLIENTE, id: 'wamid.B', botonId: 'tln.v1:aprobar:mov_1', titulo: 'Aprobar' }),
        entrante.botonPlantilla({ de: CLIENTE, id: 'wamid.P', payload: 'tln.v1:pagare', texto: 'Ya pagué' }),
        entrante.imagen({ de: CLIENTE, id: 'wamid.I', mediaId: 'sim-png', mimeType: 'image/png', caption: 'comprobante' }),
      ],
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const porId = Object.fromEntries((await filas()).map((f) => [f.wa_message_id, f]));
    expect(porId['wamid.T']).toMatchObject({ direction: 'ENTRANTE', kind: 'text', phone: CLIENTE, reply_to_wa_message_id: 'wamid.NUESTRO', business_id: null, content_json: JSON.stringify({ text: 'Hola' }) });
    expect(porId['wamid.B']).toMatchObject({ kind: 'button', content_json: JSON.stringify({ buttonId: 'tln.v1:aprobar:mov_1', title: 'Aprobar' }) });
    expect(porId['wamid.P']).toMatchObject({ kind: 'button', content_json: JSON.stringify({ buttonId: 'tln.v1:pagare', title: 'Ya pagué' }) });
    expect(porId['wamid.I']).toMatchObject({ kind: 'image', content_json: JSON.stringify({ mediaId: 'sim-png', mimeType: 'image/png', caption: 'comprobante' }) });
  });

  test('la fecha llega en segundos y se guarda en ms', async () => {
    const en = Date.now() - 60_000;
    await inyectar(unTexto({ en }));
    expect((await filas())[0]?.occurred_at).toBe(Math.floor(en / 1000) * 1000);
  });

  test('tipos no soportados (audio) y campos que no son `messages` se aceptan sin guardar nada', async () => {
    const audio = { ...entrante.texto({ de: CLIENTE, texto: 'x' }), type: 'audio', text: undefined, audio: { id: 'a1' } };
    const cuerpo = cuerpoMeta({ mensajes: [audio] });
    cuerpo.entry[0]!.changes.push({ field: 'account_update', value: { cualquier: 'cosa' } } as never);
    expect((await inyectar(cuerpo)).status).toBe(200);
    expect(await filas()).toEqual([]);
  });

  test('un entrante con fecha de más de 5 minutos en el futuro se descarta; a 4 minutos entra', async () => {
    expect((await inyectar(unTexto({ id: 'wamid.FUTURO', en: Date.now() + 6 * 60_000 }))).status).toBe(200);
    expect((await inyectar(unTexto({ id: 'wamid.CASI', en: Date.now() + 4 * 60_000 }))).status).toBe(200);
    expect((await entrantes()).map((f) => f.wa_message_id)).toEqual(['wamid.CASI']);
  });
});

describe('idempotencia: un evento repetido no se procesa dos veces', () => {
  test('el mismo wa_message_id dos veces → una sola fila, y la segunda respuesta también es 200', async () => {
    const cuerpo = unTexto({ id: 'wamid.REPETIDO' });
    expect((await inyectar(cuerpo)).status).toBe(200);
    const [primera] = await entrantes();
    expect((await inyectar(unTexto({ id: 'wamid.REPETIDO', texto: 'otro texto' }))).status).toBe(200);
    expect(await entrantes()).toEqual([primera]); // ni duplicada ni sobrescrita
  });

  test('dos entregas a la vez → una sola fila', async () => {
    const cuerpo = unTexto({ id: 'wamid.SIMULTANEO' });
    const respuestas = await Promise.all([inyectar(cuerpo), inyectar(cuerpo), inyectar(cuerpo)]);
    expect(respuestas.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await entrantes()).toHaveLength(1);
  });

  test('repetido dentro del mismo lote → una sola fila', async () => {
    const m = entrante.texto({ de: CLIENTE, id: 'wamid.DOBLE', texto: 'x' });
    expect((await inyectar(cuerpoMeta({ mensajes: [m, m] }))).status).toBe(200);
    expect(await entrantes()).toHaveLength(1);
  });
});

describe('estados de los salientes', () => {
  const enviar = async (requestId: string) => {
    const r = await new SimulatedGateway(env).sendTemplate({ to: CLIENTE, requestId, template: 'codigo_verificacion', language: 'es_CO', variables: ['123456'], callbackData: 'cb-1' });
    if (r.status !== 'accepted') throw new Error('envío no aceptado');
    return r.waMessageId;
  };
  const estadoDe = async (id: string) => env.DB.prepare('SELECT status, error_code, callback_data FROM whatsapp_messages WHERE wa_message_id = ?').bind(id).first();

  test('en orden: sent → delivered → read', async () => {
    const id = await enviar('req-orden');
    for (const s of ['sent', 'delivered', 'read']) {
      expect((await inyectar(cuerpoMeta({ estados: [estado(id, s, { callbackData: 'cb-1' })] }))).status).toBe(200);
      expect(await estadoDe(id)).toMatchObject({ status: s });
    }
  });

  test('desordenados y repetidos: nunca retrocede (read no vuelve a delivered)', async () => {
    const id = await enviar('req-desorden');
    await inyectar(cuerpoMeta({ estados: [estado(id, 'read')] }));
    await inyectar(cuerpoMeta({ estados: [estado(id, 'delivered')] }));
    expect(await estadoDe(id)).toMatchObject({ status: 'read' });
    await inyectar(cuerpoMeta({ estados: [estado(id, 'read'), estado(id, 'read'), estado(id, 'delivered'), estado(id, 'sent')] }));
    expect(await estadoDe(id)).toMatchObject({ status: 'read', error_code: null, callback_data: 'cb-1' });
  });

  test('failed guarda el código y es final', async () => {
    const id = await enviar('req-falla');
    await inyectar(cuerpoMeta({ estados: [estado(id, 'sent'), estado(id, 'failed', { codigo: 131047 })] }));
    expect(await estadoDe(id)).toMatchObject({ status: 'failed', error_code: '131047' });
    await inyectar(cuerpoMeta({ estados: [estado(id, 'delivered'), estado(id, 'read')] }));
    expect(await estadoDe(id)).toMatchObject({ status: 'failed', error_code: '131047' });
  });

  test('un estado de un mensaje que no es nuestro, o desconocido, no crea ni cambia nada', async () => {
    const id = await enviar('req-ajeno');
    const antes = await filas();
    expect((await inyectar(cuerpoMeta({ estados: [estado('wamid.AJENO', 'read'), estado(id, 'deleted')] }))).status).toBe(200);
    expect(await filas()).toEqual(antes);
  });

  test('un estado no convierte un entrante en saliente ni lo toca', async () => {
    await inyectar(unTexto({ id: 'wamid.ENTRANTE' }));
    const antes = await filas();
    await inyectar(cuerpoMeta({ estados: [estado('wamid.ENTRANTE', 'failed', { codigo: 1 })] }));
    expect(await filas()).toEqual(antes);
  });
});

describe('reto GET de alta', () => {
  const reto = (q: Record<string, string>, entorno = entornoWa()) =>
    app.request(`/api/whatsapp/webhook?${new URLSearchParams(q)}`, {}, entorno);

  test('modo subscribe y token correcto → 200 con el challenge tal cual', async () => {
    const res = await reto({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN_DEV, 'hub.challenge': '1158201444' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('1158201444');
    expect(res.headers.get('Content-Type')).toMatch(/^text\/plain/);
  });

  test.each([
    ['token incorrecto', { 'hub.mode': 'subscribe', 'hub.verify_token': `${TOKEN_DEV}x`, 'hub.challenge': '1' }],
    ['token de otro largo', { 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' }],
    ['sin token', { 'hub.mode': 'subscribe', 'hub.challenge': '1' }],
    ['otro modo', { 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN_DEV, 'hub.challenge': '1' }],
    ['sin challenge', { 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN_DEV }],
  ])('%s → 403', async (_, q) => {
    expect((await reto(q)).status).toBe(403);
  });

  test.each([undefined, ''])('sin WHATSAPP_VERIFY_TOKEN configurado (%j) → 403, ni con token vacío', async (token) => {
    const res = await reto({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': '1' }, entornoWa({ WHATSAPP_VERIFY_TOKEN: token }));
    expect(res.status).toBe(403);
  });
});

describe('revisión independiente de WAP-01', () => {
  test('A1.6: con WHATSAPP_SEND_READY apagado, un secreto real (sin el prefijo de desarrollo) no recoge nada: 401 y reto 403', async () => {
    const real = entornoWa({ WHATSAPP_APP_SECRET: 'secreto-real-de-meta', WHATSAPP_VERIFY_TOKEN: 'token-real' });
    const bytes = bytesDe(unTexto());
    expect((await postWebhook(bytes, await firmar(bytes, 'secreto-real-de-meta'), real)).status).toBe(401);
    const reto = await app.request('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=token-real&hub.challenge=123', {}, real);
    expect(reto.status).toBe(403);
    expect(await filas()).toEqual([]);
  });

  test('el 401 no revela si hay secreto configurado', async () => {
    const bytes = bytesDe(unTexto());
    const sinSecreto = await postWebhook(bytes, await firmar(bytes), entornoWa({ WHATSAPP_APP_SECRET: undefined }));
    const otraFirma = await postWebhook(bytes, await firmar(bytes, 'tln-dev-whatsapp-otro'), entornoWa());
    expect([sinSecreto.status, otraFirma.status]).toEqual([401, 401]);
    expect(await sinSecreto.text()).toBe(await otraFirma.text());
  });

  test('un mensaje o estado con forma inesperada se descarta sin tumbar el lote: los buenos se guardan y responde 200', async () => {
    const bueno = entrante.texto({ de: CLIENTE, texto: 'Hola, ya pagué' });
    const lista = { ...entrante.texto({ de: CLIENTE, texto: 'x' }), id: 'wamid.LISTA', type: 'interactive', text: undefined, interactive: { type: 'list_reply', list_reply: { id: 'a', title: 'b' } } };
    const raro = { ...entrante.texto({ de: CLIENTE, texto: 'y' }), id: 'wamid.RARO', from: '57300abc' };
    const res = await inyectar(cuerpoMeta({ mensajes: [lista as never, raro, bueno], estados: [{ id: 'wamid.X' }] }));
    expect(res.status).toBe(200);
    expect((await entrantes()).map((f) => f.wa_message_id)).toEqual([bueno.id]);
  });
});

test('B5: el webhook tiene límite de frecuencia por IP; al pasarlo responde 429 antes de leer, firmar o escribir', async () => {
  const pedidos: string[] = [];
  const agotado = entornoWa({ LIMITE_WEBHOOK: { limit: async ({ key }: { key: string }) => (pedidos.push(key), { success: false }) } as unknown as RateLimit });
  const bytes = bytesDe(unTexto());
  const res = await app.request('/api/whatsapp/webhook', { method: 'POST', body: bytes, headers: { 'X-Hub-Signature-256': await firmar(bytes), 'CF-Connecting-IP': '198.51.100.7' } }, agotado);
  expect(res.status).toBe(429);
  expect(pedidos).toEqual(['198.51.100.7']);
  expect(await filas()).toEqual([]);
});

test('encendido sin configuración real: el reto GET falla cerrado con 403 (no 500) y no devuelve el challenge', async () => {
  const encendido = entornoWa({ WHATSAPP_SEND_READY: '1' });
  const res = await app.request(`/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${TOKEN_DEV}&hub.challenge=777`, {}, encendido);
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain('777');
  // El único registro permitido: qué variables faltan (nombres, nunca valores). Se comprueba y se limpia para el afterEach.
  const error = registros[3]!;
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0]![0])).toBe('whatsapp_sin_configurar');
  for (const valor of [SECRETO_DEV, TOKEN_DEV]) expect(JSON.stringify(error.mock.calls[0])).not.toContain(valor); // nunca los valores
  error.mockClear();
});
