import type { Negocio } from '../api';
import { Enlace, useRuta } from '../ruta';
import { Boton } from '../ui/Boton';
import { Tarjeta } from '../ui/Tarjeta';
import { avisoDeEstado } from '../vigencia';
import { Ajustes } from './Ajustes';
import { Ficha } from './Ficha';
import { Morosos } from './Morosos';
import { Mostrador } from './Mostrador';
import { Suscripcion } from './Suscripcion';
import './Esqueleto.css';

// Las secciones de la navegación. La ficha de un deudor (/deudor/<id>) cuelga del mostrador.
const SECCIONES = [
  { ruta: '/', nombre: 'Mostrador' },
  { ruta: '/morosos', nombre: 'Morosos' },
  { ruta: '/suscripcion', nombre: 'Suscripción' },
  { ruta: '/ajustes', nombre: 'Ajustes' },
];

/** La app con negocio: cabecera (tienda, aviso de estado, salir), sección actual y navegación. */
type Props = {
  negocio: Negocio;
  alSalir: () => void;
  /** Vuelve a pedir el negocio al servidor (p. ej. tras subir una captura de pago, que puede cambiar el estado). */
  alRecargar: () => void;
  /** Sustituye el negocio en memoria por el que devolvió el servidor (p. ej. al guardar ajustes). */
  alActualizar: (negocio: Negocio) => void;
  /** Solo pinta el enlace a la consola; el permiso lo decide el servidor. */
  esSuperadmin: boolean;
};

export function Esqueleto({ negocio, alSalir, alRecargar, alActualizar, esSuperadmin }: Props) {
  const ruta = useRuta();
  const ficha = ruta.match(/^\/deudor\/([\w-]+)$/)?.[1];
  const seccionActual = ficha ? '/' : ruta;
  const estado = avisoDeEstado(negocio, Date.now());
  return (
    <div className="app">
      <header className="app__cabecera">
        <div className="app__tienda">
          <p className="app__nombre">{negocio.name}</p>
          <div className="app__acciones">
            {esSuperadmin && <Enlace a="/superadmin">Consola</Enlace>}
            <Boton variante="secundaria" onClick={alSalir}>
              Salir
            </Boton>
          </div>
        </div>
        {estado && <p className={`app__estado app__estado--${estado.tono}`}>{estado.texto}</p>}
      </header>
      <nav className="app__nav" aria-label="Secciones">
        {SECCIONES.map((s) => (
          <Enlace key={s.ruta} a={s.ruta} aria-current={s.ruta === seccionActual ? 'page' : undefined}>
            {s.nombre}
          </Enlace>
        ))}
      </nav>
      <main className="app__cuerpo">
        {ruta === '/' ? (
          <Mostrador negocio={negocio} />
        ) : ficha ? (
          <Ficha key={ficha} negocio={negocio} id={ficha} />
        ) : ruta === '/morosos' ? (
          <Morosos negocio={negocio} />
        ) : ruta === '/suscripcion' ? (
          <Suscripcion negocio={negocio} alCambiar={alRecargar} />
        ) : ruta === '/ajustes' ? (
          <Ajustes negocio={negocio} alGuardar={alActualizar} />
        ) : (
          <>
            <h1>Esta página no existe</h1>
            <Tarjeta crema>
              <p>
                Revisa la dirección o vuelve al <Enlace a="/">mostrador</Enlace>.
              </p>
            </Tarjeta>
          </>
        )}
      </main>
    </div>
  );
}
