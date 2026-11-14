// AUT-02: entrar → crear negocio → mostrador vacío con «Te quedan 3 días», contra el simulador local de identidad.
import { expect, type Page, test } from '@playwright/test';
import { captura as capturaEn, entrar as entrarSinEsperar, esperarMostrador, llenarAlta, sinDesborde, SUFIJO } from './ayudas';

async function entrar(pagina: Page, correo: string, uid: string) {
  await entrarSinEsperar(pagina, correo, uid);
  await expect(pagina.getByRole('heading', { name: 'Crea tu tienda' })).toBeVisible();
}

const captura = (pagina: Page, nombre: string) => capturaEn(pagina, `AUT-02-${nombre}`);

test('entrar → alta → mostrador vacío con «Te quedan 3 días»; recargar; salir', async ({ page }, info) => {
  const ancho = page.viewportSize()!.width;
  const movil = info.project.name === 'movil-360';
  // Mismo teléfono que usa después la prueba del teléfono repetido (solo en móvil).
  const telefono = movil ? `300${SUFIJO}` : `310${SUFIJO}`;
  const errores: string[] = [];
  // El único error de consola esperado: el 404 `sin_negocio` con el que la API dice que la cuenta aún no tiene tienda.
  page.on('console', (m) => m.type() === 'error' && !m.location().url.endsWith('/api/negocio') && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Simulador local de ingreso (solo desarrollo)' })).toBeVisible();
  await sinDesborde(page);
  if (movil) await captura(page, 'ingreso-360');

  await entrar(page, 'piloto@ejemplo.test', `e2e_${SUFIJO}_${ancho}`);
  await sinDesborde(page);

  // El formulario no deja pasar sin datos y dice cómo arreglarlo, sin llamar al servidor.
  await page.getByRole('button', { name: 'Empezar mi prueba de 3 días' }).click();
  await expect(page.getByText('Escribe el nombre de tu tienda (mínimo 2 letras).')).toBeVisible();
  await expect(page.getByLabel('Nombre de la tienda')).toBeFocused();
  await page.getByLabel('WhatsApp de la tienda').fill('601 234 5678');
  await page.getByLabel('WhatsApp de la tienda').blur();
  await expect(page.getByText('Debe ser un celular de Colombia: 10 dígitos que empiezan por 3. Ejemplo: 300 123 4567.')).toBeVisible();
  await sinDesborde(page);

  await page.getByLabel('Nombre de la tienda').fill('Tienda La Esquina de Rubi');
  await page.getByLabel('WhatsApp de la tienda').fill(`${telefono.slice(0, 3)} ${telefono.slice(3, 6)} ${telefono.slice(6)}`);
  await page.getByLabel('Acepto los términos y la política de datos').check();
  await expect(page.getByRole('alert')).toHaveCount(0);
  if (movil) await captura(page, 'alta-360');
  await page.getByRole('button', { name: 'Empezar mi prueba de 3 días' }).click();

  // Mostrador vacío con el aviso de vigencia (esperando el minuto si otros recorridos agotaron el límite de altas).
  await esperarMostrador(page);
  await expect(page.getByRole('banner')).toContainText('Tienda La Esquina de Rubi');
  await expect(page.getByRole('banner')).toContainText('Te quedan 3 días');
  await expect(page.getByRole('heading', { name: 'Tu libro está en blanco' })).toBeVisible();
  await sinDesborde(page);
  await captura(page, `mostrador-${ancho}`);

  // Las otras secciones existen y no se rompen.
  for (const seccion of ['Morosos', 'Suscripción', 'Ajustes']) {
    await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: seccion }).click();
    await expect(page.getByRole('heading', { name: seccion, level: 1 })).toBeVisible();
  }
  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Mostrador' }).click();

  // Recargar: sigue en el mostrador, no vuelve al alta.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mostrador' })).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('Te quedan 3 días');
  await expect(page.getByRole('heading', { name: 'Crea tu tienda' })).toHaveCount(0);

  // Salir: pantalla de ingreso, y recargar no devuelve la sesión.
  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page.getByRole('heading', { name: 'Simulador local de ingreso (solo desarrollo)' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Simulador local de ingreso (solo desarrollo)' })).toBeVisible();
  // Ni tokens ni datos personales en el almacenamiento del navegador.
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  expect(errores).toEqual([]);
});

test.describe('rechazos', () => {
  test.skip(({ viewport }) => viewport?.width !== 360, 'Basta comprobarlos en móvil: una ejecución hace 4 altas, por debajo del límite de 5 por minuto e IP.');

  test('otra cuenta piloto con el mismo teléfono: error visible junto al campo', async ({ page }) => {
    await entrar(page, 'piloto2@ejemplo.test', `e2e_${SUFIJO}_otra`);
    await llenarAlta(page, 'Tienda Doña Yuleidy', `+57 300${SUFIJO}`);
    await expect(page.getByText('Ese WhatsApp ya está registrado en otra tienda.')).toBeVisible();
    await expect(page.getByLabel('WhatsApp de la tienda')).toBeFocused();
    // No se pierde lo escrito ni se crea la tienda.
    await expect(page.getByLabel('Nombre de la tienda')).toHaveValue('Tienda Doña Yuleidy');
    await expect(page.getByRole('heading', { name: 'Crea tu tienda' })).toBeVisible();
    await sinDesborde(page);
  });

  test('correo que no es piloto: registro cerrado', async ({ page }) => {
    await entrar(page, 'cualquiera@ejemplo.test', `e2e_${SUFIJO}_ajeno`);
    await llenarAlta(page, 'Tienda Sin Invitación', `320${SUFIJO}`);
    await expect(page.getByText('TuListaNegra todavía no está abierta al público')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Mostrador' })).toHaveCount(0);
    await sinDesborde(page);
    // Sigue sin tienda: al recargar vuelve al alta, no al mostrador.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Crea tu tienda' })).toBeVisible();
  });
});
