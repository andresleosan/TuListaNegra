import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NOMBRE_TONO, textoDeCobro, type Tono, TONOS } from '../../shared/cobro';
import { type DeudorResumen, estadoDeudor } from '../../shared/deudor';
import { api, ErrorApi, type MotivoFuera, type Negocio, type ResumenLote } from '../api';
import { refrescarCartera, useCartera } from '../cartera';
import { Enlace } from '../ruta';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { BotonCobrar } from '../ui/BotonCobrar';
import { Casilla } from '../ui/Casilla';
import { Monto } from '../ui/Monto';
import { Opcion } from '../ui/Opcion';
import { Sello } from '../ui/Sello';
import { Tarjeta } from '../ui/Tarjeta';
import './Morosos.css';

const DIA = 86_400_000;

const fechaDia = (ms: number) => new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', timeZone: 'America/Bogota' }).format(ms);

/**
 * En mora según B3 (fiado sin cubrir más viejo que los días de alerta, o promesa vencida), sin mirar la lista negra:
 * esa marca es privada del tendero y no borra la deuda vencida.
 */
const enMora = (d: DeudorResumen, ahora: number, dias: number) =>
  d.archived_at === null && d.current_balance_cop > 0 && estadoDeudor({ ...d, blacklisted_at: null }, ahora, dias) === 'EN_MORA';

/** El fiado sin pagar más viejo primero. */
const porAntiguedad = (a: DeudorResumen, b: DeudorResumen) =>
  (a.oldest_unpaid_date ?? Infinity) - (b.oldest_unpaid_date ?? Infinity) || (a.promised_payment_date ?? Infinity) - (b.promised_payment_date ?? Infinity);

/** Deudores por petición del cobro masivo: el mismo tope que pone el servidor (MAX_LOTE en cobros-bot.ts). */
const TANDA = 6;

const sumar = (a: ResumenLote, b: ResumenLote): ResumenLote => {
  const fuera = { ...a.fuera };
  for (const [m, k] of Object.entries(b.fuera) as [MotivoFuera, number][]) fuera[m] = (fuera[m] ?? 0) + k;
  return { simulado: a.simulado || b.simulado, enviados: a.enviados + b.enviados, sin_confirmar: a.sin_confirmar + b.sin_confirmar, fuera };
};

/**
 * Un cobro masivo en curso: la selección partida en tandas al primer toque y el request_id del lote completo. La tanda
 * `n` va con `<toque>-t<n>`: reintentar (tras un corte) repite los mismos ids y el servidor no envía nada dos veces.
 */
type Envio = { toque: string; tandas: string[][]; hechas: number; suma: ResumenLote };

/** Por qué quedó fuera cada uno, en palabras de tendero, para «Fuera 3: 2 sin autorización, 1 ya cobrado hoy». */
const FUERA: Record<MotivoFuera, (n: number) => string> = {
  SIN_CONSENTIMIENTO: () => 'sin autorización',
  BAJA: (n) => (n === 1 ? 'pidió no recibir mensajes' : 'pidieron no recibir mensajes'),
  DOMINGO: () => 'porque hoy es domingo',
  FESTIVO: () => 'porque hoy es festivo',
  FUERA_DE_HORARIO: () => 'fuera del horario de cobro',
  FESTIVOS_SIN_DATOS: () => 'sin calendario de festivos de este año',
  YA_COBRADO_HOY: (n) => (n === 1 ? 'ya cobrado hoy' : 'ya cobrados hoy'),
  FRECUENCIA: (n) => (n === 1 ? 'cobrado hace poco' : 'cobrados hace poco'),
  SIN_SALDO: () => 'sin saldo',
  SIN_TELEFONO: () => 'sin WhatsApp anotado',
  SIN_CUOTA: () => 'porque se acabaron tus cobros por bot',
  RECHAZADO: (n) => (n === 1 ? 'no aceptado por WhatsApp' : 'no aceptados por WhatsApp'),
  NO_ENCONTRADO: () => 'que ya no están en tu lista',
};

type Fallo = { titulo: string; texto: string; aSuscripcion?: boolean };

