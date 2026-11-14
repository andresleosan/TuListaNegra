// Bindings que solo existen en las pruebas (los inyecta vitest.config.ts).
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    TEST_PRIVATE_JWK: string;
  }
}
