// IAS-04: pasar el cuaderno. Con la IA apagada (así está en local) la tabla se llena a mano mirando la foto; con tres
// lecturas simuladas de la IA la tabla llega propuesta y se corrige. Nada entra al libro hasta confirmar; reintentar no duplica.
import { expect, type Page, test } from '@playwright/test';
import { formatoCOP } from '../src/shared/dinero';
import { apiComo, captura, entrar, sinDesborde, tiendaNueva, uidDe } from './ayudas';

const renglon = (pagina: Page, n: number) => pagina.getByRole('listitem', { name: `Renglón ${n}`, exact: true });
const cuantos = async (pagina: Page, uid: string) => (await apiComo<{ deudores: unknown[] }>(pagina, uid, '/deudores')).deudores.length;

/** Una página de cuaderno de fiados dibujada en el navegador (datos ficticios), como PNG. */
async function fotoDeCuaderno(pagina: Page, lineas: string[]) {
  const base64 = await pagina.evaluate((lineas) => {
    const lienzo = document.createElement('canvas');
    [lienzo.width, lienzo.height] = [480, 640];
    const c = lienzo.getContext('2d')!;
    c.fillStyle = '#FBF8EC';
    c.fillRect(0, 0, 480, 640);
    c.fillStyle = '#9DB8D9';
    for (let y = 80; y < 640; y += 40) c.fillRect(0, y, 480, 2);
    c.strokeStyle = '#D9534F';
    c.beginPath();
    c.moveTo(60, 0);
    c.lineTo(60, 640);
    c.stroke();
    c.fillStyle = '#1F2A6B';
    c.font = 'italic 26px serif';
    c.fillText('Fiados', 72, 60);
    lineas.forEach((linea, i) => c.fillText(linea, 72, 112 + i * 40));
    return lienzo.toDataURL('image/png').split(',')[1];
  }, lineas);
  return { name: 'cuaderno.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

/** La foto que se ve es la que se subió: una imagen local (blob) que cargó de verdad. */
async function fotoVisible(pagina: Page) {
  const foto = pagina.getByRole('img', { name: 'Tu foto del cuaderno' });
  await expect(foto).toBeVisible();
  await expect(foto).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => foto.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
}

test.describe.serial('pasar mi cuaderno', () => {
  test('con la IA apagada: subir la foto, llenar la tabla mirándola, corregir, quitar e importar', async ({ page }, info) => {
    const ancho = page.viewportSize()!.width;
    const clave = `cua${ancho}`;
    const uid = uidDe(clave);
    const errores: string[] = [];
    // Esperado: el 404 `sin_negocio` con el que la API dice que la cuenta aún no tiene tienda.
    page.on('console', (m) => m.type() === 'error' && !m.location().url.endsWith('/api/negocio') && errores.push(`${m.text()} · ${m.location().url}`));
    page.on('pageerror', (e) => errores.push(String(e)));

    await tiendaNueva(page, clave, info.project.name === 'movil-360' ? '319' : '321');

    // El libro vacío conserva su encabezado y ofrece pasar el cuaderno; la pantalla cuelga del mostrador.
    await expect(page.getByRole('heading', { name: 'Tu libro está en blanco' })).toBeVisible();
    await page.getByRole('link', { name: 'Pasar mi cuaderno' }).click();
    await expect(page.getByRole('heading', { name: 'Pasar mi cuaderno', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/cuaderno$/);
    await expect(page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Mostrador' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Nada entra a tu libro hasta que tú lo confirmes.')).toBeVisible();
    await sinDesborde(page);
    await captura(page, `cuaderno-${ancho}`);

    // Rechazos en el navegador, antes de subir nada.
    const subir = page.getByRole('button', { name: 'Subir foto' });
    const campo = page.getByLabel('Foto de una página del cuaderno');
    await subir.click();
    await expect(page.getByText('Elige la foto de una página de tu cuaderno.')).toBeVisible();
    await campo.setInputFiles({ name: 'notas.txt', mimeType: 'text/plain', buffer: Buffer.from('no soy una foto') });
    await expect(page.getByText('Ese archivo no es una foto. Sube la foto en JPG, PNG o WebP.')).toBeVisible();

    await campo.setInputFiles(await fotoDeCuaderno(page, ['Doña Marta Rincón ... 15.000', 'Wilmar (el mono) ... 32.000', 'Ana ... 7.000']));
    await subir.click();
    // IA apagada: tabla vacía, con un renglón listo para escribir y la foto a la vista.
    await expect(page.getByText('Escribe lo que ves en tu foto', { exact: true })).toBeVisible();
    await fotoVisible(page);
    await expect(page.getByRole('list', { name: 'Renglones del cuaderno' }).getByRole('listitem')).toHaveCount(1);
    await expect(renglon(page, 1).getByLabel('Nombre')).toHaveValue('');

    await renglon(page, 1).getByLabel('Nombre').fill('Doña Marta Rincón');
    await renglon(page, 1).getByLabel('Debe').fill('15000');
    await expect(renglon(page, 1).getByLabel('Debe')).toHaveValue('15.000');
    await page.getByRole('button', { name: 'Añadir renglón' }).click();
    await expect(renglon(page, 2).getByLabel('Nombre')).toBeFocused();
    await renglon(page, 2).getByLabel('Nombre').fill('Wilmar Quiceno');
    await renglon(page, 2).getByLabel('Apodo (opcional)').fill('el mono de la moto');
    await page.getByRole('button', { name: 'Añadir renglón' }).click();
    await renglon(page, 3).getByLabel('Nombre').fill('Ana');
    await renglon(page, 3).getByLabel('Debe').fill('7000');
    await expect(page.getByText(`Vas a pasar 3 deudores por ${formatoCOP(22_000)}`)).toBeVisible();

    // A Wilmar le falta el saldo: el error sale junto a su campo y no se avanza.
    await page.getByRole('button', { name: 'Revisar antes de pasar' }).click();
    await expect(renglon(page, 2).getByText('Escribe cuánto debe. Si ya no debe nada, quita este renglón.')).toBeVisible();
    await expect(page.getByText('Corrige el renglón marcado en rojo.')).toBeVisible();
    await expect(renglon(page, 2).getByLabel('Debe')).toBeFocused();
    await sinDesborde(page);
    await captura(page, `cuaderno-tabla-${ancho}`);

    await renglon(page, 2).getByLabel('Debe').fill('32000');
    await expect(renglon(page, 2).getByText('Escribe cuánto debe.')).toHaveCount(0);
    await page.getByRole('button', { name: 'Quitar el renglón 3' }).click();
    await expect(page.getByRole('list', { name: 'Renglones del cuaderno' }).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByText(`Vas a pasar 2 deudores por ${formatoCOP(47_000)}`)).toBeVisible();

    await page.getByRole('button', { name: 'Revisar antes de pasar' }).click();
    await expect(page.getByRole('heading', { name: '¿Pasamos esto a tu libro?' })).toBeVisible();
    const resumen = page.getByRole('list', { name: 'Lo que vas a pasar' });
    await expect(resumen.getByRole('listitem')).toHaveCount(2);
    await expect(resumen).toContainText('Doña Marta Rincón');
    await expect(resumen).toContainText('el mono de la moto');
    // Hasta aquí nada entró al libro.
    expect(await cuantos(page, uid)).toBe(0);
    await sinDesborde(page);

    await page.getByRole('button', { name: 'Sí, pasar a mi libro' }).click();
    await expect(page.getByText('Pasaste 2 deudores a tu libro')).toBeVisible();
    const pasados = page.getByRole('list', { name: 'Deudores que pasaste' });
    await expect(pasados.getByRole('listitem').filter({ hasText: 'TLN-0001' })).toContainText(formatoCOP(15_000));
    await expect(pasados.getByRole('listitem').filter({ hasText: 'TLN-0002' })).toContainText(formatoCOP(32_000));
    await sinDesborde(page);
    await captura(page, `cuaderno-listo-${ancho}`);
    expect(await cuantos(page, uid)).toBe(2);

    // En el mostrador están con sus saldos, y en la ficha el saldo entró como «Saldo anterior (cuaderno)».
    await page.getByRole('link', { name: 'Ir al mostrador' }).click();
    const lista = page.getByRole('list', { name: 'Deudores' });
    await expect(lista.getByRole('listitem').filter({ hasText: 'Doña Marta Rincón' })).toContainText(formatoCOP(15_000));
    await expect(lista.getByRole('listitem').filter({ hasText: 'Wilmar Quiceno' })).toContainText(formatoCOP(32_000));
    await lista.getByRole('link', { name: 'Wilmar Quiceno' }).click();
    await expect(page.getByRole('heading', { name: 'Wilmar Quiceno', level: 1 })).toBeVisible();
    await expect(page.getByText('Saldo anterior (cuaderno)').first()).toBeVisible();

    // Recargar no duplica: la pantalla vuelve al primer paso y el libro sigue con los mismos dos.
    await page.goto('/cuaderno');
    await expect(page.getByRole('button', { name: 'Subir foto' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Subir foto' })).toBeVisible();
    expect(await cuantos(page, uid)).toBe(2);

    expect(errores).toEqual([]);
  });

  test('tres fotos leídas por la IA (simulada): la tabla llega propuesta, se corrige y nada entra sin confirmar', async ({ page }) => {
    const ancho = page.viewportSize()!.width;
    const uid = uidDe(`cua${ancho}`);
    const errores: string[] = [];
    // Esperados: el corte de red simulado y el 409 simulado de la importación.
    page.on('console', (m) => m.type() === 'error' && !m.location().url.includes('/api/cuadernos/importar') && errores.push(`${m.text()} · ${m.location().url}`));
    page.on('pageerror', (e) => errores.push(String(e)));

    // La foto se sube y se guarda de verdad; solo la lectura de la IA se simula (AI_READY está apagado en local).
    const lecturas = [
      [
        { full_name: 'Rosa Elena Díaz', alias_reference: null, saldo_cop: 18_000 },
        { full_name: 'El Mono', alias_reference: 'el de la moto', saldo_cop: 8_500 },
        { full_name: 'Jairo Castaño', alias_reference: 'el del taller', saldo_cop: 25_000 },
      ],
      [{ full_name: 'Pedr0 G0mez ~~', alias_reference: null, saldo_cop: 4_500_000 }],
      [],
    ];
    await page.route('**/api/cuadernos/fotos', async (ruta) => {
      const respuesta = await ruta.fetch();
      const cuerpo = await respuesta.json();
      await ruta.fulfill({ response: respuesta, json: { ...cuerpo, lectura: 'leida', filas: lecturas.shift() } });
    });

    await entrar(page, 'piloto@ejemplo.test', uid);
    await expect(page.getByRole('heading', { name: 'Mostrador', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Pasar mi cuaderno' }).click();
    const antes = await cuantos(page, uid);
    const subirFoto = async (lineas: string[]) => {
      await page.getByLabel('Foto de una página del cuaderno').setInputFiles(await fotoDeCuaderno(page, lineas));
      await page.getByRole('button', { name: 'Subir foto' }).click();
      await fotoVisible(page);
    };

    // Foto 1: tres renglones propuestos; el tendero corrige un saldo.
    await subirFoto(['Rosa Elena Díaz ... 18.000', 'El Mono (moto) ... 9.000', 'Jairo (taller) ... 25.000']);
    await expect(page.getByText('Leímos 3 renglones de tu foto')).toBeVisible();
    await expect(renglon(page, 1).getByLabel('Nombre')).toHaveValue('Rosa Elena Díaz');
    await expect(renglon(page, 2).getByLabel('Apodo (opcional)')).toHaveValue('el de la moto');
    await expect(renglon(page, 2).getByLabel('Debe')).toHaveValue('8.500');
    await sinDesborde(page);
    await captura(page, `cuaderno-ia-${ancho}`);
    await renglon(page, 2).getByLabel('Debe').fill('9000');
    await expect(page.getByText(`Vas a pasar 3 deudores por ${formatoCOP(52_000)}`)).toBeVisible();
    await page.getByRole('button', { name: 'Revisar antes de pasar' }).click();
    await expect(page.getByRole('heading', { name: '¿Pasamos esto a tu libro?' })).toBeVisible();
    await sinDesborde(page);
    await captura(page, `cuaderno-confirmar-${ancho}`);
    expect(await cuantos(page, uid)).toBe(antes);

    // La red se cae justo cuando la importación ya llegó: se explica y, al reintentar, no se anota dos veces.
    await page.route('**/api/cuadernos/importar', async (ruta) => {
      await ruta.fetch();
      await ruta.abort('internetdisconnected');
    }, { times: 1 });
    await page.getByRole('button', { name: 'Sí, pasar a mi libro' }).click();
    await expect(page.getByText('No hay conexión')).toBeVisible();
    await page.getByRole('button', { name: 'Sí, pasar a mi libro' }).click();
    await expect(page.getByText('Esta página ya estaba en tu libro')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Deudores que pasaste' }).getByRole('listitem')).toHaveCount(3);
    expect(await cuantos(page, uid)).toBe(antes + 3);

    // Foto 2: un renglón raro (letras por números, un saldo con ceros de más) que el tendero corrige.
    await page.getByRole('button', { name: 'Pasar otra página' }).click();
    await subirFoto(['Pedro Gómez ... 45.000']);
    await expect(page.getByText('Leímos 1 renglón de tu foto')).toBeVisible();
    await expect(renglon(page, 1).getByLabel('Nombre')).toHaveValue('Pedr0 G0mez ~~');
    await expect(renglon(page, 1).getByLabel('Debe')).toHaveValue('4.500.000');
    await renglon(page, 1).getByLabel('Nombre').fill('Pedro Gómez');
    await renglon(page, 1).getByLabel('Debe').fill('45000');
    await page.getByRole('button', { name: 'Revisar antes de pasar' }).click();
    await expect(page.getByRole('list', { name: 'Lo que vas a pasar' })).toContainText('Pedro Gómez');
    expect(await cuantos(page, uid)).toBe(antes + 3);
    // Si el plan no admite más deudores, se explica con el camino a Suscripción.
    await page.route('**/api/cuadernos/importar', (ruta) => ruta.fulfill({ status: 409, json: { error: 'limite_deudores', limite: 15 } }), { times: 1 });
    await page.getByRole('button', { name: 'Sí, pasar a mi libro' }).click();
    await expect(page.getByText('Tu plan no admite tantos deudores')).toBeVisible();
    await expect(page.getByText(/Tu plan permite hasta 15 deudores/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ver pases en Suscripción' })).toBeVisible();
    await sinDesborde(page);
    await page.getByRole('button', { name: 'Sí, pasar a mi libro' }).click();
    await expect(page.getByText('Pasaste 1 deudor a tu libro')).toBeVisible();
    expect(await cuantos(page, uid)).toBe(antes + 4);

    // Foto 3: la IA no lee nada; la tabla llega vacía para escribirla. Si el tendero se va sin confirmar, no entra nada.
    await page.getByRole('button', { name: 'Pasar otra página' }).click();
    await subirFoto(['(borroso)']);
    await expect(page.getByText('No alcanzamos a leer tu foto')).toBeVisible();
    await expect(renglon(page, 1).getByLabel('Nombre')).toHaveValue('');
    await renglon(page, 1).getByLabel('Nombre').fill('Lucía Ortiz');
    await renglon(page, 1).getByLabel('Debe').fill('3000');
    await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Mostrador' }).click();
    await expect(page.getByRole('list', { name: 'Deudores' })).toContainText('Pedro Gómez');
    await expect(page.getByRole('list', { name: 'Deudores' })).not.toContainText('Lucía Ortiz');
    expect(await cuantos(page, uid)).toBe(antes + 4);

    // Tienda sin permiso de escribir (p. ej. vencida): se explica y lleva a Suscripción, sin ofrecer subir nada.
    await page.route('**/api/negocio', async (ruta) => {
      const respuesta = await ruta.fetch();
      const negocio = await respuesta.json();
      await ruta.fulfill({ response: respuesta, json: { ...negocio, permisos: { ...negocio.permisos, escribir: false } } });
    });
    await page.goto('/cuaderno');
    await expect(page.getByText('Solo puedes consultar')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ver pases en Suscripción' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Subir foto' })).toHaveCount(0);
    await sinDesborde(page);

    expect(errores).toEqual([]);
  });
});