function explicarLote(e: unknown): Fallo {
  const fallo = e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido');
  if (fallo.error === 'bot_apagado') return { titulo: 'El bot de WhatsApp está apagado', texto: 'Cobra uno por uno con «Abrir WhatsApp».' };
  if (fallo.status === 403) return { titulo: 'Tu plan no incluye cobros por bot ahora', texto: 'Renueva tu pase para volver a usarlos.', aSuscripcion: true };
  if (fallo.status === 0) return { titulo: 'No hay conexión', texto: 'Revisa tu internet y vuelve a tocar el botón de enviar. A nadie le llegará dos veces.' };
  return { titulo: 'No pudimos enviar los cobros', texto: 'Es un problema nuestro, no tuyo. Vuelve a intentar en un momento.' };
}

/** «Enviados 7 · Fuera 3» y el detalle de quién quedó fuera y por qué. `parcial`: un envío que se cortó a mitad. */
function ResumenDelLote({ r, parcial = false }: { r: ResumenLote; parcial?: boolean }) {
  const motivos = Object.entries(r.fuera) as [MotivoFuera, number][];
  const fuera = motivos.reduce((suma, [, n]) => suma + n, 0);
  const titulo = (parcial ? 'Hasta ahora: ' : '') + [`Enviados ${r.enviados}`, `Fuera ${fuera}`, ...(r.sin_confirmar ? [`Sin confirmar ${r.sin_confirmar}`] : [])].join(' · ');
  return (
    <Aviso tono={r.enviados > 0 ? 'bien' : 'atencion'} titulo={titulo}>
      {fuera > 0 && (
        <p>
          Fuera {fuera}: {motivos.map(([m, n]) => `${n} ${FUERA[m](n)}`).join(', ')}. A ellos no se les envió nada ni se gastó tu cupo.
        </p>
      )}
      {r.sin_confirmar > 0 && <p>WhatsApp no confirmó {r.sin_confirmar === 1 ? 'un envío' : `${r.sin_confirmar} envíos`}: puede que sí haya llegado. No lo intentes de nuevo hoy.</p>}
      {r.fuera.SIN_CUOTA && (
        <p>
          Renueva tu pase en <Enlace a="/suscripcion">Suscripción</Enlace> para seguir cobrando por bot.
        </p>
      )}
      {r.simulado && r.enviados + r.sin_confirmar > 0 && <p>Fue un envío de prueba: el bot de WhatsApp todavía no está encendido, así que a nadie le llegó nada.</p>}
    </Aviso>
  );
}

/**
 * Cobro masivo por el bot (WAP-07): un tono para todos los elegidos, vista previa, confirmación con lo que gasta de la cuota
 * y el resumen del servidor, que deja fuera a quien no cumpla las reglas de contacto y dice por qué.
 */
