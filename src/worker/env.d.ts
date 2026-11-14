// Variables que no están en `vars` de wrangler.jsonc: las pone el dueño en Cloudflare (o .dev.vars en local).
declare namespace Cloudflare {
  interface Env {
    FIREBASE_PROJECT_ID?: string;
    SUPERADMIN_EMAILS?: string;
    PILOT_EMAILS?: string;
    /** Solo pruebas y simulador local: JWKS propio en vez del de Google. check:release impide que llegue a producción. */
    TEST_JWKS_JSON?: string;
  }
}
// `wrangler types` genera el `Env` global aparte de `Cloudflare.Env`: aquí se unen para declarar cada variable una sola vez.
interface Env extends Cloudflare.Env {}
