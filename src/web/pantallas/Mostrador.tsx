// Mostrador (MOS-01, MOS-02, IAS-02): buscar en la copia local, anotar deudores, fiar y abonar en un toque, o pedírselo a Sarin.
// WAP-06: aviso de los comprobantes que llegaron por WhatsApp y esperan revisión (se revisan en la ficha del deudor).
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { buscar, buscarCandidatos } from '../../shared/buscar';
import { type DeudorResumen, estadoDeudor } from '../../shared/deudor';
import { formatoCOP, MONTO_MAXIMO_COP } from '../../shared/dinero';
import { type AbonoPendiente, api, ErrorApi, type Negocio } from '../api';
import { refrescarCartera, useCartera } from '../cartera';
import { Enlace } from '../ruta';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { Campo } from '../ui/Campo';
import { Monto } from '../ui/Monto';
import { Sello } from '../ui/Sello';
import { Tarjeta } from '../ui/Tarjeta';
import { avisoVigencia, fechaLarga } from '../vigencia';
import './Mostrador.css';

const RAPIDOS = [2_000, 5_000, 10_000, 20_000, 50_000];
// Pintar miles de filas en cada pulsación sería lento; con escribir un poco más se afina.
const MAXIMO_FILAS = 50;

type Tipo = 'FIADO' | 'ABONO';
type Hecho = { id: string; tipo: Tipo; monto: number; saldo: number; movimiento: string };

const comoError = (e: unknown) => (e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido'));
/** `5.000` sin el signo: lo que se ve dentro del campo de monto. */
const miles = (valor: number) => formatoCOP(valor).slice(2);
const aPesos = (texto: string) => Number(texto.replace(/\D/g, '').slice(0, 9)) || 0;

const hora = (ms: number) => new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }).format(ms);
const dia = (ms: number) => new Intl.DateTimeFormat('es-CO', { dateStyle: 'short', timeZone: 'America/Bogota' }).format(ms);
const deCuando = (ms: number) => (dia(ms) === dia(Date.now()) ? `de las ${hora(ms)}` : `del ${fechaLarga(ms)}`);

/** Lo que el tendero lee cuando el servidor rechaza algo que no es de un campo concreto. */
function textoDeFallo(f: ErrorApi): { titulo: string; texto: string } {
  if (f.status === 0) return { titulo: 'No hay conexión', texto: 'Revisa tu internet y vuelve a tocar el botón. Lo que escribiste sigue aquí.' };
  if (f.status === 403) return { titulo: 'Tu plan no permite anotar', texto: 'Puedes consultar tu libro, pero para anotar necesitas un pase vigente.' };
  if (f.status === 401) return { titulo: 'Tu sesión venció', texto: 'Sal y vuelve a entrar. Lo anotado antes sigue guardado.' };
  if (f.error === 'no_encontrado') return { titulo: 'Este deudor ya no está', texto: 'Puede que lo hayan archivado. Busca de nuevo.' };
  return { titulo: 'No pudimos anotarlo', texto: 'Es un problema nuestro, no tuyo. Intenta de nuevo en un momento.' };
}

function Fallo({ fallo }: { fallo: ErrorApi }) {
  const { titulo, texto } = textoDeFallo(fallo);
  return (
    <Aviso tono="error" titulo={titulo}>
      <p>{texto}</p>
      {fallo.status === 403 && (
        <p>
          <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
        </p>
      )}
    </Aviso>
  );
}

