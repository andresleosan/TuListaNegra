// AJU-01: cambiar medios de pago, días de alerta y tono; recargar y verlos; que lleguen a los cobros; tienda vencida.
import { expect, type Page, test } from '@playwright/test';
import { apiComo, captura, entrar, esperarMostrador, llenarAlta, sinDesborde, SUFIJO, tokenComo, uidDe } from './ayudas';

/** Una tienda por proyecto, compartida con suscripcion.spec.ts: la crea el primero que llega. Prefijo 315 (móvil) o 316 (escritorio). */
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

const MEDIOS = 'Nequi 300 999 0000 a nombre de Rubiela';

test('guardar ajustes, recargar, verlos en los cobros; vencida no cambia nada', async ({ page }, info) => {
  const ancho = page.viewportSize()!.width;
  const movil = info.project.name === 'movil-360';
  const errores: string[] = [];
  // El 403 simulado al final es esperado: el navegador lo anota en la consola.
  page.on('console', (m) => m.type() === 'error' && !m.location().url.endsWith('/api/negocio') && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  const clave = await abrirTienda(page, movil);
  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Ajustes' }).click();
  await expect(page.getByRole('heading', { name: 'Ajustes', level: 1 })).toBeVisible();

  const medios = page.getByLabel('Cómo te pueden pagar');
  const dias = page.getByLabel('Días para pasar a mora');
  const muestra = page.getByRole('complementary', { name: 'Así sale tu cobro' });
  await expect(dias).toHaveValue('30');
  await expect(page.getByRole('radio', { name: /Vecino amigable/ })).toBeChecked();
  await expect(muestra).toContainText('Puede pagar directamente en la tienda.');

  // Días fuera de rango: error junto al campo al salir de él, y guardar no llama al servidor.
  await dias.fill('0');
  await dias.blur();
  await expect(page.getByText('Escribe un número entero de días entre 1 y 365. Ejemplo: 30.')).toBeVisible();
  await page.getByRole('button', { name: 'Guardar ajustes' }).click();
  await expect(dias).toBeFocused();

  await medios.fill(MEDIOS);
  await dias.fill('7');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('radio', { name: /Corte de quincena/ }).check();
  await expect(muestra).toContainText('Llegó la quincena');
  await expect(muestra).toContainText(`Puede pagar así: ${MEDIOS}`);
  await page.getByRole('button', { name: 'Guardar ajustes' }).click();
  await expect(page.getByText('Ajustes guardados')).toBeVisible();
  await sinDesborde(page);
  await captura(page, `ajustes-${ancho}`);

  // Recargar: siguen ahí, y la API los devuelve.
  await page.reload();
  await expect(medios).toHaveValue(MEDIOS);
  await expect(dias).toHaveValue('7');
  await expect(page.getByRole('radio', { name: /Corte de quincena/ })).toBeChecked();
  expect(await apiComo(page, uidDe(clave), '/negocio')).toMatchObject({ payment_methods_info: MEDIOS, default_alert_days: 7, tono_cobro: 'CORTE_DE_QUINCENA' });

  // En los cobros: deudor con saldo, teléfono y consentimiento.
  const deudor = await apiComo(page, uidDe(clave), '/deudores', { metodo: 'POST', cuerpo: { full_name: 'don Carlos', whatsapp_phone: '+573001234567', wa_consentimiento: true } });
  await apiComo(page, uidDe(clave), `/deudores/${deudor.id}/movimientos`, { metodo: 'POST', cuerpo: { request_id: `req-${deudor.id}`, type: 'FIADO', amount_cop: 84_900 } });
  const cobro = await page.request.post(`/api/deudores/${deudor.id}/cobros`, {
    headers: { Authorization: `Bearer ${await tokenComo(page, uidDe(clave))}` },
    data: { tono: 'CORTE_DE_QUINCENA' },
  });
  const cuerpo = await cobro.json();
  if (cobro.status() === 200) {
    expect(cuerpo.texto).toContain(`Puede pagar así: ${MEDIOS}`);
    expect(cuerpo.texto).toContain('Llegó la quincena');
  } else {
    // El reloj del servidor es el real: fuera del horario de cobro (o en domingo o festivo) no se cobra.
    expect(cobro.status()).toBe(409);
    expect(['FUERA_DE_HORARIO', 'DOMINGO', 'FESTIVO']).toContain(cuerpo.motivo);
    info.annotations.push({ type: 'cobro', description: `Fuera de horario (${cuerpo.motivo}): solo se comprobó GET /api/negocio.` });
  }

  // El servidor dice que la tienda venció al guardar (403): se explica y lleva a Suscripción.
  await page.route('**/api/negocio', (ruta) =>
    ruta.request().method() === 'PATCH' ? ruta.fulfill({ status: 403, json: { error: 'acceso_denegado', estado: 'EXPIRED_READONLY' } }) : ruta.fallback(),
  );
  await dias.fill('10');
  await page.getByRole('button', { name: 'Guardar ajustes' }).click();
  await expect(page.getByText('Tu plan venció: puedes ver tus ajustes, pero no cambiarlos')).toBeVisible();
  await expect(dias).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Guardar ajustes' })).toHaveCount(0);
  await sinDesborde(page);

  // Tienda vencida desde el principio: se ve todo, nada se puede cambiar y el enlace lleva a Suscripción.
  await page.unroute('**/api/negocio');
  await page.route('**/api/negocio', async (ruta) => {
    if (ruta.request().method() !== 'GET') return ruta.fallback();
    const respuesta = await ruta.fetch();
    const negocio = await respuesta.json();
    await ruta.fulfill({ response: respuesta, json: { ...negocio, estado: 'EXPIRED_READONLY', permisos: { ver: true, escribir: false, ia: false }, vence_en: Date.now() - 3_600_000 } });
  });
  await page.reload();
  await expect(page.getByText('Tu plan venció: puedes ver tus ajustes, pero no cambiarlos')).toBeVisible();
  await expect(medios).toHaveValue(MEDIOS);
  await expect(medios).toBeDisabled();
  await expect(page.getByRole('radio', { name: /Aviso firme/ })).toBeDisabled();
  await page.getByRole('link', { name: 'Renovar mi plan' }).click();
  await expect(page.getByRole('heading', { name: 'Suscripción', level: 1 })).toBeVisible();
  await expect(page.getByText('Vencido', { exact: true })).toBeVisible();
  await sinDesborde(page);

  expect(errores).toEqual([]);
});
