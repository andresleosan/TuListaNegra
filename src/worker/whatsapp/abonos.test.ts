// WAP-06: aviso al dueño, aprobar o rechazar el abono pendiente (app y WhatsApp) y tirilla al deudor.
// Los pendientes nacen como en producción: cobro por el bot + comprobante FIRMADO por el webhook real (WAP-05).
// Reloj controlado; `fetch` vigilado: con el interruptor apagado nada sale a la red; nada en consola (B5).
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DIA, HORA, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';
import { cuerpoMeta, entrante, inyectar } from '../test/whatsapp';
import {
  PREFIJO_APROBAR, PREFIJO_CANCELAR, PREFIJO_CUAL_APROBAR, PREFIJO_CUAL_RECHAZAR, PREFIJO_PEDIR_MONTO, PREFIJO_RECHAZAR, TEXTO_FORMATO,
  TEXTO_YA_REVISADO, textoPedirMonto, textoRechazoDeudor, textoSuperaSaldo,
} from './abonos';
import { textoPregunta } from './procesar';

const MARTES_10 = Date.parse('2026-11-17T10:00:00-05:00'); // día hábil, en horario de cobro
const DEUDOR = '+573001234567'; // ficticio
const DUENO_A = '+573109998877'; // ficticio
const DUENO_B = '+573109998866'; // ficticio
const EXTRANO = '+573005550000'; // ficticio
const A = 'bus_uid_a';
const SALDO = 84_900;

type Fila = Record<string, any>;
const mov = async (id: string) => (await env.DB.prepare('SELECT * FROM ledger_transactions WHERE id = ?').bind(id).first<Fila>())!;
const deudorDe = async (id: string) => (await env.DB.prepare('SELECT * FROM debtors WHERE id = ?').bind(id).first<Fila>())!;
const pendientesDe = async (deudor: string) =>
  (await env.DB.prepare("SELECT * FROM ledger_transactions WHERE debtor_id = ? AND status = 'PENDIENTE_VERIFICACION_WHATSAPP' ORDER BY created_at, id").bind(deudor).all<Fila>()).results;
/** Salientes a un teléfono, en orden. */
const salientesA = async (telefono: string) =>
  (await env.DB.prepare("SELECT * FROM whatsapp_messages WHERE direction = 'SALIENTE' AND phone = ? ORDER BY created_at, id").bind(telefono).all<Fila>()).results;
const texto = (f: Fila) => (JSON.parse(f.content_json) as { text?: string; texto?: string }).text ?? JSON.parse(f.content_json).texto;
/** Saldo = suma de los movimientos confirmados (lo que comprueba `pnpm verificar:saldos`). */
const saldoCalculado = async (deudor: string) => (await env.DB.prepare(
  `SELECT COALESCE(SUM(CASE WHEN type IN ('FIADO', 'AJUSTE_SUMA') THEN amount_cop ELSE -amount_cop END), 0) AS s
   FROM ledger_transactions WHERE debtor_id = ? AND status = 'CONFIRMADO'`,
).bind(deudor).first<{ s: number }>())!.s;

let red: ReturnType<typeof vi.fn>;
let registros: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MARTES_10);
  red = vi.fn(() => Promise.reject(new Error('WAP-06 no debe salir a la red')));
  vi.stubGlobal('fetch', red);
  registros = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
  await sembrarNegocio('uid_a', { name: 'Tienda A', whatsapp_phone: DUENO_A, whatsapp_verified_at: MARTES_10 - DIA, payment_methods_info: 'Nequi 300 000 0000' });
  await sembrarNegocio('uid_b', { name: 'Tienda B', whatsapp_phone: DUENO_B, whatsapp_verified_at: MARTES_10 - DIA });
});
afterEach(() => {
  try {
    expect(red).not.toHaveBeenCalled();
    for (const r of registros) expect(r).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

let toques = 0;
/** Deudor con saldo, teléfono y consentimiento, al que la tienda le cobró por el bot (así el enrutador lo reconoce). */
async function deudorCobrado(uid = 'uid_a', telefono = DEUDOR) {
  const res = await api('/api/deudores', { uid }, { method: 'POST', body: JSON.stringify({ full_name: 'don Carlos', whatsapp_phone: telefono, wa_consentimiento: true }) });
  const { id } = await res.json<{ id: string }>();
  // Un fiado de hace 40 días: el deudor está en mora; un abono parcial no la quita, uno completo sí.
  vi.setSystemTime(MARTES_10 - 40 * DIA);
  await api(`/api/deudores/${id}/movimientos`, { uid }, { method: 'POST', body: JSON.stringify({ request_id: `req-${id}`, type: 'FIADO', amount_cop: SALDO }) });
  vi.setSystemTime(MARTES_10);
  const cobro = await api(`/api/cobros-bot/${id}`, { uid }, { method: 'POST', body: JSON.stringify({ tono: 'VECINO_AMIGABLE', request_id: `toque-abono-${toques++}` }) });
  expect(cobro.status).toBe(200);
  return id;
}
/** El deudor manda un comprobante (imagen de muestra del simulador); devuelve el id del abono pendiente. */
async function comprobante(deudor: string, wamid: string, mediaId = 'sim-png', de = DEUDOR) {
  const res = await inyectar(cuerpoMeta({ mensajes: [entrante.imagen({ de, id: wamid, mediaId, mimeType: 'image/png' })] }));
  expect(res.status).toBe(200);
  const fila = await env.DB.prepare('SELECT id FROM ledger_transactions WHERE debtor_id = ? AND request_id = ?').bind(deudor, `wa:${wamid}`).first<{ id: string }>();
  expect(fila, 'el comprobante no creó el pendiente').not.toBeNull();
  return fila!.id;
}
const aprobar = (id: string, monto: unknown, uid = 'uid_a') => api(`/api/abonos/${id}/aprobar`, { uid }, { method: 'POST', body: JSON.stringify({ amount_cop: monto }) });
const rechazar = (id: string, uid = 'uid_a') => api(`/api/abonos/${id}/rechazar`, { uid }, { method: 'POST', body: '{}' });

/** Alguien pulsa un botón (de plantilla o interactivo) desde `de`, citando `respondeA` si se da. */
const pulsa = (de: string, id: string, payload: string, respondeA?: string) =>
  inyectar(cuerpoMeta({ mensajes: [entrante.botonPlantilla({ de, id, payload, texto: 'Aprobar', respondeA })] }));
const escribe = (de: string, id: string, t: string) => inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de, id, texto: t })] }));

