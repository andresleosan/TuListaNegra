---
name: avanzar
description: Avanza el checklist de TuListaNegra sin detenerse (elige por la ruta, construye, verifica, publica y sigue).
---

# /avanzar · bucle de avance de TuListaNegra

Dónde vive cada cosa: reglas e interruptores (A1–A3) en `docs/spec/reglas.md`; producto (B1–B7) en `docs/spec/producto.md`; diseño en `DESIGN.md`; fichas en `docs/roadmap/tasks/`; autorizaciones, cola del dueño, mejoras y registro en `docs/roadmap/`; relevo privado en `.avanzar/relevo.md`.

**1. Arranque: un minuto, sin preguntas**

1. `git pull --ff-only` si hay remoto. Los commits propios sin publicar se conservan. Nunca `reset --hard`, `clean`, `stash`, rebase ni force-push.
2. `pnpm ruta` y anuncia `Progreso: X de Y · Z %`.
3. Lee `CONTINUIDAD-AVANZAR.md`, `COLA-DUENO.md` (aplica lo que el dueño ya respondió y borra esa fila) y `.avanzar/relevo.md` si existe: lo que quedó a medias va primero.

La fuente de cada tarea es su ficha, `docs/spec/` y `DESIGN.md`. No releas registros largos.

**2. Elegir: cerrar antes de abrir**

Dentro de «Cerrables ahora»: primero las que solo esperan una comprobación, después las `apagada`, después lo que más desbloquea. Lotes de **hasta 4 tareas** cuyos `resources` no se solapen. Una tarea que necesita al dueño no se espera: fila en la cola y siguiente. No abras una tarea nueva mientras otra del lote pueda cerrarse.

**3. Criterio de «hecho»**

Una tarea está hecha cuando se cumplen las tres:

- Cumple su `criterio` y lo que promete su título.
- Está en `main` y, si lleva migración o interruptor autorizado, aplicada y encendido.
- Se comprobó su recorrido y la evidencia está en la ficha.

Lo que corresponde a otra tarea se mueve al `falta` de esa otra. Las mejoras fuera de alcance van a `MEJORAS.md` y no bloquean, salvo que sean graves: fuga de datos personales, fallo de permisos, pérdida de datos o dinero mal calculado. Si un criterio exige un servicio real apagado (Meta, DeepSeek, Firebase), se comprueba contra el simulador, la tarea queda `parcial` y el `falta` nombra solo ese criterio.

**4. Decidir sin detenerse**

No uses herramientas de preguntas ni esperes respuesta. Decide con la primera fuente que lo resuelva:

1. Instrucción del dueño en la sesión y `CONTINUIDAD-AVANZAR.md`.
2. `docs/spec/reglas.md` y `docs/spec/producto.md`.
3. `DESIGN.md` para interfaz; `docs/spec/referencias.md` para patrones.
4. Si nada lo resuelve: la opción más simple y reversible que cumpla el título.

Anota la decisión y su fuente en la evidencia. Lo que solo el dueño puede hacer o decidir va a la cola, y sigues con otra tarea.

**5. Construir**

- Lógica de dinero, permisos, estados y cuotas: primero la prueba que falla.
- El mínimo código que cumple. Sin dependencias nuevas para lo que resuelven pocas líneas.
- Interfaz con los valores de `DESIGN.md`.
- **Subagentes**, si tu herramienta los ofrece: uno por tarea del lote, con encargo cerrado (ficha, criterio, pruebas que debe pasar, «devuelve el commit y lo que no pudiste comprobar»). Un solo escritor por archivo. Quien orquesta integra los commits uno a uno.
- **Revisión independiente** por lote si toca dinero, permisos, datos de personas, migraciones, sesión o la consola. El revisor recibe el diff, no tus conclusiones.

**6. Migrar y encender** (solo lo que `CONTINUIDAD-AVANZAR.md` autoriza)

1. `pnpm exec wrangler d1 migrations list tulistanegra --remote` y lee cada archivo entero. **Aditiva:** crear tabla, índice o vista y añadir columna. **No aditiva:** borrar, renombrar o reconstruir tablas con datos, `UPDATE` o `DELETE` sobre filas existentes → cola.
2. Ensayo sobre una base local nueva con todas las migraciones.
3. Punto de recuperación: `pnpm exec wrangler d1 time-travel info tulistanegra`; guarda el marcador en el relevo.
4. Aplica solo los archivos revisados, en orden. Un resultado incierto se comprueba antes de repetir.
5. Los interruptores de A3 nunca los enciendes tú.
6. Tras desplegar, comprueba el recorrido real con lecturas.

**7. Verificar y publicar: una vez por lote**

```sh
pnpm test && pnpm typecheck && pnpm build && pnpm check:release
```

1. Si cambia la interfaz: recorrido en navegador a 360 y 1280 px.
2. Distingue fallo del cambio, fallo anterior y comprobación que el entorno no permite.
3. Actualiza cada ficha: `estado`, `hecho`, `falta`, `nextStep`, `evidencia`, `actualizado`.
4. Una línea por cierre arriba de `ESTADO.md`: fecha, código, qué cambió para el tendero o el superadministrador y progreso antes → después.
5. Commit corto en inglés con solo tus archivos. Si hay remoto: `git pull --ff-only` y `git push origin main` sin prompts interactivos y con límite de tiempo. Si falla la credencial: commits en local, sigue con otro lote y dilo al final.
6. Si BAS-05 está hecha y el despliegue está autorizado: despliega y comprueba la URL.
7. Sobrescribe `.avanzar/relevo.md` y vuelve al arranque.

**Contexto largo.** Tras una compactación, o si dudas de algo que «recuerdas», vuelve a leer la skill, el relevo y la ruta. No reconstruyas de memoria commits, estados ni resultados de pruebas.

**8. Cuándo parar**

Solo si el dueño lo pide, no queda ninguna tarea viable o se alcanza un límite real de la sesión. Un lote terminado, una tarea bloqueada o una prueba fallida no son motivo.

Al parar: sobrescribe `.avanzar/relevo.md` (máximo 40 líneas: último commit publicado, trabajo local sin publicar, puntos de recuperación, siguiente paso exacto) y responde al dueño en lenguaje simple: progreso antes → después, qué cambió y cómo probarlo, las filas nuevas de la cola y qué conviene para la próxima sesión.
