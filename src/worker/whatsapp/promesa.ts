// Lectura SIN IA de lo que escribe un deudor (WAP-05, producto.md B4): «SALIR» y una fecha de pago simple.
// Módulo puro. Conjunto pequeño y explícito: lo que no está aquí no se reconoce y no hace nada.
//
// Baja: el mensaje ENTERO, sin mayúsculas, tildes, espacios de más ni puntuación, es una de BAJA, sola o seguida de una
// cortesía corta («salir por favor», «salir gracias»). («SALIR» es lo que piden las plantillas de cobro.)
// «quiero salir» o «quiero salir de la deuda» no cuentan.
//
// Fecha de pago, en cualquier parte del texto, con días de calendario de Bogotá contados desde que lo escribió:
// - «mañana» → +1 (no «la mañana», «esta mañana», «una mañana», «hasta mañana»); «pasado mañana» → +2.
// - «el|este <día de la semana>» → el próximo, de 1 a 7 días después («el viernes» dicho un viernes es el siguiente).
//   Con número («el viernes 27») → esa fecha, solo si cae en ese día de la semana; si no, no hay promesa.
// - «<D> de <mes>» → esa fecha, este año o el siguiente, si cae dentro del horizonte.
// - «el <D>» (sin «de <mes>», montos ni horas detrás) → el próximo día D, dentro del horizonte.
// Si el texto trae dos fechas distintas, o una que no es estrictamente posterior a hoy (o fuera del horizonte), no hay
// promesa: no se adivina. Tampoco si habla en pasado de un pago («ya le pagué el viernes») o niega («mañana no puedo»).
// No se reconocen «hoy» (no es futuro), «la otra semana» ni «el próximo viernes» (ambiguos en Colombia).
//
// La fecha reconocida es solo una PROPUESTA: el deudor la confirma con un botón antes de guardarla (A1.3, ./procesar.ts).

const HORA = 3_600_000;
const DIA = 24 * HORA;
/** America/Bogota es UTC−5 fijo (como en src/shared/contacto.ts). */
const DESFASE_BOGOTA_MS = 5 * HORA;
/** Una promesa más lejana que esto no se toma: así «15 de noviembre» dicho el 17 no se vuelve el del año siguiente. */
export const HORIZONTE_PROMESA_DIAS = 90;

const BAJA = new Set(['salir', 'stop', 'baja', 'no mas mensajes', 'no me escriban mas']);
/** Cortesías cortas que pueden seguir a una frase de baja. */
const CORTESIA = / (?:por favor|porfavor|porfa|gracias|muchas gracias)$/;
/** Niega o habla de un pago ya hecho: no hay promesa. */
const SIN_PROMESA = /\b(?:no|nunca|tampoco|pague|consigne|abone|transferi|deposite|cancele|gire)\b/;
/** Lo que, detrás de «el <D>», lo vuelve un monto o una hora y no un día. */
const NO_ES_DIA = '(?!\\s*(?:mil|millon|millones|pesos|lucas|k|am|pm|h|hrs|horas)\\b|\\s*%|[.,:]\\d| \\d{3}\\b| de la (?:manana|tarde|noche)\\b)';
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES = `(${MESES.join('|')}|setiembre)`;

/** Minúsculas, sin tildes y con un solo espacio entre palabras. */
const normalizar = (texto: string) => texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const numeroDeMes = (nombre: string) => (nombre === 'setiembre' ? 8 : MESES.indexOf(nombre));

/** Día de calendario de Bogotá, contado desde la época (el mismo número que el de `Date.UTC` de esa fecha / DIA). */
const diaBogota = (t: number) => Math.floor((t - DESFASE_BOGOTA_MS) / DIA);
/** 00:00 de Bogotá de ese día, en ms UTC. */
export const inicioDiaBogota = (dia: number) => dia * DIA + DESFASE_BOGOTA_MS;

export function esBaja(texto: string): boolean {
  const n = normalizar(texto.replace(/[^\p{L}\p{N}\s]/gu, ' '));
  return BAJA.has(n) || BAJA.has(n.replace(CORTESIA, ''));
}

/** Día `d` del mes `mes` (0–11) del año `anio`, o null si no existe (31 de abril). */
function fecha(anio: number, mes: number, d: number): number | null {
  const t = Date.UTC(anio, mes, d);
  return new Date(t).getUTCDate() === d ? t / DIA : null;
}

const enHorizonte = (dia: number | null, hoy: number) => dia !== null && dia > hoy && dia - hoy <= HORIZONTE_PROMESA_DIAS;

/** Primer día futuro (dentro del horizonte) de entre los candidatos, en orden. */
const primero = (candidatos: (number | null)[], hoy: number) => candidatos.find((dia) => enHorizonte(dia, hoy)) ?? null;

/**
 * 00:00 de Bogotá del día prometido en `texto`, contado desde `referencia` (ms UTC, cuando lo escribió); null si no se
 * reconoce una sola fecha futura.
 */
export function fechaPrometida(texto: string, referencia: number): number | null {
  const n = normalizar(texto);
  if (SIN_PROMESA.test(n)) return null;
  const hoy = diaBogota(referencia);
  const local = new Date(hoy * DIA);
  const [anio, mes] = [local.getUTCFullYear(), local.getUTCMonth()];
  const dias: (number | null)[] = [];
  const semana = (dia: number) => (dia + 4) % 7; // el 1 de enero de 1970 fue jueves
  /** Próximo día D (este mes o de los tres siguientes) dentro del horizonte. */
  const proximoDia = (d: number) => primero([0, 1, 2, 3].map((i) => fecha(anio, mes + i, d)), hoy);
  const conMes = (d: number, nombreMes: string) => primero([fecha(anio, numeroDeMes(nombreMes), d), fecha(anio + 1, numeroDeMes(nombreMes), d)], hoy);

  for (const _ of n.matchAll(/(?<!\bhasta )\bpasado manana\b/g)) dias.push(hoy + 2);
  for (const _ of n.matchAll(/(?<!\b(?:la|esta|una|pasado|hasta) )\bmanana\b/g)) dias.push(hoy + 1);
  for (const m of n.matchAll(new RegExp(`\\b(?:el|este) (${DIAS.join('|')})\\b(?: (\\d{1,2})\\b${NO_ES_DIA}(?: de ${MES}\\b)?)?`, 'g'))) {
    const diaSemana = DIAS.indexOf(m[1]!);
    if (m[2] === undefined) {
      dias.push(hoy + ((diaSemana - semana(hoy) + 6) % 7) + 1);
      continue;
    }
    // «el viernes 27»: vale solo si el 27 cae en viernes.
    const dia = m[3] === undefined ? proximoDia(Number(m[2])) : conMes(Number(m[2]), m[3]);
    dias.push(dia !== null && semana(dia) === diaSemana ? dia : null);
  }
  for (const m of n.matchAll(new RegExp(`\\b(\\d{1,2}) de ${MES}\\b`, 'g'))) dias.push(conMes(Number(m[1]), m[2]!));
  for (const m of n.matchAll(new RegExp(`\\bel (\\d{1,2})\\b(?! de ${MES}\\b)${NO_ES_DIA}`, 'g'))) dias.push(proximoDia(Number(m[1])));

  const distintos = new Set(dias);
  if (distintos.size !== 1) return null;
  const [dia] = distintos;
  return enHorizonte(dia!, hoy) ? inicioDiaBogota(dia!) : null;
}
