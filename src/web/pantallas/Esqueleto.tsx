import type { Negocio } from '../api';
import { Enlace, useRuta } from '../ruta';
import { Boton } from '../ui/Boton';
import { Tarjeta } from '../ui/Tarjeta';
import { avisoDeEstado } from '../vigencia';
import { Mostrador } from './Mostrador';
import './Esqueleto.css';

// Las secciones de la app. Cada tarea que construya una pantalla la cuelga aquí.
const SECCIONES = [
  { ruta: '/', nombre: 'Mostrador' },
  { ruta: '/morosos', nombre: 'Morosos' },
  { ruta: '/suscripcion', nombre: 'Suscripción' },
  { ruta: '/ajustes', nombre: 'Ajustes' },
];

/** La app con negocio: cabecera (tienda, aviso de estado, salir), sección actual y navegación. */
export function Esqueleto({ negocio, alSalir }: { negocio: Negocio; alSalir: () => void }) {
  const ruta = useRuta();
  const seccion = SECCIONES.find((s) => s.ruta === ruta);
  const estado = avisoDeEstado(negocio, Date.now());
  return (
    <div className="app">
      <header className="app__cabecera">
        <div className="app__tienda">
          <p className="app__nombre">{negocio.name}</p>
          <Boton variante="secundaria" onClick={alSalir}>
            Salir
          </Boton>
        </div>
        {estado && <p className={`app__estado app__estado--${estado.tono}`}>{estado.texto}</p>}
      </header>
      <nav className="app__nav" aria-label="Secciones">
        {SECCIONES.map((s) => (
          <Enlace key={s.ruta} a={s.ruta} aria-current={s.ruta === ruta ? 'page' : undefined}>
            {s.nombre}
          </Enlace>
        ))}
      </nav>
      <main className="app__cuerpo">
        {ruta === '/' ? (
          <Mostrador negocio={negocio} />
        ) : (
          <>
            <h1>{seccion?.nombre ?? 'Esta página no existe'}</h1>
            <Tarjeta crema>
              {seccion ? (
                <p>
                  <strong>Próximamente.</strong> Estamos terminando esta parte.
                </p>
              ) : (
                <p>
                  Revisa la dirección o vuelve al <Enlace a="/">mostrador</Enlace>.
                </p>
              )}
            </Tarjeta>
          </>
        )}
      </main>
    </div>
  );
}
