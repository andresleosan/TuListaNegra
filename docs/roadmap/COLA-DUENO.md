# Cola del dueño

Lo que solo el dueño puede hacer o decidir. Responde debajo de la fila o bórrala al resolverla; el agente aplica la respuesta en el siguiente arranque.

| Qué hace falta | Desbloquea |
| --- | --- |
| Iniciar sesión de Cloudflare en este equipo (`pnpm exec wrangler login`). | BAS-05 y todo lo de producción. |
| Proyecto de Firebase con Google y correo/contraseña activados; pasar el `PROJECT_ID` y la configuración web. | Ingreso real. |
| Poner `SUPERADMIN_EMAILS` (y `PILOT_EMAILS`) como variables en Cloudflare. | Consola real. |
| Cuentas de pago de ALS DevStudio para `PAYMENT_ACCOUNTS_JSON`. | Pago real de pases. |
| Clave de DeepSeek **propia de TuListaNegra** (nunca la de Sarin Bot, A1.2; mejor en una cuenta de DeepSeek aparte para ver su consumo y gasto por separado) como secreto (`DEEPSEEK_API_KEY`) y encender `AI_READY`. Al encender: probar una frase real, porque el cliente solo se ha probado contra respuestas simuladas. Para leer fotos de cuadernos hace falta además el binding de Workers AI (`"ai": { "binding": "AI" }` en `wrangler.jsonc`; cobra por uso) y probar una foto real. | Fase 3 en real (frases y migrador de cuadernos). |
| WhatsApp — **decidido 2026-11-14: variante A, número propio** (el dueño compra la SIM el 2026-11-15). Falta: alta del número en la plataforma de WhatsApp Business de Meta (cuenta de TuListaNegra, no la de Sarin Bot), verificación por SMS o llamada, nombre visible aprobado, token permanente de usuario del sistema y plantillas `cobro_*`, `aviso_abono_pendiente` y `codigo_verificacion` aprobadas; luego poner `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` y el token y el id del número como secretos, y encender `WHATSAPP_SEND_READY` a la vez. | Fase 4 en real. |
| Abogado: términos y política de datos, reglas de cobranza, DeepSeek como proveedor fuera del país, plazos de conservación y semáforo. | LEG-01, SEM-01, `SIGNUP_READY`. |
| Contador: cómo se facturan los pases. | Cobro formal. |
| Dominio `tulistanegra.com`. | Lanzamiento. |
| Abogado: confirmar el festivo nuevo de la Ley 2578 de 2026 (9 de julio, trasladado a lunes). Hoy está incluido en `src/shared/festivos-co.json` por prudencia: ese día no se cobra. | Reglas de contacto exactas (COB-01). |
