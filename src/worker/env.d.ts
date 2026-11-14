// Variables que no están en `vars` de wrangler.jsonc: las pone el dueño en Cloudflare (o .dev.vars en local).
declare namespace Cloudflare {
  interface Env {
    FIREBASE_PROJECT_ID?: string;
    SUPERADMIN_EMAILS?: string;
    PILOT_EMAILS?: string;
    /** Cómo contactar a soporte; se muestra a un negocio suspendido. */
    SOPORTE_CONTACTO?: string;
    PAYMENT_ACCOUNTS_JSON?: string; // cuentas donde se pagan los pases: lista JSON que se muestra al dueño
    /** Secreto de DeepSeek. Solo se usa con AI_READY = "1". */
    DEEPSEEK_API_KEY?: string;
    /** Workers AI (visión del migrador de cuadernos). Se añade como binding al encender AI_READY; solo se usa con AI_READY = "1". */
    AI?: Ai;
    /** Secreto de la app de Meta: firma (HMAC-SHA-256) de cada POST al webhook de WhatsApp. Sin él, el webhook responde 401 a todo. */
    WHATSAPP_APP_SECRET?: string;
    /** Token que Meta repite en el reto GET de alta del webhook. Sin él, el reto responde 403. */
    WHATSAPP_VERIFY_TOKEN?: string;
    /** Secreto: token del número en la Cloud API de Meta (variante A). Solo se usa con WHATSAPP_SEND_READY = "1"; nunca en `vars`. */
    WHATSAPP_ACCESS_TOKEN?: string;
    /** Id del número de WhatsApp en Meta (solo dígitos; no es el teléfono). Solo se usa con WHATSAPP_SEND_READY = "1". */
    WHATSAPP_PHONE_NUMBER_ID?: string;
    /** Solo desarrollo y pruebas: habilita el cobro por bot contra el simulador con el interruptor apagado. check:release lo prohíbe en producción. */
    TEST_WHATSAPP_SIMULADO?: string;
    /** Solo pruebas y simulador local: JWKS propio en vez del de Google. check:release impide que llegue a producción. */
    TEST_JWKS_JSON?: string;
  }
}
// `wrangler types` genera el `Env` global aparte de `Cloudflare.Env`: aquí se unen para declarar cada variable una sola vez.
interface Env extends Cloudflare.Env {}
