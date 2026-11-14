// Un comprobante que llegó por WhatsApp (WAP-06): la foto, el monto (editable) y Aprobar o Rechazar con confirmación.
// El monto sugerido es el saldo del deudor (nadie leyó la imagen): el tendero lo ve junto a la foto antes de aprobar.
import { type FormEvent, useEffect, useState } from 'react';
import { formatoCOP } from '../../shared/dinero';
import { api, apiArchivo, type AbonoRevisado, ErrorApi } from '../api';
import { Enlace } from '../ruta';
import { Aviso } from './Aviso';
import { Boton } from './Boton';
import { Campo } from './Campo';
import { Monto } from './Monto';
import './RevisarAbono.css';

type Props = {
  abono: { id: string; amount_cop: number; created_at: number; evidence_r2_key: string | null };
  nombre: string;
  /** Saldo de hoy: el abono no puede pasar de aquí. */
  saldo: number;
  puedeEscribir: boolean;
  alRevisar: (r: AbonoRevisado) => void;
  /** Alguien lo revisó antes (p. ej. desde WhatsApp): hay que volver a traer la ficha. */
  alCambiarFuera: () => void;
};

const recibido = (ms: number) =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }).format(ms);
const aPesos = (texto: string) => Number(texto.replace(/\D/g, '').slice(0, 9)) || 0;
const miles = (valor: number) => (valor ? formatoCOP(valor).slice(2) : '');

