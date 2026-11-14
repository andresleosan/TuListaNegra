# Reglas y decisiones (Parte A del encargo)

Orden de autoridad: este archivo (Parte A) > `docs/spec/producto.md` (Parte B) > fichas de `docs/roadmap/tasks/` (Parte C) > criterio del agente. Se responde en español.

### A1. Reglas inquebrantables

1. **Solo `pnpm`.** Prohibido `npm`, `yarn` y `npx` (usa `pnpm exec` y `pnpm dlx`). `packageManager` lleva una versión exacta; usa la misma que fija SarinBotSAAS (`pnpm@11.23.0`, con Node 24).
2. **Referencias de solo lectura.** `E:\Proyectos\Sarin Bot` y los repositorios `andresleosan/SarinBotSAAS` y `andresleosan/AgendIA`. Nunca los modifiques ni copies sus `.env`, claves o identificadores de cuenta. Se adaptan sus **patrones** (pago por captura, desbloqueo de 24 h, cuotas, consola de superadministrador, WhatsApp Cloud API), no su infraestructura: ellos corren Next.js en un contenedor; este proyecto es solo edge.
3. **La IA propone y una persona confirma.** Ninguna herramienta de IA escribe dinero en firme. Todo lo que venga de voz, imagen o WhatsApp genera una propuesta que alguien aprueba con un toque.
4. **El `business_id` sale siempre de la sesión verificada**, nunca de lo que envía el navegador.
5. **Nada de secretos ni datos personales en el repositorio.** El correo del superadministrador tampoco: va en una variable de Cloudflare.
6. **Nada escribe a personas reales ni recoge datos del público** hasta que el dueño encienda el interruptor correspondiente (A3).
7. **Prohibido cualquier interruptor que salte la autenticación**, ni siquiera para pruebas.
8. **No declares comprobado lo que no corrió.**

### A2. Decisiones del dueño (ya tomadas; no las reabras)

| # | Tema | Decisión | Alternativa descartada |
| --- | --- | --- | --- |
| 1 | Alojamiento | **Un solo Worker de Cloudflare** con archivos estáticos: SPA + API + cron en un despliegue. Dominio: `workers.dev` y luego `tulistanegra.com`. | Cloudflare Pages: no admite Cron Triggers y Cloudflare recomienda Workers para proyectos nuevos. |
| 2 | Interfaz | React + Vite (SPA instalable como PWA). | Next.js con OpenNext: más peso sin beneficio en un panel privado. |
| 3 | Semáforo comunitario | **Fuera** de la primera versión. Tarea bloqueada hasta visto bueno legal por escrito. | — |
| 4 | Documento del deudor | **Opcional.** Un deudor se crea solo con nombre o apodo. | Obligatorio: choca con importar cuadernos, que no traen documento. |
| 5 | Cobro por WhatsApp, fase 1 | Desde el WhatsApp **del tendero**, con el mensaje ya escrito (enlace `wa.me`). El bot llega en la fase 4. | — |
| 6 | Texto de los cobros | **Plantillas fijas** con variables. La IA no redacta cobros. | — |
| 7 | Cuotas del pase de 30 días | 60 fotos · 300 interacciones de IA · 250 cobros por bot. | «Ilimitado bajo uso justo»: no se puede programar. |
| 8 | Repositorio | Trátalo como **público**. | — |

Si falta una decisión, aplica la opción más simple y reversible, anótala en la evidencia de la tarea y añade una fila a la cola del dueño.

### A3. Interruptores (en `vars` de `wrangler.jsonc`, todos en `"0"` al empezar)

| Interruptor | Qué enciende | Quién lo enciende |
| --- | --- | --- |
| `SIGNUP_READY` | Registro abierto al público. Apagado: solo entran los correos de `SUPERADMIN_EMAILS` y `PILOT_EMAILS`. | Dueño |
| `AI_READY` | Llamadas reales a DeepSeek y Workers AI (cuestan dinero). | Dueño |
| `WHATSAPP_SEND_READY` | Envío real de mensajes por el bot. | Dueño |
| `SEMAFORO_READY` | Semáforo comunitario. | Dueño, con visto bueno legal |

Con el interruptor apagado se construye y se comprueba igual, contra simuladores locales.
