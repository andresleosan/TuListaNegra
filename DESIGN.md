# DESIGN · «Libro mayor y recibo térmico»

- **Prohibido** el aspecto genérico de IA: fondos oscuros espaciales, gradientes neón, glassmorphism y librerías de componentes prefabricados.
- Fondo papel `#F6F4EE`; tarjetas `#FFFFFF` y `#EFECE6`; tinta `#141413`.
- Bordes sólidos de 1,5 y 2 px con sombra dura `2px 2px 0 #141413`.
- Sellos de estado tipo caucho: verde `#166534` (al día, abonos), ámbar `#D97706` (promesas, avisos), rojo `#DC2626` (mora, tope excedido, lista negra). Cada sello lleva **texto** además de color.
- El ámbar no se usa como color de texto sobre fondo claro (no alcanza contraste): va como fondo del sello con texto en tinta.
- Tipografía: `Plus Jakarta Sans` para texto. Monoespaciada tabular (`JetBrains Mono`) para montos (`$ 49.900`), documentos, códigos y tirillas. Fuentes autoalojadas.
- Primero móvil (360 px). Zonas táctiles de 44 px como mínimo. Contraste AA.

## Tokens

Viven en `src/web/styles/tokens.css`. Los colores se repiten en `src/web/styles/pares.ts` y `contraste.test.ts` falla si dejan de coincidir o si un par usado baja de 4,5:1.

### Color

| Variable | Valor | Uso | Pares de contraste (texto sobre fondo) |
| --- | --- | --- | --- |
| `--papel` | `#F6F4EE` | Fondo de la app | tinta 16,76 · verde 6,48 |
| `--blanco` | `#FFFFFF` | Tarjeta, tirilla, fondo de sello; texto sobre tinta, verde o rojo | tinta 18,43 · verde 7,13 · rojo 4,83 |
| `--crema` | `#EFECE6` | Tarjeta alterna, botón deshabilitado | tinta 15,63 · verde 6,05 |
| `--tinta` | `#141413` | Texto, bordes, sombra, botón primario | blanco 18,43 |
| `--verde` | `#166534` | Al día, abonos | como texto sobre papel, blanco o crema |
| `--ambar` | `#D97706` | Promesas y avisos, **solo como fondo** | tinta 5,79 |
| `--rojo` | `#DC2626` | Mora, tope excedido, lista negra, peligro | blanco 4,83 (y rojo sobre blanco 4,83) |

No alcanzan AA y por eso no se usan: ámbar como texto (2,90 sobre papel, 3,19 sobre blanco) y rojo como texto sobre papel (4,39) o crema (4,10). **El rojo como texto solo va sobre `--blanco`.**

### Forma, espacio y tipografía

| Variable | Valor | Uso |
| --- | --- | --- |
| `--borde-fino` | `1.5px solid` tinta | Tarjeta, tirilla |
| `--borde-grueso` | `2px solid` tinta | Botón, subrayado de títulos de sección |
| `--sombra-dura` | `2px 2px 0 #141413` | Botón, tarjeta, tirilla. Nunca difuminada |
| `--radio` | `4px` | Único radio. La tirilla va sin radio |
| `--esp-1` … `--esp-8` | 4, 8, 12, 16, 24, 32 px | Espaciado (base 4 px) |
| `--toque` | `44px` | Alto mínimo de todo lo que se pulsa |
| `--fuente-texto` | Plus Jakarta Sans | Texto |
| `--fuente-mono` | JetBrains Mono, cifras tabulares, sin ligaduras | Montos, códigos, documentos, tirillas |
| `--texto-s` | 13 px | Sellos, etiquetas, cuerpo de tirilla |
| `--texto-m` | 16 px | Cuerpo y botones |
| `--texto-l` | 20 px | Títulos de sección |
| `--texto-xl` | 28 px | Título de pantalla, saldo destacado |

Separadores dentro de tarjetas y tirillas: línea discontinua de 1,5 px en tinta.

## Piezas (`src/web/ui/`)

