// WAP-06: comprobantes que llegan por WhatsApp. Aviso en el mostrador, ficha con la foto y el monto editable; corregir
// el monto, aprobar (saldo nuevo y movimiento confirmado) y rechazar otro (el saldo no cambia).
//
// Siembra: cobro por el bot + dos fotos FIRMADAS al webhook real (el enrutador asigna el deudor porque la tienda le
// escribió). El reloj del servidor es el real y el cobro solo sale en horario de cobro (B6): fuera de él, los dos
// pendientes se escriben en la D1 y el R2 locales de este recorrido con `wrangler --local` (como los crearía WAP-05,
// que ya prueban src/worker/whatsapp/procesar.test.ts y abonos.test.ts) y se anota en el informe de Playwright.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { apiComo, captura, sinDesborde, SUFIJO, tiendaNueva, tokenComo, uidDe, whatsappImagen } from './ayudas';

const SALDO = 84_900;

/** Los bytes de un medio de muestra del simulador (una sola fuente: src/worker/whatsapp/simulado.ts). */
function medioDeMuestra(id: string): Buffer {
  const fuente = readFileSync('src/worker/whatsapp/simulado.ts', 'utf8');
  const b64 = new RegExp(`'${id}': \\{ bytes: deBase64\\('([A-Za-z0-9+/=]+)'\\)`).exec(fuente)?.[1];
  expect(b64, `no está ${id} en el simulador`).toBeTruthy();
  return Buffer.from(b64!, 'base64');
}

/** Fuera del horario de cobro: dos ABONO pendientes con su foto, como los deja ./procesar.ts, en el estado local. */
function sembrarLocal(negocio: string, deudor: string) {
  const estado = process.env.E2E_ESTADO;
  expect(estado, 'la siembra local necesita E2E_ESTADO (carpeta propia de D1 y R2)').toBeTruthy();
  const wrangler = (...args: string[]) => execFileSync('pnpm', ['exec', 'wrangler', ...args, '--local', '--persist-to', estado!], { stdio: 'pipe', env: { ...process.env, CI: '1' } });
  const carpeta = mkdtempSync(join(tmpdir(), 'tln-abonos-'));
  const ahora = Date.now();
  const filas = ['sim-recibo-1', 'sim-recibo-2'].map((medio, i) => {
    const bytes = medioDeMuestra(medio);
    const clave = `negocios/${negocio}/comprobantes/${createHash('sha256').update(bytes).digest('hex')}.png`;
    const archivo = join(carpeta, `${medio}.png`);
    writeFileSync(archivo, bytes);
    wrangler('r2', 'object', 'put', `tulistanegra-archivos/${clave}`, '--file', archivo, '--content-type', 'image/png');
    const id = `mov_${createHash('sha256').update(`${negocio}${medio}${ahora}`).digest('hex').slice(0, 32)}`;
    return `('${id}', '${negocio}', '${deudor}', 'wa:wamid.E2E.${ahora}.${i}', 'ABONO', ${SALDO}, 'PENDIENTE_VERIFICACION_WHATSAPP',
      'Comprobante por WhatsApp (monto sugerido: el saldo al recibirlo; verifícalo antes de aprobar)', '${clave}', ${ahora - 60_000 + i * 30_000}, 'WHATSAPP_BOT')`;
  });
  wrangler('d1', 'execute', 'tulistanegra', '--command',
    `INSERT INTO ledger_transactions (id, business_id, debtor_id, request_id, type, amount_cop, status, description, evidence_r2_key, created_at, source) VALUES ${filas.join(', ')}`);
}

