// MOS-04: morosos por antigüedad, Cobrar con los tres tonos y bloqueos (sin consentimiento, fuera de horario) que no abren nada.
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
  const esperado = (url: string) => url.endsWith('/api/negocio') || url.endsWith('/cobros');
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

  // Plan vencido: se ve la lista, pero Cobrar lleva a Suscripción en vez de fallar.
  await page.route('**/api/negocio', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const respuesta = await route.fetch();
    const negocio = await respuesta.json();
    await route.fulfill({ response: respuesta, json: { ...negocio, estado: 'EXPIRED_READONLY', permisos: { ver: true, escribir: false, ia: false } } });
  });
  await page.reload();
  await expect(filas).toHaveCount(5);
  await expect(filas.nth(0).getByRole('link', { name: 'Suscripción' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Cobrar a / })).toHaveCount(0);
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
