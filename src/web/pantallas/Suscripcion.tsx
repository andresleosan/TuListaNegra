import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ErrorApi, type Negocio } from '../api';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { Campo } from '../ui/Campo';
import { Monto } from '../ui/Monto';
import { Opcion } from '../ui/Opcion';
import { Tarjeta } from '../ui/Tarjeta';
import { avisoVigencia, fechaLarga } from '../vigencia';
import './Suscripcion.css';

/** `GET /api/suscripcion`. Precio y días los fija el servidor (PLANES): aquí solo se muestran. */
type Pase = { id: string; nombre: string; dias: number; precio_cop: number; cuotas: { deudores: number | null } };
type Datos = {
  pases: Pase[];
  /** `PAYMENT_ACCOUNTS_JSON`: lista libre (objetos como `{ banco, tipo, numero, titular }` o textos). */
  cuentas: unknown[];
  pago_pendiente: { id: string; plan: string; amount_cop: number; created_at: number } | null;
  ultimo_revisado: { status: 'PAID' | 'REJECTED'; review_note: string | null } | null;
};

// Las mismas reglas que aplica el servidor (que además mira el contenido del archivo, no solo su tipo).
const TIPOS = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;

const ETIQUETA: Record<string, string> = { banco: 'Banco', tipo: 'Tipo de cuenta', numero: 'Número', titular: 'A nombre de' };

function revisarCaptura(archivo: File | null): string | null {
  if (!archivo) return 'Elige la foto o la captura de pantalla del pago.';
  if (!TIPOS.includes(archivo.type)) return 'Ese archivo no es una foto. Sube la captura en JPG, PNG o WebP.';
  if (archivo.size > MAX_BYTES) {
    return `La foto pesa ${(archivo.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB y el máximo es 2 MB. Recórtala o toma la captura de nuevo.`;
  }
  return null;
}

/** Qué decirle junto al campo cuando el servidor no acepta la captura. */
function errorDeSubida(fallo: ErrorApi): string {
  if (fallo.status === 0) return 'No hay conexión. Revisa tu internet y vuelve a tocar «Enviar captura».';
  if (fallo.status === 400) return 'No pudimos leer esa imagen. Sube una captura en JPG, PNG o WebP.';
  if (fallo.status === 413) return 'La foto pesa más de 2 MB. Recórtala o toma la captura de nuevo.';
  if (fallo.status === 411) return 'No pudimos enviar la foto completa. Vuelve a tocar «Enviar captura».';
  if (fallo.status === 429) return 'Enviaste varias capturas seguidas. Espera un minuto y vuelve a intentar.';
  if (fallo.status === 401) return 'Tu sesión venció. Sal, vuelve a entrar e inténtalo de nuevo.';
  return 'Es un problema nuestro, no tuyo. Vuelve a tocar «Enviar captura» en un momento.';
}

/** Sello y explicación del estado actual, en renglones. El texto lo explica solo; el color acompaña. */
function estadoActual(n: Negocio, nombrePlan: string | undefined, ahora: number): { sello: string; tono: string; lineas: string[] } {
  if (n.gratis) return { sello: 'Gratis', tono: 'bien', lineas: ['Tu tienda no tiene vencimiento. No necesitas comprar pases.'] };
  const vence = n.vence_en === null ? [] : [`${n.vence_en > ahora ? 'Vence el' : 'Venció el'} ${fechaLarga(n.vence_en)}`];
  if (n.estado === 'EXPIRED_READONLY') return { sello: 'Vencido', tono: 'peligro', lineas: ['Puedes consultar tu libro, pero no anotar. Elige un pase para seguir.', ...vence] };
  if (n.estado === 'GRACE_UNLOCK_24H') {
    const hasta = n.desbloqueo_hasta ? [`Hasta el ${fechaLarga(n.desbloqueo_hasta)}`] : [];
    return { sello: 'Desbloqueo de 24 horas', tono: 'atencion', lineas: ['Puedes seguir anotando mientras revisamos tu pago.', ...hasta] };
  }
  const quedan = n.vence_en === null ? [] : [`${avisoVigencia(n.vence_en, ahora)}.`];
  if (n.estado === 'TRIAL') return { sello: 'En prueba', tono: 'atencion', lineas: [...quedan, ...vence] };
  return { sello: 'Activo', tono: 'bien', lineas: [...(nombrePlan ? [`${nombrePlan}.`] : []), ...quedan, ...vence] };
}