describe('aviso al dueño', () => {
  test('dueño VERIFICADO: plantilla sin monto ni botón que confirme (pide el monto o rechaza); en la app, la lista de pendientes', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.C1');
    const [aviso, ...mas] = await salientesA(DUENO_A);
    expect(mas).toEqual([]);
    expect(aviso).toMatchObject({
      business_id: A, kind: 'template', template: 'aviso_abono_pendiente', status: 'accepted', request_id: `aviso_abono:${id}`,
      buttons_json: JSON.stringify([`${PREFIJO_PEDIR_MONTO}${id}`, `${PREFIJO_RECHAZAR}${id}`]),
    });
    expect(JSON.parse(aviso!.content_json).variables).toEqual(['don Carlos', 'TLN-0001']);
    expect(texto(aviso!)).toContain('Mira la foto en la app');
    expect(texto(aviso!)).toContain('responde APROBAR TLN-0001 y lo que pagó según la foto');
    expect(texto(aviso!)).not.toContain('84.900'); // el sugerido es el saldo, no lo leído: no se ofrece
    const lista = await (await api('/api/abonos', { uid: 'uid_a' })).json<any>();
    expect(lista.pendientes).toMatchObject([{ id, debtor_id: d, amount_cop: SALDO, full_name: 'don Carlos', unique_code: 'TLN-0001', current_balance_cop: SALDO }]);
    expect(lista.pendientes[0].evidence_r2_key).toMatch(new RegExp(`^negocios/${A}/comprobantes/`));
    expect((await (await api('/api/abonos', { uid: 'uid_b' })).json<any>()).pendientes).toEqual([]);
  });

  test('dueño sin verificar: solo el aviso en la app, nada a su WhatsApp', async () => {
    await env.DB.prepare('UPDATE businesses SET whatsapp_verified_at = NULL WHERE id = ?').bind(A).run();
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.C2');
    expect(await salientesA(DUENO_A)).toEqual([]);
    expect((await (await api('/api/abonos', { uid: 'uid_a' })).json<any>()).pendientes).toMatchObject([{ id }]);
  });
});

