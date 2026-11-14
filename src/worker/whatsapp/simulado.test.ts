// WAP-01: el simulador (contrato-sarin.md, d) permite el recorrido completo sin Meta y sin salir a la red.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HORA, sembrarNegocio } from '../test/datos';
import { cuerpoMeta, entornoWa, entrante, estado, inyectar } from '../test/whatsapp';
import { gatewayPara } from './index';
import { SimulatedGateway, VENTANA_MS } from './simulado';
import type { NombrePlantilla, SendTemplateInput } from './tipos';

const CLIENTE = '+573001112233'; // ficticio
const filas = async () => (await env.DB.prepare('SELECT * FROM whatsapp_messages ORDER BY created_at, id').all<Record<string, unknown>>()).results;
const cobro = (extra: Partial<SendTemplateInput> = {}): SendTemplateInput => ({
  to: CLIENTE, requestId: 'req-1', template: 'cobro_vecino_amigable', language: 'es_CO',
  variables: ['don Carlos', 'Tienda La Esquina', '$ 49.900', 'Puede pagar directamente en la tienda.'], ...extra,
});

let red: ReturnType<typeof vi.fn>;
beforeEach(() => {
  red = vi.fn(() => Promise.reject(new Error('el simulador no debe salir a la red')));
  vi.stubGlobal('fetch', red);
});
afterEach(() => {
  expect(red).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('elección del gateway', () => {
  test('con WHATSAPP_SEND_READY apagado es siempre el simulado', () => {
    expect(env.WHATSAPP_SEND_READY).toBe('0');
    expect(gatewayPara(env)).toBeInstanceOf(SimulatedGateway);
    expect(gatewayPara({ ...env, WHATSAPP_SEND_READY: 'true' })).toBeInstanceOf(SimulatedGateway);
  });

  test('encendido, sin gateway real todavía, falla cerrado en vez de enviar', () => {
    expect(() => gatewayPara({ ...env, WHATSAPP_SEND_READY: '1' })).toThrow('gateway_real_sin_implementar');
  });
});

describe('plantillas', () => {
  test('una plantilla válida se acepta y queda en la bandeja resuelta, con sus botones', async () => {
    const r = await new SimulatedGateway(env).sendTemplate(cobro({ buttonPayloads: ['tln.v1:pague', 'tln.v1:salir'], callbackData: 'cb-9' }));
    expect(r).toMatchObject({ status: 'accepted', waMessageId: expect.stringMatching(/^wamid\.SIM\./) });
    const [fila] = await filas();
    expect(fila).toMatchObject({
      direction: 'SALIENTE', kind: 'template', template: 'cobro_vecino_amigable', phone: CLIENTE, status: 'accepted', request_id: 'req-1',
      callback_data: 'cb-9', buttons_json: JSON.stringify(['tln.v1:pague', 'tln.v1:salir']), id: expect.stringMatching(/^wam_/),
    });
    const contenido = JSON.parse(String(fila!.content_json));
    expect(contenido.texto).toBe('Hola don Carlos, le saluda Tienda La Esquina. Le recordamos con mucho gusto que tiene un saldo pendiente de $ 49.900. Puede pagar directamente en la tienda. Si ya pagó, no tenga en cuenta este mensaje. Si no quiere recibir más recordatorios, responda SALIR.');
  });

  test.each([
    ['desconocida', cobro({ template: 'cobro_amenaza' as NombrePlantilla })],
    ['variables de menos', cobro({ variables: ['don Carlos', 'Tienda', '$ 1'] })],
    ['variables de más', cobro({ variables: ['a', 'b', 'c', 'd', 'e'] })],
    ['variable vacía', cobro({ variables: ['don Carlos', ' ', '$ 1', 'x'] })],
    ['otro idioma', cobro({ language: 'en_US' as 'es_CO' })],
  ])('%s → INVALID_TEMPLATE, sin wa_message_id', async (_, input) => {
    expect(await new SimulatedGateway(env).sendTemplate(input)).toEqual({ status: 'rejected', code: 'INVALID_TEMPLATE', retryable: false });
    expect(await filas()).toMatchObject([{ status: 'rejected', error_code: 'INVALID_TEMPLATE', wa_message_id: null }]);
  });

  test('cada plantilla del catálogo se puede enviar con su número de variables', async () => {
    const gw = new SimulatedGateway(env);
    const casos: [NombrePlantilla, number][] = [['cobro_vecino_amigable', 4], ['cobro_corte_de_quincena', 4], ['cobro_aviso_firme', 4], ['aviso_abono_pendiente', 3], ['codigo_verificacion', 1]];
    for (const [template, n] of casos) {
      expect(await gw.sendTemplate(cobro({ template, requestId: template, variables: Array.from({ length: n }, (_, i) => `v${i}`) }))).toMatchObject({ status: 'accepted' });
    }
  });

  test('teléfono que no es E.164 o más de 3 botones → OTHER', async () => {
    const gw = new SimulatedGateway(env);
    expect(await gw.sendTemplate(cobro({ to: '3001112233' }))).toMatchObject({ status: 'rejected', code: 'OTHER' });
    expect(await gw.sendTemplate(cobro({ requestId: 'req-2', buttonPayloads: ['a', 'b', 'c', 'd'] }))).toMatchObject({ status: 'rejected', code: 'OTHER' });
  });
});

describe('idempotencia por requestId', () => {
  test('el mismo requestId dos veces → un solo envío y el mismo resultado', async () => {
    const gw = new SimulatedGateway(env);
    const primero = await gw.sendTemplate(cobro());
    const segundo = await gw.sendTemplate(cobro({ variables: ['otro', 'otro', 'otro', 'otro'] }));
    expect(segundo).toEqual(primero);
    expect(await filas()).toHaveLength(1);
  });

  test('dos llamadas a la vez con el mismo requestId → un solo envío', async () => {
    const gw = new SimulatedGateway(env);
    const resultados = await Promise.all([gw.sendTemplate(cobro()), gw.sendTemplate(cobro()), gw.sendTemplate(cobro())]);
    expect(new Set(resultados.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(await filas()).toHaveLength(1);
  });

  test('un rechazo también se recuerda: reintentar con el mismo requestId no envía', async () => {
    const gw = new SimulatedGateway(env);
    await gw.sendTemplate(cobro({ template: 'nada' as NombrePlantilla }));
    expect(await gw.sendTemplate(cobro())).toMatchObject({ status: 'rejected', code: 'INVALID_TEMPLATE' });
    expect(await filas()).toHaveLength(1);
  });
});

describe('ventana de 24 h (reloj inyectado)', () => {
  const texto = (requestId: string) => ({ to: CLIENTE, requestId, content: { kind: 'text' as const, text: 'Recibimos su comprobante.' } });

  test('sin ningún entrante de ese teléfono → WINDOW_CLOSED', async () => {
    expect(await new SimulatedGateway(env).sendReply(texto('r1'))).toEqual({ status: 'rejected', code: 'WINDOW_CLOSED', retryable: false });
  });

  test('abierta hasta 24 h después del último entrante; cerrada desde las 24 h', async () => {
    const t0 = Date.now() - HORA;
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: CLIENTE, texto: 'Hola', en: t0 })] }), entornoWa());
    const ultimo = Math.floor(t0 / 1000) * 1000; // Meta manda segundos
    expect(await new SimulatedGateway(env, () => ultimo + 23 * HORA).sendReply(texto('r1'))).toMatchObject({ status: 'accepted' });
    expect(await new SimulatedGateway(env, () => ultimo + VENTANA_MS - 1).sendReply(texto('r2'))).toMatchObject({ status: 'accepted' });
    expect(await new SimulatedGateway(env, () => ultimo + VENTANA_MS).sendReply(texto('r3'))).toMatchObject({ status: 'rejected', code: 'WINDOW_CLOSED' });
    // La plantilla sí sale fuera de la ventana.
    expect(await new SimulatedGateway(env, () => ultimo + 30 * HORA).sendTemplate(cobro({ requestId: 'r4' }))).toMatchObject({ status: 'accepted' });
  });

  test('la ventana es por teléfono: el entrante de otro no la abre', async () => {
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: '+573009998877', texto: 'Hola' })] }), entornoWa());
    expect(await new SimulatedGateway(env).sendReply(texto('r1'))).toMatchObject({ status: 'rejected', code: 'WINDOW_CLOSED' });
  });

  test('contenido inválido → OTHER (4 botones, título de más de 20, texto vacío)', async () => {
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: CLIENTE, texto: 'Hola' })] }), entornoWa());
    const gw = new SimulatedGateway(env);
    const boton = (title: string) => ({ id: 'tln.v1:x', title });
    const malos = [
      { kind: 'buttons' as const, text: 'Elija', buttons: [boton('a'), boton('b'), boton('c'), boton('d')] },
      { kind: 'buttons' as const, text: 'Elija', buttons: [boton('x'.repeat(21))] },
      { kind: 'text' as const, text: '' },
    ];
    for (const [i, content] of malos.entries()) {
      expect(await gw.sendReply({ to: CLIENTE, requestId: `m${i}`, content })).toMatchObject({ status: 'rejected', code: 'OTHER' });
    }
  });
});