export function Mostrador({ negocio }: { negocio: Negocio }) {
  const { deudores, estado, actualizada_en } = useCartera();
  const [consulta, setConsulta] = useState('');
  const [falloCarga, setFalloCarga] = useState<ErrorApi | null>(null);
  const [creando, setCreando] = useState<string | null>(null); // nombre con que arranca el formulario de alta
  const [creado, setCreado] = useState<DeudorResumen | null>(null);
  const [abierto, setAbierto] = useState<{ id: string; tipo: Tipo } | null>(null);
  const [hecho, setHecho] = useState<Hecho | null>(null);
  const [pendientes, setPendientes] = useState<AbonoPendiente[]>([]);

  useEffect(() => {
    const traer = () => {
      // Si la lista de comprobantes no llega, el mostrador sigue igual: el aviso aparece en la próxima carga.
      api<{ pendientes: AbonoPendiente[] }>('/abonos').then((r) => setPendientes(r.pendientes), () => {});
      return refrescarCartera().then(() => setFalloCarga(null), (e) => setFalloCarga(comoError(e)));
    };
    void traer();
    // Al perder o recuperar la red se vuelve a pedir: así el aviso de «sin conexión» aparece y se va solo.
    addEventListener('online', traer);
    addEventListener('offline', traer);
    return () => {
      removeEventListener('online', traer);
      removeEventListener('offline', traer);
    };
  }, []);

  const resultados = useMemo(() => buscar(deudores, consulta), [deudores, consulta]);
  const sinConexion = estado === 'sin_conexion';
  const permitido = negocio.permisos.escribir;
  const puedeEscribir = permitido && !sinConexion;
  // Sarin necesita red y el permiso de IA de la tienda (B2); sin él, ni se ofrece.
  const conSarin = puedeEscribir && negocio.permisos.ia;
  const ahora = Date.now();
  const enPrueba = negocio.estado === 'TRIAL';

  const alCrear = (d: DeudorResumen) => {
    setCreando(null);
    setCreado(d);
    setHecho(null);
    setConsulta(d.unique_code); // queda a la vista, con su botón de fiar
  };

  const cuerpo =
    falloCarga ? (
      <Aviso tono="error" titulo="No pudimos traer tu libro">
        <p>{falloCarga.status === 401 ? 'Tu sesión venció. Sal y vuelve a entrar.' : 'Es un problema nuestro, no tuyo. Intenta de nuevo en un momento.'}</p>
        <Boton onClick={() => refrescarCartera().then(() => setFalloCarga(null), (e) => setFalloCarga(comoError(e)))}>Volver a intentar</Boton>
      </Aviso>
    ) : estado === 'cargando' ? (
      <p className="mostrador__nota" role="status">
        Abriendo tu libro…
      </p>
    ) : sinConexion && actualizada_en === null ? null : creando !== null ? (
      <NuevoDeudor inicial={creando} alCrear={alCrear} alCancelar={() => setCreando(null)} />
    ) : deudores.length === 0 ? (
      <Tarjeta>
        <div className="mostrador__vacio">
          {/* Hoja de libro sin renglones escritos. Decorativa: el mensaje va en el texto. */}
          <div className="mostrador__libro" aria-hidden="true">
            <p>
              <span>Código</span>
              <span>Nombre</span>
              <span>Saldo</span>
            </p>
            <p />
            <p />
            <p />
          </div>
          <h2>Tu libro está en blanco</h2>
          <p>Anota a tu primer deudor: basta con el nombre o el apodo. Después le fías, le abonas y le cobras desde aquí.</p>
          {puedeEscribir && <Boton onClick={() => setCreando('')}>Crear mi primer deudor</Boton>}
          <p className="mostrador__nota">
            ¿Llevas los fiados en un cuaderno?{' '}
            <Enlace a="/cuaderno" className="mostrador__cuaderno">
              Pasar mi cuaderno
            </Enlace>
          </p>
        </div>
      </Tarjeta>
    ) : (
      <>
        <div className="mostrador__buscador">
          <Campo
            id="mostrador-buscar"
            etiqueta="Buscar en tu libro"
            ayuda="Nombre, apodo, código (TLN-0042 o 0042) o últimos 4 del documento."
            type="search"
            autoComplete="off"
            enterKeyHint="search"
            value={consulta}
            onChange={(e) => {
              setConsulta(e.target.value);
              setCreado(null);
            }}
          />
          {puedeEscribir && (
            <Boton variante="secundaria" onClick={() => setCreando('')}>
              +{' '}Nuevo deudor
            </Boton>
          )}
        </div>
        {/* Debajo del buscador: encontrar a alguien es lo primero del mostrador (B4); Sarin es el atajo. */}
        {conSarin && (
          <Sarin
            deudores={deudores}
            alAnotar={(d, h) => {
              setConsulta(d.unique_code); // queda a la vista con lo que se anotó
              setCreado(null);
              setAbierto(null);
              setHecho(h);
            }}
            alBuscar={(texto) => {
              setConsulta(texto);
              setCreado(null);
              document.getElementById('mostrador-buscar')?.focus();
            }}
          />
        )}
        {creado && (
          <Aviso tono="bien" titulo={`Anotaste a ${creado.full_name}`}>
            <p>
              Su código es <code>{creado.unique_code}</code>. Ya puedes fiarle.
            </p>
          </Aviso>
        )}
        <p className="mostrador__cuenta" role="status">
          {consulta.trim()
            ? `${resultados.length} de ${deudores.length} ${deudores.length === 1 ? 'deudor' : 'deudores'}`
            : `${deudores.length} ${deudores.length === 1 ? 'deudor' : 'deudores'} en tu libro`}
          {resultados.length > MAXIMO_FILAS && ` · ves los primeros ${MAXIMO_FILAS}; escribe más para afinar`}
        </p>
        {resultados.length === 0 ? (
          <Tarjeta crema>
            <div className="mostrador__vacio">
              <p>
                No hay nadie con «{consulta.trim()}» en tu libro. Prueba con el apodo, el código o los últimos 4 del documento.
              </p>
              {puedeEscribir && <Boton onClick={() => setCreando(consulta.trim())}>Anotar a «{consulta.trim()}» como deudor nuevo</Boton>}
            </div>
          </Tarjeta>
        ) : (
          <ol className="mostrador__lista" aria-label="Deudores">
            {resultados.slice(0, MAXIMO_FILAS).map((d) => (
              <Fila
                key={d.id}
                deudor={d}
                estado={estadoDeudor(d, ahora, negocio.default_alert_days)}
                puedeEscribir={puedeEscribir}
                abierto={abierto?.id === d.id ? abierto.tipo : null}
                hecho={hecho?.id === d.id ? hecho : null}
                alAbrir={(tipo) => {
                  setAbierto({ id: d.id, tipo });
                  setHecho(null);
                  setCreado(null);
                }}
                alCerrar={() => setAbierto(null)}
                alTerminar={(h) => {
                  setAbierto(null);
                  setHecho(h);
                }}
              />
            ))}
          </ol>
        )}
        <p className="mostrador__nota">
          ¿Te quedan fiados en el cuaderno?{' '}
          <Enlace a="/cuaderno" className="mostrador__cuaderno">
            Pasar mi cuaderno
          </Enlace>
        </p>
      </>
    );

  return (
    <>
      <h1>Mostrador</h1>
      {sinConexion && (
        <Aviso titulo="Sin conexión">
          <p>
            {actualizada_en === null
              ? 'Todavía no hay una copia de tu libro en este teléfono. Cuando vuelva el internet, la traemos.'
              : `Estás viendo la copia ${deCuando(actualizada_en)}; no puedes fiar ni abonar hasta que vuelva.`}
          </p>
        </Aviso>
      )}
      {!permitido && (
        <Aviso titulo="Solo puedes consultar">
          <p>
            {negocio.estado === 'EXPIRED_READONLY' ? 'Tu plan venció. ' : ''}Puedes buscar y ver tu libro, pero para anotar deudores, fiar o abonar necesitas un pase vigente.
          </p>
          <p>
            <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
          </p>
        </Aviso>
      )}
      {pendientes.length > 0 && <ComprobantesPorRevisar pendientes={pendientes} />}
      {cuerpo}
      {negocio.vence_en !== null && !negocio.gratis && (
        <Tarjeta crema>
          <div className="mostrador__vigencia">
            <p>
              <strong>
                {enPrueba ? 'Prueba de 3 días' : 'Tu plan'} · {avisoVigencia(negocio.vence_en, ahora)}
              </strong>
            </p>
            <p>
              {negocio.vence_en > ahora ? 'Vence el' : 'Venció el'} {fechaLarga(negocio.vence_en)}
            </p>
            {enPrueba && negocio.limites.deudores !== null && <p>Incluye hasta {negocio.limites.deudores} deudores.</p>}
            <p className="mostrador__nota">
              Los pases para seguir están en <Enlace a="/suscripcion">Suscripción</Enlace>.
            </p>
          </div>
        </Tarjeta>
      )}
    </>
  );
}