describe('aprobar desde la app', () => {
  test('confirma con el monto corregido, mueve el saldo exacto, deja la mora bien y envía la tirilla', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.A1');
    const antes = await deudorDe(d);
    vi.setSystemTime(MARTES_10 + 60_000);
    const res = await aprobar(id, 50_000);
    expect(res.status).toBe(200);
    const cuerpo = await res.json<any>();
    expect(cuerpo).toMatchObject({ envio: 'enviado', deudor: { current_balance_cop: SALDO - 50_000, oldest_unpaid_date: antes.oldest_unpaid_date } });
    expect(await mov(id)).toMatchObject({ status: 'CONFIRMADO', amount_cop: 50_000, balance_after_cop: SALDO - 50_000, confirmed_at: MARTES_10 + 60_000 });
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO - 50_000, oldest_unpaid_date: antes.oldest_unpaid_date });
    expect(await saldoCalculado(d)).toBe(SALDO - 50_000);
    const tirilla = (await salientesA(DEUDOR)).find((f) => f.request_id === `tirilla:${id}`);
    expect(tirilla).toMatchObject({ business_id: A, kind: 'text', status: 'accepted' });
    expect(texto(tirilla!)).toBe(['Tienda A', 'Recibo · Código TLN-0001', '17/11/2026 10:01', 'Saldo anterior: $ 84.900', 'Abono: −$ 50.000', 'Total: $ 34.900', 'Medios de pago: Nequi 300 000 0000'].join('\n'));
  });

  test('comprobante 10:00, fiado 11:00, aprobado 12:00 → en el historial va después del fiado y el saldo corrido queda en orden', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.ORD');
    vi.setSystemTime(MARTES_10 + HORA);
    const fiado = await api(`/api/deudores/${d}/movimientos`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ request_id: 'req-fiado-11', type: 'FIADO', amount_cop: 10_000 }) });
    expect(fiado.status).toBe(201);
    vi.setSystemTime(MARTES_10 + 2 * HORA);
    expect((await aprobar(id, 30_000)).status).toBe(200);
    const { movimientos } = await (await api(`/api/deudores/${d}/movimientos`, { uid: 'uid_a' })).json<{ movimientos: Fila[] }>();
    // Lo más nuevo arriba: el abono (aprobado a las 12:00), el fiado de las 11:00 y el fiado inicial.
    expect(movimientos.map((m) => `${m.type}:${m.amount_cop}:${m.balance_after_cop}`)).toEqual([
      `ABONO:30000:${SALDO + 10_000 - 30_000}`, `FIADO:10000:${SALDO + 10_000}`, `FIADO:${SALDO}:${SALDO}`,
    ]);
    expect(movimientos[0]).toMatchObject({ id, created_at: MARTES_10, confirmed_at: MARTES_10 + 2 * HORA });
    // La tirilla lleva la hora de la aprobación.
    expect(texto((await salientesA(DEUDOR)).find((f) => f.request_id === `tirilla:${id}`)!)).toContain('17/11/2026 12:00');
  });

  test('abono completo: saldo en cero, sin mora y sin promesa', async () => {
    const d = await deudorCobrado();
    await env.DB.prepare('UPDATE debtors SET promised_payment_date = ? WHERE id = ?').bind(MARTES_10 + 3 * DIA, d).run();
    const id = await comprobante(d, 'wamid.A2');
    expect((await aprobar(id, SALDO)).status).toBe(200);
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: 0, oldest_unpaid_date: null, promised_payment_date: null });
  });

  test('dos aprobaciones a la vez (o aprobar y rechazar a la vez) → solo una tiene efecto', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.A3');
    const r = await Promise.all([aprobar(id, 30_000), aprobar(id, 30_000), aprobar(id, 20_000)]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409, 409]);
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: await saldoCalculado(d) });
    expect([SALDO - 30_000, SALDO - 20_000]).toContain((await deudorDe(d)).current_balance_cop);
    expect((await salientesA(DEUDOR)).filter((f) => f.request_id === `tirilla:${id}`)).toHaveLength(1);

    const id2 = await comprobante(d, 'wamid.A4', 'sim-jpeg');
    const saldo = (await deudorDe(d)).current_balance_cop;
    const [ap, re] = await Promise.all([aprobar(id2, 1_000), rechazar(id2)]);
    expect([ap.status, re.status].sort()).toEqual([200, 409]);
    const final = await mov(id2);
    expect((await deudorDe(d)).current_balance_cop).toBe(final.status === 'CONFIRMADO' ? saldo - 1_000 : saldo);
    expect(await saldoCalculado(d)).toBe((await deudorDe(d)).current_balance_cop);
    expect(await (await aprobar(id2, 1_000)).json()).toMatchObject({ error: 'ya_revisado', estado: final.status });
  });

  test('un monto mayor que el saldo de ESE momento → rechazado sin escribir nada', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.A5');
    // Entretanto abonó 10.000 en el mostrador: el sugerido ya no cabe.
    await api(`/api/deudores/${d}/movimientos`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ request_id: 'req-mostrador', type: 'ABONO', amount_cop: 10_000 }) });
    const antesMov = await mov(id);
    const antesDeudor = await deudorDe(d);
    const res = await aprobar(id, SALDO);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'supera_saldo', saldo: SALDO - 10_000 });
    expect(await mov(id)).toEqual(antesMov);
    expect(await deudorDe(d)).toEqual(antesDeudor);
    expect((await salientesA(DEUDOR)).filter((f) => f.request_id === `tirilla:${id}`)).toEqual([]);
    // Montos que no son enteros positivos: 400, nada escrito.
    for (const monto of [0, -1, 1.5, '50000', null, 100_000_001]) expect((await aprobar(id, monto)).status).toBe(400);
    expect(await mov(id)).toEqual(antesMov);
  });

  test('rechazar no mueve el saldo y avisa al deudor en tono neutro', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.R1');
    const res = await rechazar(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ envio: 'enviado', deudor: { current_balance_cop: SALDO } });
    expect(await mov(id)).toMatchObject({ status: 'RECHAZADO', amount_cop: SALDO, balance_after_cop: null, confirmed_at: null });
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO });
    const aviso = (await salientesA(DEUDOR)).find((f) => f.request_id === `rechazo:${id}`);
    expect(texto(aviso!)).toBe(textoRechazoDeudor('Tienda A'));
    expect(texto(aviso!)).not.toMatch(/lista negra|reporte/i);
  });

  test('otra tienda no ve, aprueba ni rechaza el pendiente de A (responde como si no existiera)', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.ISO');
    const antes = await mov(id);
    expect((await aprobar(id, 1_000, 'uid_b')).status).toBe(404);
    expect((await rechazar(id, 'uid_b')).status).toBe(404);
    expect(await mov(id)).toEqual(antes);
  });
});

