// Migrador de cuadernos (IAS-04): foto → tabla de nombre, apodo y saldo que el tendero corrige mirando la foto → importar.
// Leer la foto no escribe nada en el libro (A1.3): los deudores solo entran al tocar «Sí, pasar a mi libro».
import { type FormEvent, useEffect, useState } from 'react';
import { formatoCOP, MONTO_MAXIMO_COP } from '../../shared/dinero';
import { api, apiArchivo, ErrorApi, type Negocio } from '../api';
import { refrescarCartera } from '../cartera';
import { Enlace } from '../ruta';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { Campo } from '../ui/Campo';
import { Monto } from '../ui/Monto';
import { Progreso } from '../ui/Progreso';
import { Tarjeta } from '../ui/Tarjeta';
import './Cuaderno.css';

// Las mismas reglas que aplica el servidor (que además mira los bytes, no solo el tipo).
const TIPOS = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_RENGLONES = 60;

type Lectura = 'leida' | 'apagada' | 'fallida' | 'sin_cuota';
/** `POST /api/cuadernos/fotos`. */
type Subida = { foto: string; lectura: Lectura; filas: { full_name: string; alias_reference: string | null; saldo_cop: number }[]; mensaje?: string };
type Renglon = { id: number; nombre: string; apodo: string; saldo: number };
type ErroresRenglon = { nombre?: string; saldo?: string };
type Importado = { id: string; unique_code: string; full_name: string; alias_reference: string | null; current_balance_cop: number };
type Paso = 'foto' | 'tabla' | 'confirmar' | 'listo';

let siguienteId = 0;
const renglon = (nombre = '', apodo = '', saldo = 0): Renglon => ({ id: ++siguienteId, nombre, apodo, saldo });

