# Estado · registro de cierres

Lo más nuevo arriba: fecha · código · qué cambió para el tendero o el superadministrador · progreso antes → después.

- 2026-11-14 · WAP-02 · En Ajustes el tendero genera un código y lo envía por WhatsApp desde el número de su tienda; al verificarlo, sus mensajes cuentan como órdenes. Funciona con el simulador hasta que exista el número de TuListaNegra. · 31 → 32 de 39
- 2026-11-14 · WAP-05 · Cuando un deudor manda por WhatsApp la foto de su pago, queda un abono pendiente con la foto para que el tendero lo apruebe; si dice una fecha, se le pregunta y se anota al confirmar; si escribe «SALIR», no se le vuelve a cobrar. Por ahora contra el simulador. · 30 → 31 de 39
- 2026-11-14 · IAS-03 · Al encender la IA, la bandeja de pagos mostrará el monto y la referencia leídos de cada captura y alertará si el monto no cuadra o la referencia ya se usó, también en otra tienda; nunca aprueba sola. · 29 → 30 de 39
- 2026-11-14 · IAS-02 · El tendero le escribe (o dicta con el teclado) a Sarin «abónale veinte mil a don Carlos» y ve la propuesta con el saldo antes y después; nada se anota hasta que confirma. Apagado hasta encender la IA. · 28 → 29 de 39
- 2026-11-14 · WAP-04 · Cada mensaje de WhatsApp que llega se asigna a la tienda que corresponde (respuesta a su cobro, su dueño, la única que le escribió o la que el cliente elige con un botón); ninguna tienda ve mensajes de otra. Sin cambio visible aún. · 27 → 28 de 39
- 2026-11-14 · MOS-05 · TuListaNegra se puede instalar en el teléfono y, tras abrirla una vez, abre sin internet y busca en la copia guardada (sin fiar ni abonar hasta que vuelva la red). · 26 → 27 de 39
- 2026-11-14 · WAP-03 · El tendero puede cobrar con el bot de WhatsApp usando las plantillas de los tres tonos, con las mismas reglas de horario y permiso y su cuota; por ahora solo contra el simulador (el envío real espera la decisión del dueño). · 25 → 26 de 39
- 2026-11-14 · IAS-04 · El tendero pasa su cuaderno a la app: sube la foto, corrige la tabla mirándola y confirma; los deudores entran con su saldo y la foto como evidencia. La lectura automática espera a que se encienda la IA. · 24 → 25 de 39
- 2026-11-14 · WAP-01 · Existe la base de WhatsApp: webhook firmado, registro de mensajes sin duplicados y un simulador que permite probar toda la fase 4 sin Meta y sin escribir a nadie. Sin cambio visible. · 23 → 24 de 39
- 2026-11-14 · SUP-01..04 · El superadministrador tiene su consola: revisa capturas y aprueba o rechaza pagos con motivo, busca negocios y les da cortesía, gratis, suspensión o reactivación con motivo, y ve los indicadores. · 19 → 23 de 39
- 2026-11-14 · SUS-01, AJU-01 · El tendero elige su pase, ve dónde pagar y sube la captura desde la app; en Ajustes cambia cómo le pagan, los días para pasar a mora y el tono de cobro, y lo ve en el recibo y en el cobro. · 17 → 19 de 39
- 2026-11-14 · MOS-03, MOS-04 · Cada deudor tiene su ficha con saldo corrido y recibo compartible por WhatsApp; Morosos los ordena por antigüedad y cobra con tres tonos, sin abrir nada si el horario o el permiso no lo dejan. · 15 → 17 de 39
- 2026-11-14 · MOS-01, MOS-02 · El mostrador funciona: buscar por nombre, apodo, código o documento, fiar $ 5.000 en 3 toques, abonar con recibo y alerta al pasar el tope; sin conexión se sigue buscando. · 13 → 15 de 39
- 2026-11-14 · SUS-03 · El sistema deja anotado cada hora el aviso de 3 días, 1 día y vencido de cada tienda (el envío por WhatsApp llega en la fase 4); en la app el aviso ya se veía. · 12 → 13 de 39
- 2026-11-14 · IAS-01 · Existe el cliente de IA con cuota por plan y sin enviar documentos, teléfonos ni saldos. Apagado hasta que el dueño encienda AI_READY. · 11 → 12 de 39
- 2026-11-14 · AUT-02 (parcial) · Ya se puede entrar, crear la tienda con su prueba de 3 días y ver el mostrador vacío con «Te quedan 3 días». Probado con el simulador local; falta el ingreso real de Firebase (cola del dueño). · 11 de 39
- 2026-11-14 · SEG-01 · Una prueba automática ataca cada ruta con dos tiendas y falla si una ve o cambia algo de la otra, o si alguien añade una ruta sin protegerla. Sin cambio visible. · 10 → 11 de 39
- 2026-11-14 · SUS-02 · Una tienda vencida que sube su captura de pago queda desbloqueada 24 horas para seguir atendiendo, salvo que su último pago haya sido rechazado. Falta la pantalla. · 9 → 10 de 39
- 2026-11-14 · LIB-01 · La API ya fía, abona y ajusta con el saldo exacto aunque lleguen muchos toques a la vez, sin duplicar si se reintenta, y sabe desde cuándo debe cada deudor. Falta la pantalla (MOS-02). · 8 → 9 de 39
- 2026-11-14 · DEU-01 · La API ya permite crear deudores con solo el nombre, darles su código TLN, editarlos, archivarlos y marcarlos en lista negra, con el límite de 15 en la prueba. Falta la pantalla (MOS-01). · 7 → 8 de 39
- 2026-11-14 · AUT-03 · La API ya sabe en qué estado está cada tienda (prueba, activa, desbloqueo, vencida, suspendida, gratis) y qué puede hacer en cada uno. Sin pantalla aún. · 6 → 7 de 39
- 2026-11-14 · BAS-02 · Ya existe el aspecto de la app (papel, tinta, sellos de caucho, montos y tirilla de recibo) con contraste comprobado. Visible en la página de muestra de desarrollo. · 5 → 6 de 39
- 2026-11-14 · COB-01 · Las reglas de cuándo se puede cobrar por WhatsApp (consentimiento, horario, festivos, frecuencia) ya existen y explican al tendero por qué no. Sin cambio visible aún. · 4 → 5 de 39
- 2026-11-14 · AUT-01 · La API ya solo atiende a quien trae una sesión válida de Firebase; lo demás recibe 401. Sin cambio visible. · 3 → 4 de 39
- 2026-11-14 · BAS-03 · La base de datos ya tiene negocios, pagos, deudores, libro y auditoría, con protecciones para que el dinero no se edite ni se borre. Sin cambio visible. · 2 → 3 de 39
- 2026-11-14 · BAS-04 · Quedaron escritos los patrones que se adaptan de Sarin Bot y el contrato del puente de WhatsApp. Sin cambio visible. · 1 → 2 de 39
- 2026-11-14 · BAS-01 · Existe la base del proyecto: un Worker que sirve la app y la API, con pruebas y comprobación previa a publicar. Aún nada visible para el tendero. · 0 → 1 de 39
