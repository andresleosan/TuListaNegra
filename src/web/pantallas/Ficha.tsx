import type { Negocio } from '../api';
import { Tarjeta } from '../ui/Tarjeta';

export function Ficha(_: { negocio: Negocio; id: string }) {
  return (
    <>
      <h1>Ficha del deudor</h1>
      <Tarjeta crema>
        <p>
          <strong>Próximamente.</strong> Estamos terminando esta parte.
        </p>
      </Tarjeta>
    </>
  );
}