const comoError = (e: unknown) => (e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido'));
/** `5.000` sin el signo: lo que se ve dentro del campo de saldo. */
const miles = (valor: number) => formatoCOP(valor).slice(2);
const aPesos = (texto: string) => Number(texto.replace(/\D/g, '').slice(0, 9)) || 0;
const deudores = (n: number) => `${n} ${n === 1 ? 'deudor' : 'deudores'}`;

function revisarFoto(archivo: File | null): string | null {
  if (!archivo) return 'Elige la foto de una página de tu cuaderno.';
  if (!TIPOS.includes(archivo.type)) return 'Ese archivo no es una foto. Sube la foto en JPG, PNG o WebP.';
  if (archivo.size > MAX_BYTES) {
    return `La foto pesa ${(archivo.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB y el máximo es 2 MB. Tómala de nuevo con menos zoom o recórtala.`;
  }
  return null;
}

/** Lo mismo que exige el servidor a cada fila: nombre de 1 a 80 letras y saldo entero de $ 1 al máximo. */
function revisarRenglon(r: Renglon): ErroresRenglon {
  return {
    nombre: r.nombre.trim() ? undefined : 'Escribe el nombre o el apodo, como sale en tu cuaderno.',
    saldo:
      r.saldo <= 0
        ? 'Escribe cuánto debe. Si ya no debe nada, quita este renglón.'
        : r.saldo > MONTO_MAXIMO_COP
          ? `El máximo es ${formatoCOP(MONTO_MAXIMO_COP)}. Revisa los ceros.`
          : undefined,
  };
}

function errorDeSubida(f: ErrorApi): string {
  if (f.status === 0) return 'No hay conexión. Revisa tu internet y vuelve a tocar «Subir foto».';
  if (f.status === 400) return 'No pudimos abrir esa imagen. Sube una foto en JPG, PNG o WebP.';
  if (f.status === 413) return 'La foto pesa más de 2 MB. Tómala de nuevo con menos zoom o recórtala.';
  if (f.status === 411) return 'No pudimos enviar la foto completa. Vuelve a tocar «Subir foto».';
  if (f.status === 429) return 'Subiste varias fotos seguidas. Espera un minuto y vuelve a intentar.';
  if (f.status === 401) return 'Tu sesión venció. Sal, vuelve a entrar e inténtalo de nuevo.';
  if (f.status === 403) return 'Tu plan no permite anotar. Para pasar tu cuaderno necesitas un pase vigente en Suscripción.';
  return 'Es un problema nuestro, no tuyo. Vuelve a tocar «Subir foto» en un momento.';
}

/** Por qué falló la importación y cómo seguir. Nada quedó a medias: el servidor pasa todos los renglones o ninguno. */
function FalloImportar({ fallo }: { fallo: ErrorApi }) {
  const [titulo, texto, aSuscripcion] =
    fallo.error === 'limite_deudores'
      ? ['Tu plan no admite tantos deudores', `Tu plan permite hasta ${String(fallo.datos.limite)} deudores en total y con estos te pasarías. No pasamos ninguno: quita renglones o compra un pase con más deudores.`, true]
      : fallo.status === 0
        ? ['No hay conexión', 'Revisa tu internet y vuelve a tocar «Sí, pasar a mi libro». Aunque ya hubiera llegado, no se anota dos veces.', false]
        : fallo.status === 403
          ? ['Tu plan no permite anotar', 'Puedes consultar tu libro, pero para pasar tu cuaderno necesitas un pase vigente.', true]
          : fallo.status === 401
            ? ['Tu sesión venció', 'Sal y vuelve a entrar. Tu cuaderno no se pasó todavía.', false]
            : fallo.campos?.includes('foto')
              ? ['Tu foto ya no está guardada', 'Toca «Volver a corregir» y luego «Usar otra foto» para subirla de nuevo.', false]
              : fallo.status === 400
                ? ['Algún renglón no cuadra', 'Toca «Volver a corregir» y revisa nombres y saldos.', false]
                : ['No pudimos pasar tu cuaderno', 'Es un problema nuestro, no tuyo. Vuelve a tocar el botón en un momento; no se anota dos veces.', false];
  return (
    <Aviso tono="error" titulo={titulo}>
      <p>{texto}</p>
      {aSuscripcion && (
        <p>
          <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
        </p>
      )}
    </Aviso>
  );
}

/** Qué hizo la lectura con la foto, en palabras de tendero. */
function AvisoLectura({ subida }: { subida: Subida }) {
  const n = subida.filas.length;
  if (subida.lectura === 'leida' && n > 0) {
    return (
      <Aviso titulo={`Leímos ${n} ${n === 1 ? 'renglón' : 'renglones'} de tu foto`}>
        <p>Compáralos con tu cuaderno: corrige nombres y saldos, y quita lo que sobre. La lectura se puede equivocar; tú tienes la última palabra.</p>
      </Aviso>
    );
  }
  const [titulo, texto] =
    subida.lectura === 'leida'
      ? ['No alcanzamos a leer tu foto', 'No encontramos renglones claros. Escribe lo que ves en tu foto, un renglón por persona, o sube otra con más luz.']
      : subida.lectura === 'fallida'
        ? ['No pudimos leer tu foto', 'La lectura falló esta vez y no te gastó ninguna foto del plan. Escribe lo que ves en tu foto, un renglón por persona.']
        : subida.lectura === 'sin_cuota'
          ? ['Se acabaron las fotos de tu plan', `${subida.mensaje ?? 'Ya usaste todas las fotos de tu plan.'} Igual puedes escribir lo que ves en tu foto.`]
          : ['Escribe lo que ves en tu foto', 'La lectura automática todavía está apagada. Mira tu foto y anota un renglón por persona: nombre, apodo si lo tiene y cuánto debe.'];
  return (
    <Aviso titulo={titulo}>
      <p>{texto}</p>
      {subida.lectura === 'sin_cuota' && (
        <p>
          <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
        </p>
      )}
    </Aviso>
  );
}

export function Cuaderno({ negocio }: { negocio: Negocio }) {
  const [paso, setPaso] = useState<Paso>('foto');
  const [subida, setSubida] = useState<Subida | null>(null);
  // Uno por foto subida: si la red falla al importar y se vuelve a tocar, el servidor no anota dos veces.
  const [solicitud, setSolicitud] = useState('');
  const [renglones, setRenglones] = useState<Renglon[]>([]);
  const [errores, setErrores] = useState<Record<number, ErroresRenglon>>({});
  const [sinRenglones, setSinRenglones] = useState(false);
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [hecho, setHecho] = useState<{ deudores: Importado[]; repetido: boolean } | null>(null);
  const [foto, setFoto] = useState<{ url: string } | { error: string } | null>(null);

  // La foto es privada: se pide con la sesión y vive como URL local solo mientras se usa la pantalla.
  const clave = subida?.foto;
  useEffect(() => {
    if (!clave) return;
    let vigente = true;
    let creada: string | null = null;
    setFoto(null);
    apiArchivo(`/archivos/${clave.split('/').map(encodeURIComponent).join('/')}`).then(
      (blob) => {
        if (!vigente) return;
        creada = URL.createObjectURL(blob);
        setFoto({ url: creada });
      },
      (e: unknown) => vigente && setFoto({ error: comoError(e).status === 0 ? 'No hay conexión para mostrar tu foto.' : 'No pudimos mostrar tu foto.' }),
    );
    return () => {
      vigente = false;
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [clave]);

  const ir = (nuevo: Paso) => {
    setPaso(nuevo);
    scrollTo(0, 0);
  };

  const alSubir = (s: Subida) => {
    setSubida(s);
    setSolicitud(crypto.randomUUID());
    setRenglones(s.filas.length ? s.filas.map((f) => renglon(f.full_name, f.alias_reference ?? '', f.saldo_cop)) : [renglon()]);
    setErrores({});
    setSinRenglones(false);
    setFallo(null);
    ir('tabla');
  };

  const empezarDeNuevo = () => {
    setSubida(null);
    setFoto(null);
    setHecho(null);
    setFallo(null);
    ir('foto');
  };

  const cambiar = (id: number, campo: 'nombre' | 'apodo' | 'saldo', valor: string) => {
    setRenglones((rs) => rs.map((r) => (r.id === id ? { ...r, [campo]: campo === 'saldo' ? aPesos(valor) : valor } : r)));
    if (campo !== 'apodo') setErrores((es) => ({ ...es, [id]: { ...es[id], [campo]: undefined } }));
  };

  function revisar(e: FormEvent) {
    e.preventDefault();
    if (renglones.length === 0) return setSinRenglones(true);
    const hallados = renglones.map((r) => [r.id, revisarRenglon(r)] as const);
    setErrores(Object.fromEntries(hallados));
    const primero = hallados.find(([, e]) => e.nombre || e.saldo);
    if (primero) return void document.getElementById(`cua-${primero[0]}-${primero[1].nombre ? 'nombre' : 'saldo'}`)?.focus();
    setFallo(null);
    ir('confirmar');
  }

  async function importar() {
    setFallo(null);
    setEnviando(true);
    try {
      const r = await api<{ deudores: Importado[]; repetido: boolean }>('/cuadernos/importar', {
        metodo: 'POST',
        cuerpo: {
          foto: subida!.foto,
          request_id: solicitud,
          filas: renglones.map((r) => ({ full_name: r.nombre.trim(), alias_reference: r.apodo.trim() || undefined, saldo_cop: r.saldo })),
        },
      });
      await refrescarCartera().catch(() => {});
      setHecho(r);
      ir('listo');
    } catch (err) {
      setFallo(comoError(err));
    } finally {
      setEnviando(false);
    }
  }

  const total = renglones.reduce((suma, r) => suma + r.saldo, 0);
  const conError = renglones.filter((r) => errores[r.id]?.nombre || errores[r.id]?.saldo).length;
  const numero = (i: number) => String(i + 1).padStart(2, '0');

  if (!negocio.permisos.escribir) {
    return (
      <>
        <h1>Pasar mi cuaderno</h1>
        <Aviso titulo="Solo puedes consultar">
          <p>
            {negocio.estado === 'EXPIRED_READONLY' ? 'Tu plan venció. ' : ''}Puedes ver tu libro, pero para pasar tu cuaderno y anotar deudores necesitas un pase vigente.
          </p>
          <p>
            <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
          </p>
        </Aviso>
        <p>
          <Enlace a="/">Volver al mostrador</Enlace>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Pasar mi cuaderno</h1>
      {paso !== 'listo' && (
        <Progreso
          paso={paso === 'foto' ? 1 : paso === 'tabla' ? 2 : 3}
          total={3}
          nombre={paso === 'foto' ? 'Sube la foto' : paso === 'tabla' ? 'Revisa la tabla' : 'Confirma'}
        />
      )}

      {paso === 'foto' && <PasoFoto alSubir={alSubir} />}

      {paso === 'tabla' && subida && (
        <>
          <AvisoLectura subida={subida} />
          <div className="cua__mesa">
            <figure className="cua__foto">
              {foto && 'url' in foto ? (
                <img src={foto.url} alt="Tu foto del cuaderno" />
              ) : foto ? (
                <p className="campo__error" role="alert">
                  {foto.error} Igual puedes escribir la tabla.
                </p>
              ) : (
                <p className="cua__nota" role="status">
                  Cargando tu foto…
                </p>
              )}
              <figcaption className="cua__nota">Tu foto. Cópiala renglón por renglón.</figcaption>
            </figure>

            <form className="cua__tabla" onSubmit={revisar} noValidate>
              <h2>Tu tabla</h2>
              <p className="cua__nota">
                <strong>Nada de esto está en tu libro todavía.</strong> Solo entra cuando confirmes en el siguiente paso.
              </p>
              {renglones.length > 0 ? (
                <ol className="cua__renglones" aria-label="Renglones del cuaderno">
                  {renglones.map((r, i) => (
                    <li key={r.id} className="cua__renglon" aria-label={`Renglón ${i + 1}`}>
                      <span className="cua__numero" aria-hidden="true">
                        {numero(i)}
                      </span>
                      <div className="cua__nombre">
                        <Campo
                          id={`cua-${r.id}-nombre`}
                          etiqueta="Nombre"
                          autoComplete="off"
                          autoCapitalize="words"
                          maxLength={80}
                          value={r.nombre}
                          onChange={(e) => cambiar(r.id, 'nombre', e.target.value)}
                          error={errores[r.id]?.nombre}
                        />
                      </div>
                      <div className="cua__apodo">
                        <Campo etiqueta="Apodo (opcional)" autoComplete="off" maxLength={80} value={r.apodo} onChange={(e) => cambiar(r.id, 'apodo', e.target.value)} />
                      </div>
                      <div className="cua__saldo">
                        <Campo
                          id={`cua-${r.id}-saldo`}
                          etiqueta="Debe"
                          inputMode="numeric"
                          autoComplete="off"
                          value={r.saldo ? miles(r.saldo) : ''}
                          onChange={(e) => cambiar(r.id, 'saldo', e.target.value)}
                          error={errores[r.id]?.saldo}
                        />
                      </div>
                      <div className="cua__quitar">
                        <Boton variante="secundaria" aria-label={`Quitar el renglón ${i + 1}`} onClick={() => setRenglones((rs) => rs.filter((x) => x.id !== r.id))}>
                          Quitar
                        </Boton>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <Tarjeta crema>
                  <p>La tabla está vacía. Añade un renglón por cada persona que te debe.</p>
                </Tarjeta>
              )}
              {sinRenglones && renglones.length === 0 && (
                <p className="campo__error" role="alert">
                  Añade al menos un renglón con nombre y saldo.
                </p>
              )}
              {renglones.length < MAX_RENGLONES ? (
                <Boton
                  variante="secundaria"
                  onClick={() => {
                    const nuevo = renglon();
                    setRenglones((rs) => [...rs, nuevo]);
                    setSinRenglones(false);
                    requestAnimationFrame(() => document.getElementById(`cua-${nuevo.id}-nombre`)?.focus());
                  }}
                >
                  +{' '}Añadir renglón
                </Boton>
              ) : (
                <p className="cua__nota">Una foto admite hasta {MAX_RENGLONES} renglones. Pasa el resto con otra foto.</p>
              )}

              <div className="cua__total">
                <p role="status">
                  Vas a pasar <strong>{deudores(renglones.length)}</strong> por <Monto valor={total} />
                </p>
                {conError > 0 && (
                  <p className="campo__error" role="alert">
                    {conError === 1 ? 'Corrige el renglón marcado en rojo.' : `Corrige los ${conError} renglones marcados en rojo.`}
                  </p>
                )}
              </div>
              <div className="cua__botones">
                <Boton type="submit">Revisar antes de pasar</Boton>
                <Boton variante="secundaria" onClick={empezarDeNuevo}>
                  Usar otra foto
                </Boton>
              </div>
            </form>
          </div>
        </>
      )}

      {paso === 'confirmar' && (
        <Tarjeta>
          <div className="cua__confirmar">
            <h2>¿Pasamos esto a tu libro?</h2>
            <p>
              Cada persona queda como deudor nuevo, con su saldo anotado como «Saldo anterior (cuaderno)» y tu foto como prueba. Después le fías, le abonas y le cobras como a cualquiera.
            </p>
            <ol className="cua__lista" aria-label="Lo que vas a pasar">
              {renglones.map((r, i) => (
                <li key={r.id}>
                  <span className="cua__numero">{numero(i)}</span>
                  <span className="cua__quien">
                    {r.nombre.trim()}
                    {r.apodo.trim() && <span className="cua__apodo-texto">{r.apodo.trim()}</span>}
                  </span>
                  <Monto valor={r.saldo} />
                </li>
              ))}
            </ol>
            <p className="cua__suma">
              <span>Total · {deudores(renglones.length)}</span>
              <Monto valor={total} />
            </p>
            {fallo && <FalloImportar fallo={fallo} />}
            <div className="cua__botones">
              <Boton onClick={importar} disabled={enviando}>
                {enviando ? 'Pasando…' : 'Sí, pasar a mi libro'}
              </Boton>
              <Boton variante="secundaria" onClick={() => ir('tabla')} disabled={enviando}>
                Volver a corregir
              </Boton>
            </div>
          </div>
        </Tarjeta>
      )}

      {paso === 'listo' && hecho && (
        <>
          <Aviso tono="bien" titulo={hecho.repetido ? 'Esta página ya estaba en tu libro' : `Pasaste ${deudores(hecho.deudores.length)} a tu libro`}>
            <p>
              {hecho.repetido
                ? 'Ya la habías pasado: no se anotó dos veces. Estos son los deudores que creó.'
                : 'Ya puedes buscarlos en el mostrador, fiarles y abonarles. Su saldo quedó con tu foto como prueba.'}
            </p>
          </Aviso>
          <ol className="cua__lista cua__lista--hoja" aria-label="Deudores que pasaste">
            {hecho.deudores.map((d) => (
              <li key={d.id}>
                <code className="cua__codigo">{d.unique_code}</code>
                <span className="cua__quien">
                  <Enlace a={`/deudor/${d.id}`}>{d.full_name}</Enlace>
                  {d.alias_reference && <span className="cua__apodo-texto">{d.alias_reference}</span>}
                </span>
                <Monto valor={d.current_balance_cop} />
              </li>
            ))}
          </ol>
          <div className="cua__botones">
            <Enlace a="/" className="boton boton--primaria">
              Ir al mostrador
            </Enlace>
            <Boton variante="secundaria" onClick={empezarDeNuevo}>
              Pasar otra página
            </Boton>
          </div>
        </>
      )}
    </>
  );
}

/** Paso 1: elegir la foto, revisarla en el navegador y subirla. */
function PasoFoto({ alSubir }: { alSubir: (s: Subida) => void }) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function subir(e: FormEvent) {
    e.preventDefault();
    const hallado = revisarFoto(archivo);
    setError(hallado);
    if (hallado) return void document.getElementById('cua-foto')?.focus();
    const formulario = new FormData();
    formulario.append('foto', archivo!);
    setEnviando(true);
    try {
      alSubir(await api<Subida>('/cuadernos/fotos', { metodo: 'POST', cuerpo: formulario }));
    } catch (err) {
      setEnviando(false);
      setError(errorDeSubida(comoError(err)));
      document.getElementById('cua-foto')?.focus();
    }
  }

  return (
    <div className="cua__inicio">
      <Tarjeta crema>
        <div className="cua__como">
          <h2>Así funciona</h2>
          <ol>
            <li>Le tomas una foto a una página de tu cuaderno de fiados.</li>
            <li>Revisas la tabla mirando la foto: nombre, apodo y cuánto debe cada uno.</li>
            <li>Confirmas, y entran a tu libro con la foto como prueba.</li>
          </ol>
          <p>
            <strong>Nada entra a tu libro hasta que tú lo confirmes.</strong>
          </p>
        </div>
      </Tarjeta>
      <form className="cua__subir" onSubmit={subir} noValidate>
        <Campo
          id="cua-foto"
          type="file"
          accept={TIPOS.join(',')}
          etiqueta="Foto de una página del cuaderno"
          ayuda="JPG, PNG o WebP de máximo 2 MB. Con buena luz y la página completa."
          onChange={(e) => {
            const nuevo = e.target.files?.[0] ?? null;
            setArchivo(nuevo);
            setError(nuevo ? revisarFoto(nuevo) : null);
          }}
          error={error}
        />
        <Boton type="submit" disabled={enviando}>
          {enviando ? 'Subiendo…' : 'Subir foto'}
        </Boton>
      </form>
    </div>
  );
}
