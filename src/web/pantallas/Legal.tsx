import { Enlace } from '../ruta';
import { Aviso } from '../ui/Aviso';
import { Hoja } from './Hoja';

const TITULOS = { '/terminos': 'Términos y condiciones', '/privacidad': 'Política de tratamiento de datos' };

/** Página provisional: los textos legales los entrega el dueño (LEG-01). */
export function Legal({ ruta }: { ruta: keyof typeof TITULOS }) {
  return (
    <Hoja>
      <h1>{TITULOS[ruta]}</h1>
      <Aviso titulo="Texto pendiente de publicación">
        <p>Lo publicaremos en esta página antes de abrir el registro al público.</p>
      </Aviso>
      <p>
        <Enlace a="/">Ir al inicio</Enlace>
      </p>
    </Hoja>
  );
}