/** Aviso en la app de los comprobantes por WhatsApp (B4, «doble aviso»): uno por deudor, con enlace a su ficha. */
function ComprobantesPorRevisar({ pendientes }: { pendientes: AbonoPendiente[] }) {
  const porDeudor = new Map<string, AbonoPendiente[]>();
  for (const p of pendientes) porDeudor.set(p.debtor_id, [...(porDeudor.get(p.debtor_id) ?? []), p]);
  const n = pendientes.length;
  return (
    <Aviso titulo={n === 1 ? 'Tienes 1 comprobante por revisar' : `Tienes ${n} comprobantes por revisar`}>
      <p>Llegaron por WhatsApp. Mira la foto y apruébalos o recházalos: el saldo solo cambia cuando apruebas.</p>
      <ul className="mostrador__pendientes" aria-label="Comprobantes por revisar">
        {[...porDeudor.values()].map((lista) => {
          const d = lista[0]!;
          return (
            <li key={d.debtor_id}>
              <span>
                <strong>{d.full_name}</strong> <code>{d.unique_code}</code>
                <span className="mostrador__nota"> · {lista.length === 1 ? '1 comprobante' : `${lista.length} comprobantes`} · debe <Monto valor={d.current_balance_cop} /></span>
              </span>
              <Enlace a={`/deudor/${d.debtor_id}`} className="mostrador__revisar" aria-label={`Revisar los comprobantes de ${d.full_name}`}>
                Revisar
              </Enlace>
            </li>
          );
        })}
      </ul>
    </Aviso>
  );
}

