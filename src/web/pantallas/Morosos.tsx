import { useEffect, useState } from 'react';
import { type DeudorResumen, estadoDeudor } from '../../shared/deudor';
import type { Negocio } from '../api';
import { refrescarCartera, useCartera } from '../cartera';
import { Enlace } from '../ruta';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { BotonCobrar } from '../ui/BotonCobrar';
import { Monto } from '../ui/Monto';
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

/** Morosos (`/morosos`): deudas vencidas por antigüedad, con su saldo, los días de atraso y el botón Cobrar. */
export function Morosos({ negocio }: { negocio: Negocio }) {
  const cartera = useCartera();
  const [fallo, setFallo] = useState(false);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    setFallo(false);
    refrescarCartera().catch(() => setFallo(true));
  }, [intento]);

  const ahora = Date.now();
  const dias = negocio.default_alert_days;
  const morosos = cartera.deudores.filter((d) => enMora(d, ahora, dias)).sort(porAntiguedad);
  const total = morosos.reduce((suma, d) => suma + d.current_balance_cop, 0);
  const sinCopia = cartera.actualizada_en === null;

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
          <ol className="morosos__lista" aria-label="Deudores en mora, el más antiguo primero">
            {morosos.map((d) => {
              const atraso = d.oldest_unpaid_date === null ? 0 : Math.floor((ahora - d.oldest_unpaid_date) / DIA);
              return (
                <li key={d.id} className="morosos__fila" data-testid="moroso">
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
        </>
      )}
    </div>
  );
}