describe('tirilla al deudor', () => {
  test('sin consentimiento o con baja → no se le escribe; la tirilla queda en la app', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.T1');
    await api(`/api/deudores/${d}`, { uid: 'uid_a' }, { method: 'PATCH', body: JSON.stringify({ wa_consentimiento: false }) });
    expect(await (await aprobar(id, 1_000)).json()).toMatchObject({ envio: 'sin_permiso' });
    const id2 = await comprobante(d, 'wamid.T2', 'sim-jpeg');
    await env.DB.prepare('UPDATE debtors SET wa_consent_at = ?1, wa_opt_out_at = ?1 WHERE id = ?2').bind(MARTES_10, d).run();
    expect(await (await rechazar(id2)).json()).toMatchObject({ envio: 'baja' });
    expect((await salientesA(DEUDOR)).filter((f) => /^(tirilla|rechazo):/.test(f.request_id))).toEqual([]);
  });

  test('pasadas 24 h desde su último mensaje, la ventana está cerrada: no sale y se dice', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.T3');
    vi.setSystemTime(MARTES_10 + DIA + 1);
    expect(await (await aprobar(id, 1_000)).json()).toMatchObject({ envio: 'ventana_cerrada' });
    expect(await mov(id)).toMatchObject({ status: 'CONFIRMADO' });
    expect((await salientesA(DEUDOR)).find((f) => f.request_id === `tirilla:${id}`)).toMatchObject({ status: 'rejected', error_code: 'WINDOW_CLOSED' });
  });

  test('en producción con el interruptor apagado (sin simulador habilitado) no se escribe nada, ni al simulador', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.T4');
    const res = await api(`/api/abonos/${id}/aprobar`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ amount_cop: 1_000 }) }, { ...env, TEST_WHATSAPP_SIMULADO: undefined });
    expect(await res.json()).toMatchObject({ envio: 'bot_apagado' });
    expect((await salientesA(DEUDOR)).filter((f) => f.request_id === `tirilla:${id}`)).toEqual([]);
  });
});

