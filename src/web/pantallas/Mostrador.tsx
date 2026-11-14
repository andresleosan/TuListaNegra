// Mostrador (MOS-01, MOS-02): buscar en la copia local, anotar deudores, fiar y abonar en un toque.
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { buscar } from '../../shared/buscar';
import { type DeudorResumen, estadoDeudor } from '../../shared/deudor';
import { formatoCOP, MONTO_MAXIMO_COP } from '../../shared/dinero';
import { api, ErrorApi, type Negocio } from '../api';
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

  useEffect(() => {
    const traer = () => refrescarCartera().then(() => setFalloCarga(null), (e) => setFalloCarga(comoError(e)));
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
        </div>
      </Tarjeta>
    ) : (
      <>
        <div className="mostrador__buscador">
          <Campo
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

/** Fiar o abonar a un deudor: montos rápidos, monto a mano y nota. Si el fiado pasa el tope, alerta roja y confirmar. */
function Panel({ deudor: d, tipo, alCerrar, alTerminar }: { deudor: DeudorResumen; tipo: Tipo; alCerrar: () => void; alTerminar: (h: Hecho) => void }) {
  const fiar = tipo === 'FIADO';
  const [monto, setMonto] = useState(0);
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  // El servidor tiene la última palabra: si su saldo ya pasa el tope aunque la copia no lo diga, se alerta igual.
  const [topeDelServidor, setTopeDelServidor] = useState<{ saldo: number; tope: number } | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Uno por intento de anotar: si la red falla y se vuelve a tocar, el servidor no lo anota dos veces.
  const [solicitud] = useState(() => crypto.randomUUID());

  const saldo = d.current_balance_cop;
  const tope =
    topeDelServidor ?? (fiar && d.credit_limit_cop !== null && monto > 0 && saldo + monto > d.credit_limit_cop ? { saldo, tope: d.credit_limit_cop } : null);
  const verbo = fiar ? 'Fiar' : 'Abonar';

  const cambiar = (valor: number) => {
    setMonto(valor);
    setError(null);
    setTopeDelServidor(null);
  };

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (monto <= 0) return setError(fiar ? 'Escribe cuánto le vas a fiar o toca un monto rápido.' : 'Escribe cuánto abona o toca un monto rápido.');
    if (monto > MONTO_MAXIMO_COP) return setError(`El monto máximo es ${formatoCOP(MONTO_MAXIMO_COP)}. Revisa los ceros.`);
    if (!fiar && monto > saldo) return setError(`Debe ${formatoCOP(saldo)}: no puede abonar más que eso. Toca «Todo» para saldar la cuenta.`);
    setFallo(null);
    setEnviando(true);
    try {
      const r = await api<Respuesta>(`/deudores/${d.id}/movimientos`, {
        metodo: 'POST',
        cuerpo: { request_id: solicitud, type: tipo, amount_cop: monto, description: nota.trim() || undefined, confirmar_tope: tope ? true : undefined },
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
      {tope && (
        <Aviso tono="error" titulo="Pasa su tope de crédito">
          <p>
            Con este fiado quedaría debiendo <Monto valor={tope.saldo + monto} /> y su tope es <Monto valor={tope.tope} />. Si de todas formas le fías, toca el botón rojo.
          </p>
        </Aviso>
      )}
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