type PropsFila = {
  deudor: DeudorResumen;
  estado: ReturnType<typeof estadoDeudor>;
  puedeEscribir: boolean;
  abierto: Tipo | null;
  hecho: Hecho | null;
  alAbrir: (tipo: Tipo) => void;
  alCerrar: () => void;
  alTerminar: (hecho: Hecho) => void;
};

/** Un renglón del libro: código, quién es, saldo y estado; debajo, fiar y abonar. */
function Fila({ deudor: d, estado, puedeEscribir, abierto, hecho, alAbrir, alCerrar, alTerminar }: PropsFila) {
  const pasoTope = d.credit_limit_cop !== null && d.current_balance_cop > d.credit_limit_cop;
  return (
    <li className={abierto ? 'mostrador__fila mostrador__fila--abierta' : 'mostrador__fila'}>
      <div className="mostrador__datos">
        <code className="mostrador__codigo">{d.unique_code}</code>
        <p className="mostrador__quien">
          <Enlace a={`/deudor/${d.id}`}>{d.full_name}</Enlace>
          {d.alias_reference && <span className="mostrador__apodo">{d.alias_reference}</span>}
        </p>
        <p className="mostrador__saldo">
          <Monto valor={d.current_balance_cop} tono={pasoTope ? 'rojo' : undefined} />
          {pasoTope && <span className="mostrador__tope">Pasó su tope de {formatoCOP(d.credit_limit_cop!)}</span>}
        </p>
        <span className="mostrador__estado">
          <Sello estado={estado} />
        </span>
      </div>
      {puedeEscribir && !abierto && (
        <div className="mostrador__acciones">
          <Boton onClick={() => alAbrir('FIADO')}>+{' '}Fiar</Boton>
          {d.current_balance_cop > 0 && (
            <Boton variante="secundaria" onClick={() => alAbrir('ABONO')}>
              −{' '}Abonar
            </Boton>
          )}
        </div>
      )}
      {puedeEscribir && abierto && <Panel deudor={d} tipo={abierto} alCerrar={alCerrar} alTerminar={alTerminar} />}
      {hecho && (
        <Aviso tono="bien" titulo={hecho.tipo === 'FIADO' ? 'Fiado anotado' : 'Abono anotado'}>
          <p>
            {hecho.tipo === 'FIADO' ? 'Le fiaste' : 'Abonó'} <Monto valor={hecho.monto} />. Ahora debe <Monto valor={hecho.saldo} />.
          </p>
          {hecho.tipo === 'ABONO' && (
            <p>
              <Enlace a={`/deudor/${d.id}?recibo=${hecho.movimiento}`}>Ver recibo</Enlace>
            </p>
          )}
        </Aviso>
      )}
    </li>
  );
}

type Respuesta = { movimiento: { id: string; amount_cop: number }; deudor: { current_balance_cop: number } };
type Tope = { saldo: number; tope: number };

/**
 * Anotar un fiado o un abono: el mismo POST, su `request_id`, la alerta de tope y los errores traducidos, tanto para el
 * panel de cada renglón como para la propuesta de Sarin.
 */
function useAnotar(d: DeudorResumen, tipo: Tipo, alTerminar: (h: Hecho) => void, origen?: 'SARIN_TEXT') {
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  // El servidor tiene la última palabra: si su saldo ya pasa el tope aunque la copia no lo diga, se alerta igual.
  const [topeDelServidor, setTopeDelServidor] = useState<Tope | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Uno por intento de anotar: si la red falla y se vuelve a tocar, el servidor no lo anota dos veces.
  const [solicitud] = useState(() => crypto.randomUUID());
  const saldo = d.current_balance_cop;

  /** ¿Con este monto el fiado pasa el tope? */
  const topeCon = (monto: number): Tope | null =>
    topeDelServidor ?? (tipo === 'FIADO' && d.credit_limit_cop !== null && monto > 0 && saldo + monto > d.credit_limit_cop ? { saldo, tope: d.credit_limit_cop } : null);

  const limpiar = () => {
    setError(null);
    setTopeDelServidor(null);
  };

  async function anotar(monto: number, nota = '') {
    const tope = topeCon(monto);
    setFallo(null);
    setEnviando(true);
    try {
      const r = await api<Respuesta>(`/deudores/${d.id}/movimientos`, {
        metodo: 'POST',
        cuerpo: { request_id: solicitud, type: tipo, amount_cop: monto, description: nota.trim() || undefined, confirmar_tope: tope ? true : undefined, origen },
      });
      await refrescarCartera().catch(() => {});
      alTerminar({ id: d.id, tipo, monto: r.movimiento.amount_cop, saldo: r.deudor.current_balance_cop, movimiento: r.movimiento.id });
    } catch (err) {
      const f = comoError(err);
      setEnviando(false);
      if (f.error === 'supera_tope') return setTopeDelServidor({ saldo: Number(f.datos.saldo), tope: Number(f.datos.tope) });
      if (f.error === 'supera_saldo') return setError(`Ahora debe ${formatoCOP(Number(f.datos.saldo))}: no puede abonar más que eso.`);
      if (f.error === 'datos_invalidos') return setError('No pudimos aceptar este monto. Revísalo y vuelve a intentar.');
      setFallo(f);
      if (f.status === 0) void refrescarCartera(); // enciende el aviso de «sin conexión» si la red se fue
    }
  }

  return { error, setError, fallo, enviando, topeCon, limpiar, anotar };
}