function CobroMasivo({ negocio, morosos, elegidos, alElegir, children }: {
  negocio: Negocio;
  morosos: DeudorResumen[];
  /** `null` mientras no se está eligiendo; si no, los ids marcados. */
  elegidos: Set<string> | null;
  alElegir: (ids: Set<string> | null) => void;
  /** La lista: va entre el panel y la barra de envío, que se queda pegada abajo mientras se recorre. */
  children: ReactNode;
}) {
  const [tono, setTono] = useState<Tono>(negocio.tono_cobro);
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<Fallo | null>(null);
  const [resumen, setResumen] = useState<ResumenLote | null>(null);
  // Cuántos deudores van de cuántos y la suma de sus resúmenes: la barra de progreso y lo enviado antes de un corte.
  const [avance, setAvance] = useState<{ hechos: number; total: number; suma: ResumenLote } | null>(null);
  // Se conserva tras un fallo: reintentar sigue con los mismos ids. Un lote nuevo (Volver, Cancelar, otra selección u
  // otro tono) empieza de cero.
  const envio = useRef<Envio | null>(null);
  const caja = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (resumen) caja.current?.focus();
  }, [resumen]);
  // Al confirmar se sube al panel: la confirmación va junto al tono y la vista previa.
  useEffect(() => {
    if (confirmando) panel.current?.focus();
  }, [confirmando]);
  useEffect(() => {
    envio.current = null;
    setAvance(null);
  }, [elegidos, tono]);

  const restantes = Math.max(negocio.limites.cobros - negocio.usados.cobros, 0);
  const lista = elegidos && morosos.filter((d) => elegidos.has(d.id));
  const n = lista?.length ?? 0;
  const todos = n > 0 && n === morosos.length;
  const simulado = !negocio.bot_whatsapp_activo;
  // Un envío que se cortó después de alguna tanda: lo enviado hasta ahí y el botón para seguir.
  const partido = !enviando && avance && avance.hechos > 0 ? avance : null;

  function olvidarEnvio() {
    envio.current = null;
    setAvance(null);
  }

  /** Envía las tandas una tras otra (no a la vez) y suma sus resúmenes. Si una falla, se detiene ahí. */
  async function enviar() {
    setEnviando(true);
    setFallo(null);
    const ids = lista!.map((d) => d.id);
    const e = (envio.current ??= {
      toque: crypto.randomUUID(),
      tandas: Array.from({ length: Math.ceil(ids.length / TANDA) }, (_, i) => ids.slice(i * TANDA, (i + 1) * TANDA)),
      hechas: 0,
      suma: { simulado: false, enviados: 0, sin_confirmar: 0, fuera: {} },
    });
    const anotar = () => setAvance({ hechos: e.tandas.slice(0, e.hechas).flat().length, total: e.tandas.flat().length, suma: e.suma });
    anotar();
    try {
      while (e.hechas < e.tandas.length) {
        const r = await api<ResumenLote>('/cobros-bot/lote', { metodo: 'POST', cuerpo: { tono, request_id: `${e.toque}-t${e.hechas + 1}`, deudores: e.tandas[e.hechas] } });
        e.suma = sumar(e.suma, r);
        e.hechas += 1;
        anotar();
      }
      setResumen(e.suma);
      setConfirmando(false);
      alElegir(null); // y con eso se olvida el envío
      void refrescarCartera().catch(() => {});
    } catch (err) {
      setFallo(explicarLote(err));
    } finally {
      setEnviando(false);
    }
  }

  function revisar() {
    setFallo(n === 0 ? { titulo: 'No has elegido a nadie', texto: 'Marca la casilla «Elegir» de cada deudor, o elige a todos los de la lista.' } : null);
    if (n > 0) setConfirmando(true);
  }

  if (lista === null) {
    return (
      <>
        <div className="morosos__masivo" ref={caja} tabIndex={-1}>
          {resumen && <ResumenDelLote r={resumen} />}
          <Boton variante="secundaria" onClick={() => (setResumen(null), alElegir(new Set()))}>
            {simulado ? 'Cobrar a varios con el bot (simulado)' : 'Cobrar a varios con el bot'}
          </Boton>
        </div>
        {children}
      </>
    );
  }

  const ejemplo = lista[0];
  const aviso = fallo && (
    <Aviso tono="error" titulo={fallo.titulo}>
      <p>{fallo.texto}</p>
      {fallo.aSuscripcion && (
        <p>
          Ve a <Enlace a="/suscripcion">Suscripción</Enlace>.
        </p>
      )}
    </Aviso>
  );
  return (
    <>
      <section className="morosos__masivo morosos__masivo--abierto" aria-labelledby="morosos-masivo" ref={panel} tabIndex={-1}>
        <h2 id="morosos-masivo">Cobro masivo por el bot</h2>
        {!confirmando && (
          <>
            <p>Marca a quién cobrar. A cada uno le llega el mismo mensaje con su nombre y su saldo. Si alguien no cumple las reglas de cobro, se queda fuera y te decimos por qué.</p>
            <Boton variante="secundaria" onClick={() => alElegir(new Set(todos ? [] : morosos.map((d) => d.id)))}>
              {todos ? 'Quitar a todos' : `Elegir a todos los de la lista (${morosos.length})`}
            </Boton>
          </>
        )}
        <fieldset className="morosos__tonos">
          <legend>¿Cómo les escribes?</legend>
          {TONOS.map((t) => (
            <Opcion key={t} name="tono-masivo" titulo={NOMBRE_TONO[t]} checked={tono === t} onChange={() => setTono(t)} disabled={enviando} />
          ))}
        </fieldset>
        <div className="morosos__previa">
          <p className="morosos__etiqueta">{ejemplo ? `Así le llega a ${ejemplo.full_name}` : 'Así les llega'}</p>
          <p data-testid="previa-masivo">
            {ejemplo
              ? textoDeCobro(tono, { tienda: negocio.name, nombre: ejemplo.full_name, saldo_cop: ejemplo.current_balance_cop, medios_de_pago: negocio.payment_methods_info })
              : 'Elige al menos un deudor para ver el mensaje.'}
          </p>
        </div>
        {confirmando && (
          <>
            <Aviso titulo={`Vas a enviar ${n} ${n === 1 ? 'cobro' : 'cobros'} por el bot; gasta hasta ${n} de tu cuota`}>
              <p>
                Te quedan {restantes} de {negocio.limites.cobros} cobros por bot.
                {n > restantes && ` Solo alcanzan para ${restantes}: los demás quedarán fuera por falta de cupo.`}
                {simulado && ' El bot está en modo de prueba: a nadie le llegará nada.'}
              </p>
            </Aviso>
            {enviando && avance && (
              <div className="morosos__progreso">
                <p aria-live="polite">{`Enviando ${avance.hechos + 1} de ${avance.total}…`}</p>
                <div className="morosos__progreso-barra" role="progressbar" aria-label="Cobros enviados" aria-valuemin={0} aria-valuemax={avance.total} aria-valuenow={avance.hechos}>
                  <span style={{ width: `${(avance.hechos / avance.total) * 100}%` }} />
                </div>
              </div>
            )}
            <div className="morosos__botones">
              <Boton onClick={enviar} disabled={enviando}>
                {enviando ? 'Enviando…'
                  : partido ? (partido.total - partido.hechos === 1 ? 'Seguir con el que falta' : `Seguir con los ${partido.total - partido.hechos} que faltan`)
                  : `Sí, enviar ${n} ${n === 1 ? 'cobro' : 'cobros'}`}
              </Boton>
              <Boton variante="secundaria" onClick={() => (setConfirmando(false), setFallo(null), olvidarEnvio())} disabled={enviando}>
                Volver
              </Boton>
            </div>
            {partido && <ResumenDelLote r={partido.suma} parcial />}
            {aviso}
          </>
        )}
      </section>
      {children}
      {!confirmando && (
        <div className="morosos__barra" role="group" aria-label="Envío del cobro masivo">
          <p className="morosos__cuenta" aria-live="polite">
            <strong>{n}</strong> {n === 1 ? 'elegido' : 'elegidos'}
          </p>
          <div className="morosos__botones">
            <Boton onClick={revisar}>Revisar y enviar</Boton>
            <Boton variante="secundaria" onClick={() => (alElegir(null), setFallo(null), olvidarEnvio())}>
              Cancelar
            </Boton>
          </div>
          {aviso}
        </div>
      )}
    </>
  );
}

