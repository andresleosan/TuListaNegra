import type { Negocio } from '../api';
import { Enlace } from '../ruta';
import { Boton } from '../ui/Boton';
import { Tarjeta } from '../ui/Tarjeta';
import { avisoVigencia, fechaLarga } from '../vigencia';
import './Mostrador.css';

/** Mostrador sin deudores todavía: invita a crear el primero y recuerda la vigencia. */
export function Mostrador({ negocio }: { negocio: Negocio }) {
  const ahora = Date.now();
  const enPrueba = negocio.estado === 'TRIAL';
  return (
    <>
      <h1>Mostrador</h1>
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
          <Boton disabled>Crear mi primer deudor</Boton>
          <p className="mostrador__nota">Próximamente: estamos terminando esta parte.</p>
        </div>
      </Tarjeta>
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