function AvisoTope({ tope, monto }: { tope: Tope; monto: number }) {
  return (
    <Aviso tono="error" titulo="Pasa su tope de crédito">
      <p>
        Con este fiado quedaría debiendo <Monto valor={tope.saldo + monto} /> y su tope es <Monto valor={tope.tope} />. Si de todas formas le fías, toca el botón rojo.
      </p>
    </Aviso>
  );
}

/** Fiar o abonar a un deudor: montos rápidos, monto a mano y nota. Si el fiado pasa el tope, alerta roja y confirmar. */
function Panel({ deudor: d, tipo, alCerrar, alTerminar }: { deudor: DeudorResumen; tipo: Tipo; alCerrar: () => void; alTerminar: (h: Hecho) => void }) {
  const fiar = tipo === 'FIADO';
  const [monto, setMonto] = useState(0);
  const [nota, setNota] = useState('');
  const { error, setError, fallo, enviando, topeCon, limpiar, anotar } = useAnotar(d, tipo, alTerminar);

  const saldo = d.current_balance_cop;
  const tope = topeCon(monto);
  const verbo = fiar ? 'Fiar' : 'Abonar';

  const cambiar = (valor: number) => {
    setMonto(valor);
    limpiar();
  };

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (monto <= 0) return setError(fiar ? 'Escribe cuánto le vas a fiar o toca un monto rápido.' : 'Escribe cuánto abona o toca un monto rápido.');
    if (monto > MONTO_MAXIMO_COP) return setError(`El monto máximo es ${formatoCOP(MONTO_MAXIMO_COP)}. Revisa los ceros.`);
    if (!fiar && monto > saldo) return setError(`Debe ${formatoCOP(saldo)}: no puede abonar más que eso. Toca «Todo» para saldar la cuenta.`);
    void anotar(monto, nota);
  }

  return (
    <form className="mostrador__panel" onSubmit={enviar} noValidate aria-label={`${verbo} a ${d.full_name}`}>
      <p className="mostrador__panel-titulo">
        {verbo} · debe <Monto valor={saldo} />
        {fiar && d.credit_limit_cop !== null && (
          <>
            {' '}
            · tope <Monto valor={d.credit_limit_cop} />
          </>
        )}
      </p>
      <div className="mostrador__rapidos" role="group" aria-label="Montos rápidos">
        {!fiar && (
          <Boton variante="secundaria" onClick={() => cambiar(saldo)}>
            Todo: {formatoCOP(saldo)}
          </Boton>
        )}
        {RAPIDOS.map((valor) => (
          <Boton key={valor} variante="secundaria" onClick={() => cambiar(monto + valor)}>
            +{miles(valor)}
          </Boton>
        ))}
      </div>
      <Campo
        etiqueta={fiar ? '¿Cuánto le fías?' : '¿Cuánto abona?'}
        ayuda="En pesos, sin centavos. Los montos rápidos se van sumando."
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="done"
        className="mostrador__monto"
        value={monto ? miles(monto) : ''}
        onChange={(e) => cambiar(aPesos(e.target.value))}
        error={error}
      />
      <Campo etiqueta="Nota (opcional)" ayuda="Qué se llevó, para acordarse después." maxLength={140} value={nota} onChange={(e) => setNota(e.target.value)} />
      {tope && <AvisoTope tope={tope} monto={monto} />}
      {fallo && <Fallo fallo={fallo} />}
      <div className="mostrador__botones">
        <Boton type="submit" variante={tope ? 'peligro' : 'primaria'} disabled={enviando}>
          {enviando ? 'Anotando…' : `${verbo}${monto ? ` ${formatoCOP(monto)}` : ''}${tope ? ' de todas formas' : ''}`}
        </Boton>
        <Boton variante="secundaria" onClick={alCerrar}>
          Cancelar
        </Boton>
      </div>
    </form>
  );
}

/** Lo que devuelve `POST /api/ia/orden`: una propuesta del modelo, nunca un movimiento. */
type Orden = { accion: 'FIAR' | 'ABONAR' | 'DESCONOCIDA'; monto: number | null; deudor_buscado: string | null };

