// Captura la página de muestra del sistema de diseño a 360 y 1280 px de ancho (página completa).
// Requiere el servidor de desarrollo levantado en otra terminal: `pnpm dev --port 5199`.
// Uso: `node scripts/capturas-muestra.mjs`. Usa el Chrome del sistema; no descarga navegadores.
// Sale con error si la página se desborda en horizontal o si no cargaron las dos fuentes.
import { chromium } from '@playwright/test';

const fuentesEsperadas = ['Plus Jakarta Sans Variable', 'JetBrains Mono Variable'];

const navegador = await chromium.launch({ channel: 'chrome' });
for (const ancho of [360, 1280]) {
  const pagina = await navegador.newPage({ viewport: { width: ancho, height: 800 } });
  // Vite puede escuchar solo en IPv6 (::1) y Chrome resolver `localhost` solo a IPv4: se prueba también ::1.
  await pagina.goto('http://localhost:5199/__muestra').catch(() => pagina.goto('http://[::1]:5199/__muestra'));
  await pagina.getByRole('heading', { name: 'Muestra de piezas' }).waitFor();
  const { fuentes, desborde } = await pagina.evaluate(async () => {
    await document.fonts.ready;
    return {
      fuentes: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replaceAll('"', '')),
      desborde: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const ruta = `docs/roadmap/evidencia/BAS-02-${ancho}.png`;
  await pagina.screenshot({ path: ruta, fullPage: true });
  console.log(`${ruta} · fuentes: ${fuentes.join(', ')} · desborde horizontal: ${desborde} px`);
  if (desborde > 0 || fuentesEsperadas.some((f) => !fuentes.includes(f))) process.exitCode = 1;
  await pagina.close();
}
await navegador.close();