describe('medios de muestra', () => {
  test.each([['sim-png', 'image/png', 0x89], ['sim-jpeg', 'image/jpeg', 0xff], ['sim-webp', 'image/webp', 0x52]])('%s', async (id, tipo, primer) => {
    const m = await new SimulatedGateway(env).fetchMedia(id);
    expect(m.mimeType).toBe(tipo);
    expect(new Uint8Array(m.bytes)[0]).toBe(primer);
  });

  test('un archivo que no es imagen, y un medio desconocido', async () => {
    const gw = new SimulatedGateway(env);
    expect(new TextDecoder().decode((await gw.fetchMedia('sim-no-imagen')).bytes)).toBe('no soy una imagen');
    await expect(gw.fetchMedia('no-existe')).rejects.toThrow('medio_desconocido');
  });
});

test('recorrido completo sin Meta: plantilla → estados → respuesta firmada → respuesta en ventana → leído', async () => {
  const entorno = entornoWa();
  const gw = gatewayPara(entorno);

  // 1. Cobro con plantilla y botones.
  const envio = await gw.sendTemplate(cobro({ requestId: 'cobro-deb_1-001', buttonPayloads: ['tln.v1:pague:deb_1'], callbackData: 'cobro-deb_1-001' }));
  if (envio.status !== 'accepted') throw new Error('el cobro no se aceptó');
  const wamid = envio.waMessageId;
  // Como hace la ruta del cobro por bot: el envío se asigna a su negocio, así la respuesta se enruta a él (WAP-04).
  await sembrarNegocio();
  await env.DB.prepare('UPDATE whatsapp_messages SET business_id = ?1 WHERE wa_message_id = ?2').bind('bus_uid_1', wamid).run();

  // 2. Meta avisa que salió y que llegó.
  expect((await inyectar(cuerpoMeta({ estados: [estado(wamid, 'sent', { callbackData: 'cobro-deb_1-001' })] }), entorno)).status).toBe(200);
  expect((await inyectar(cuerpoMeta({ estados: [estado(wamid, 'delivered')] }), entorno)).status).toBe(200);

  // 3. El deudor pulsa el botón de la plantilla y manda la foto del comprobante, respondiendo a nuestro mensaje.
  const res = await inyectar(cuerpoMeta({
    mensajes: [
      entrante.botonPlantilla({ de: CLIENTE, payload: 'tln.v1:pague:deb_1', texto: 'Ya pagué', respondeA: wamid }),
      entrante.imagen({ de: CLIENTE, mediaId: 'sim-jpeg', respondeA: wamid }),
    ],
  }), entorno);
  expect(res.status).toBe(200);
  const medio = await gw.fetchMedia('sim-jpeg');
  expect(medio.mimeType).toBe('image/jpeg');

  // 4. La ventana quedó abierta: se le contesta con botones.
  const respuesta = await gw.sendReply({
    to: CLIENTE, requestId: 'resp-001', replyTo: wamid,
    content: { kind: 'buttons', text: 'Recibimos su comprobante. El tendero lo revisará.', buttons: [{ id: 'tln.v1:ok', title: 'Entendido' }] },
  });
  expect(respuesta).toMatchObject({ status: 'accepted' });

  // 5. Meta avisa que lo leyó (y llega un delivered tarde, que no hace retroceder).
  await inyectar(cuerpoMeta({ estados: [estado(wamid, 'read'), estado(wamid, 'delivered')] }), entorno);

  const bandeja = await filas();
  // Varias filas comparten milisegundo: se comparan sin depender del orden.
  expect(bandeja.map((f) => `${f.direction} ${f.kind} ${f.status}`).sort()).toEqual([
    'ENTRANTE button delivered',
    'ENTRANTE image delivered',
    'SALIENTE buttons accepted',
    'SALIENTE template read',
  ]);
  expect(bandeja.filter((f) => f.direction === 'ENTRANTE').every((f) => f.reply_to_wa_message_id === wamid)).toBe(true);
  expect(bandeja.filter((f) => f.direction === 'ENTRANTE').every((f) => f.business_id === 'bus_uid_1' && f.routing_rule === 'RESPUESTA')).toBe(true);
});