const MAXIMO_OPCIONES = 8;

function textoDeSarin(f: ErrorApi): { titulo: string; texto: string; suscripcion?: boolean } {
  if (f.error === 'ia_apagada') return { titulo: 'Sarin aún no está encendida', texto: 'Pronto podrás dictarle. Mientras tanto, anota con los botones Fiar y Abonar de cada deudor.' };
  if (f.error === 'sin_cuota') return { titulo: 'Se acabaron las órdenes a Sarin', texto: String(f.datos.mensaje ?? 'Ya usaste las interacciones de Sarin de tu plan.'), suscripcion: true };
  if (f.status === 503) return { titulo: 'Sarin no responde ahora', texto: 'Intenta de nuevo en un momento, o anota con los botones de cada deudor. No se te descontó nada.' };
  if (f.status === 429) return { titulo: 'Vas muy rápido', texto: 'Espera un minuto y díselo de nuevo.' };
  if (f.status === 0) return { titulo: 'No hay conexión', texto: 'Revisa tu internet y vuelve a enviar. Lo que escribiste sigue aquí.' };
  if (f.status === 403) return { titulo: 'Tu plan no incluye a Sarin ahora', texto: 'Para dictarle órdenes necesitas un pase vigente.', suscripcion: true };
  if (f.status === 401) return { titulo: 'Tu sesión venció', texto: 'Sal y vuelve a entrar.' };
  return { titulo: 'Sarin no pudo leer tu orden', texto: 'Es un problema nuestro, no tuyo. Intenta de nuevo en un momento.' };
}

/**
 * Sarin dentro de la app (IAS-02, B4): el tendero escribe o dicta con el micrófono de su teclado, Sarin propone y él
 * confirma. Nada se anota sin ese toque (A1.3); la confirmación es el mismo envío que el panel de fiar y abonar.
 */
function Sarin({ deudores, alAnotar, alBuscar }: { deudores: DeudorResumen[]; alAnotar: (d: DeudorResumen, h: Hecho) => void; alBuscar: (texto: string) => void }) {
  const [frase, setFrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  // `n` cambia con cada respuesta: una propuesta nueva lleva su propio request_id.
  const [orden, setOrden] = useState<{ n: number; orden: Orden } | null>(null);
  const [elegido, setElegido] = useState<DeudorResumen | null>(null);

  const cerrar = () => {
    setOrden(null);
    setElegido(null);
  };
  const buscarAMano = (texto: string) => {
    cerrar();
    alBuscar(texto);
  };

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!frase.trim()) return setError('Escribe o dicta qué quieres anotar, por ejemplo «fíale cinco mil a Wilmar».');
    setError(null);
    setFallo(null);
    cerrar();
    setEnviando(true);
    try {
      const o = await api<Orden>('/ia/orden', { metodo: 'POST', cuerpo: { frase: frase.trim() } });
      setOrden((x) => ({ n: (x?.n ?? 0) + 1, orden: o }));
    } catch (err) {
      const f = comoError(err);
      if (f.error === 'datos_invalidos') setError('Escribe la orden en una frase corta: máximo 300 letras.');
      else setFallo(f);
    } finally {
      setEnviando(false);
    }
  }

  let respuesta: ReactNode = null;
  if (fallo) {
    const { titulo, texto, suscripcion } = textoDeSarin(fallo);
    respuesta = (
      <Aviso tono={fallo.error === 'ia_apagada' ? 'atencion' : 'error'} titulo={titulo}>
        <p>{texto}</p>
        {suscripcion && (
          <p>
            <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
          </p>
        )}
      </Aviso>
    );
  } else if (orden) {
    const { accion, monto, deudor_buscado: buscado } = orden.orden;
    const tipo: Tipo = accion === 'FIAR' ? 'FIADO' : 'ABONO';
    const lista = accion === 'DESCONOCIDA' || monto === null || !buscado ? null : elegido ? [elegido] : buscarCandidatos(deudores, buscado);
    if (!lista) {
      respuesta = (
        <Aviso titulo="No te entendí">
          <p>Dile qué hacer, cuánto y a quién. Por ejemplo: «fíale cinco mil a Wilmar» o «abónale veinte mil a don Carlos».</p>
        </Aviso>
      );
    } else if (lista.length === 0) {
      respuesta = (
        <Aviso titulo={`No encontré a «${buscado}» en tu libro`}>
          <p>Puede que lo tengas anotado con otro nombre o apodo. Búscalo a mano y anótale desde su renglón.</p>
          <Boton variante="secundaria" onClick={() => buscarAMano(buscado!)}>
            Buscar a mano
          </Boton>
        </Aviso>
      );
    } else if (lista.length > 1) {
      respuesta = (
        <div className="mostrador__sarin-elegir">
          <p className="mostrador__sarin-pregunta">
            Hay {lista.length} con «{buscado}». ¿{tipo === 'FIADO' ? 'A cuál le fías' : 'Cuál abona'} <Monto valor={monto!} />?
          </p>
          <ul aria-label="¿A cuál?">
            {lista.slice(0, MAXIMO_OPCIONES).map((d) => (
              <li key={d.id}>
                <Boton variante="secundaria" onClick={() => setElegido(d)}>
                  <code>{d.unique_code}</code>
                  <span className="mostrador__sarin-quien">
                    {d.full_name}
                    {d.alias_reference && <span>{d.alias_reference}</span>}
                  </span>
                  <span className="mostrador__sarin-debe">
                    debe <Monto valor={d.current_balance_cop} />
                  </span>
                </Boton>
              </li>
            ))}
          </ul>
          {lista.length > MAXIMO_OPCIONES && <p className="mostrador__nota">Ves los primeros {MAXIMO_OPCIONES}. Si no está, búscalo a mano.</p>}
          <div className="mostrador__botones">
            <Boton variante="secundaria" onClick={() => buscarAMano(buscado!)}>
              Buscar a mano
            </Boton>
            <Boton variante="secundaria" onClick={cerrar}>
              Cancelar
            </Boton>
          </div>
        </div>
      );
    } else {
      const d = lista[0]!;
      respuesta = (
        <Propuesta
          key={`${orden.n}-${d.id}`}
          deudor={d}
          tipo={tipo}
          monto={monto!}
          entendido={buscado!}
          alCancelar={cerrar}
          alTerminar={(h) => {
            cerrar();
            setFrase('');
            alAnotar(d, h);
          }}
        />
      );
    }
  }

  return (
    <section className="mostrador__sarin" aria-label="Sarin">
      <form className="mostrador__sarin-form" onSubmit={enviar} noValidate>
        <Campo
          etiqueta="Dile a Sarin"
          ayuda="Por ejemplo: «abónale veinte mil a don Carlos el del taller». Para hablar, toca el micrófono de tu teclado."
          autoComplete="off"
          enterKeyHint="send"
          maxLength={300}
          value={frase}
          onChange={(e) => {
            setFrase(e.target.value);
            if (error) setError(null);
          }}
          error={error}
        />
        <Boton type="submit" disabled={enviando}>
          {enviando ? 'Sarin está leyendo…' : 'Enviar a Sarin'}
        </Boton>
      </form>
      {respuesta}
      <p className="mostrador__nota">Sarin te muestra lo que entendió. Nada se anota hasta que tú lo confirmes.</p>
    </section>
  );
}

