import type { Negocio } from '../api';
import { Tarjeta } from '../ui/Tarjeta';

export function Morosos(_: { negocio: Negocio }) {
  return (
    <>
      <h1>Morosos</h1>
      <Tarjeta crema>
        <p>
          <strong>Próximamente.</strong> Estamos terminando esta parte.
        </p>
      </Tarjeta>
    </>
  );
}
