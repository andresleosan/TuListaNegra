// MOS-01 y MOS-02: buscar en la copia local, fiar $ 5.000 en 3 toques, abonar, alerta de tope, sin conexión y solo consulta.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { apiComo, captura, sinDesborde, tiendaNueva, uidDe } from './ayudas';

const lista = (pagina: Page) => pagina.getByRole('list', { name: 'Deudores' });
const fila = (pagina: Page, texto: string) => lista(pagina).getByRole('listitem').filter({ hasText: texto });
const nombresDeBases = (pagina: Page) => pagina.evaluate(async () => (await indexedDB.databases()).map((b) => b.name));

test('mostrador: crear, buscar, fiar en 3 toques, abonar, tope, sin conexión, solo consulta y salir', async ({ page, context }, info) => {
  const ancho = page.viewportSize()!.width;
  const clave = `mos${ancho}`;
  const uid = uidDe(clave);
  const errores: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  await tiendaNueva(page, clave, info.project.name === 'movil-360' ? '311' : '312');

  // Libro vacío: el encabezado de siempre y un botón que ya funciona.
  await expect(page.getByRole('heading', { name: 'Tu libro está en blanco' })).toBeVisible();
  await page.getByRole('button', { name: 'Crear mi primer deudor' }).click();
  // Sin nombre no se envía, y el error dice cómo arreglarlo.
  await page.getByRole('button', { name: 'Anotar deudor' }).click();
  await expect(page.getByText('Escribe el nombre o el apodo con que lo conoces.')).toBeVisible();
  await page.getByLabel('Nombre o apodo').fill('Carlos Arturo Peñaloza');
  await page.getByLabel('Referencia (opcional)').fill('don Carlos el del taller');
  await sinDesborde(page);
  await captura(page, `mostrador-nuevo-${ancho}`);
  await page.getByRole('button', { name: 'Anotar deudor' }).click();
  await expect(page.getByText('Anotaste a Carlos Arturo Peñaloza')).toBeVisible();
  await expect(fila(page, 'TLN-0001')).toContainText('Carlos Arturo Peñaloza');

  // Más deudores sembrados por la API (datos ficticios).
  const crear = (cuerpo: object) => apiComo<{ id: string }>(page, uid, '/deudores', { metodo: 'POST', cuerpo });
  const fiarPorApi = (id: string, monto: number) =>
    apiComo(page, uid, `/deudores/${id}/movimientos`, { metodo: 'POST', cuerpo: { request_id: `semilla-${id}-${monto}`, type: 'FIADO', amount_cop: monto } });
  const maria = await crear({ full_name: 'María José Núñez', alias_reference: 'la del 302', doc_type: 'CC', doc_number: '1032456789', credit_limit_cop: 20_000 });
  await fiarPorApi(maria.id, 10_000);
  const wilmar = await crear({ full_name: 'Wilmar Quiceno', alias_reference: 'el mono de la moto' });
  await fiarPorApi(wilmar.id, 12_000);
  await crear({ full_name: 'Rubiela Zapata', alias_reference: 'doña Rubi' });
  const edinson = await crear({ full_name: 'Édinson Mosquera', alias_reference: 'el primo de Yeison' });
  await fiarPorApi(edinson.id, 316_400);
  await apiComo(page, uid, `/deudores/${edinson.id}`, { metodo: 'PATCH', cuerpo: { lista_negra: true } });
  await page.reload();
  await expect(page.getByText('5 deudores en tu libro')).toBeVisible();
  await expect(fila(page, 'Édinson Mosquera')).toContainText('Lista negra');
  await sinDesborde(page);
  await captura(page, `mostrador-${ancho}`);

  // Búsqueda por cada campo, sin tildes ni mayúsculas.
  const buscador = page.getByLabel('Buscar en tu libro');
  for (const [consulta, quien] of [['nunez', 'María José Núñez'], ['MOTO', 'Wilmar Quiceno'], ['0001', 'Carlos Arturo Peñaloza'], ['tln-0004', 'Rubiela Zapata'], ['6789', 'María José Núñez']] as const) {
    await buscador.fill(consulta);
    await expect(lista(page).getByRole('listitem')).toHaveCount(1);
    await expect(lista(page)).toContainText(quien);
  }
  await buscador.fill('Yeimy');
  await expect(page.getByText('No hay nadie con «Yeimy» en tu libro.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anotar a «Yeimy» como deudor nuevo' })).toBeVisible();

  // MOS-02: buscar → fiar $ 5.000 → saldo actualizado, contando toques.
  let toques = 0;
  const toque = async (objetivo: Locator) => {
    toques++;
    await objetivo.click();
  };
  await buscador.fill('carlos');
  const carlos = fila(page, 'Carlos Arturo Peñaloza');
  await expect(carlos).toContainText('$ 0');
  await toque(carlos.getByRole('button', { name: /Fiar/ }));
  await toque(carlos.getByRole('button', { name: '+5.000' }));
  await sinDesborde(page);
  await captura(page, `mostrador-fiar-${ancho}`);
  await toque(carlos.getByRole('button', { name: 'Fiar $ 5.000' }));
  await expect(carlos.getByText('Fiado anotado')).toBeVisible();
  await expect(carlos.locator('.mostrador__saldo')).toHaveText('$ 5.000');
  await expect(carlos).toContainText('Con saldo');
  expect(toques).toBeLessThanOrEqual(3);

  // Abonar: no deja abonar más de lo que debe; abono parcial y enlace al recibo.
  await carlos.getByRole('button', { name: /Abonar/ }).click();
  await carlos.getByLabel('¿Cuánto abona?').fill('9000');
  await carlos.getByRole('button', { name: 'Abonar $ 9.000' }).click();
  await expect(carlos.getByText('Debe $ 5.000: no puede abonar más que eso.')).toBeVisible();
  await carlos.getByLabel('¿Cuánto abona?').fill('');
  await carlos.getByRole('button', { name: '+2.000' }).click();
  await carlos.getByRole('button', { name: 'Abonar $ 2.000' }).click();
  await expect(carlos.getByText('Abono anotado')).toBeVisible();
  await expect(carlos.locator('.mostrador__saldo')).toHaveText('$ 3.000');
  await expect(carlos.getByRole('link', { name: 'Ver recibo' })).toHaveAttribute('href', /^\/deudor\/deb_[\w-]+\?recibo=mov_\w+$/);
  await sinDesborde(page);
  await captura(page, `mostrador-abono-${ancho}`);

  // Tope: debe $ 10.000 con tope de $ 20.000; fiarle $ 15.000 pide confirmar con la alerta roja.
  await buscador.fill('6789');
  const mariaFila = fila(page, 'María José Núñez');
  await mariaFila.getByRole('button', { name: /Fiar/ }).click();
  await mariaFila.getByRole('button', { name: '+10.000' }).click();
  await expect(mariaFila.getByRole('alert')).toHaveCount(0);
  await mariaFila.getByRole('button', { name: '+5.000' }).click();
  await expect(mariaFila.getByRole('alert')).toContainText('Pasa su tope de crédito');
  await expect(mariaFila.getByRole('alert')).toContainText('quedaría debiendo $ 25.000 y su tope es $ 20.000');
  await sinDesborde(page);
  await captura(page, `mostrador-tope-${ancho}`);
  await mariaFila.getByRole('button', { name: 'Fiar $ 15.000 de todas formas' }).click();
  await expect(mariaFila.getByText('Fiado anotado')).toBeVisible();
  await expect(mariaFila.locator('.mostrador__saldo')).toContainText('$ 25.000');
  await expect(mariaFila).toContainText('Pasó su tope de $ 20.000');

  // La copia queda guardada: si al abrir no llega la lista, se busca en la última copia y se avisa.
  await expect.poll(() => nombresDeBases(page)).toContain('tln-cartera');
  await page.route('**/api/deudores', (ruta) => ruta.abort('internetdisconnected'));
  await page.reload();
  await expect(page.getByText(/Estás viendo la copia de las .+; no puedes fiar ni abonar hasta que vuelva\./)).toBeVisible();
  await page.getByLabel('Buscar en tu libro').fill('rubi');
  await expect(lista(page)).toContainText('Rubiela Zapata');
  await expect(lista(page).getByRole('button')).toHaveCount(0);
  await page.unroute('**/api/deudores');

  // Sin conexión con la página ya abierta: busca, avisa y no deja fiar ni abonar.
  await page.reload();
  await expect(page.getByText('5 deudores en tu libro')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText('Sin conexión', { exact: true })).toBeVisible();
  await expect(page.getByText(/Estás viendo la copia de las/)).toBeVisible();
  await page.getByLabel('Buscar en tu libro').fill('moto');
  await expect(lista(page).getByRole('listitem')).toHaveCount(1);
  await expect(lista(page)).toContainText('Wilmar Quiceno');
  await expect(lista(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Nuevo deudor/ })).toHaveCount(0);
  await sinDesborde(page);
  await captura(page, `mostrador-sin-conexion-${ancho}`);
  await context.setOffline(false);
  await expect(page.getByText('Sin conexión', { exact: true })).toHaveCount(0);

  // Tienda que solo puede consultar (p. ej. plan vencido): busca y ve, pero las acciones llevan a Suscripción.
  await page.route('**/api/negocio', async (ruta) => {
    const respuesta = await ruta.fetch();
    const negocio = await respuesta.json();
    await ruta.fulfill({ response: respuesta, json: { ...negocio, estado: 'EXPIRED_READONLY', permisos: { ...negocio.permisos, escribir: false } } });
  });
  await page.reload();
  await expect(page.getByText('Solo puedes consultar', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ver pases en Suscripción' })).toHaveAttribute('href', '/suscripcion');
  await page.getByLabel('Buscar en tu libro').fill('wilmar');
  await expect(lista(page)).toContainText('$ 12.000');
  await expect(lista(page).getByRole('button')).toHaveCount(0);
  await sinDesborde(page);
  await captura(page, `mostrador-solo-consulta-${ancho}`);
  await page.unroute('**/api/negocio');

  // Al salir no queda la copia en el navegador.
  await page.reload();
  await expect(page.getByText('5 deudores en tu libro')).toBeVisible();
  await page.getByRole('button', { name: 'Salir' }).click();
  await expect(page.getByRole('heading', { name: 'Simulador local de ingreso (solo desarrollo)' })).toBeVisible();
  expect(await nombresDeBases(page)).not.toContain('tln-cartera');

  // Errores esperados: los de la red cortada a propósito y el 404 `sin_negocio` antes del alta y al salir.
  expect(errores.filter((e) => !/net::ERR_INTERNET_DISCONNECTED|\[vite\]|WebSocket/.test(e) && !e.endsWith('/api/negocio'))).toEqual([]);
});