async function sembrarPendientes(pagina: Page, uid: string, telefono: string, deudor: string): Promise<'webhook' | 'local'> {
  const cobro = await pagina.request.post(`/api/cobros-bot/${deudor}`, {
    headers: { Authorization: `Bearer ${await tokenComo(pagina, uid)}` },
    data: { tono: 'VECINO_AMIGABLE', request_id: `e2e-abonos-${SUFIJO}` },
  });
  if (cobro.status() === 200) {
    await whatsappImagen(pagina, telefono, 'sim-recibo-1');
    await whatsappImagen(pagina, telefono, 'sim-recibo-2');
    return 'webhook';
  }
  const cuerpo = await cobro.json();
  expect(cobro.status(), JSON.stringify(cuerpo)).toBe(409);
  expect(['FUERA_DE_HORARIO', 'DOMINGO', 'FESTIVO']).toContain(cuerpo.motivo);
  test.info().annotations.push({ type: 'siembra', description: `Cobro bloqueado (${cuerpo.motivo}): los pendientes se sembraron en la D1 y el R2 locales, no por el webhook.` });
  sembrarLocal((await apiComo(pagina, uid, '/negocio')).id, deudor);
  return 'local';
}

test('comprobantes por WhatsApp: aviso, foto, monto corregido, aprobar uno y rechazar otro', async ({ page }, info) => {
  const ancho = page.viewportSize()!.width;
  const movil = info.project.name === 'movil-360';
  const clave = `abo${ancho}`;
  const uid = uidDe(clave);
  const prefijo = movil ? '330' : '331';
  const errores: string[] = [];
  // El 404 de /api/negocio es el de antes de crear la tienda (la app lo usa para mostrar el alta).
  page.on('console', (m) => m.type() === 'error' && !m.location().url.endsWith('/api/negocio') && errores.push(`${m.text()} · ${m.location().url}`));
  page.on('pageerror', (e) => errores.push(String(e)));

  await tiendaNueva(page, clave, prefijo);
  // Datos ficticios. El teléfono del deudor es único por ejecución y distinto del de la tienda.
  const telefono = `+57${prefijo}${String((Number(SUFIJO) + 5_000_000) % 10_000_000).padStart(7, '0')}`;
  const deudor = await apiComo<{ id: string }>(page, uid, '/deudores', {
    metodo: 'POST', cuerpo: { full_name: 'Marta Rojas', alias_reference: 'la de la panadería', whatsapp_phone: telefono, wa_consentimiento: true },
  });
  await apiComo(page, uid, `/deudores/${deudor.id}/movimientos`, { metodo: 'POST', cuerpo: { request_id: `semilla-${deudor.id}`, type: 'FIADO', amount_cop: SALDO } });
  const siembra = await sembrarPendientes(page, uid, telefono, deudor.id);
  await expect.poll(async () => (await apiComo(page, uid, '/abonos')).pendientes.length).toBe(2);

  // Mostrador: el aviso, con un renglón por deudor y su enlace a la ficha.
  await page.reload();
  await expect(page.getByText('Tienes 2 comprobantes por revisar')).toBeVisible();
  const renglon = page.getByRole('list', { name: 'Comprobantes por revisar' }).getByRole('listitem');
  await expect(renglon).toHaveCount(1);
  await expect(renglon).toContainText('Marta Rojas');
  await expect(renglon).toContainText('2 comprobantes · debe $ 84.900');
  await sinDesborde(page);
  await captura(page, `abonos-mostrador-${ancho}`);
  await renglon.getByRole('link', { name: 'Revisar los comprobantes de Marta Rojas' }).click();

  // Ficha: los dos comprobantes con su foto y el monto sugerido; el saldo no se ha movido.
  await expect(page.getByRole('heading', { name: 'Marta Rojas', level: 1 })).toBeVisible();
  const seccion = page.getByRole('region', { name: 'Comprobantes por revisar' });
  const comprobantes = seccion.getByRole('article');
  await expect(comprobantes).toHaveCount(2);
  const fotos = seccion.getByRole('img', { name: 'Foto del comprobante que envió Marta Rojas' });
  await expect(fotos).toHaveCount(2);
  for (const foto of await fotos.all()) {
    await expect.poll(() => foto.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  }
  await expect(page.getByTestId('saldo-actual')).toHaveText('$ 84.900');
  const primero = comprobantes.first();
  const monto = primero.getByLabel('Monto del abono');
  await expect(monto).toHaveValue('84.900');
  await sinDesborde(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); // la barra fija queda al pie de la captura
  await captura(page, `abonos-pendiente-${ancho}`);

  // Más de lo que debe: el error lo dice junto al campo y no se pide confirmar.
  await monto.fill('100000');
  await primero.getByRole('button', { name: 'Aprobar abono' }).click();
  await expect(primero.getByText('Debe hoy $ 84.900: el abono no puede pasar de ahí.')).toBeVisible();
  await expect(primero.getByRole('button', { name: 'Sí, aprobar' })).toHaveCount(0);

  // Corrige el monto según la foto y aprueba (doble toque: una sola vez).
  await monto.fill('50000');
  await expect(monto).toHaveValue('50.000');
  await primero.getByRole('button', { name: 'Aprobar abono' }).click();
  await expect(primero.getByText('¿Aprobar el abono de $ 50.000?')).toBeVisible();
  await expect(primero).toContainText('Su saldo baja de $ 84.900 a $ 34.900');
  await sinDesborde(page);
  await primero.getByRole('button', { name: 'Sí, aprobar' }).dblclick();
  await expect(seccion.getByText('Abono de $ 50.000 aprobado')).toBeVisible();
  await expect(seccion).toContainText('Ahora debe $ 34.900');
  // Por el webhook, el deudor acaba de escribir: la tirilla sale. Sembrado a mano no hay entrante suyo: ventana cerrada.
  await expect(seccion).toContainText(siembra === 'webhook' ? 'Tirilla: Le llegó por WhatsApp.' : 'pasaron más de 24 horas desde su último mensaje');
  await expect(page.getByTestId('saldo-actual')).toHaveText('$ 34.900');
  const confirmado = page.getByTestId('movimiento').filter({ hasText: 'Abono con comprobante por WhatsApp' }).filter({ hasText: '$ 34.900' });
  await expect(confirmado).toHaveCount(1);
  await expect(confirmado).toContainText('−$ 50.000');
  await expect(comprobantes).toHaveCount(1);

  // El recibo del abono aprobado queda en la app.
  await seccion.getByRole('button', { name: 'Ver recibo' }).click();
  const recibo = page.getByRole('region', { name: 'Recibo' });
  await expect(recibo).toContainText('Abono con comprobante por WhatsApp');
  await expect(recibo).toContainText('$ 34.900');
  await recibo.getByRole('button', { name: 'Cerrar recibo' }).click();

  // El otro comprobante se rechaza: el saldo no cambia.
  await comprobantes.first().getByRole('button', { name: 'Rechazar' }).click();
  await expect(seccion.getByText('¿Rechazar este comprobante?')).toBeVisible();
  await seccion.getByRole('button', { name: 'Sí, rechazar' }).click();
  await expect(seccion.getByText('Comprobante rechazado')).toBeVisible();
  await expect(seccion).toContainText('El saldo sigue en $ 34.900');
  await expect(comprobantes).toHaveCount(0);
  await expect(page.getByTestId('saldo-actual')).toHaveText('$ 34.900');
  await sinDesborde(page);

  // Lo que quedó en el servidor: uno confirmado por 50.000, uno rechazado, saldo 34.900 y nada pendiente.
  const { movimientos } = await apiComo<{ movimientos: { type: string; status: string; amount_cop: number }[] }>(page, uid, `/deudores/${deudor.id}/movimientos`);
  expect(movimientos.filter((m) => m.type === 'ABONO').map((m) => `${m.status}:${m.amount_cop}`).sort()).toEqual(['CONFIRMADO:50000', `RECHAZADO:${SALDO}`]);
  expect((await apiComo(page, uid, `/deudores/${deudor.id}`)).current_balance_cop).toBe(34_900);
  expect((await apiComo(page, uid, '/abonos')).pendientes).toEqual([]);

  // De vuelta en el mostrador ya no hay aviso.
  await page.getByRole('link', { name: 'Volver al mostrador' }).click();
  await expect(page.getByRole('heading', { name: 'Mostrador' })).toBeVisible();
  await expect(page.getByText('1 deudor en tu libro')).toBeVisible();
  await expect(page.getByText(/comprobantes? por revisar/)).toHaveCount(0);

  expect(errores).toEqual([]);
});
