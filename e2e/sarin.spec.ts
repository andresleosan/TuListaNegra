// IAS-02: «Dile a Sarin» en el mostrador. Con la orden grabada (la IA está apagada en local, así que se simula la
// respuesta de POST /api/ia/orden): propuesta correcta, elegir entre dos «Carlos», nadie, «no entendí»; nada se anota
// hasta confirmar y al confirmar se anota una sola vez. Con la respuesta real del servidor: «Sarin aún no está encendida».
import { expect, test } from '@playwright/test';
import { apiComo, captura, sinDesborde, tiendaNueva, uidDe } from './ayudas';

type Orden = { accion: 'FIAR' | 'ABONAR' | 'DESCONOCIDA'; monto: number | null; deudor_buscado: string | null };

test('Sarin: propone, pide elegir, no inventa y solo anota al confirmar', async ({ page }, info) => {
  const ancho = page.viewportSize()!.width;
  const clave = `sar${ancho}`;
  const uid = uidDe(clave);
  const errores: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  await tiendaNueva(page, clave, info.project.name === 'movil-360' ? '326' : '327');

  // Datos ficticios: dos «Carlos» y alguien más.
  const crear = (cuerpo: object) => apiComo<{ id: string }>(page, uid, '/deudores', { metodo: 'POST', cuerpo });
  const donCarlos = await crear({ full_name: 'Don Carlos', alias_reference: 'el del taller' });
  await apiComo(page, uid, `/deudores/${donCarlos.id}/movimientos`, { metodo: 'POST', cuerpo: { request_id: `semilla-${donCarlos.id}`, type: 'FIADO', amount_cop: 50_000 } });
  const carlosArturo = await crear({ full_name: 'Carlos Arturo Peñaloza', alias_reference: 'el de la moto' });
  await crear({ full_name: 'Wilmar Quiceno' });
  const saldo = async (id: string) => (await apiComo<{ current_balance_cop: number }>(page, uid, `/deudores/${id}`)).current_balance_cop;
  const movimientos = async (id: string) => (await apiComo<{ movimientos: unknown[] }>(page, uid, `/deudores/${id}/movimientos`)).movimientos.length;
  const iaUsada = async () => (await apiComo<{ usados: { ia: number } }>(page, uid, '/negocio')).usados.ia;

  await page.reload();
  await expect(page.getByText('3 deudores en tu libro')).toBeVisible();
  const sarin = page.getByRole('region', { name: 'Sarin' });
  const campo = sarin.getByLabel('Dile a Sarin');
  const enviar = sarin.getByRole('button', { name: 'Enviar a Sarin' });
  await expect(sarin).toContainText('abónale veinte mil a don Carlos el del taller');

  // Sin frase no se envía, y el error dice qué hacer.
  await enviar.click();
  await expect(sarin.getByText(/Escribe o dicta qué quieres anotar/)).toBeVisible();

  // Respuesta real del servidor: la IA está apagada en local. Se explica, sin fallar y sin gastar cuota.
  await campo.fill('abónale veinte mil a don Carlos el del taller');
  await enviar.click();
  await expect(sarin.getByText('Sarin aún no está encendida')).toBeVisible();
  await expect(sarin).toContainText('anota con los botones Fiar y Abonar');
  expect(await iaUsada()).toBe(0);
  await sinDesborde(page);

  // De aquí en adelante, la orden grabada que devolvería el modelo.
  let grabada: Orden = { accion: 'ABONAR', monto: 20_000, deudor_buscado: 'don Carlos el del taller' };
  await page.route('**/api/ia/orden', (ruta) => (ruta.request().method() === 'POST' ? ruta.fulfill({ json: grabada }) : ruta.fallback()));

  // Un solo deudor: propuesta clara; antes de confirmar no cambió nada.
  await enviar.click();
  const propuesta = sarin.getByRole('group', { name: 'Propuesta de Sarin' });
  await expect(propuesta).toContainText('Abonar $ 20.000 a Don Carlos, el del taller (TLN-0001)');
  await expect(propuesta).toContainText('Debe hoy$ 50.000');
  await expect(propuesta).toContainText('Abona− $ 20.000');
  await expect(propuesta).toContainText('Quedaría debiendo$ 30.000');
  expect(await saldo(donCarlos.id)).toBe(50_000);
  expect(await movimientos(donCarlos.id)).toBe(1);
  await sinDesborde(page);
  await captura(page, `sarin-propuesta-${ancho}`);

  // Confirmar (con doble toque): se anota una sola vez y el renglón queda a la vista con el abono.
  await propuesta.getByRole('button', { name: 'Confirmar' }).dblclick();
  const fila = page.getByRole('list', { name: 'Deudores' }).getByRole('listitem').filter({ hasText: 'Don Carlos' });
  await expect(fila.getByText('Abono anotado')).toBeVisible();
  await expect(fila.locator('.mostrador__saldo')).toHaveText('$ 30.000');
  await expect(propuesta).toHaveCount(0);
  await expect(campo).toHaveValue('');
  expect(await saldo(donCarlos.id)).toBe(30_000);
  expect(await movimientos(donCarlos.id)).toBe(2);

  // Dos «Carlos»: pide elegir. Elegido uno, propuesta; Cancelar no anota nada.
  grabada = { accion: 'FIAR', monto: 5_000, deudor_buscado: 'Carlos' };
  await campo.fill('fíale cinco mil a Carlos');
  await enviar.click();
  const opciones = sarin.getByRole('list', { name: '¿A cuál?' }).getByRole('button');
  await expect(sarin).toContainText('Hay 2 con «Carlos». ¿A cuál le fías $ 5.000?');
  await expect(opciones).toHaveCount(2);
  await expect(propuesta).toHaveCount(0);
  await sinDesborde(page);
  if (ancho === 360) await captura(page, 'sarin-elegir-360');
  await opciones.filter({ hasText: 'Carlos Arturo Peñaloza' }).click();
  await expect(propuesta).toContainText('Fiar $ 5.000 a Carlos Arturo Peñaloza, el de la moto (TLN-0002)');
  await expect(propuesta).toContainText('Quedaría debiendo$ 5.000');
  await propuesta.getByRole('button', { name: 'Cancelar' }).click();
  await expect(propuesta).toHaveCount(0);
  expect(await saldo(carlosArturo.id)).toBe(0);
  expect(await movimientos(carlosArturo.id)).toBe(0);

  // Nadie con ese nombre: lo dice y lleva a buscar a mano.
  grabada = { accion: 'FIAR', monto: 5_000, deudor_buscado: 'Yeimy' };
  await campo.fill('fíale cinco mil a Yeimy');
  await enviar.click();
  await expect(sarin.getByText('No encontré a «Yeimy» en tu libro')).toBeVisible();
  await expect(sarin.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
  await sarin.getByRole('button', { name: 'Buscar a mano' }).click();
  await expect(page.getByLabel('Buscar en tu libro')).toHaveValue('Yeimy');
  await expect(page.getByLabel('Buscar en tu libro')).toBeFocused();
  await expect(page.getByText('No hay nadie con «Yeimy» en tu libro.')).toBeVisible();

  // Lo que el modelo no entendió no se convierte en propuesta.
  for (const orden of [{ accion: 'DESCONOCIDA', monto: null, deudor_buscado: null }, { accion: 'FIAR', monto: null, deudor_buscado: 'Wilmar' }] as Orden[]) {
    grabada = orden;
    await campo.fill('ponme lo de siempre');
    await enviar.click();
    await expect(sarin.getByText('No te entendí')).toBeVisible();
    await expect(sarin.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
  }
  await sinDesborde(page);

  // Una tienda sin permiso de IA (p. ej. vencida) ni ve el campo.
  await page.route('**/api/negocio', async (ruta) => {
    const respuesta = await ruta.fetch();
    const negocio = await respuesta.json();
    await ruta.fulfill({ response: respuesta, json: { ...negocio, permisos: { ...negocio.permisos, ia: false } } });
  });
  await page.reload();
  await expect(page.getByText('3 deudores en tu libro')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sarin' })).toHaveCount(0);

  // Errores esperados: el 409 real de «IA apagada» y el 404 `sin_negocio` antes del alta.
  expect(errores.filter((e) => !/\[vite\]|WebSocket/.test(e) && !/status of 409.*\/api\/ia\/orden$/.test(e) && !e.endsWith('/api/negocio'))).toEqual([]);
});