/** La propuesta de Sarin para un deudor: qué se anotaría y cómo queda el saldo. Confirmar es el mismo envío del panel. */
function Propuesta({ deudor: d, tipo, monto, entendido, alCancelar, alTerminar }: { deudor: DeudorResumen; tipo: Tipo; monto: number; entendido: string; alCancelar: () => void; alTerminar: (h: Hecho) => void }) {
  const { error, fallo, enviando, topeCon, anotar } = useAnotar(d, tipo, alTerminar, 'SARIN_TEXT');
  const fiar = tipo === 'FIADO';
  const saldo = d.current_balance_cop;
  const tope = topeCon(monto);
  const pasaSaldo = !fiar && monto > saldo;

  return (
    <div className="mostrador__propuesta" role="group" aria-label="Propuesta de Sarin">
      {/* Lo que entendió Sarin, para comparar con el deudor propuesto antes de confirmar por reflejo. */}
      <p className="mostrador__propuesta-entendi">Entendí: «{entendido}»</p>
      <p className="mostrador__propuesta-que">
        {fiar ? 'Fiar' : 'Abonar'} <Monto valor={monto} /> a {d.full_name}
        {d.alias_reference && <span>, {d.alias_reference}</span>} <code>({d.unique_code})</code>
      </p>
      <dl className="mostrador__propuesta-cuentas">
        <div>
          <dt>Debe hoy</dt>
          <dd>
            <Monto valor={saldo} />
          </dd>
        </div>
        {!pasaSaldo && (
          <>
            <div>
              <dt>{fiar ? 'Le fías' : 'Abona'}</dt>
              <dd>
                {fiar ? '+' : '−'} <Monto valor={monto} />
              </dd>
            </div>
            <div className="mostrador__propuesta-total">
              <dt>Quedaría debiendo</dt>
              <dd>
                <Monto valor={fiar ? saldo + monto : saldo - monto} />
              </dd>
            </div>
          </>
        )}
      </dl>
      {pasaSaldo && (
        <Aviso tono="error" titulo="Abona más de lo que debe">
          <p>
            Debe <Monto valor={saldo} /> y Sarin entendió <Monto valor={monto} />. Revisa el monto y díselo de nuevo, o abónale desde su renglón.
          </p>
        </Aviso>
      )}
      {tope && <AvisoTope tope={tope} monto={monto} />}
      {error && (
        <Aviso tono="error" titulo="No se anotó">
          <p>{error}</p>
        </Aviso>
      )}
      {fallo && <Fallo fallo={fallo} />}
      <div className="mostrador__botones">
        {!pasaSaldo && (
          <Boton variante={tope ? 'peligro' : 'primaria'} disabled={enviando} onClick={() => void anotar(monto)}>
            {enviando ? 'Anotando…' : tope ? 'Confirmar de todas formas' : 'Confirmar'}
          </Boton>
        )}
        <Boton variante="secundaria" onClick={alCancelar}>
          Cancelar
        </Boton>
      </div>
    </div>
  );
}

