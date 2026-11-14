# Mejoras fuera de alcance

Ideas que no bloquean ninguna tarea. Una línea cada una: fecha, qué y por qué.

- 2026-11-14 · Pagos: llevar la elegibilidad del desbloqueo de 24 h al SQL del batch. Hoy se lee el último pago revisado y luego se escribe; si el superadministrador rechaza en esos milisegundos, el desbloqueo se decide con datos viejos.
- 2026-11-14 · Pagos: barrido periódico de capturas huérfanas en R2 (objeto sin fila si el Worker muere entre subir y guardar).
- 2026-11-14 · Pagos: decidir como producto qué pasa si una tienda en prueba o activa sube captura y vence antes de la revisión (queda en solo lectura con un pago pendiente y sin desbloqueo, tal como dice B2).
- 2026-11-14 · Ids: el ULID no es monótono dentro del mismo milisegundo; los listados ordenan por fecha y luego id.
- 2026-11-14 · Mora (revisión independiente): `estadoDeudor` cuenta los días de alerta en bloques de 24 h desde la hora del fiado, no en días de calendario de Bogotá (B1); y el servidor acepta cualquier entero en `promised_payment_date` en vez de forzar las 00:00 de Bogotá. Diferencia de horas, no de días.
- 2026-11-14 · Cuotas gratis (revisión independiente): el reinicio de 30 días ocurre al gastar la primera unidad del ciclo nuevo; hasta entonces `GET /api/negocio` muestra los `usados` del ciclo viejo. La pantalla no debe bloquear por `usados >= límite` en una cuenta gratis; mejor, calcular el reinicio también al leer.
