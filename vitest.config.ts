import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { exportJWK, generateKeyPair } from 'jose';
import { defineConfig } from 'vitest/config';

// Llaves RSA locales, nuevas en cada ejecución: firman los ID tokens de prueba (B5). Nunca salen de aquí.
const llaves = await generateKeyPair('RS256', { extractable: true });
const jwks = { keys: [{ ...(await exportJWK(llaves.publicKey)), kid: 'prueba', alg: 'RS256', use: 'sig' }] };

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
            // Solo pruebas: migraciones para la D1 local y el JWKS local que sustituye al de Google.
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
                FIREBASE_PROJECT_ID: 'tln-pruebas',
                TEST_JWKS_JSON: JSON.stringify(jwks),
                TEST_PRIVATE_JWK: JSON.stringify(await exportJWK(llaves.privateKey)),
              },
            },
          })),
        ],
        test: { name: 'worker', include: ['src/worker/**/*.test.ts'], setupFiles: ['./src/worker/test/setup.ts'] },
      },
    ],
  },
});
