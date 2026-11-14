// MOS-04: morosos por antigüedad, Cobrar con los tres tonos y bloqueos (sin consentimiento, fuera de horario) que no abren nada.
// WAP-07: cobro masivo por el bot (elegir a todos, vista previa, confirmar y ver el resumen de quién quedó fuera y por qué).
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { enlaceWhatsApp, textoDeCobro, type Tono } from '../src/shared/cobro';
import { apiComo, captura, entrar, esperarMostrador, llenarAlta, sinDesborde, SUFIJO, uidDe } from './ayudas';

/** La misma tienda que e2e/ficha.spec.ts (ver allí por qué se comparte). */
async function miTienda(page: Page, info: TestInfo) {
  const movil = info.project.name === 'movil-360';
  const uid = uidDe(`fic_${movil ? 360 : 1280}`);
  const prefijo = movil ? '313' : '314';
  await entrar(page, 'piloto@ejemplo.test', uid);
  const alta = page.getByRole('heading', { name: 'Crea tu tienda' });
  const mostrador = page.getByRole('heading', { name: 'Mostrador' });
  await expect(alta.or(mostrador)).toBeVisible();
  if (await alta.isVisible()) {
    await llenarAlta(page, 'Tienda Doña Rubi', `${prefijo}${SUFIJO}`);
    await esperarMostrador(page);
  }
  return { uid, prefijo };
}

const TIENDA = 'Tienda Doña Rubi';
const MEDIOS = 'Nequi o efectivo en la tienda';
const DIA = 86_400_000;
const LISTA = /\/api\/deudores(\?.*)?$/;

const abiertos = (page: Page) => page.evaluate(() => (window as unknown as { __abiertos: string[] }).__abiertos);

