import { Hoja } from '../Hoja';

/** Consola del superadministrador. El permiso real lo comprueba el servidor en cada ruta de /api/superadmin. */
export default function Consola({ alSalir }: { alSalir: () => void }) {
  return (
    <Hoja alSalir={alSalir}>
      <h1>Consola</h1>
      <p>Próximamente.</p>
    </Hoja>
  );
}
