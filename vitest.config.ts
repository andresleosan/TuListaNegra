import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Módulos puros (compartidos y de navegador): corren en Node.
      { test: { name: 'unit', environment: 'node', include: ['src/shared/**/*.test.ts', 'src/web/**/*.test.ts'] } },
      // API: corre dentro del runtime de Workers con D1 y R2 locales.
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
        test: { name: 'worker', include: ['src/worker/**/*.test.ts'] },
      },
    ],
  },
});