/** Morosos (`/morosos`): deudas vencidas por antigüedad, con su saldo, los días de atraso y el botón Cobrar. */
export function Morosos({ negocio }: { negocio: Negocio }) {
  const cartera = useCartera();
  const [fallo, setFallo] = useState(false);
  const [intento, setIntento] = useState(0);
  // Cobro masivo: `null` mientras no se está eligiendo; si no, los ids marcados.
  const [elegidos, setElegidos] = useState<Set<string> | null>(null);

  useEffect(() => {
    setFallo(false);
    refrescarCartera().catch(() => setFallo(true));
  }, [intento]);

  const ahora = Date.now();
  const dias = negocio.default_alert_days;
  const morosos = cartera.deudores.filter((d) => enMora(d, ahora, dias)).sort(porAntiguedad);
  const total = morosos.reduce((suma, d) => suma + d.current_balance_cop, 0);
  const sinCopia = cartera.actualizada_en === null;
  // Como el botón «Enviar con el bot»: solo con el bot encendido o en modo de prueba, y con IA en el plan.
  const masivo = negocio.permisos.ia && (negocio.bot_whatsapp_activo || negocio.bot_whatsapp_simulado);
  const marcar = (id: string, si: boolean) =>
    setElegidos((antes) => {
      const nuevo = new Set(antes);
      if (si) nuevo.add(id);
      else nuevo.delete(id);
      return nuevo;
    });

  const lista = (
    <ol className="morosos__lista" aria-label="Deudores en mora, el más antiguo primero">
      {morosos.map((d) => {
        const atraso = d.oldest_unpaid_date === null ? 0 : Math.floor((ahora - d.oldest_unpaid_date) / DIA);
        return (
          <li key={d.id} className="morosos__fila" data-testid="moroso">
            {masivo && elegidos && (
              <div className="morosos__elegir">
                <Casilla checked={elegidos.has(d.id)} onChange={(e) => marcar(d.id, e.target.checked)} aria-label={`Elegir a ${d.full_name}`}>
                  Elegir
                </Casilla>
              </div>
            )}
            <p className="morosos__dias">
              <strong>{atraso}</strong> {atraso === 1 ? 'día' : 'días'}
            </p>
            <div className="morosos__quien">
              <Enlace a={`/deudor/${d.id}`} className="morosos__nombre">
                {d.full_name}
              </Enlace>
              <p className="morosos__codigo">
                <code>{d.unique_code}</code>
                <Sello estado={estadoDeudor(d, ahora, dias)} />
              </p>
              <p className="morosos__detalle">
                {d.oldest_unpaid_date !== null && <>Debe desde el {fechaDia(d.oldest_unpaid_date)}. </>}
                {d.promised_payment_date !== null && <>Prometió pagar el {fechaDia(d.promised_payment_date)}. </>}
                {d.last_reminder_sent_at !== null && <>Último cobro: {fechaDia(d.last_reminder_sent_at)}.</>}
              </p>
            </div>
            <p className="morosos__saldo">
              <Monto valor={d.current_balance_cop} tono="rojo" />
            </p>
            <div className="morosos__cobrar">
              <BotonCobrar negocio={negocio} deudor={d} alCobrar={() => void refrescarCartera().catch(() => {})} />
            </div>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className="morosos">
      <header className="morosos__cabecera">
        <h1>Morosos</h1>
        <p>
          Fiados de más de {dias} días sin pagar o con promesa de pago vencida. El más antiguo va primero. Los días se cambian en{' '}
          <Enlace a="/ajustes">Ajustes</Enlace>.
        </p>
      </header>

      {fallo && (
        <Aviso tono="error" titulo="No pudimos traer tu lista">
          <p>Es un problema nuestro, no tuyo. Vuelve a intentar en un momento.</p>
          <div>
            <Boton variante="secundaria" onClick={() => setIntento((n) => n + 1)}>
              Volver a intentar
            </Boton>
          </div>
        </Aviso>
      )}
      {cartera.estado === 'sin_conexion' && (
        <Aviso tono={sinCopia ? 'error' : 'atencion'} titulo="No hay conexión">
          <p>{sinCopia ? 'Revisa tu internet y vuelve a intentar.' : 'Ves la última lista que se cargó. Para cobrar hace falta internet.'}</p>
          <div>
            <Boton variante="secundaria" onClick={() => setIntento((n) => n + 1)}>
              Volver a intentar
            </Boton>
          </div>
        </Aviso>
      )}

      {sinCopia ? (
        cartera.estado === 'cargando' && !fallo && <p role="status">Buscando quién te debe con atraso…</p>
      ) : morosos.length === 0 ? (
        <Tarjeta>
          <div className="morosos__vacio">
            <h2>Nadie te debe con atraso</h2>
            <p>Cuando un fiado pase de {dias} días sin pagarse, o alguien incumpla una promesa de pago, aparece aquí para que le cobres.</p>
            <Enlace a="/" className="boton boton--primaria">
              Ir al mostrador
            </Enlace>
          </div>
        </Tarjeta>
      ) : (
        <>
          <p className="morosos__resumen">
            <span>
              {morosos.length} {morosos.length === 1 ? 'deudor' : 'deudores'} en mora
            </span>
            <span>
              Por cobrar <Monto valor={total} />
            </span>
          </p>
          {masivo ? (
            <CobroMasivo negocio={negocio} morosos={morosos} elegidos={elegidos} alElegir={setElegidos}>
              {lista}
            </CobroMasivo>
          ) : (
            lista
          )}
        </>
      )}
    </div>
  );
}
