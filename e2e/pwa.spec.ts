// MOS-05: PWA instalable. Manifest e iconos, service worker activo tras la primera carga, abrir sin red y buscar
// en la copia local; al salir no queda ni la copia ni el negocio guardado.
import { expect, type Page, test } from '@playwright/test';
import { apiComo, captura, sinDesborde, tiendaNueva, tokenComo, uidDe } from './ayudas';

const lista = (pagina: Page) => pagina.getByRole('list', { name: 'Deudores' });
const nombresDeBases = (pagina: Page) => pagina.evaluate(async () => (await indexedDB.databases()).map((b) => b.name));
/** Claves guardadas en la copia local (`tln-cartera`) y la cuenta a la que pertenece cada una. */
const copiaLocal = (pagina: Page) =>
  pagina.evaluate(
    () =>
      new Promise<Record<string, string>>((resolver, fallar) => {
        const pedido = indexedDB.open('tln-cartera');
        pedido.onerror = () => fallar(pedido.error);
        pedido.onsuccess = () => {
          const almacen = pedido.result.transaction('copia').objectStore('copia');
          const claves = almacen.getAllKeys();
          const valores = almacen.getAll();
          valores.onsuccess = () => {
            pedido.result.close();
            resolver(Object.fromEntries((claves.result as string[]).map((c, i) => [c, (valores.result[i] as { uid: string }).uid])));
          };
        };
      }),
  );

test('pwa: manifest, service worker, abre sin red y busca; salir borra la copia', async ({ page, context }, info) => {
  const ancho = page.viewportSize()!.width;
  const clave = `pwa${ancho}`;
  const uid = uidDe(clave);
  // Sin red los fallos de carga son lo esperado; se vigilan los errores de consola solo con red.
  let conRed = true;
  const errores: string[] = [];
  page.on('console', (m) => conRed && m.type() === 'error' && !m.location().url.endsWith('/api/negocio') && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  // Instalable: el manifest se sirve, está completo y sus iconos existen.
  const respuesta = await page.request.get('/manifest.webmanifest');
  expect(respuesta.status()).toBe(200);
  const manifest = (await respuesta.json()) as { name: string; short_name: string; start_url: string; display: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };
  expect(manifest).toMatchObject({ name: 'TuListaNegra', short_name: 'TuListaNegra', start_url: '/', display: 'standalone', background_color: '#F6F4EE' });
  for (const [tamano, uso] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) {
    expect(manifest.icons.some((i) => i.sizes === tamano && i.purpose === uso && i.type === 'image/png'), `icono ${tamano} ${uso}`).toBe(true);
  }
  for (const icono of manifest.icons) {
    const archivo = await page.request.get(icono.src);
    expect(archivo.status(), icono.src).toBe(200);
    expect(archivo.headers()['content-type']).toBe('image/png');
  }

  // En desarrollo el service worker solo se registra si se pide (src/web/main.tsx); en producción, siempre.
  await page.addInitScript(() => localStorage.setItem('tln-sw', '1'));
  await tiendaNueva(page, clave, info.project.name === 'movil-360' ? '322' : '323');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#F6F4EE');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe('activated');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  // Chrome mismo dice si la app se puede instalar (manifest, iconos, service worker): ninguna objeción, salvo
  // «in-incognito», que viene del navegador de pruebas (Playwright abre contextos de incógnito), no de la app.
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito')).toEqual([]);

  // Deudores sembrados por la API (datos ficticios). Se traen navegando dentro de la app: no hay segunda carga.
  const crear = (cuerpo: object) => apiComo<{ id: string }>(page, uid, '/deudores', { metodo: 'POST', cuerpo });
  const wilmar = await crear({ full_name: 'Wilmar Quiceno', alias_reference: 'el mono de la moto' });
  await apiComo(page, uid, `/deudores/${wilmar.id}/movimientos`, { metodo: 'POST', cuerpo: { request_id: `semilla-${wilmar.id}`, type: 'FIADO', amount_cop: 12_000 } });
  await crear({ full_name: 'Rubiela Zapata', alias_reference: 'doña Rubi' });
  await crear({ full_name: 'Édinson Mosquera', alias_reference: 'el primo de Yeison' });
  await page.getByRole('link', { name: 'Morosos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Morosos', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Mostrador', exact: true }).click();
  await expect(page.getByText('3 deudores en tu libro')).toBeVisible();
  // La copia de la cartera y el último negocio quedan guardados, ligados a esta cuenta.
  await expect.poll(() => copiaLocal(page)).toEqual({ actual: uid, negocio: uid });

  // Sin red, desde cero: el worker sirve el esqueleto y la app abre con el último negocio y la copia local.
  // El simulador de desarrollo pide su token a Vite incluso al recuperar la sesión; Firebase, en producción, la
  // recupera de su IndexedDB sin red. Aquí se le da el token emitido antes del corte, solo a `/__dev/token`:
  // la API (`/api/*`) sigue sin red y nada llega al servidor.
  const token = await tokenComo(page, uid);
  await page.route('**/__dev/token', (ruta) => ruta.fulfill(ruta.request().method() === 'POST' ? { json: { token } } : { status: 204 }));
  conRed = false;
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mostrador', level: 1 })).toBeVisible();
  await expect(page.getByText('Sin conexión', { exact: true })).toBeVisible();
  await expect(page.getByText(/Estás viendo la copia de las .+; no puedes fiar ni abonar hasta que vuelva\./)).toBeVisible();
  await expect(page.getByText('Tienda La Esquina de Rubi')).toBeVisible();
  await page.getByLabel('Buscar en tu libro').fill('moto');
  await expect(lista(page).getByRole('listitem')).toHaveCount(1);
  await expect(lista(page)).toContainText('Wilmar Quiceno');
  await expect(lista(page)).toContainText('$ 12.000');
  // Sin red no se escribe: ni fiar, ni abonar, ni anotar deudores.
  await expect(lista(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Nuevo deudor/ })).toHaveCount(0);
  await sinDesborde(page);
  await captura(page, `pwa-sin-conexion-${ancho}`);

  // Vuelve la red: la app trae el negocio y la lista del servidor sin recargar, y el aviso se va. Chromium emulado no
  // da el evento `online` a una página que se abrió sin red; se da a mano el aviso que en el teléfono da el sistema.
  await page.unroute('**/__dev/token');
  await context.setOffline(false);
  conRed = true;
  const negocioFresco = page.waitForResponse((r) => r.url().endsWith('/api/negocio') && r.ok());
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await negocioFresco;
  await expect(page.getByText('Sin conexión', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Nuevo deudor/ })).toBeVisible();
  // Al salir no queda en el navegador ni la copia ni el negocio guardado.
  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page.getByRole('heading', { name: 'Simulador local de ingreso (solo desarrollo)' })).toBeVisible();
  await expect.poll(() => nombresDeBases(page)).not.toContain('tln-cartera');

  expect(errores).toEqual([]);
});
