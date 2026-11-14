// MOS-03: ficha del deudor con saldo corrido, tirilla compartible (?recibo=), edición, lista negra y archivo.
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { apiComo, captura, entrar, esperarMostrador, llenarAlta, sinDesborde, SUFIJO, uidDe } from './ayudas';

/**
 * La tienda de este recorrido. La comparte con e2e/morosos.spec.ts (mismo uid y mismo teléfono por proyecto):
 * solo hay dos prefijos de teléfono para los dos proyectos, así que la crea el primero que llegue.
 */
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

const MEDIOS = 'Nequi o efectivo en la tienda';

test('ficha: saldo corrido, recibo con tirilla, compartir, editar, lista negra y archivar', async ({ page }, info) => {
  const ancho = page.viewportSize()!.width;
  const errores: string[] = [];
  // Errores de consola esperados: el 404 `sin_negocio` antes de crear la tienda y el de la ficha que no existe, al final.
  const esperado = (url: string) => url.endsWith('/api/negocio') || url.includes('/api/deudores/deb_no_existe');
  page.on('console', (m) => m.type() === 'error' && !esperado(m.location().url) && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));
  // Sin menú del sistema (como Chrome de escritorio) y sin abrir ventanas de verdad: se anota qué se abriría.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
    const w = window as unknown as { __abiertos: string[] };
    w.__abiertos = [];
    window.open = (url) => (w.__abiertos.push(String(url)), {} as Window);
  });

  const { uid, prefijo } = await miTienda(page, info);
  await apiComo(page, uid, '/negocio', { metodo: 'PATCH', cuerpo: { payment_methods_info: MEDIOS } });
  const deudor = await apiComo(page, uid, '/deudores', {
    metodo: 'POST',
    cuerpo: { full_name: 'Carlos Arturo Peñaloza', alias_reference: 'el del taller', whatsapp_phone: `+57${prefijo}${SUFIJO}` },
  });
  const mover = async (type: string, amount_cop: number, description?: string) =>
    (await apiComo(page, uid, `/deudores/${deudor.id}/movimientos`, {
      metodo: 'POST',
      cuerpo: { request_id: `fic_${SUFIJO}_${ancho}_${amount_cop}_${type}`, type, amount_cop, description },
    })).movimiento;
  await mover('FIADO', 30_000, 'Mercado de la semana');
  const abono = await mover('ABONO', 10_000);
  await mover('FIADO', 5_000, 'Gaseosa y pan');

  // Saldo actual y saldo corrido, lo más nuevo arriba.
  await page.goto(`/deudor/${deudor.id}`);
  await expect(page.getByRole('heading', { name: 'Carlos Arturo Peñaloza', level: 1 })).toBeVisible();
  await expect(page.getByText(deudor.unique_code, { exact: true })).toBeVisible();
  await expect(page.getByTestId('saldo-actual')).toHaveText('$ 25.000');
  const filas = page.getByTestId('movimiento');
  await expect(filas).toHaveCount(3);
  await expect(filas.nth(0)).toContainText('Gaseosa y pan');
  await expect(filas.nth(0).locator('.ficha__valor')).toHaveText('$ 5.000');
  await expect(filas.nth(0).locator('.ficha__corrido')).toHaveText('Saldo $ 25.000');
  await expect(filas.nth(1)).toContainText('Abono');
  await expect(filas.nth(1).locator('.ficha__valor')).toHaveText('−$ 10.000');
  await expect(filas.nth(1).locator('.ficha__corrido')).toHaveText('Saldo $ 20.000');
  await expect(filas.nth(2)).toContainText('Mercado de la semana');
  await expect(filas.nth(2).locator('.ficha__corrido')).toHaveText('Saldo $ 30.000');
  await sinDesborde(page);
  await captura(page, `ficha-${ancho}`);

  // ?recibo= abre la tirilla de ese movimiento: código y montos en monoespaciada, medios de pago de la tienda.
  await page.goto(`/deudor/${deudor.id}?recibo=${abono.id}`);
  const recibo = page.getByRole('region', { name: 'Recibo' });
  await expect(recibo).toBeVisible();
  await expect(recibo).toContainText('Tienda Doña Rubi');
  await expect(recibo).toContainText(`Código ${deudor.unique_code}`);
  await expect(recibo.locator('.tirilla__linea').nth(0)).toHaveText(/Saldo anterior\s*\$ 30\.000/);
  await expect(recibo.locator('.tirilla__linea').nth(1)).toHaveText(/Abono\s*−\$ 10\.000/);
  await expect(recibo.locator('.tirilla__total')).toHaveText(/Total\s*\$ 20\.000/);
  await expect(recibo).toContainText(MEDIOS);
  const fuentes = await recibo.evaluate((r) =>
    [r.querySelector('.tirilla__codigo')!, ...r.querySelectorAll('.tirilla .monto')].map((n) => getComputedStyle(n).fontFamily),
  );
  expect(fuentes.length).toBe(4);
  for (const f of fuentes) expect(f).toContain('JetBrains Mono');
  await sinDesborde(page);
  if (ancho === 360) await captura(page, 'ficha-recibo-360');

  // Sin menú del sistema: abre WhatsApp (wa.me) con el texto del recibo.
  await recibo.getByRole('button', { name: 'Compartir recibo' }).click();
  const abiertos = await page.evaluate(() => (window as unknown as { __abiertos: string[] }).__abiertos);
  expect(abiertos).toHaveLength(1);
  expect(abiertos[0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
  const texto = decodeURIComponent(abiertos[0]!.split('?text=')[1]!);
  expect(texto).toContain(`Código ${deudor.unique_code}`);
  expect(texto).toContain('Saldo anterior: $ 30.000');
  expect(texto).toContain('Abono: −$ 10.000');
  expect(texto).toContain('Total: $ 20.000');
  expect(texto).toContain(`Medios de pago: ${MEDIOS}`);

  // Con menú del sistema (celular): se usa navigator.share y no se abre ninguna ventana.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'share', { value: async (d: ShareData) => void ((window as unknown as { __compartido: string }).__compartido = d.text!), configurable: true });
  });
  await recibo.getByRole('button', { name: 'Compartir recibo' }).click();
  expect(await page.evaluate(() => (window as unknown as { __compartido: string }).__compartido)).toBe(texto);
  expect(await page.evaluate(() => (window as unknown as { __abiertos: string[] }).__abiertos.length)).toBe(1);

  await recibo.getByRole('button', { name: 'Cerrar recibo' }).click();
  await expect(recibo).toHaveCount(0);
  expect(new URL(page.url()).search).toBe('');
  // Cada movimiento confirmado tiene su recibo.
  await filas.nth(0).getByRole('button', { name: /Ver recibo: Gaseosa y pan/ }).click();
  await expect(recibo.locator('.tirilla__total')).toHaveText(/Total\s*\$ 25\.000/);
  expect(new URL(page.url()).searchParams.get('recibo')).toBeTruthy();
  await recibo.getByRole('button', { name: 'Cerrar recibo' }).click();

  // Editar datos: el error dice cómo arreglarlo, junto al campo.
  await page.getByRole('button', { name: 'Editar datos' }).click();
  await page.getByLabel('WhatsApp (opcional)').fill('601 234 5678');
  await page.getByLabel('Tope de crédito (opcional)').fill('80.000');
  await page.getByLabel('Cómo lo reconoces (opcional)').fill('don Carlos el del taller');
  await page.getByRole('button', { name: 'Guardar datos' }).click();
  await expect(page.getByText('Debe ser un celular de Colombia: 10 dígitos que empiezan por 3. Ejemplo: 300 123 4567.')).toBeVisible();
  await expect(page.getByLabel('WhatsApp (opcional)')).toBeFocused();
  await page.getByLabel('WhatsApp (opcional)').fill(`${prefijo} ${SUFIJO.slice(0, 3)} ${SUFIJO.slice(3)}`);
  await page.getByRole('button', { name: 'Guardar datos' }).click();
  await expect(page.getByRole('button', { name: 'Editar datos' })).toBeVisible();
  await expect(page.getByText('don Carlos el del taller')).toBeVisible();
  await expect(page.getByText('Tope de crédito: $ 80.000')).toBeVisible();
  const guardado = await apiComo(page, uid, `/deudores/${deudor.id}`);
  expect(guardado).toMatchObject({ alias_reference: 'don Carlos el del taller', credit_limit_cop: 80_000, whatsapp_phone: `+57${prefijo}${SUFIJO}` });

  // Permiso de WhatsApp.
  await page.getByRole('button', { name: 'Registrar que autorizó' }).click();
  await expect(page.getByText(/Autorizó que le escribas por WhatsApp/)).toBeVisible();
  expect((await apiComo(page, uid, `/deudores/${deudor.id}`)).wa_consent_at).not.toBeNull();

  // Lista negra: marca privada que se pone y se quita.
  await page.getByRole('button', { name: 'Marcar en lista negra' }).click();
  await expect(page.locator('.ficha__identidad .sello')).toHaveText('Lista negra');
  await page.getByRole('button', { name: 'Quitar de la lista negra' }).click();
  await expect(page.locator('.ficha__identidad .sello')).toHaveText('Con saldo');

  // Archivar pide confirmación; se puede recuperar.
  await page.getByRole('button', { name: 'Archivar deudor' }).click();
  await expect(page.getByText('¿Archivar a Carlos Arturo Peñaloza?')).toBeVisible();
  await sinDesborde(page);
  await page.getByRole('button', { name: 'Sí, archivar' }).click();
  await expect(page.getByText('Deudor archivado')).toBeVisible();
  const lista = await apiComo<{ deudores: { id: string }[] }>(page, uid, '/deudores');
  expect(lista.deudores.map((d) => d.id)).not.toContain(deudor.id);
  await page.getByRole('button', { name: 'Recuperar deudor' }).click();
  await expect(page.getByText('Deudor archivado')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archivar deudor' })).toBeVisible();

  // Una ficha que no existe lo dice y lleva al mostrador.
  await page.goto('/deudor/deb_no_existe');
  await expect(page.getByRole('heading', { name: 'No encontramos a este deudor' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Volver al mostrador' })).toBeVisible();

  expect(errores).toEqual([]);
});