/** Suscripción (SUS-01): estado, pases, cuentas de pago y subida de la captura. */
export function Suscripcion({ negocio, alCambiar }: { negocio: Negocio; alCambiar: () => void }) {
  const [datos, setDatos] = useState<Datos | null>(null);
  const [errorCarga, setErrorCarga] = useState<ErrorApi | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [errores, setErrores] = useState<{ plan?: string | null; captura?: string | null }>({});
  const [enviando, setEnviando] = useState(false);
  // El servidor dijo que ya había otro pago en revisión (p. ej. enviado desde otro celular).
  const [repetido, setRepetido] = useState(false);

  const cargar = useCallback(() => {
    let vigente = true;
    setErrorCarga(null);
    api<Datos>('/suscripcion').then(
      (d) => vigente && setDatos(d),
      (e: unknown) => vigente && setErrorCarga(e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido')),
    );
    return () => {
      vigente = false;
    };
  }, []);
  useEffect(cargar, [cargar]);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const hallados = { plan: plan ? null : 'Elige uno de los pases.', captura: revisarCaptura(archivo) };
    setErrores(hallados);
    if (hallados.plan) return void document.getElementById(`sus-pase-${datos?.pases[0]?.id}`)?.focus();
    if (hallados.captura) return void document.getElementById('sus-captura')?.focus();

    const formulario = new FormData();
    formulario.append('plan', plan!);
    formulario.append('captura', archivo!);
    setEnviando(true);
    try {
      await api('/suscripcion/pagos', { metodo: 'POST', cuerpo: formulario });
      setRepetido(false);
      cargar();
      alCambiar(); // un vencido pasa a desbloqueo de 24 h: la cabecera y los permisos cambian
    } catch (error) {
      const fallo = error instanceof ErrorApi ? error : new ErrorApi(0, 'error_desconocido');
      if (fallo.status === 409) {
        setRepetido(true);
        cargar();
        alCambiar();
      } else if (fallo.error === 'plan_invalido') {
        setErrores({ plan: 'Ese pase ya no está disponible. Elige otro.' });
        cargar();
      } else {
        setErrores({ captura: errorDeSubida(fallo) });
        document.getElementById('sus-captura')?.focus();
      }
    } finally {
      setEnviando(false);
    }
  }

  const estado = estadoActual(negocio, datos?.pases.find((p) => p.id === negocio.plan)?.nombre, Date.now());
  const elegido = datos?.pases.find((p) => p.id === plan);
  const pendiente = datos?.pago_pendiente;
  const rechazado = datos?.ultimo_revisado?.status === 'REJECTED' ? datos.ultimo_revisado : null;

  return (
    <>
      <h1>Suscripción</h1>
      <Tarjeta>
        <div className="sus__estado">
          <p className="sus__etiqueta">Estado de tu plan</p>
          <p>
            <span className={`sus__sello sus__sello--${estado.tono}`}>{estado.sello}</span>
          </p>
          {estado.lineas.map((linea) => (
            <p key={linea}>{linea}</p>
          ))}
        </div>
      </Tarjeta>

      {errorCarga ? (
        <>
          <Aviso tono="error" titulo={errorCarga.status === 0 ? 'No hay conexión' : 'No pudimos cargar los pases'}>
            <p>{errorCarga.status === 0 ? 'Revisa tu internet y vuelve a intentar.' : 'Es un problema nuestro, no tuyo. Intenta de nuevo en un momento.'}</p>
          </Aviso>
          <Boton onClick={cargar}>Volver a intentar</Boton>
        </>
      ) : !datos ? (
        <Tarjeta crema>
          <p>Cargando los pases…</p>
        </Tarjeta>
      ) : pendiente ? (
        <Aviso titulo="Lo estamos revisando">
          <p>
            Recibimos tu captura del {datos.pases.find((p) => p.id === pendiente.plan)?.nombre.toLowerCase() ?? 'pase'} por <Monto valor={pendiente.amount_cop} />.
          </p>
          <p className="sus__nota">Enviada el {fechaLarga(pendiente.created_at)}</p>
          <p>Cuando la aprobemos, los días se suman solos a tu plan. No tienes que hacer nada más.</p>
          {repetido && (
            <p>
              <strong>No enviamos la otra captura:</strong> solo puede haber un pago en revisión a la vez.
            </p>
          )}
        </Aviso>
      ) : negocio.gratis ? null : (
        <>
          {rechazado && (
            <Aviso tono="error" titulo="No aprobamos tu último pago">
              <p>Motivo: {rechazado.review_note || 'no quedó anotado.'}</p>
              <p>Revisa el monto y la cuenta, y vuelve a enviar la captura abajo.</p>
            </Aviso>
          )}
          <form className="sus__formulario" onSubmit={enviar} noValidate>
            <section className="sus__paso" aria-labelledby="sus-paso-1">
              <h2 id="sus-paso-1">
                <span className="sus__numero">1</span> Elige tu pase
              </h2>
              <div className="sus__pases" role="radiogroup" aria-labelledby="sus-paso-1">
                {datos.pases.map((p) => (
                  <Opcion
                    key={p.id}
                    id={`sus-pase-${p.id}`}
                    name="pase"
                    value={p.id}
                    checked={plan === p.id}
                    onChange={() => {
                      setPlan(p.id);
                      setErrores((er) => ({ ...er, plan: null }));
                    }}
                    titulo={p.nombre}
                  >
                    <span className="sus__precio">
                      <Monto valor={p.precio_cop} />
                    </span>
                    <span className="sus__nota">
                      {p.dias} días{p.cuotas.deudores === null ? ' · deudores sin límite' : ''}
                    </span>
                  </Opcion>
                ))}
              </div>
              {errores.plan && (
                <p className="campo__error" role="alert">
                  {errores.plan}
                </p>
              )}
            </section>

            <section className="sus__paso" aria-labelledby="sus-paso-2">
              <h2 id="sus-paso-2">
                <span className="sus__numero">2</span> Paga en una de estas cuentas
              </h2>
              {datos.cuentas.length === 0 ? (
                <Aviso titulo="Todavía no hay cuentas para pagar">
                  <p>Estamos configurando dónde recibir los pagos. Por ahora no puedes pagar un pase desde aquí; escríbele a quien te dio acceso a TuListaNegra.</p>
                </Aviso>
              ) : (
                <>
                  <p>
                    {elegido ? (
                      <>
                        Transfiere exactamente <Monto valor={elegido.precio_cop} /> y toma una captura del comprobante.
                      </>
                    ) : (
                      'Transfiere el valor del pase que elegiste y toma una captura del comprobante.'
                    )}
                  </p>
                  <ul className="sus__cuentas">
                    {datos.cuentas.map((cuenta, i) =>
                      typeof cuenta === 'string' ? (
                        <li key={i} className="sus__cuenta">
                          {cuenta}
                        </li>
                      ) : cuenta && typeof cuenta === 'object' ? (
                        <li key={i} className="sus__cuenta">
                          <dl>
                            {Object.entries(cuenta)
                              .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
                              .map(([clave, valor]) => (
                                <div key={clave}>
                                  <dt>{ETIQUETA[clave] ?? clave}</dt>
                                  <dd>{String(valor)}</dd>
                                </div>
                              ))}
                          </dl>
                        </li>
                      ) : null,
                    )}
                  </ul>
                </>
              )}
            </section>

            {datos.cuentas.length > 0 && (
              <section className="sus__paso" aria-labelledby="sus-paso-3">
                <h2 id="sus-paso-3">
                  <span className="sus__numero">3</span> Envía la captura
                </h2>
                <Campo
                  id="sus-captura"
                  type="file"
                  accept={TIPOS.join(',')}
                  etiqueta="Foto o captura del pago"
                  ayuda="JPG, PNG o WebP de máximo 2 MB. Que se vean el monto y la fecha."
                  onChange={(e) => {
                    const nuevo = e.target.files?.[0] ?? null;
                    setArchivo(nuevo);
                    setErrores((er) => ({ ...er, captura: nuevo ? revisarCaptura(nuevo) : null }));
                  }}
                  error={errores.captura}
                />
                {negocio.estado === 'EXPIRED_READONLY' && (
                  <p className="sus__nota">
                    {rechazado
                      ? 'Esta vez no hay desbloqueo de 24 horas: esperamos a revisar el pago para volver a abrir tu libro.'
                      : 'Al enviarla te desbloqueamos 24 horas para seguir anotando mientras la revisamos.'}
                  </p>
                )}
                <Boton type="submit" disabled={enviando}>
                  {enviando ? 'Enviando…' : 'Enviar captura'}
                </Boton>
              </section>
            )}
          </form>
        </>
      )}
    </>
  );
}