- **`Boton`**: `primaria` (tinta, texto blanco), `secundaria` (blanco, texto tinta), `peligro` (rojo, texto blanco). Borde grueso, sombra dura, alto mínimo de 44 px. Al pulsar se desplaza 2 px sobre su sombra, sin transición. Deshabilitado: fondo crema, borde discontinuo, sin sombra y texto en tinta (sigue legible; no se atenúa con opacidad).
- **`Tarjeta`**: blanca o `crema`. Borde fino, sombra dura.
- **`Sello`**: borde doble de 4 px, mayúsculas, 800, rotación de −2°. Siempre con texto. `AL_DIA` verde sobre blanco; `PROMESA_PAGO` tinta sobre ámbar; `EN_MORA` rojo sobre blanco; `LISTA_NEGRA` blanco sobre rojo (relleno, para distinguirse de mora); `CON_SALDO` tinta sobre blanco. El sello trae su propio fondo: se puede poner sobre papel o crema.
- **`Monto`**: `formatoCOP` (`$ 49.900`, negativos `−$ 5.000`), monoespaciada tabular, sin salto de línea; hereda el tamaño. Tono `verde` para abonos; tono `rojo` solo sobre tarjeta blanca.
- **`Tirilla`**: recibo de 320 px de ancho máximo, fondo blanco, todo en monoespaciada: tienda, código del deudor, líneas concepto/monto, total y fecha, separados por líneas discontinuas. Lleva fondo y borde propios para que su captura sea el recibo completo.
- **`Campo`**: etiqueta visible encima (700), ayuda opcional en 13 px, entrada blanca con borde grueso, alto mínimo de 44 px y texto de 16 px (con menos, iOS amplía la página). Con error: borde rojo y, debajo, el mensaje en rojo sobre **fondo blanco propio** con borde rojo (así se puede usar sobre papel o crema), enlazado con `aria-describedby` y anunciado con `role="alert"`.
- **`Casilla`**: cuadro de 24 px con borde grueso dentro de una fila de 44 px que se pulsa entera; marcada, cuadro en tinta con visto bueno blanco. Admite enlaces en el texto y el mismo mensaje de error que `Campo`.
- **`Aviso`**: nota al margen. Fondo blanco, borde fino y franja izquierda de 8 px en ámbar (`atencion`), rojo (`error`, se anuncia) o verde (`bien`). Título en 800 y texto siempre en tinta: el color nunca va solo.
- **`Progreso`**: «Paso X de N · nombre» y una fila de tramos de 8 px con borde fino; los pasos hechos van en tinta y el actual, medio lleno. Lleva `role="progressbar"`.
- **Foco**: contorno de 3 px en tinta separado 2 px, en todo elemento enfocable.

## Esqueleto de la app (`src/web/pantallas/`)

- **`Hoja`**: pantallas de una columna de 28 rem como máximo (ingreso, alta, avisos, textos legales). Arriba, la marca: «TuLista» en tinta y «Negra» en bloque de tinta con texto blanco.
- **`Esqueleto`**: cabecera blanca con el nombre de la tienda (800) y «Salir»; debajo, el aviso de estado como franja de lado a lado en mayúsculas de 13 px: ámbar con texto en tinta (prueba, vence pronto, pago en revisión), rojo con texto blanco (vencido) o crema. Navegación de cuatro secciones: fija abajo en móvil (56 px de alto), bajo la cabecera desde 768 px; la sección actual va en tinta con texto blanco. El contenido se centra a 60 rem.
- **Estado vacío del mostrador**: renglones de libro en blanco (cabecera en monoespaciada, líneas discontinuas), una frase que invita y un solo botón.

## Prohibido

- Fondos oscuros, gradientes, glassmorphism, sombras difusas, radios mayores de 4 px (píldoras, círculos decorativos).
- Librerías de componentes, Tailwind, CSS-in-JS. Solo CSS plano con las variables de `tokens.css`.
- Colores fuera de la tabla o escritos a mano en una pieza; opacidad para atenuar texto.
- Ámbar como texto. Rojo como texto fuera de fondo blanco.
- Estado comunicado solo con color: siempre con texto.
- Fuentes servidas por terceros. Montos, códigos o documentos en fuente proporcional.
- Animaciones decorativas. Si algo se anima, respeta `prefers-reduced-motion`.
