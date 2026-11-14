import type { Negocio } from '../api';
import { Tarjeta } from '../ui/Tarjeta';

export function Ajustes(_: { negocio: Negocio; alGuardar: (negocio: Negocio) => void }) {
  return (
    <>
      <h1>Ajustes</h1>
      <Tarjeta crema>
        <p>
          <strong>Próximamente.</strong> Estamos terminando esta parte.
        </p>
      </Tarjeta>
    </>
  );
}
