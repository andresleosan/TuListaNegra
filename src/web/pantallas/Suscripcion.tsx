import type { Negocio } from '../api';
import { Tarjeta } from '../ui/Tarjeta';

export function Suscripcion(_: { negocio: Negocio; alCambiar: () => void }) {
  return (
    <>
      <h1>Suscripción</h1>
      <Tarjeta crema>
        <p>
          <strong>Próximamente.</strong> Estamos terminando esta parte.
        </p>
      </Tarjeta>
    </>
  );
}
