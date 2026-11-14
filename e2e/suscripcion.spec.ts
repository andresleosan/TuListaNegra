// SUS-01: ver pases y cuentas, rechazos de la captura (en el navegador y en el servidor), subir una captura válida,
// ver el pago en revisión y el rechazo de un segundo pago pendiente.
import { expect, type Page, test } from '@playwright/test';
import { formatoCOP } from '../src/shared/dinero';
import { apiComo, captura, entrar, esperarMostrador, llenarAlta, sinDesborde, SUFIJO, uidDe } from './ayudas';

/** Una tienda por proyecto, compartida con ajustes.spec.ts: la crea el primero que llega. Prefijo 315 (móvil) o 316 (escritorio). */
async function abrirTienda(pagina: Page, movil: boolean) {
  const clave = `sus_${movil ? 360 : 1280}`;
  await entrar(pagina, 'piloto@ejemplo.test', uidDe(clave));
  const alta = pagina.getByRole('heading', { name: 'Crea tu tienda' });
  const mostrador = pagina.getByRole('heading', { name: 'Mostrador', level: 1 });
  await expect(alta.or(mostrador)).toBeVisible();
  if (await alta.isVisible()) {
    await llenarAlta(pagina, 'Tienda La Esquina de Rubi', `${movil ? 315 : 316}${SUFIJO}`);
    await esperarMostrador(pagina); // espera el minuto si otros recorridos agotaron el límite de altas
  }
  await expect(mostrador).toBeVisible();
  return clave;
}

// `.dev.vars` no trae PAYMENT_ACCOUNTS_JSON: las cuentas se simulan en la respuesta de GET /api/suscripcion.
const CUENTAS = [{ banco: 'Banco de prueba', tipo: 'Ahorros', numero: '000-000000-00', titular: 'Titular ficticio' }];

// PNG mínimo de 1×1 (firma + IHDR + IDAT + IEND).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * Simula cuentas y, si `sinPendiente`, que la pantalla no vea el pago pendiente hasta que intente subir otro
 * (como si lo hubiera enviado otro celular). En desarrollo React pide dos veces al montar: por eso no basta «la primera».
 */
async function simularCuentas(pagina: Page, sinPendiente = false) {
  let subio = false;
  await pagina.unroute('**/api/suscripcion');
  await pagina.unroute('**/api/suscripcion/pagos');
  await pagina.route('**/api/suscripcion/pagos', (ruta) => {
    subio = true;
    return ruta.fallback();
  });
  await pagina.route('**/api/suscripcion', async (ruta) => {
    const respuesta = await ruta.fetch();
    const cuerpo = await respuesta.json();
    if (sinPendiente && !subio) cuerpo.pago_pendiente = null;
    await ruta.fulfill({ response: respuesta, json: { ...cuerpo, cuentas: CUENTAS } });
  });
}