test('morosos: orden por antigüedad, tres tonos, sin consentimiento y fuera de horario no abren', async ({ page }, info) => {
  const ancho = page.viewportSize()!.width;
  const errores: string[] = [];
  // Errores de consola esperados: el 404 `sin_negocio` antes de crear la tienda y los 409 de los cobros bloqueados.
  // También el corte de red simulado en la segunda tanda del cobro masivo.
  const esperado = (url: string) => url.endsWith('/api/negocio') || url.endsWith('/cobros') || url.endsWith('/api/cobros-bot/lote');
  page.on('console', (m) => m.type() === 'error' && !esperado(m.location().url) && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));
  // No se abren ventanas de verdad: se anota qué se abriría.
  await page.addInitScript(() => {
    const w = window as unknown as { __abiertos: string[] };
    w.__abiertos = [];
    window.open = (url) => (w.__abiertos.push(String(url)), {} as Window);
  });

  const { uid, prefijo } = await miTienda(page, info);
  // Tono por defecto de la tienda: Corte de quincena.
  await apiComo(page, uid, '/negocio', { metodo: 'PATCH', cuerpo: { payment_methods_info: MEDIOS, tono_cobro: 'CORTE_DE_QUINCENA' } });

  let n = 0;
  async function deudor(nombre: string, saldo: number, extra: Record<string, unknown> = {}) {
    n += 1;
    const d = await apiComo(page, uid, '/deudores', { metodo: 'POST', cuerpo: { full_name: nombre, whatsapp_phone: `+57${prefijo}${SUFIJO.slice(0, 6)}${n}`, ...extra } });
    if (saldo > 0) {
      await apiComo(page, uid, `/deudores/${d.id}/movimientos`, { metodo: 'POST', cuerpo: { request_id: `mor_${SUFIJO}_${ancho}_${n}`, type: 'FIADO', amount_cop: saldo } });
    }
    return { ...d, saldo } as { id: string; full_name: string; whatsapp_phone: string; saldo: number };
  }
  // Se crean en un orden que no es ni el alfabético ni el de antigüedad.
  const marta = await deudor('Marta Lucía Gómez', 18_500, { wa_consentimiento: true });
  const zoila = await deudor('Zoila Restrepo', 64_000, { wa_consentimiento: true });
  const andres = await deudor('Andrés Cifuentes', 42_300, { wa_consentimiento: true });
  // En mora de verdad (promesa vencida hace 10 días), sin consentimiento.
  const wilmar = await deudor('Wilmar Quiceno', 12_000, { promised_payment_date: Date.now() - 10 * DIA });
  const yeison = await deudor('Yeison Palacios', 9_000, { wa_consentimiento: true }); // fiado reciente: no está en mora
  await deudor('Ramiro Al Día', 0, { wa_consentimiento: true }); // no debe nada

  // El servidor fecha los fiados con su reloj real: para tener deudas viejas se envejece la lista que recibe la pantalla.
  const edad: Record<string, number> = { [zoila.id]: 75, [andres.id]: 48, [marta.id]: 33, [yeison.id]: 5 };
  await page.route(LISTA, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const respuesta = await route.fetch();
    const cuerpo = (await respuesta.json()) as { deudores: { id: string; oldest_unpaid_date: number | null }[] };
    for (const d of cuerpo.deudores) if (edad[d.id] !== undefined) d.oldest_unpaid_date = Date.now() - edad[d.id]! * DIA - 60_000;
    await route.fulfill({ response: respuesta, json: cuerpo });
  });

  await page.goto('/morosos');
  await expect(page.getByRole('heading', { name: 'Morosos', level: 1 })).toBeVisible();
  const filas = page.getByTestId('moroso');
  await expect(filas).toHaveCount(4);
  const orden = ['Zoila Restrepo', 'Andrés Cifuentes', 'Marta Lucía Gómez', 'Wilmar Quiceno'];
  for (const [i, nombre] of orden.entries()) await expect(filas.nth(i).getByRole('link', { name: nombre })).toBeVisible();
  await expect(filas.nth(0)).toContainText('75 días');
  await expect(filas.nth(0)).toContainText('$ 64.000');
  await expect(filas.nth(3)).toContainText('0 días');
  await expect(filas.nth(3)).toContainText('Prometió pagar');
  await expect(page.getByText('4 deudores en mora')).toBeVisible();
  await expect(page.getByText('Por cobrar $ 136.800')).toBeVisible();
  await sinDesborde(page);
  await captura(page, `morosos-${ancho}`);

  /**
   * Cobra con `tono` y comprueba el enlace abierto. Si el reloj real cae fuera del horario de cobro, el servidor
   * respondería 409: en ese caso se simula su respuesta con la misma plantilla fija (src/shared/cobro.ts).
   */
  async function cobrarCon(fila: number, d: { id: string; full_name: string; whatsapp_phone: string; saldo: number }, tono: Tono | null, nombreTono: string, frase: string) {
    const esperado = textoDeCobro((tono ?? 'CORTE_DE_QUINCENA') as Tono, { tienda: TIENDA, nombre: d.full_name, saldo_cop: d.saldo, medios_de_pago: MEDIOS });
    const tonos: string[] = [];
    await page.route(`**/api/deudores/${d.id}/cobros`, async (route) => {
      tonos.push(route.request().postDataJSON().tono);
      const real = await route.fetch();
      if (real.ok()) return route.fulfill({ response: real });
      const cuerpo = await real.json();
      expect(['DOMINGO', 'FESTIVO', 'FUERA_DE_HORARIO']).toContain(cuerpo.motivo);
      info.annotations.push({ type: 'cobro simulado', description: `${d.full_name}: el servidor respondió ${cuerpo.motivo}` });
      await route.fulfill({ json: { texto: esperado, url: enlaceWhatsApp(d.whatsapp_phone, esperado), last_reminder_sent_at: Date.now() } });
    });
    const f = filas.nth(fila);
    await f.getByRole('button', { name: `Cobrar a ${d.full_name}` }).click();
    if (tono) await f.getByText(nombreTono, { exact: true }).click();
    await expect(f.getByRole('radio', { name: nombreTono })).toBeChecked();
    await expect(f.getByTestId('mensaje-cobro')).toHaveText(esperado);
    await expect(f.getByTestId('mensaje-cobro')).toContainText(frase);
    const antes = (await abiertos(page)).length;
    await f.getByRole('button', { name: 'Abrir WhatsApp' }).click();
    await expect(f.getByText('Mensaje listo en tu WhatsApp')).toBeVisible();
    const lista = await abiertos(page);
    expect(lista).toHaveLength(antes + 1);
    expect(lista.at(-1)).toBe(`https://wa.me/${d.whatsapp_phone.slice(1)}?text=${encodeURIComponent(esperado)}`);
    expect(tonos).toEqual([tono ?? 'CORTE_DE_QUINCENA']);
  }

  // Tono por defecto de la tienda, sin tocar nada.
  await cobrarCon(1, andres, null, 'Corte de quincena', 'Llegó la quincena');
  await cobrarCon(0, zoila, 'VECINO_AMIGABLE', 'Vecino amigable', 'Le recordamos con mucho gusto');

  // Fuera de horario (simulado: el reloj del servidor es el real): no abre nada y explica por qué.
  const mensajeHorario = 'Estás fuera del horario de cobro: lunes a viernes de 7:00 a 19:00 y sábados de 8:00 a 15:00.';
  await page.route(`**/api/deudores/${marta.id}/cobros`, (route) =>
    route.fulfill({ status: 409, json: { error: 'contacto_bloqueado', motivo: 'FUERA_DE_HORARIO', mensaje: mensajeHorario } }),
  );
  const filaMarta = filas.nth(2);
  await filaMarta.getByRole('button', { name: 'Cobrar a Marta Lucía Gómez' }).click();
  const antes = (await abiertos(page)).length;
  await filaMarta.getByRole('button', { name: 'Abrir WhatsApp' }).click();
  await expect(filaMarta.getByRole('alert')).toContainText('Fuera del horario de cobro');
  await expect(filaMarta.getByRole('alert')).toContainText(mensajeHorario);
  expect(await abiertos(page)).toHaveLength(antes);
  await sinDesborde(page);
  if (ancho === 360) await captura(page, 'morosos-bloqueado-360');
  await page.unroute(`**/api/deudores/${marta.id}/cobros`);

  await filaMarta.getByRole('button', { name: 'Cancelar' }).click();
  await cobrarCon(2, marta, 'AVISO_FIRME', 'Aviso firme', 'ya pasó el plazo acordado');

  // Sin consentimiento (servidor real: se comprueba antes que el horario): no abre nada y explica por qué.
  const filaWilmar = filas.nth(3);
  await filaWilmar.getByRole('button', { name: 'Cobrar a Wilmar Quiceno' }).click();
  await filaWilmar.getByRole('button', { name: 'Abrir WhatsApp' }).click();
  await expect(filaWilmar.getByRole('alert')).toContainText('Falta su autorización');
  await expect(filaWilmar.getByRole('alert')).toContainText('no ha autorizado que le escriban por WhatsApp');
  expect(await abiertos(page)).toHaveLength(3);

  // WAP-03: «Enviar con el bot» a un deudor en mora con consentimiento. Con WHATSAPP_SEND_READY apagado va al simulador
  // y la pantalla lo dice. Si el reloj real cae fuera del horario de cobro, el servidor responde 409 y se simula su respuesta.
  const hernan = await deudor('Hernán Ospina', 15_000, { wa_consentimiento: true, promised_payment_date: Date.now() - 3 * DIA });
  const pedidosBot: { tono: string; request_id: string }[] = [];
  await page.route(`**/api/cobros-bot/${hernan.id}`, async (route) => {
    pedidosBot.push(route.request().postDataJSON());
    const real = await route.fetch();
    if (real.ok()) return route.fulfill({ response: real });
    const cuerpo = await real.json();
    expect(['DOMINGO', 'FESTIVO', 'FUERA_DE_HORARIO']).toContain(cuerpo.motivo);
    info.annotations.push({ type: 'cobro por bot simulado', description: `${hernan.full_name}: el servidor respondió ${cuerpo.motivo}` });
    await route.fulfill({ json: { estado: 'enviado', simulado: true, last_reminder_sent_at: Date.now() } });
  });
  await page.reload();
  await expect(filas).toHaveCount(5);
  const filaHernan = filas.filter({ hasText: 'Hernán Ospina' });
  await filaHernan.getByRole('button', { name: 'Cobrar a Hernán Ospina' }).click();
  if (ancho === 360) await captura(page, 'morosos-bot-panel-360');
  const antesBot = (await abiertos(page)).length;
  await filaHernan.getByRole('button', { name: 'Enviar con el bot (simulado)' }).click();
  await expect(filaHernan.getByRole('status')).toContainText('Enviado (simulado)');
  await expect(filaHernan.getByRole('status')).toContainText('a Hernán Ospina no le llegó nada');
  expect(await abiertos(page)).toHaveLength(antesBot); // el bot no abre el WhatsApp del tendero
  expect(pedidosBot).toEqual([{ tono: 'CORTE_DE_QUINCENA', request_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/) }]);
  await sinDesborde(page);
  if (ancho === 360) await captura(page, 'morosos-bot-360');
  await page.unroute(`**/api/cobros-bot/${hernan.id}`);

  // WAP-07: cobro masivo por el bot con dos deudores más en mora (promesa vencida) y con consentimiento: 7 elegidos, que la
  // pantalla envía en dos tandas (6 + 1). El servidor es el real: si el reloj cae fuera del horario de cobro, el resumen
  // lo dice (todos fuera por horario) y se acepta así. La segunda tanda se corta una vez (sin red) y se reintenta.
  await deudor('Gloria Pérez', 21_000, { wa_consentimiento: true, promised_payment_date: Date.now() - 2 * DIA });
  await deudor('Óscar Mejía', 7_500, { wa_consentimiento: true, promised_payment_date: Date.now() - 4 * DIA });
  await page.reload();
  await expect(filas).toHaveCount(7);
  await page.getByRole('button', { name: 'Cobrar a varios con el bot (simulado)' }).click();
  await page.getByRole('button', { name: 'Elegir a todos los de la lista (7)' }).click();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(7);
  await expect(page.getByText('7 elegidos')).toBeVisible();
  // Tono por defecto de la tienda; la vista previa es la plantilla fija con el primero de la lista (el más antiguo).
  await expect(page.getByRole('radio', { name: 'Corte de quincena' })).toBeChecked();
  const previa = page.getByTestId('previa-masivo');
  await expect(previa).toHaveText(textoDeCobro('CORTE_DE_QUINCENA', { tienda: TIENDA, nombre: zoila.full_name, saldo_cop: zoila.saldo, medios_de_pago: MEDIOS }));
  await page.getByRole('radio', { name: 'Aviso firme' }).check();
  await expect(previa).toHaveText(textoDeCobro('AVISO_FIRME', { tienda: TIENDA, nombre: zoila.full_name, saldo_cop: zoila.saldo, medios_de_pago: MEDIOS }));
  await page.getByRole('button', { name: 'Revisar y enviar' }).click();
  await expect(page.getByText('Vas a enviar 7 cobros por el bot; gasta hasta 7 de tu cuota')).toBeVisible();
  await sinDesborde(page);
  await captura(page, `morosos-lote-${ancho}`);

  type Resumen = { simulado: boolean; enviados: number; sin_confirmar: number; fuera: Record<string, number> };
  const pedidosLote: { tono: string; request_id: string; deudores: string[] }[] = [];
  const resumenes: Resumen[] = [];
  let cortarSegunda = true;
  let soltar = () => {};
  const retenida = new Promise<void>((r) => (soltar = r));
  await page.route('**/api/cobros-bot/lote', async (route) => {
    const pedido = route.request().postDataJSON();
    pedidosLote.push(pedido);
    if (pedido.request_id.endsWith('-t2')) {
      if (cortarSegunda) return (cortarSegunda = false), route.abort('internetdisconnected');
      await retenida; // el reintento espera, para ver la barra de progreso
    }
    const real = await route.fetch();
    resumenes.push((await real.json()) as Resumen);
    await route.fulfill({ response: real });
  });

  // Primera tanda (6) sale; la segunda se corta: se ve lo enviado hasta ahí y el botón para seguir.
  await page.getByRole('button', { name: 'Sí, enviar 7 cobros' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No hay conexión' })).toBeVisible();
  expect(resumenes).toHaveLength(1);
  const fueraDe = (r: Resumen) => Object.values(r.fuera).reduce((a, b) => a + b, 0);
  await expect(page.getByRole('status').filter({ hasText: `Hasta ahora: Enviados ${resumenes[0]!.enviados} · Fuera ${fueraDe(resumenes[0]!)}` })).toBeVisible();

  // Reintento: la segunda tanda va con el MISMO request_id y se ve el progreso mientras responde.
  await page.getByRole('button', { name: 'Seguir con el que falta' }).click();
  await expect(page.getByText('Enviando 7 de 7…')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Cobros enviados' })).toHaveAttribute('aria-valuenow', '6');
  await sinDesborde(page);
  await captura(page, `morosos-lote-progreso-${ancho}`);
  soltar();

  const avisoLote = page.getByRole('status').filter({ hasText: /^Enviados \d+ · Fuera \d+/ });
  await expect(avisoLote).toBeVisible();
  const [t1, t2, t2bis] = pedidosLote;
  expect(pedidosLote).toHaveLength(3);
  expect(t1).toMatchObject({ tono: 'AVISO_FIRME', request_id: expect.stringMatching(/^[A-Za-z0-9_-]{8,61}-t1$/) });
  expect(t1!.deudores).toHaveLength(6);
  expect(t2!.request_id).toBe(t1!.request_id.replace(/-t1$/, '-t2'));
  expect(t2bis).toEqual(t2);
  expect(new Set([...t1!.deudores, ...t2!.deudores]).size).toBe(7);

  // El resumen suma las dos tandas.
  expect(resumenes).toHaveLength(2);
  const fuera: Record<string, number> = {};
  for (const r of resumenes) for (const [m, k] of Object.entries(r.fuera)) fuera[m] = (fuera[m] ?? 0) + k;
  const resumen = { enviados: resumenes[0]!.enviados + resumenes[1]!.enviados, sin_confirmar: resumenes[0]!.sin_confirmar + resumenes[1]!.sin_confirmar, fuera };
  const horario = Object.keys(fuera).find((m) => ['DOMINGO', 'FESTIVO', 'FUERA_DE_HORARIO'].includes(m));
  if (horario) {
    info.annotations.push({ type: 'cobro masivo fuera de horario', description: `el servidor dejó fuera a 6 por ${horario}` });
    expect(resumen).toEqual({ enviados: 0, sin_confirmar: 0, fuera: { SIN_CONSENTIMIENTO: 1, [horario]: 6 } });
  } else {
    // En horario: los cuatro de antes ya se cobraron hoy y solo salen los dos nuevos.
    expect(resumen).toEqual({ enviados: 2, sin_confirmar: 0, fuera: { SIN_CONSENTIMIENTO: 1, YA_COBRADO_HOY: 4 } });
  }
  await expect(avisoLote).toHaveText(new RegExp(`^Enviados ${resumen.enviados} · Fuera ${7 - resumen.enviados}`));
  await expect(avisoLote).toContainText('1 sin autorización');
  await expect(avisoLote).toContainText(horario ? '6 ' : '4 ya cobrados hoy');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cobrar a varios con el bot (simulado)' })).toBeVisible();
  await sinDesborde(page);
  await captura(page, `morosos-lote-resumen-${ancho}`);
  await page.unroute('**/api/cobros-bot/lote');

  // Plan vencido: se ve la lista, pero Cobrar lleva a Suscripción en vez de fallar.
  await page.route('**/api/negocio', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const respuesta = await route.fetch();
    const negocio = await respuesta.json();
    await route.fulfill({ response: respuesta, json: { ...negocio, estado: 'EXPIRED_READONLY', permisos: { ver: true, escribir: false, ia: false } } });
  });
  await page.reload();
  await expect(filas).toHaveCount(7);
  await expect(filas.nth(0).getByRole('link', { name: 'Suscripción' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Cobrar a / })).toHaveCount(0); // ni uno por uno ni «Cobrar a varios»
  await page.unroute('**/api/negocio');

  // Sin nadie en mora: estado vacío que invita a actuar.
  await page.unroute(LISTA);
  await page.route(LISTA, (route) => route.fulfill({ json: { deudores: [] } }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nadie te debe con atraso' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'Ir al mostrador' })).toBeVisible();
  await sinDesborde(page);
  if (ancho === 360) await captura(page, 'morosos-vacio-360');

  expect(errores).toEqual([]);
});