function Foto({ clave, nombre }: { clave: string | null; nombre: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [fallo, setFallo] = useState(false);
  useEffect(() => {
    if (!clave) return;
    let vigente = true;
    let creada: string | null = null;
    apiArchivo(`/archivos/${clave}`).then(
      (blob) => {
        if (!vigente) return;
        creada = URL.createObjectURL(blob);
        setUrl(creada);
      },
      () => vigente && setFallo(true),
    );
    return () => {
      vigente = false;
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [clave]);
  if (!clave || fallo) return <p className="revisar__sin-foto">No pudimos mostrar la foto. Vuelve a abrir la ficha; si sigue sin verse, no lo apruebes sin confirmar el pago.</p>;
  if (!url) return <p className="revisar__sin-foto" role="status">Cargando la foto…</p>;
  return (
    <a className="revisar__foto" href={url} target="_blank" rel="noreferrer" aria-label={`Ver en grande la foto del comprobante de ${nombre}`}>
      <img src={url} alt={`Foto del comprobante que envió ${nombre}`} />
    </a>
  );
}

export function RevisarAbono({ abono, nombre, saldo, puedeEscribir, alRevisar, alCambiarFuera }: Props) {
  const [texto, setTexto] = useState(() => miles(Math.min(abono.amount_cop, saldo)));
  const [error, setError] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<'aprobar' | 'rechazar' | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  const monto = aPesos(texto);
  const campo = `revisar-${abono.id}`;

  function revisarMonto(): string | null {
    if (monto <= 0) return 'Escribe cuánto pagó según la foto: un valor mayor que cero.';
    if (monto > saldo) return `Debe hoy ${formatoCOP(saldo)}: el abono no puede pasar de ahí.`;
    return null;
  }

  function pedirAprobar(e: FormEvent) {
    e.preventDefault();
    const hallado = revisarMonto();
    setError(hallado);
    setFallo(null);
    if (hallado) return void document.getElementById(campo)?.focus();
    setConfirmar('aprobar');
  }

  async function enviar(accion: 'aprobar' | 'rechazar') {
    setEnviando(true);
    setFallo(null);
    try {
      alRevisar(await api<AbonoRevisado>(`/abonos/${abono.id}/${accion}`, { metodo: 'POST', cuerpo: accion === 'aprobar' ? { amount_cop: monto } : {} }));
    } catch (e) {
      const err = e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido');
      setConfirmar(null);
      if (err.error === 'supera_saldo') {
        setError(`Debe hoy ${formatoCOP(Number(err.datos.saldo))}: el abono no puede pasar de ahí. Corrige el monto.`);
        document.getElementById(campo)?.focus();
        alCambiarFuera(); // el saldo cambió: se trae la ficha de nuevo
      } else if (err.error === 'ya_revisado' || err.error === 'no_encontrado') {
        alCambiarFuera();
      } else {
        setFallo(err);
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <article className="revisar" aria-label={`Comprobante recibido el ${recibido(abono.created_at)}`}>
      <p className="revisar__cabeza">
        <span className="revisar__marca">Por revisar</span>
        <span>Recibido por WhatsApp el {recibido(abono.created_at)}</span>
      </p>
      <div className="revisar__cuerpo">
        <Foto clave={abono.evidence_r2_key} nombre={nombre} />
        {puedeEscribir ? (
          <form className="revisar__formulario" onSubmit={pedirAprobar} noValidate>
            <Campo
              id={campo}
              etiqueta="Monto del abono"
              ayuda={`Mira la foto y escribe lo que pagó. Sugerimos su saldo (${formatoCOP(abono.amount_cop)}) porque no leemos la imagen.`}
              inputMode="numeric"
              autoComplete="off"
              value={texto}
              onChange={(e) => {
                setTexto(miles(aPesos(e.target.value)));
                setError(null);
                setConfirmar(null);
              }}
              error={error}
            />
            {confirmar === 'aprobar' ? (
              <Aviso titulo={`¿Aprobar el abono de ${formatoCOP(monto)}?`}>
                <p>
                  Su saldo baja de <Monto valor={saldo} /> a <Monto valor={saldo - monto} />. Si autorizó mensajes, le enviamos la tirilla por WhatsApp.
                </p>
                <div className="revisar__botones">
                  <Boton disabled={enviando} onClick={() => enviar('aprobar')}>
                    {enviando ? 'Aprobando…' : 'Sí, aprobar'}
                  </Boton>
                  <Boton variante="secundaria" disabled={enviando} onClick={() => setConfirmar(null)}>
                    No, volver
                  </Boton>
                </div>
              </Aviso>
            ) : confirmar === 'rechazar' ? (
              <Aviso titulo="¿Rechazar este comprobante?">
                <p>El saldo no cambia. Si autorizó mensajes, le avisamos por WhatsApp sin dar detalles.</p>
                <div className="revisar__botones">
                  <Boton variante="peligro" disabled={enviando} onClick={() => enviar('rechazar')}>
                    {enviando ? 'Rechazando…' : 'Sí, rechazar'}
                  </Boton>
                  <Boton variante="secundaria" disabled={enviando} onClick={() => setConfirmar(null)}>
                    No, volver
                  </Boton>
                </div>
              </Aviso>
            ) : (
              <div className="revisar__botones">
                <Boton type="submit">Aprobar abono</Boton>
                <Boton variante="secundaria" onClick={() => (setFallo(null), setConfirmar('rechazar'))}>
                  Rechazar
                </Boton>
              </div>
            )}
            {fallo && (
              <Aviso tono="error" titulo={fallo.status === 0 ? 'No hay conexión' : fallo.status === 403 ? 'Tu plan no permite anotar' : 'No se guardó'}>
                <p>
                  {fallo.status === 0
                    ? 'Revisa tu internet y vuelve a intentar. El comprobante sigue esperando.'
                    : fallo.status === 403
                      ? 'Para aprobar o rechazar necesitas un pase vigente.'
                      : 'Es un problema nuestro, no tuyo. Vuelve a intentar en un momento.'}
                </p>
                {fallo.status === 403 && (
                  <p>
                    <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
                  </p>
                )}
              </Aviso>
            )}
          </form>
        ) : (
          <div className="revisar__formulario">
            <p>
              Monto sugerido: <Monto valor={abono.amount_cop} />
            </p>
            <p>
              Para aprobarlo o rechazarlo necesitas un pase vigente. <Enlace a="/suscripcion">Ver pases en Suscripción</Enlace>
            </p>
          </div>
        )}
      </div>
    </article>
  );
}
