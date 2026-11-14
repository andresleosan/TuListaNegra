// SUP-02: bandeja de pagos por revisar. Las alertas son sugerencias: aprobar o rechazar lo decide una persona.
import { useCallback, useEffect, useState } from 'react';
import { api, apiArchivo, ErrorApi } from '../../api';
import { Aviso } from '../../ui/Aviso';
import { Boton } from '../../ui/Boton';
import { Monto } from '../../ui/Monto';
import { Tarjeta } from '../../ui/Tarjeta';
import { Confirmacion, fecha, mensajeDeError } from './comun';

/** Una fila de `GET /api/superadmin/pagos`. */
type Pago = {
  id: string;
  negocio: string;
  owner_email: string;
  days_to_add: number;
  amount_cop: number;
  receipt_r2_key: string;
  ocr_extracted_amount: number | null;
  ocr_reference_number: string | null;
  grace_started_at: number | null;
  created_at: number;
  monto_no_coincide: boolean;
  referencia_repetida: boolean;
};

type Carga = { tipo: 'cargando' } | { tipo: 'error'; mensaje: string } | { tipo: 'lista'; pagos: Pago[] };
type Abierto = { id: string; accion: 'aprobar' | 'rechazar' } | null;

export function Pagos() {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
  const [abierto, setAbierto] = useState<Abierto>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  const cargar = useCallback(() => {
    let vigente = true;
    setCarga({ tipo: 'cargando' });
    api<{ pagos: Pago[] }>('/superadmin/pagos').then(
      ({ pagos }) => vigente && setCarga({ tipo: 'lista', pagos }),
      (e: unknown) => vigente && setCarga({ tipo: 'error', mensaje: mensajeDeError(e) }),
    );
    return () => {
      vigente = false;
    };
  }, []);
  useEffect(cargar, [cargar]);

  const quitar = (id: string, mensaje: string) => {
    setCarga((c) => (c.tipo === 'lista' ? { tipo: 'lista', pagos: c.pagos.filter((p) => p.id !== id) } : c));
    setAbierto(null);
    setHecho(mensaje);
  };

  async function revisar(pago: Pago, accion: 'aprobar' | 'rechazar', motivo: string) {
    try {
      await api(`/superadmin/pagos/${encodeURIComponent(pago.id)}/${accion}`, { metodo: 'POST', cuerpo: accion === 'aprobar' ? { nota: motivo || null } : { motivo } });
      quitar(
        pago.id,
        accion === 'aprobar'
          ? `Aprobado: ${pago.negocio} quedó con su pase de ${pago.days_to_add} días.`
          : `Rechazado: ${pago.negocio} verá el motivo en su app y su desbloqueo terminó.`,
      );
    } catch (e) {
      // Otra persona (u otra pestaña) ya lo revisó: no queda nada que hacer con él aquí.
      if (e instanceof ErrorApi && e.error === 'ya_revisado') {
        return quitar(pago.id, `El pago de ${pago.negocio} ya estaba revisado (${e.datos.status === 'PAID' ? 'aprobado' : 'rechazado'}). Lo quitamos de la bandeja.`);
      }
      throw e;
    }
  }

  return (
    <>
      <div className="consola__titulo">
        <h1>Pagos por revisar</h1>
        {carga.tipo === 'lista' && carga.pagos.length > 0 && (
          <p className="consola__cuenta-filas">
            <code>{carga.pagos.length}</code> {carga.pagos.length === 1 ? 'pendiente' : 'pendientes'}, del más antiguo al más nuevo
          </p>
        )}
      </div>
      {hecho && (
        <Aviso tono="bien" titulo="Listo">
          <p>{hecho}</p>
        </Aviso>
      )}
      {carga.tipo === 'cargando' && <p role="status">Cargando la bandeja…</p>}
      {carga.tipo === 'error' && (
        <>
          <Aviso tono="error" titulo="No pudimos traer los pagos">
            <p>{carga.mensaje}</p>
          </Aviso>
          <Boton onClick={cargar}>Volver a intentar</Boton>
        </>
      )}
      {carga.tipo === 'lista' && carga.pagos.length === 0 && (
        <Tarjeta crema>
          <p className="consola__vacio-titulo">La bandeja está al día</p>
          <p>No hay capturas de pago esperando revisión. Cuando una tienda suba la suya, aparece aquí.</p>
        </Tarjeta>
      )}
      {carga.tipo === 'lista' && carga.pagos.length > 0 && (
        <div className="consola__libro consola__libro--pagos">
          <div className="consola__encabezado" aria-hidden="true">
            <span>Negocio</span>
            <span>Pase</span>
            <span className="consola__num">Esperado</span>
            <span>Leído en la captura</span>
            <span>Subido</span>
          </div>
          <ul className="consola__filas">
            {carga.pagos.map((pago) => (
              <FilaPago
                key={pago.id}
                pago={pago}
                abierto={abierto?.id === pago.id ? abierto.accion : null}
                alAbrir={(accion) => (setHecho(null), setAbierto({ id: pago.id, accion }))}
                alCerrar={() => setAbierto(null)}
                alRevisar={(accion, motivo) => revisar(pago, accion, motivo)}
              />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

type PropsFila = {
  pago: Pago;
  abierto: 'aprobar' | 'rechazar' | null;
  alAbrir: (accion: 'aprobar' | 'rechazar') => void;
  alCerrar: () => void;
  alRevisar: (accion: 'aprobar' | 'rechazar', motivo: string) => Promise<void>;
};

function FilaPago({ pago, abierto, alAbrir, alCerrar, alRevisar }: PropsFila) {
  const [verCaptura, setVerCaptura] = useState(false);
  const pase = `Pase de ${pago.days_to_add} días`;
  return (
    <li className="consola__fila">
      <dl className="consola__datos">
        <div>
          <dt>Negocio</dt>
          <dd>
            <strong className="consola__nombre">{pago.negocio}</strong>
            <span className="consola__dato-menor">{pago.owner_email}</span>
          </dd>
        </div>
        <div>
          <dt>Pase</dt>
          <dd>{pase}</dd>
        </div>
        <div>
          <dt>Monto esperado</dt>
          <dd className="consola__num">
            <Monto valor={pago.amount_cop} />
          </dd>
        </div>
        <div>
          <dt>Leído en la captura</dt>
          <dd>
            {pago.ocr_extracted_amount === null && pago.ocr_reference_number === null ? (
              'Sin lectura automática'
            ) : (
              <>
                {pago.ocr_extracted_amount !== null && <Monto valor={pago.ocr_extracted_amount} />}
                {pago.ocr_reference_number !== null && (
                  <span className="consola__dato-menor">
                    Ref. <code>{pago.ocr_reference_number}</code>
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Subido</dt>
          <dd>
            {fecha(pago.created_at)}
            {pago.grace_started_at !== null && <span className="consola__dato-menor">Con desbloqueo de 24 h</span>}
          </dd>
        </div>
      </dl>
      {(pago.monto_no_coincide || pago.referencia_repetida) && (
        <ul className="consola__alertas" aria-label="Alertas">
          {pago.monto_no_coincide && (
            <li>
              Monto distinto: se leyó <Monto valor={pago.ocr_extracted_amount ?? 0} /> y el pase cuesta <Monto valor={pago.amount_cop} />.
            </li>
          )}
          {pago.referencia_repetida && <li>Referencia repetida: ese número ya apareció en otro pago.</li>}
        </ul>
      )}
      <div className="consola__botones">
        <Boton variante="secundaria" aria-expanded={verCaptura} onClick={() => setVerCaptura((v) => !v)}>
          {verCaptura ? 'Ocultar captura' : 'Ver captura'}
        </Boton>
        <Boton onClick={() => alAbrir('aprobar')} disabled={abierto === 'aprobar'}>
          Aprobar
        </Boton>
        <Boton variante="peligro" onClick={() => alAbrir('rechazar')} disabled={abierto === 'rechazar'}>
          Rechazar
        </Boton>
      </div>
      {verCaptura && <Captura clave={pago.receipt_r2_key} negocio={pago.negocio} />}
      {abierto === 'aprobar' && (
        <Confirmacion
          titulo={`¿Aprobar el pago de ${pago.negocio}?`}
          boton="Sí, aprobar"
          motivoOpcional
          etiqueta="Nota"
          alConfirmar={(nota) => alRevisar('aprobar', nota)}
          alCancelar={alCerrar}
        >
          <p>
            Suma el {pase.toLowerCase()} (<Monto valor={pago.amount_cop} />), reinicia sus cuotas y cierra el desbloqueo. Confírmalo solo si viste la plata en la cuenta.
          </p>
        </Confirmacion>
      )}
      {abierto === 'rechazar' && (
        <Confirmacion
          titulo={`¿Rechazar el pago de ${pago.negocio}?`}
          boton="Sí, rechazar"
          peligro
          etiqueta="Motivo del rechazo"
          alConfirmar={(motivo) => alRevisar('rechazar', motivo)}
          alCancelar={alCerrar}
        >
          <p>La tienda verá este motivo en su app y, si tenía desbloqueo de 24 h, se le termina ahora.</p>
        </Confirmacion>
      )}
    </li>
  );
}

/** La captura se pide con la sesión y vive como URL local solo mientras se ve. */
function Captura({ clave, negocio }: { clave: string; negocio: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let vigente = true;
    let creada: string | null = null;
    apiArchivo(`/superadmin/archivos/${clave.split('/').map(encodeURIComponent).join('/')}`).then(
      (blob) => {
        if (!vigente) return;
        creada = URL.createObjectURL(blob);
        setUrl(creada);
      },
      (e: unknown) => vigente && setError(e instanceof ErrorApi && e.error === 'no_encontrado' ? 'La captura ya no está guardada.' : mensajeDeError(e)),
    );
    return () => {
      vigente = false;
      if (creada) URL.revokeObjectURL(creada);
    };
  }, [clave]);

  if (error) {
    return (
      <p className="campo__error" role="alert">
        {error}
      </p>
    );
  }
  if (!url) return <p role="status">Cargando la captura…</p>;
  return (
    <figure className="consola__captura">
      <img src={url} alt={`Captura del pago de ${negocio}`} />
    </figure>
  );
}
