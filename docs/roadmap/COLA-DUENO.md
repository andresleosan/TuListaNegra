# Cola del dueño

Lo que solo el dueño puede hacer o decidir. Responde debajo de la fila o bórrala al resolverla; el agente aplica la respuesta en el siguiente arranque.

| Qué hace falta | Desbloquea |
| --- | --- |
| Iniciar sesión de Cloudflare en este equipo (`pnpm exec wrangler login`). | BAS-05 y todo lo de producción. |
| Proyecto de Firebase con Google y correo/contraseña activados; pasar el `PROJECT_ID` y la configuración web. | Ingreso real. |
| Poner `SUPERADMIN_EMAILS` (y `PILOT_EMAILS`) como variables en Cloudflare. | Consola real. |
| Crear el repositorio remoto. | Push. |
| Cuentas de pago de ALS DevStudio para `PAYMENT_ACCOUNTS_JSON`. | Pago real de pases. |
| Clave de DeepSeek como secreto (`DEEPSEEK_API_KEY`) y encender `AI_READY`. Al encender: probar una frase real, porque el cliente solo se ha probado contra respuestas simuladas. | Fase 3 en real. |
| WhatsApp: decidir número propio o reenvío desde Sarin Bot; número verificado y plantillas aprobadas en Meta; encender `WHATSAPP_SEND_READY`. | Fase 4 en real. |
| Abogado: términos y política de datos, reglas de cobranza, DeepSeek como proveedor fuera del país, plazos de conservación y semáforo. | LEG-01, SEM-01, `SIGNUP_READY`. |
| Contador: cómo se facturan los pases. | Cobro formal. |
| Dominio `tulistanegra.com`. | Lanzamiento. |
| Abogado: confirmar el festivo nuevo de la Ley 2578 de 2026 (9 de julio, trasladado a lunes). Hoy está incluido en `src/shared/festivos-co.json` por prudencia: ese día no se cobra. | Reglas de contacto exactas (COB-01). |
