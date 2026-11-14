# AGENTS.md · TuListaNegra

Para avanzar el proyecto: lee `.agents/skills/avanzar/SKILL.md` y síguela entera. Especificación en `docs/spec/`, diseño en `DESIGN.md`.

## Reglas inquebrantables (A1)

1. **Solo `pnpm`.** Prohibido `npm`, `yarn` y `npx` (usa `pnpm exec` y `pnpm dlx`). `packageManager` lleva una versión exacta; usa la misma que fija SarinBotSAAS (`pnpm@11.23.0`, con Node 24).
2. **Referencias de solo lectura.** `E:\Proyectos\Sarin Bot` y los repositorios `andresleosan/SarinBotSAAS` y `andresleosan/AgendIA`. Nunca los modifiques ni copies sus `.env`, claves o identificadores de cuenta. Se adaptan sus **patrones** (pago por captura, desbloqueo de 24 h, cuotas, consola de superadministrador, WhatsApp Cloud API), no su infraestructura: ellos corren Next.js en un contenedor; este proyecto es solo edge.
3. **La IA propone y una persona confirma.** Ninguna herramienta de IA escribe dinero en firme. Todo lo que venga de voz, imagen o WhatsApp genera una propuesta que alguien aprueba con un toque.
4. **El `business_id` sale siempre de la sesión verificada**, nunca de lo que envía el navegador.
5. **Nada de secretos ni datos personales en el repositorio.** El correo del superadministrador tampoco: va en una variable de Cloudflare.
6. **Nada escribe a personas reales ni recoge datos del público** hasta que el dueño encienda el interruptor correspondiente (A3).
7. **Prohibido cualquier interruptor que salte la autenticación**, ni siquiera para pruebas.
8. **No declares comprobado lo que no corrió.**
