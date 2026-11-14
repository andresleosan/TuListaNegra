import { defineConfig } from '@playwright/test';

// Sufijo único por ejecución: la D1 local persiste, y cada recorrido necesita cuentas y teléfonos nuevos.
// Se fija aquí (proceso principal) y lo heredan los procesos de prueba.
process.env.E2E_SUFIJO ??= String(Date.now() % 10_000_000).padStart(7, '0');

// Las altas tienen límite por IP (5 por minuto). En local nadie pone `CF-Connecting-IP`, así que todas las
// ejecuciones compartirían cupo: cada una se presenta con una IP ficticia propia (rango de pruebas 198.18.0.0/15),
// igual que hacen las pruebas del Worker. En producción esa cabecera la escribe Cloudflare, no el navegador.
const n = Number(process.env.E2E_SUFIJO);
const ipFicticia = `198.18.${Math.floor(n / 250) % 250}.${n % 250}`;

// Recorrido en navegador contra el servidor de desarrollo y el simulador local de identidad.
// Usa el Chrome del sistema: no descarga navegadores.
export default defineConfig({
  testDir: 'e2e',
  workers: 1, // un recorrido a la vez: la prueba del teléfono repetido depende del alta anterior
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5199',
    channel: 'chrome',
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    extraHTTPHeaders: { 'CF-Connecting-IP': ipFicticia },
  },
  projects: [
    { name: 'movil-360', use: { viewport: { width: 360, height: 800 } } },
    { name: 'escritorio-1280', use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    // Migraciones en la D1 local (con CI=1 no pregunta) y servidor de desarrollo, que prepara la identidad local.
    command: 'pnpm exec wrangler d1 migrations apply tulistanegra --local && pnpm dev --port 5199 --strictPort',
    env: { CI: '1' },
    url: 'http://localhost:5199/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
