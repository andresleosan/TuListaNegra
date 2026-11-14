// Ayudas compartidas por los recorridos de navegador (Playwright) contra el simulador local de identidad.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';

/** Único por ejecución (lo fija playwright.config.ts): la D1 local persiste y cada recorrido necesita cuentas nuevas. */
export const SUFIJO = process.env.E2E_SUFIJO!;
export const EVIDENCIA = 'docs/roadmap/evidencia';

/** Entra por el formulario del simulador. No espera ninguna pantalla concreta después. */
export async function entrar(pagina: Page, correo: string, uid: string) {
  await pagina.goto('/');
  await expect(pagina.getByRole('heading', { name: 'Simulador local de ingreso (solo desarrollo)' })).toBeVisible();
  await pagina.getByLabel('Correo de la cuenta').fill(correo);
  await pagina.getByLabel('UID (opcional)').fill(uid);
  await pagina.getByRole('button', { name: 'Entrar con esta cuenta' }).click();
}

export async function llenarAlta(pagina: Page, nombre: string, telefono: string) {
  await pagina.getByLabel('Nombre de la tienda').fill(nombre);
  await pagina.getByLabel('WhatsApp de la tienda').fill(telefono);
  await pagina.getByLabel('Acepto los términos y la política de datos').check();
  await pagina.getByRole('button', { name: 'Empezar mi prueba de 3 días' }).click();
}

/**
 * Crea una tienda nueva en prueba y deja la página en el mostrador.
 * `prefijo`: tres dígitos que empiezan por 3 y que ningún otro recorrido usa (el teléfono de la tienda es único).
 */
export async function tiendaNueva(pagina: Page, clave: string, prefijo: string, nombre = 'Tienda La Esquina de Rubi') {
  await entrar(pagina, 'piloto@ejemplo.test', `e2e_${SUFIJO}_${clave}`);
  await expect(pagina.getByRole('heading', { name: 'Crea tu tienda' })).toBeVisible();
  await llenarAlta(pagina, nombre, `${prefijo}${SUFIJO}`);
  await esperarMostrador(pagina);
}

/**
 * Tras enviar el alta, espera el mostrador. El límite de altas (5 por minuto por IP) es real y al correr todos los
 * recorridos juntos se alcanza: se hace lo que haría una persona, esperar el minuto y volver a tocar el botón.
 */
export async function esperarMostrador(pagina: Page) {
  const mostrador = pagina.getByRole('heading', { name: 'Mostrador' });
  for (let intento = 0; intento < 3; intento++) {
    await expect(mostrador.or(pagina.getByText('Demasiados intentos seguidos'))).toBeVisible();
    if (await mostrador.isVisible()) return;
    test.info().setTimeout(test.info().timeout + 75_000);
    await pagina.waitForTimeout(61_000);
    await pagina.getByRole('button', { name: 'Empezar mi prueba de 3 días' }).click();
  }
  await expect(mostrador).toBeVisible();
}

/** Nada se sale de la pantalla en horizontal. */
export const sinDesborde = async (pagina: Page) =>
  expect(await pagina.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

/** Captura de página completa en docs/roadmap/evidencia/<nombre>.png, con las fuentes ya cargadas. */
export async function captura(pagina: Page, nombre: string) {
  await pagina.evaluate(() => document.fonts.ready);
  await pagina.screenshot({ path: `${EVIDENCIA}/${nombre}.png`, fullPage: true });
}

/** El uid de la cuenta simulada que crea `tiendaNueva(pagina, clave, …)`. */
export const uidDe = (clave: string) => `e2e_${SUFIJO}_${clave}`;

/** ID token del simulador para llamar a la API directamente (sembrar datos sin pasar por la pantalla). */
export async function tokenComo(pagina: Page, uid: string, correo = 'piloto@ejemplo.test', proveedor: 'google.com' | 'password' = 'google.com') {
  const respuesta = await pagina.request.post('/__dev/token', { data: { uid, email: correo, email_verified: true, proveedor } });
  expect(respuesta.ok()).toBe(true);
  return ((await respuesta.json()) as { token: string }).token;
}

/** Llama a `/api<ruta>` como la cuenta `uid` y devuelve el JSON. Falla si la API no responde 2xx. */
export async function apiComo<T = any>(pagina: Page, uid: string, ruta: string, { metodo = 'GET', cuerpo }: { metodo?: string; cuerpo?: unknown } = {}): Promise<T> {
  const respuesta = await pagina.request.fetch(`/api${ruta}`, { method: metodo, headers: { Authorization: `Bearer ${await tokenComo(pagina, uid)}` }, data: cuerpo });
  expect(respuesta.ok(), `${metodo} /api${ruta} → ${respuesta.status()} ${await respuesta.text()}`).toBe(true);
  return (await respuesta.json()) as T;
}

/**
 * Un mensaje de WhatsApp que llega al webhook real, FIRMADO con el secreto de desarrollo de `.dev.vars` (prefijo
 * `tln-dev-whatsapp-`, el único que el simulador acepta con el interruptor apagado). Nada salta la firma (A1.7).
 */
export async function whatsappEntrante(pagina: Page, de: string, texto: string) {
  const secreto = /^WHATSAPP_APP_SECRET=(.+)$/m.exec(readFileSync('.dev.vars', 'utf8'))?.[1]?.trim();
  expect(secreto, 'falta WHATSAPP_APP_SECRET de desarrollo en .dev.vars (lo crea scripts/dev-identidad.mjs)').toMatch(/^tln-dev-whatsapp-/);
  const cuerpo = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '200000000000002', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: '100000000000001' },
      contacts: [{ wa_id: de.replace(/^\+/, '') }],
      messages: [{ id: `wamid.E2E.${Date.now()}.${Math.random().toString(36).slice(2)}`, from: de.replace(/^\+/, ''), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
    } }] }],
  });
  const firma = `sha256=${createHmac('sha256', secreto!).update(cuerpo).digest('hex')}`;
  const respuesta = await pagina.request.post('/api/whatsapp/webhook', { data: cuerpo, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma } });
  expect(respuesta.status(), await respuesta.text()).toBe(200);
}
