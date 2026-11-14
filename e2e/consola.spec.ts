// SUP-01..04: consola del superadministrador contra el simulador local de identidad.
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, test } from '@playwright/test';
import { captura, entrar, sinDesborde, SUFIJO, tiendaNueva, tokenComo, uidDe, whatsappEntrante } from './ayudas';

/** PNG válido en escala de grises con renglones negros, para que la captura se vea como un comprobante. */
function pngDePrueba(ancho = 120, alto = 200): Buffer {
  const trozo = (tipo: string, datos: Buffer) => {
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
    const largo = Buffer.alloc(4);
    largo.writeUInt32BE(datos.length);
    const suma = Buffer.alloc(4);
    suma.writeUInt32BE(crc32(cuerpo));
    return Buffer.concat([largo, cuerpo, suma]);
  };
  const cabecera = Buffer.alloc(13);
  cabecera.writeUInt32BE(ancho, 0);
  cabecera.writeUInt32BE(alto, 4);
  cabecera[8] = 8; // 8 bits por muestra, escala de grises (tipo 0), sin entrelazado
  const filas = Buffer.alloc((ancho + 1) * alto, 0xff);
  for (let y = 0; y < alto; y++) {
    filas[y * (ancho + 1)] = 0; // filtro «ninguno»
    if (y % 24 >= 20) filas.fill(0x14, y * (ancho + 1) + 11, y * (ancho + 1) + 1 + ancho - 10);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), trozo('IHDR', cabecera), trozo('IDAT', deflateSync(filas)), trozo('IEND', Buffer.alloc(0))]);
}