/** Alta de un deudor: solo el nombre o apodo es obligatorio. */
function NuevoDeudor({ inicial, alCrear, alCancelar }: { inicial: string; alCrear: (d: DeudorResumen) => void; alCancelar: () => void }) {
  const [nombre, setNombre] = useState(inicial);
  const [apodo, setApodo] = useState('');
  const [tope, setTope] = useState(0);
  const [errores, setErrores] = useState<{ nombre?: string; apodo?: string; tope?: string }>({});
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!nombre.trim()) {
      setErrores({ nombre: 'Escribe el nombre o el apodo con que lo conoces.' });
      return document.getElementById('mostrador-nombre')?.focus();
    }
    setErrores({});
    setFallo(null);
    setEnviando(true);
    try {
      const d = await api<DeudorResumen>('/deudores', {
        metodo: 'POST',
        cuerpo: { full_name: nombre.trim(), alias_reference: apodo.trim() || undefined, credit_limit_cop: tope || undefined },
      });
      await refrescarCartera().catch(() => {});
      alCrear(d);
    } catch (err) {
      const f = comoError(err);
      setEnviando(false);
      if (f.error === 'datos_invalidos') {
        const campos = f.campos ?? [];
        return setErrores({
          nombre: campos.includes('full_name') ? 'Revisa el nombre: máximo 80 letras.' : undefined,
          apodo: campos.includes('alias_reference') ? 'Revisa el apodo: máximo 80 letras.' : undefined,
          tope: campos.includes('credit_limit_cop') ? `El tope va de $ 0 a ${formatoCOP(MONTO_MAXIMO_COP)}.` : undefined,
        });
      }
      setFallo(f);
    }
  }

  return (
    <Tarjeta>
      <form className="mostrador__nuevo" onSubmit={enviar} noValidate>
        <h2>Nuevo deudor</h2>
        <Campo
          id="mostrador-nombre"
          etiqueta="Nombre o apodo"
          ayuda="Lo único obligatorio. Como lo llamas en la tienda."
          autoComplete="off"
          autoCapitalize="words"
          maxLength={80}
          value={nombre}
          onChange={(e) => {
            setNombre(e.target.value);
            if (errores.nombre && e.target.value.trim()) setErrores((x) => ({ ...x, nombre: undefined }));
          }}
          error={errores.nombre}
        />
        <Campo
          etiqueta="Referencia (opcional)"
          ayuda="Para reconocerlo al buscar: «el del taller», «la del 302»."
          autoComplete="off"
          maxLength={80}
          value={apodo}
          onChange={(e) => setApodo(e.target.value)}
          error={errores.apodo}
        />
        <Campo
          etiqueta="Tope de crédito (opcional)"
          ayuda="Hasta cuánto le fías. Si lo pasa, te avisamos. Vacío: sin tope."
          inputMode="numeric"
          autoComplete="off"
          className="mostrador__monto"
          value={tope ? miles(tope) : ''}
          onChange={(e) => setTope(aPesos(e.target.value))}
          error={errores.tope}
        />
        {fallo?.error === 'limite_deudores' ? (
          <Aviso tono="error" titulo="Llegaste al límite de tu prueba">
            <p>La prueba incluye hasta {String(fallo.datos.limite)} deudores. Para anotar más, compra un pase.</p>
            <p>
              <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
            </p>
          </Aviso>
        ) : (
          fallo && <Fallo fallo={fallo} />
        )}
        <div className="mostrador__botones">
          <Boton type="submit" disabled={enviando}>
            {enviando ? 'Anotando…' : 'Anotar deudor'}
          </Boton>
          <Boton variante="secundaria" onClick={alCancelar}>
            Cancelar
          </Boton>
        </div>
      </form>
    </Tarjeta>
  );
}
