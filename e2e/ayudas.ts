// Ayudas compartidas por los recorridos de navegador (Playwright) contra el simulador local de identidad.
import { expect, type Page } from '@playwright/test';

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
  await expect(pagina.getByRole('heading', { name: 'Mostrador' })).toBeVisible();
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