describe('órdenes del dueño por WhatsApp', () => {
  const PENDIENTE = 'PENDIENTE_VERIFICACION_WHATSAPP';
  const avisoDe = async (id: string) => (await env.DB.prepare('SELECT * FROM whatsapp_messages WHERE request_id = ?').bind(`aviso_abono:${id}`).first<Fila>())!;
  const respuestaA = async (wamid: string) =>
    (await env.DB.prepare("SELECT * FROM whatsapp_messages WHERE direction = 'SALIENTE' AND reply_to_wa_message_id = ?").bind(wamid).all<Fila>()).results;
  /** Toca un botón de una respuesta interactiva nuestra. */
  const toca = (de: string, id: string, botonId: string, respondeA?: string) =>
    inyectar(cuerpoMeta({ mensajes: [entrante.boton({ de, id, botonId, titulo: 'Botón', respondeA })] }));
  const botones = (f: Fila) => JSON.parse(f.buttons_json) as { id: string; title: string }[];

  test('el botón del aviso solo pide el monto; un botón que confirme el saldo sugerido nunca se ofrece y no hace nada', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.W1');
    const aviso = await avisoDe(id);
    await pulsa(DUENO_A, 'wamid.B1', `${PREFIJO_PEDIR_MONTO}${id}`, aviso.wa_message_id);
    expect(await mov(id)).toMatchObject({ status: PENDIENTE, amount_cop: SALDO });
    const [r, ...mas] = await respuestaA('wamid.B1');
    expect(mas).toEqual([]);
    expect(r).toMatchObject({ kind: 'text', business_id: A, buttons_json: null });
    expect(texto(r!)).toBe('¿Cuánto pagó don Carlos (TLN-0001)? Mira la foto en la app y responde APROBAR TLN-0001 y lo que pagó según la foto, por ejemplo APROBAR TLN-0001 20000.');
    await pulsa(DUENO_A, 'wamid.B2', `${PREFIJO_APROBAR}${id}:${SALDO}`, aviso.wa_message_id);
    await toca(DUENO_A, 'wamid.B3', `${PREFIJO_APROBAR}${id}:${SALDO}`);
    expect(await mov(id)).toMatchObject({ status: PENDIENTE, amount_cop: SALDO });
    expect(await respuestaA('wamid.B2')).toEqual([]);
    expect(await respuestaA('wamid.B3')).toEqual([]);
  });

  test('«APROBAR TLN-0001 20000» no confirma: responde con UN botón final con deudor, código y monto; solo ese toque del dueño confirma, una vez', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.W2');
    await escribe(DUENO_A, 'wamid.M1', 'APROBAR TLN-0001 20000');
    expect(await mov(id)).toMatchObject({ status: PENDIENTE, amount_cop: SALDO });
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO });
    const [final, ...mas] = await respuestaA('wamid.M1');
    expect(mas).toEqual([]);
    expect(final).toMatchObject({ kind: 'buttons', business_id: A, callback_data: 'dueno_confirmar' });
    expect(texto(final!)).toBe('¿Aprobar $ 20.000 a don Carlos (TLN-0001)? Es por el comprobante que envió el 17/11 10:00. Su saldo pasa de $ 84.900 a $ 64.900. Si el monto no es el de la foto, toca Cancelar.');
    const si = `${PREFIJO_APROBAR}${id}:20000`;
    expect(botones(final!)).toEqual([{ id: si, title: 'Aprobar $ 20.000' }, { id: `${PREFIJO_CANCELAR}${id}`, title: 'Cancelar' }]);
    // Nadie más puede usar ese botón: ni un extraño, ni el deudor, ni el dueño verificado de otra tienda.
    await toca(EXTRANO, 'wamid.F1', si, final!.wa_message_id);
    await toca(DEUDOR, 'wamid.F2', si);
    await toca(DUENO_B, 'wamid.F3', si);
    expect(await mov(id)).toMatchObject({ status: PENDIENTE });
    // El dueño lo toca dos veces: confirma una sola vez.
    await toca(DUENO_A, 'wamid.T1', si, final!.wa_message_id);
    await toca(DUENO_A, 'wamid.T2', si, final!.wa_message_id);
    expect(await mov(id)).toMatchObject({ status: 'CONFIRMADO', amount_cop: 20_000, balance_after_cop: SALDO - 20_000 });
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO - 20_000 });
    expect(await saldoCalculado(d)).toBe(SALDO - 20_000);
    expect((await salientesA(DEUDOR)).filter((f) => f.request_id === `tirilla:${id}`)).toHaveLength(1);
    expect(texto((await respuestaA('wamid.T1'))[0]!)).toMatch(/^Listo: aprobaste el abono de \$ 20\.000 de don Carlos \(TLN-0001\)\. Saldo nuevo: \$ 64\.900\. Tirilla: Le enviamos/);
    expect(texto((await respuestaA('wamid.T2'))[0]!)).toBe(TEXTO_YA_REVISADO);
  });

  test('el botón final muestra el monto formateado («APROBAR 0001 20» → $ 20); Cancelar no cambia nada; formatos de código y monto', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.W3');
    await escribe(DUENO_A, 'wamid.M2', 'APROBAR 0001 20');
    const [chico] = await respuestaA('wamid.M2');
    expect(texto(chico!)).toMatch(/^¿Aprobar \$ 20 a don Carlos \(TLN-0001\)\?/);
    expect(botones(chico!)[0]).toEqual({ id: `${PREFIJO_APROBAR}${id}:20`, title: 'Aprobar $ 20' });
    await toca(DUENO_A, 'wamid.C1', `${PREFIJO_CANCELAR}${id}`, chico!.wa_message_id);
    expect(texto((await respuestaA('wamid.C1'))[0]!)).toBe('No cambiamos nada: el comprobante de don Carlos (TLN-0001) sigue por revisar.');
    expect(await mov(id)).toMatchObject({ status: PENDIENTE, amount_cop: SALDO });
    for (const [w, t] of [['wamid.M3', 'aprobar tln0001 50.000'], ['wamid.M4', 'Aprobar TLN-0001 $ 50.000'], ['wamid.M5', 'APROBAR 000001 $50000']] as const) {
      await escribe(DUENO_A, w, t);
      expect(botones((await respuestaA(w))[0]!)[0], t).toEqual({ id: `${PREFIJO_APROBAR}${id}:50000`, title: 'Aprobar $ 50.000' });
    }
    expect(await mov(id)).toMatchObject({ status: PENDIENTE });
  });

  test('un monto mayor que el saldo se explica sin botón; si el saldo bajó antes del toque final, tampoco se aprueba', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.W4');
    await escribe(DUENO_A, 'wamid.S1', 'APROBAR 0001 90000');
    const [r] = await respuestaA('wamid.S1');
    expect(r).toMatchObject({ kind: 'text', buttons_json: null });
    expect(texto(r!)).toBe(textoSuperaSaldo(90_000, SALDO, 'TLN-0001'));
    await escribe(DUENO_A, 'wamid.S2', 'APROBAR 0001 80000');
    const [final] = await respuestaA('wamid.S2');
    await api(`/api/deudores/${d}/movimientos`, { uid: 'uid_a' }, { method: 'POST', body: JSON.stringify({ request_id: 'req-mostrador-wa', type: 'ABONO', amount_cop: 10_000 }) });
    await toca(DUENO_A, 'wamid.S3', `${PREFIJO_APROBAR}${id}:80000`, final!.wa_message_id);
    expect(await mov(id)).toMatchObject({ status: PENDIENTE, amount_cop: SALDO });
    expect(texto((await respuestaA('wamid.S3'))[0]!)).toBe(textoSuperaSaldo(80_000, SALDO - 10_000, 'TLN-0001'));
  });

  test('con dos pendientes pregunta cuál (opciones sin cifras); elegir no confirma: lleva al botón final, y solo ese confirma', async () => {
    const d = await deudorCobrado();
    const p1 = await comprobante(d, 'wamid.D1');
    vi.setSystemTime(MARTES_10 + 60_000);
    const p2 = await comprobante(d, 'wamid.D2', 'sim-jpeg');
    await escribe(DUENO_A, 'wamid.O1', 'aprobar tln-0001 $ 20.000');
    const [pregunta, ...mas] = await respuestaA('wamid.O1');
    expect(mas).toEqual([]);
    expect(pregunta).toMatchObject({ kind: 'buttons', business_id: A });
    expect(texto(pregunta!)).toBe('don Carlos (TLN-0001) tiene 2 comprobantes por revisar:\nA. Recibido el 17/11 10:00\nB. Recibido el 17/11 10:01\n¿A cuál corresponde el abono de $ 20.000? Mira las fotos en la app.');
    expect(botones(pregunta!)).toEqual([
      { id: `${PREFIJO_CUAL_APROBAR}${p1}:20000`, title: 'Comprobante A' }, { id: `${PREFIJO_CUAL_APROBAR}${p2}:20000`, title: 'Comprobante B' },
    ]);
    expect(botones(pregunta!).map((b) => b.title).join(' ')).not.toMatch(/\d/);
    // Elegir el segundo: nada se confirma, llega el botón final de ese comprobante.
    await toca(DUENO_A, 'wamid.O2', `${PREFIJO_CUAL_APROBAR}${p2}:20000`, pregunta!.wa_message_id);
    expect(await pendientesDe(d)).toHaveLength(2);
    const [final] = await respuestaA('wamid.O2');
    expect(texto(final!)).toBe('¿Aprobar $ 20.000 a don Carlos (TLN-0001)? Es por el comprobante que envió el 17/11 10:01. Su saldo pasa de $ 84.900 a $ 64.900. Si el monto no es el de la foto, toca Cancelar.');
    expect(botones(final!)).toEqual([{ id: `${PREFIJO_APROBAR}${p2}:20000`, title: 'Aprobar $ 20.000' }, { id: `${PREFIJO_CANCELAR}${p2}`, title: 'Cancelar' }]);
    // Una elección que no ofrecimos (otro monto) no lleva a nada.
    await toca(DUENO_A, 'wamid.O3', `${PREFIJO_CUAL_APROBAR}${p1}:1000`, pregunta!.wa_message_id);
    expect(await respuestaA('wamid.O3')).toEqual([]);
    await toca(DUENO_A, 'wamid.O4', `${PREFIJO_APROBAR}${p2}:20000`, final!.wa_message_id);
    expect(await mov(p2)).toMatchObject({ status: 'CONFIRMADO', amount_cop: 20_000 });
    expect(await mov(p1)).toMatchObject({ status: PENDIENTE });
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO - 20_000 });
  });

  test('RECHAZAR: con uno pide confirmar con un botón que nombra al deudor; con varios pregunta cuál primero', async () => {
    const d = await deudorCobrado();
    const p1 = await comprobante(d, 'wamid.R1');
    await escribe(DUENO_A, 'wamid.RX1', 'RECHAZAR 0001');
    expect(await mov(p1)).toMatchObject({ status: PENDIENTE });
    const [conf] = await respuestaA('wamid.RX1');
    expect(texto(conf!)).toBe('¿Rechazar el comprobante de don Carlos (TLN-0001) que envió el 17/11 10:00? Su saldo no cambia.');
    expect(botones(conf!)).toEqual([{ id: `${PREFIJO_RECHAZAR}${p1}`, title: 'Sí, rechazar' }, { id: `${PREFIJO_CANCELAR}${p1}`, title: 'Cancelar' }]);
    await toca(DUENO_A, 'wamid.RX2', `${PREFIJO_RECHAZAR}${p1}`, conf!.wa_message_id);
    expect(await mov(p1)).toMatchObject({ status: 'RECHAZADO' });
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO });
    expect(texto((await respuestaA('wamid.RX2'))[0]!)).toMatch(/^Listo: rechazaste el comprobante de don Carlos \(TLN-0001\)\. Su saldo sigue en \$ 84\.900\./);
    expect((await salientesA(DEUDOR)).filter((f) => f.request_id === `rechazo:${p1}`)).toHaveLength(1);

    vi.setSystemTime(MARTES_10 + 60_000);
    const p2 = await comprobante(d, 'wamid.R2', 'sim-jpeg');
    vi.setSystemTime(MARTES_10 + 120_000);
    const p3 = await comprobante(d, 'wamid.R3', 'sim-webp');
    await escribe(DUENO_A, 'wamid.RX3', 'rechazar 0001');
    const [cual] = await respuestaA('wamid.RX3');
    expect(texto(cual!)).toBe('don Carlos (TLN-0001) tiene 2 comprobantes por revisar:\nA. Recibido el 17/11 10:01\nB. Recibido el 17/11 10:02\n¿Cuál quieres rechazar? Mira las fotos en la app.');
    expect(botones(cual!)).toEqual([{ id: `${PREFIJO_CUAL_RECHAZAR}${p2}`, title: 'Comprobante A' }, { id: `${PREFIJO_CUAL_RECHAZAR}${p3}`, title: 'Comprobante B' }]);
    await toca(DUENO_A, 'wamid.RX4', `${PREFIJO_CUAL_RECHAZAR}${p3}`, cual!.wa_message_id);
    expect(await pendientesDe(d)).toHaveLength(2);
    const [conf3] = await respuestaA('wamid.RX4');
    expect(texto(conf3!)).toMatch(/^¿Rechazar el comprobante de don Carlos \(TLN-0001\) que envió el 17\/11 10:02\?/);
    expect(botones(conf3!)[0]).toEqual({ id: `${PREFIJO_RECHAZAR}${p3}`, title: 'Sí, rechazar' });
  });

  test('el botón Rechazar del aviso: RECHAZADO, saldo intacto, aviso neutro al deudor', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.W5');
    await pulsa(DUENO_A, 'wamid.B4', `${PREFIJO_RECHAZAR}${id}`, (await avisoDe(id)).wa_message_id);
    expect(await mov(id)).toMatchObject({ status: 'RECHAZADO' });
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO });
    expect((await salientesA(DEUDOR)).filter((f) => f.request_id === `rechazo:${id}`)).toHaveLength(1);
  });

  test('un botón con otro monto (no ofrecido) o pulsado por quien no es el dueño verificado → nada', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.W6');
    const aviso = await avisoDe(id);
    await escribe(DUENO_A, 'wamid.P0', `APROBAR 0001 ${SALDO}`);
    const [final] = await respuestaA('wamid.P0');
    const si = `${PREFIJO_APROBAR}${id}:${SALDO}`;
    expect(botones(final!)[0]!.id).toBe(si);
    const antes = await mov(id);
    await toca(DUENO_A, 'wamid.F1', `${PREFIJO_APROBAR}${id}:1000`, final!.wa_message_id); // monto que no le ofrecimos
    await toca(DUENO_A, 'wamid.F2', `${PREFIJO_APROBAR}${id}:1000`); // ni sin citar
    await toca(EXTRANO, 'wamid.F3', si, final!.wa_message_id); // un extraño
    await toca(DEUDOR, 'wamid.F4', si); // el propio deudor
    await escribe(DEUDOR, 'wamid.F5', `APROBAR 0001 ${SALDO}`);
    // El dueño deja de estar verificado (cambió de número): su botón ya no vale.
    await env.DB.prepare('UPDATE businesses SET whatsapp_verified_at = NULL WHERE id = ?').bind(A).run();
    await toca(DUENO_A, 'wamid.F6', si, final!.wa_message_id);
    await pulsa(DUENO_A, 'wamid.F7', `${PREFIJO_RECHAZAR}${id}`, aviso.wa_message_id);
    expect(await mov(id)).toEqual(antes);
    expect(await deudorDe(d)).toMatchObject({ current_balance_cop: SALDO });
    for (const w of ['wamid.F1', 'wamid.F2', 'wamid.F4', 'wamid.F5', 'wamid.F6', 'wamid.F7']) expect(await respuestaA(w), w).toEqual([]);
    expect(await respuestaA('wamid.F3')).toMatchObject([{ callback_data: 'neutro', business_id: null }]); // el extraño: la respuesta neutra de siempre
  });

  test('el botón de un abono de OTRA tienda, pulsado por el dueño verificado de B → nada', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.W7');
    const antes = await mov(id);
    await toca(DUENO_B, 'wamid.X1', `${PREFIJO_APROBAR}${id}:${SALDO}`);
    await pulsa(DUENO_B, 'wamid.X2', `${PREFIJO_RECHAZAR}${id}`, (await avisoDe(id)).wa_message_id);
    await escribe(DUENO_B, 'wamid.X3', 'APROBAR 0001 1000'); // B no tiene ese código: no se le confirma nada de A
    expect(await mov(id)).toEqual(antes);
    expect(texto((await respuestaA('wamid.X3'))[0]!)).toBe('No encontramos el código TLN-0001 en tu libro.');
  });

  test('«APROBAR 0001» sin monto pide el monto (con uno o con varios pendientes), sin botones', async () => {
    const d = await deudorCobrado();
    const id = await comprobante(d, 'wamid.U1');
    await escribe(DUENO_A, 'wamid.U2', 'Aprobar 0001');
    expect(await mov(id)).toMatchObject({ status: PENDIENTE });
    const [r] = await respuestaA('wamid.U2');
    expect(r).toMatchObject({ kind: 'text', buttons_json: null });
    expect(texto(r!)).toBe(textoPedirMonto('don Carlos', 'TLN-0001'));
    vi.setSystemTime(MARTES_10 + 60_000);
    await comprobante(d, 'wamid.U3', 'sim-jpeg');
    await escribe(DUENO_A, 'wamid.U4', 'APROBAR TLN-0001');
    expect(texto((await respuestaA('wamid.U4'))[0]!)).toBe(textoPedirMonto('don Carlos', 'TLN-0001'));
    expect(await pendientesDe(d)).toHaveLength(2);
  });

  test('texto mal escrito (o un código de 1 a 3 cifras) → se explica el formato; sin pendientes o tienda vencida → se dice, y nada cambia', async () => {
    const d = await deudorCobrado();
    const malos = ['APROBAR', 'aprobar a don Carlos', 'RECHAZAR 0001 5000', 'APROBAR 1', 'APROBAR 2 20000', 'RECHAZAR 001', 'APROBAR TLN 0001', 'APROBAR 1234567'];
    for (const [i, t] of malos.entries()) await escribe(DUENO_A, `wamid.E${i}`, t);
    for (const [i, t] of malos.entries()) expect(texto((await respuestaA(`wamid.E${i}`))[0]!), t).toBe(TEXTO_FORMATO);
    await escribe(DUENO_A, 'wamid.E10', 'APROBAR 0001 1000');
    expect(texto((await respuestaA('wamid.E10'))[0]!)).toBe('TLN-0001 no tiene comprobantes por revisar.');
    const id = await comprobante(d, 'wamid.E11');
    await env.DB.prepare('UPDATE businesses SET subscription_expires_at = ? WHERE id = ?').bind(MARTES_10 - 1, A).run();
    await escribe(DUENO_A, 'wamid.E12', 'APROBAR 0001 1000');
    expect(await mov(id)).toMatchObject({ status: PENDIENTE });
    expect(texto((await respuestaA('wamid.E12'))[0]!)).toMatch(/^Tu plan no permite anotar abonos/);
    await escribe(DUENO_A, 'wamid.E13', 'hola, ¿cómo va todo?'); // conversación: ni se contesta
    expect(await respuestaA('wamid.E13')).toEqual([]);
  });

  test('un DEUDOR que responde con un texto que empieza por «aprobar» sigue el flujo de deudor (propuesta de fecha)', async () => {
    await deudorCobrado();
    const cobro = (await salientesA(DEUDOR)).find((f) => String(f.request_id).startsWith('cobro-bot:'))!;
    await inyectar(cuerpoMeta({ mensajes: [entrante.texto({ de: DEUDOR, id: 'wamid.DD1', texto: 'Aprobar el viernes le pago', respondeA: cobro.wa_message_id })] }));
    const entranteDD1 = await env.DB.prepare('SELECT routing_rule FROM whatsapp_messages WHERE wa_message_id = ?').bind('wamid.DD1').first<Fila>();
    expect(entranteDD1).toMatchObject({ routing_rule: 'RESPUESTA' });
    const [r, ...mas] = await respuestaA('wamid.DD1');
    expect(mas).toEqual([]);
    expect(r).toMatchObject({ kind: 'buttons', callback_data: 'promesa', business_id: A });
    expect(texto(r!)).toBe(textoPregunta(Date.parse('2026-11-20T00:00:00-05:00')));
  });
});
