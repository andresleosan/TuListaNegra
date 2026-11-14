import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Módulos puros (compartidos y de navegador): corren en Node.
      { test: { name: 'unit', environment: 'node', include: ['src/shared/**/*.test.ts', 'src/web/**/*.test.ts'] } },
      // API: corre dentro del runtime de Workers con D1 y R2 locales.
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            // Solo pruebas: las migraciones viajan como binding para aplicarlas a la D1 local de cada prueba.
            miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
          })),
        ],
        test: { name: 'worker', include: ['src/worker/**/*.test.ts'], setupFiles: ['./src/worker/test/setup.ts'] },
      },
    ],
  },
});