/** La tienda sube su captura por la API (multipart), como lo haría su pantalla de Suscripción. */
async function subirPago(pagina: Page, uid: string) {
  const respuesta = await pagina.request.fetch('/api/suscripcion/pagos', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenComo(pagina, uid)}` },
    multipart: { plan: 'PASS_15D', captura: { name: 'pago.png', mimeType: 'image/png', buffer: pngDePrueba() } },
  });
  expect(respuesta.status(), await respuesta.text()).toBe(201);
}

// Errores de consola esperados: el 404 `sin_negocio` (el administrador no tiene tienda), el 403 de la consola a un tendero
// y el 409 de la prueba del puente mientras el administrador no tiene WhatsApp verificado.
const ESPERADOS = ['/api/negocio', '/api/superadmin/yo', '/api/superadmin/puente/prueba'];

/** Llama a la API como el superadministrador (sesión de Google con su correo). */
async function comoAdmin<T = any>(pagina: Page, uid: string, ruta: string, metodo = 'GET', cuerpo?: unknown): Promise<T> {
  const pedir = async () => pagina.request.fetch(`/api${ruta}`, { method: metodo, headers: { Authorization: `Bearer ${await tokenComo(pagina, uid, 'admin@ejemplo.test')}` }, data: cuerpo });
  let respuesta = await pedir();
  // El alta tiene límite real de 5 por minuto; al correr todos los recorridos juntos se alcanza: se espera el minuto, una vez.
  if (respuesta.status() === 429 && ruta === '/negocio' && metodo === 'POST') {
    test.info().setTimeout(test.info().timeout + 75_000);
    await pagina.waitForTimeout(61_000);
    respuesta = await pedir();
  }
  expect(respuesta.ok(), `${metodo} /api${ruta} → ${respuesta.status()} ${await respuesta.text()}`).toBe(true);
  return (await respuesta.json()) as T;
}

test('consola: bandeja de pagos, negocios e indicadores; un tendero no entra', async ({ page }) => {
  const ancho = page.viewportSize()!.width;
  const tienda = `Tienda Consola ${SUFIJO} ${ancho}`;
  const uidTienda = uidDe(`con${ancho}`);
  const errores: string[] = [];
  page.on('console', (m) => m.type() === 'error' && !ESPERADOS.some((r) => m.location().url.endsWith(r)) && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  // Un tendero (piloto) con tienda abre /superadmin: no tiene acceso.
  await tiendaNueva(page, `con${ancho}`, ancho === 360 ? '317' : '318', tienda);
  await page.goto('/superadmin');
  await expect(page.getByRole('heading', { name: 'No tienes acceso', level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Consola' })).toHaveCount(0);
  await sinDesborde(page);
  await page.getByRole('button', { name: 'Salir' }).click();

  await subirPago(page, uidTienda);

  // El superadministrador entra con Google.
  await entrar(page, 'admin@ejemplo.test', `e2e_${SUFIJO}_admin${ancho}`);
  await expect(page.getByRole('heading', { name: 'Crea tu tienda' })).toBeVisible();
  await page.goto('/superadmin');
  await expect(page.getByRole('heading', { name: 'Pagos por revisar', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/superadmin\/pagos$/);
  const nav = page.getByRole('navigation', { name: 'Consola' });
  await expect(nav.getByRole('link', { name: 'Pagos' })).toHaveAttribute('aria-current', 'page');

  // La fila de la tienda: pase, monto esperado y lectura (sin OCR en local).
  const fila = page.getByRole('listitem').filter({ hasText: tienda });
  await expect(fila).toHaveCount(1);
  await expect(fila).toContainText('Pase de 15 días');
  await expect(fila).toContainText('$ 27.900');
  await expect(fila).toContainText('Sin lectura automática');

  // Ver la captura: llega con la sesión y se pinta.
  await fila.getByRole('button', { name: 'Ver captura' }).click();
  const imagen = fila.getByRole('img', { name: `Captura del pago de ${tienda}` });
  await expect(imagen).toBeVisible();
  expect(await imagen.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(120);
  expect(await imagen.getAttribute('src')).toMatch(/^blob:/);
  await sinDesborde(page);
  await captura(page, `consola-pagos-${ancho}`);

  // Rechazar sin motivo: error junto al campo, sin llamar al servidor. Con motivo: sale de la bandeja.
  await fila.getByRole('button', { name: 'Rechazar' }).click();
  await fila.getByRole('button', { name: 'Sí, rechazar' }).click();
  await expect(fila.getByText('Escribe el motivo (mínimo 3 letras).', { exact: false })).toBeVisible();
  await expect(fila.getByLabel('Motivo del rechazo')).toBeFocused();
  await sinDesborde(page);
  await fila.getByLabel('Motivo del rechazo').fill('El pago no aparece en la cuenta');
  await fila.getByRole('button', { name: 'Sí, rechazar' }).click();
  await expect(fila).toHaveCount(0);
  await expect(page.getByText(`Rechazado: ${tienda} verá el motivo`)).toBeVisible();

  // Tras el rechazo sube otra captura; esta se aprueba.
  await subirPago(page, uidTienda);
  await page.reload();
  await expect(fila).toHaveCount(1);
  await fila.getByRole('button', { name: 'Aprobar' }).click();
  await fila.getByRole('button', { name: 'Sí, aprobar' }).click();
  await expect(fila).toHaveCount(0);
  await expect(page.getByText(`Aprobado: ${tienda} quedó con su pase de 15 días.`)).toBeVisible();

  // Negocios: buscar la tienda, darle cortesía y marcarla gratis.
  await nav.getByRole('link', { name: 'Negocios' }).click();
  await expect(page.getByRole('heading', { name: 'Negocios', level: 1 })).toBeVisible();
  await page.getByLabel('Buscar negocio').fill(tienda);
  await page.getByRole('button', { name: 'Buscar' }).click();
  await expect(page.getByText(`1 negocio con «${tienda}»`)).toBeVisible();
  const negocio = page.getByRole('listitem').filter({ hasText: tienda });
  await expect(negocio).toContainText('Activo');
  await expect(negocio).toContainText('Pase de 15 días');
  const venceAntes = await negocio.getByText(/^Vence /).textContent();

  await negocio.getByRole('button', { name: '+7 días de cortesía' }).click();
  await negocio.getByRole('button', { name: 'Sí, dar 7 días' }).click();
  await expect(negocio.getByText('Escribe el motivo (mínimo 3 letras).', { exact: false })).toBeVisible();
  await negocio.getByLabel('Motivo').fill('Compensación por caída');
  await negocio.getByRole('button', { name: 'Sí, dar 7 días' }).click();
  await expect(negocio.getByText(`${tienda} recibió 7 días de cortesía.`)).toBeVisible();
  await expect(negocio.getByText(/^Vence /)).not.toHaveText(venceAntes!);

  await negocio.getByRole('button', { name: 'Marcar gratis' }).click();
  await negocio.getByLabel('Motivo').fill('Tienda aliada del piloto');
  await negocio.getByRole('button', { name: 'Sí, marcar gratis' }).click();
  await expect(negocio.getByText(`${tienda} quedó gratis sin vencimiento.`)).toBeVisible();
  await expect(negocio.locator('.sello')).toHaveText(['Activo', 'Gratis']);
  await expect(negocio).toContainText('Sin vencimiento');
  await expect(negocio.getByRole('button', { name: 'Quitar gratis' })).toBeVisible();
  await sinDesborde(page);
  await captura(page, `consola-negocios-${ancho}`);

  // Indicadores: cifras en pantalla, con los gratis aparte.
  await nav.getByRole('link', { name: 'Indicadores' }).click();
  await expect(page.getByRole('heading', { name: 'Indicadores', level: 1 })).toBeVisible();
  const ingresos = page.getByRole('region', { name: 'Ingresos confirmados del mes' });
  await expect(ingresos).toContainText(/\$ \d{1,3}(\.\d{3})*/);
  const estados = page.getByRole('region', { name: 'Negocios por estado' });
  await expect(estados.getByRole('definition').last()).toHaveText(/^\d+(\.\d{3})*$/);
  await expect(estados).toContainText('no suman ingresos');
  await expect(page.getByRole('region', { name: 'Conversión de prueba a pago' })).toContainText(/\d+(,\d)? %/);
  await expect(page.getByRole('region', { name: 'Consumo de IA y WhatsApp' })).toContainText('Cobros por WhatsApp');
  await sinDesborde(page);
  await captura(page, `consola-indicadores-${ancho}`);

  // Alertas del OCR (en local no hay lectura de capturas): se simula la respuesta de la bandeja.
  await page.route('**/api/superadmin/pagos', (ruta) =>
    ruta.fulfill({
      json: {
        pagos: [{
          id: 'pay_simulado', business_id: 'bus_simulado', negocio: 'Tienda Simulada', owner_email: 'piloto@ejemplo.test', plan_requested: 'PASS_15D', days_to_add: 15,
          amount_cop: 27_900, receipt_r2_key: 'negocios/bus_simulado/pagos/pay_simulado.png', ocr_extracted_amount: 2_790, ocr_reference_number: 'REF-777',
          grace_started_at: Date.now(), status: 'PENDING_REVIEW', created_at: Date.now(), monto_no_coincide: true, referencia_repetida: true,
        }],
      },
    }),
  );
  await nav.getByRole('link', { name: 'Pagos' }).click();
  const alertas = page.getByRole('list', { name: 'Alertas' });
  await expect(alertas).toContainText('Monto distinto: se leyó $ 2.790 y el pase cuesta $ 27.900.');
  await expect(alertas).toContainText('Referencia repetida: ese número ya apareció en otro pago.');
  await expect(page.getByRole('listitem').filter({ hasText: 'Tienda Simulada' })).toContainText('REF-777');
  await sinDesborde(page);
  await captura(page, `consola-pagos-alertas-${ancho}`);
  await page.unroute('**/api/superadmin/pagos');

  // Puente de WhatsApp (WAP-08). Sin tienda verificada, la prueba no sale y se explica cómo verificar.
  await nav.getByRole('link', { name: 'Puente' }).click();
  await expect(page.getByRole('heading', { name: 'Puente de WhatsApp', level: 1 })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Puente' })).toHaveAttribute('aria-current', 'page');
  const prueba = page.getByRole('region', { name: 'Envío de prueba' });
  await prueba.getByRole('button', { name: 'Enviar prueba a mi WhatsApp' }).click();
  await expect(prueba.getByText('No tienes un WhatsApp verificado')).toBeVisible();
  await expect(prueba).toContainText('genera el código y envíalo por WhatsApp desde ese número');
  await sinDesborde(page);

  // El administrador crea su tienda y verifica su número con el flujo real de WAP-02: el código llega FIRMADO al webhook.
  const uidAdmin = `e2e_${SUFIJO}_admin${ancho}`;
  const telAdmin = `+57${ancho === 360 ? 340 : 341}${SUFIJO}`;
  await comoAdmin(page, uidAdmin, '/negocio', 'POST', { name: `Tienda Admin ${ancho}`, whatsapp_phone: telAdmin, acepta_terminos: true });
  const { codigo } = await comoAdmin<{ codigo: string }>(page, uidAdmin, '/negocio/whatsapp/codigo', 'POST', {});
  await whatsappEntrante(page, telAdmin, codigo);
  await expect.poll(async () => (await comoAdmin(page, uidAdmin, '/negocio')).whatsapp_verificado_en).not.toBeNull();

  // Salud y último evento firmado (el código que acaba de llegar).
  await page.getByRole('button', { name: 'Actualizar' }).click();
  const salud = page.getByRole('region', { name: 'Salud del webhook' });
  // La salud mira todo el tráfico de 24 h, también el de otros recorridos que comparten esta base (p. ej. tirillas con la
  // ventana cerrada, que salen rechazadas): aquí solo se exige un estado con eventos; las reglas las prueba puente.test.ts.
  await expect(salud.locator('.sello')).toHaveText(/^(Funciona|Revisar)$/);
  await expect(salud).toContainText('Apagado · simulador');
  const evento = page.getByRole('region', { name: 'Último evento firmado' });
  await expect(evento.locator('.consola__fecha')).toHaveText(/\d{4}, \d{2}:\d{2}$/);
  await expect(evento).toContainText('Un mensaje que llegó por WhatsApp.');
  await expect(page.getByRole('region', { name: 'Últimas 24 horas' }).getByRole('definition').first()).toHaveText(/^[1-9]\d*$/);

  // Ahora sí: la prueba sale (al simulador) y queda como último envío.
  await prueba.getByRole('button', { name: 'Enviar prueba a mi WhatsApp' }).click();
  await expect(prueba.getByText('Prueba enviada al simulador')).toBeVisible();
  await expect(evento).toContainText('Aceptados');
  await sinDesborde(page);
  await captura(page, `consola-puente-${ancho}`);

  // Ni tokens ni datos de negocios en el almacenamiento persistente del navegador.
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  expect(errores).toEqual([]);
});
