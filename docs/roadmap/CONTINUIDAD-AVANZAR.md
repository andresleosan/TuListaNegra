# Continuidad de `/avanzar` · autorizaciones

Vigente desde 2026-11-14. Solo el dueño cambia este archivo.

**Autorizado sin preguntar**

| Qué | Condiciones |
| --- | --- |
| Commits en `main` y push si existe remoto | Solo archivos propios, pruebas del lote pasadas, sin forzar. |
| Trabajar sin parar entre tareas y lotes | Un bloqueo localizado no detiene lo demás. |
| Subagentes | Un escritor por archivo. |
| Todo lo local: D1 y R2 locales, simuladores, datos ficticios | — |
| Lecturas de producción | Sin escribir datos ni imprimir secretos. |
| Migraciones aditivas en D1 remoto | Pasos del punto 6 de la skill. |
| Desplegar el Worker | Tras pasar las comprobaciones del lote y con los interruptores de A3 intactos. |

**No autorizado: va a la cola**

- Los cuatro interruptores de A3 y cualquier otro que escriba a personas, recoja datos del público o gaste dinero.
- `SUPERADMIN_EMAILS`, credenciales, claves, DNS, dominios y la configuración de Firebase, Meta y Cloudflare.
- Migraciones no aditivas, restauraciones, escrituras de prueba en producción y borrado de datos reales.
- Cualquier cambio en Sarin Bot o AgendIA.
- Cuentas externas, trámites legales y cualquier gasto.

Lo que no esté en ninguna lista y sea difícil de revertir o salga del repositorio se trata como no autorizado.