test('pases, cuentas, rechazos de la captura, pago en revisión y segundo pago rechazado', async ({ page }, info) => {
  const ancho = page.viewportSize()!.width;
  const movil = info.project.name === 'movil-360';
  const errores: string[] = [];
  // Esperados: los rechazos de la subida (400 y 409) y el 404 `sin_negocio` de /api/negocio si esta spec crea la tienda.
  const esperado = (url: string) => url.includes('/api/suscripcion/pagos') || url.endsWith('/api/negocio');
  page.on('console', (m) => m.type() === 'error' && !esperado(m.location().url) && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  const clave = await abrirTienda(page, movil);
  const servidor = await apiComo(page, uidDe(clave), '/suscripcion');
  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Suscripción' }).click();
  await expect(page.getByRole('heading', { name: 'Suscripción', level: 1 })).toBeVisible();
  await expect(page.getByText('En prueba', { exact: true })).toBeVisible();

  // Precios y días salen del servidor.
  for (const pase of servidor.pases) {
    const opcion = page.getByRole('radio', { name: new RegExp(pase.nombre) });
    await expect(opcion).toBeVisible();
    await expect(page.locator('label', { has: opcion })).toContainText(formatoCOP(pase.precio_cop));
    await expect(page.locator('label', { has: opcion })).toContainText(`${pase.dias} días`);
  }
  // Sin cuentas configuradas se dice claro y no se ofrece subir nada.
  if (servidor.cuentas.length === 0) {
    await expect(page.getByText('Todavía no hay cuentas para pagar')).toBeVisible();
    await expect(page.getByLabel('Foto o captura del pago')).toHaveCount(0);
  }
  await sinDesborde(page);

  await simularCuentas(page);
  await page.reload();
  await expect(page.getByText('Banco de prueba')).toBeVisible();
  await expect(page.getByText('000-000000-00')).toBeVisible();

  // Sin pase elegido: lo dice y no envía.
  const enviar = page.getByRole('button', { name: 'Enviar captura' });
  const campo = page.getByLabel('Foto o captura del pago');
  await campo.setInputFiles({ name: 'pago.png', mimeType: 'image/png', buffer: PNG });
  await enviar.click();
  await expect(page.getByText('Elige uno de los pases.')).toBeVisible();

  const [pase] = servidor.pases.slice(-1);
  await page.getByRole('radio', { name: new RegExp(pase.nombre) }).check();
  await expect(page.getByText('Elige uno de los pases.')).toHaveCount(0);
  await expect(page.getByText(`Transfiere exactamente ${formatoCOP(pase.precio_cop)}`)).toBeVisible();
  await sinDesborde(page);
  await captura(page, `suscripcion-${ancho}`);

  // Rechazos en el navegador, antes de subir.
  await campo.setInputFiles({ name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('no soy una foto') });
  await expect(page.getByText('Ese archivo no es una foto. Sube la captura en JPG, PNG o WebP.')).toBeVisible();
  await campo.setInputFiles({ name: 'grande.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]) });
  await expect(page.getByText(/La foto pesa 2,0 MB y el máximo es 2 MB/)).toBeVisible();
  await sinDesborde(page);
  if (movil) await captura(page, 'suscripcion-error-360');

  // Un texto con nombre de imagen pasa el navegador, pero el servidor mira los bytes: 400 traducido junto al campo.
  await campo.setInputFiles({ name: 'falsa.png', mimeType: 'image/png', buffer: Buffer.from('tampoco soy una foto') });
  await enviar.click();
  await expect(page.getByText('No pudimos leer esa imagen. Sube una captura en JPG, PNG o WebP.')).toBeVisible();
  await expect(campo).toBeFocused();

  // Captura válida → pago en revisión.
  await campo.setInputFiles({ name: 'pago.png', mimeType: 'image/png', buffer: PNG });
  await enviar.click();
  await expect(page.getByText('Lo estamos revisando')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Lo estamos revisando' })).toContainText(formatoCOP(pase.precio_cop));
  await expect(campo).toHaveCount(0);
  expect((await apiComo(page, uidDe(clave), '/suscripcion')).pago_pendiente).toMatchObject({ plan: pase.id, amount_cop: pase.precio_cop });
  await sinDesborde(page);
  if (movil) await captura(page, 'suscripcion-pendiente-360');

  // Segundo pago con la pantalla desactualizada (como desde otro celular): el servidor responde 409 y se explica.
  await simularCuentas(page, true);
  await page.reload();
  await page.getByRole('radio', { name: new RegExp(servidor.pases[0].nombre) }).check();
  await campo.setInputFiles({ name: 'otro.png', mimeType: 'image/png', buffer: PNG });
  await enviar.click();
  await expect(page.getByText('solo puede haber un pago en revisión a la vez')).toBeVisible();
  await expect(page.getByText('Lo estamos revisando')).toBeVisible();
  // Sigue el primero: el segundo no se guardó.
  expect((await apiComo(page, uidDe(clave), '/suscripcion')).pago_pendiente).toMatchObject({ plan: pase.id });
  await sinDesborde(page);

  expect(errores).toEqual([]);
});
