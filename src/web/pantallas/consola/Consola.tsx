import { useEffect, useState } from 'react';
import { api, ErrorApi } from '../../api';
import { Enlace, useRuta } from '../../ruta';
import { Aviso } from '../../ui/Aviso';
import { Boton } from '../../ui/Boton';
import { Hoja, Marca } from '../Hoja';
import { Indicadores } from './Indicadores';
import { Negocios } from './Negocios';
import { Pagos } from './Pagos';
import './Consola.css';

const SECCIONES = [
  { ruta: '/superadmin/pagos', nombre: 'Pagos' },
  { ruta: '/superadmin/negocios', nombre: 'Negocios' },
  { ruta: '/superadmin/indicadores', nombre: 'Indicadores' },
];

type Acceso = { tipo: 'cargando' } | { tipo: 'sin_acceso' } | { tipo: 'error'; error: ErrorApi } | { tipo: 'listo'; email: string };

/** Consola del superadministrador. El permiso real lo comprueba el servidor en cada ruta de /api/superadmin. */
export default function Consola({ alSalir }: { alSalir: () => void }) {
  const ruta = useRuta();
  const [acceso, setAcceso] = useState<Acceso>({ tipo: 'cargando' });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vigente = true;
    api<{ email: string }>('/superadmin/yo').then(
      (yo) => vigente && setAcceso({ tipo: 'listo', email: yo.email }),
      (e: unknown) => {
        if (!vigente) return;
        const error = e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido');
        setAcceso(error.status === 403 ? { tipo: 'sin_acceso' } : { tipo: 'error', error });
      },
    );
    return () => {
      vigente = false;
    };
  }, [intento]);

  // /superadmin (o una subruta que no existe) abre la bandeja de pagos, sin dejar la dirección vieja en el historial.
  useEffect(() => {
    if (acceso.tipo !== 'listo' || SECCIONES.some((s) => s.ruta === ruta)) return;
    history.replaceState(null, '', '/superadmin/pagos');
    dispatchEvent(new PopStateEvent('popstate'));
  }, [acceso.tipo, ruta]);

  if (acceso.tipo === 'cargando') return <Hoja cargando />;
  if (acceso.tipo === 'sin_acceso') {
    return (
      <Hoja alSalir={alSalir}>
        <h1>No tienes acceso</h1>
        <Aviso titulo="Esta parte es solo para quien administra TuListaNegra">
          <p>Tu cuenta no tiene permiso para abrir la consola. Si crees que es un error, sal y entra con la cuenta de Google autorizada.</p>
        </Aviso>
        <p>
          <Enlace a="/">Volver a mi tienda</Enlace>
        </p>
      </Hoja>
    );
  }
  if (acceso.tipo === 'error') {
    return (
      <Hoja alSalir={alSalir}>
        <h1>No pudimos abrir la consola</h1>
        <Aviso tono="error" titulo={acceso.error.status === 0 ? 'No hay conexión' : 'Algo falló'}>
          <p>{acceso.error.status === 0 ? 'Revisa tu internet y vuelve a intentar.' : acceso.error.status === 401 ? 'Tu sesión venció. Sal y vuelve a entrar.' : 'Es un problema nuestro. Intenta de nuevo en un momento.'}</p>
        </Aviso>
        <Boton onClick={() => (setAcceso({ tipo: 'cargando' }), setIntento((n) => n + 1))}>Volver a intentar</Boton>
      </Hoja>
    );
  }

  return (
    <div className="consola">
      <header className="consola__cabecera">
        <div className="consola__marca">
          <Marca />
          <p className="consola__rotulo">Consola</p>
        </div>
        <div className="consola__cuenta">
          <code className="consola__correo">{acceso.email}</code>
          <Boton variante="secundaria" onClick={alSalir}>
            Salir
          </Boton>
        </div>
      </header>
      <nav className="consola__nav" aria-label="Consola">
        {SECCIONES.map((s) => (
          <Enlace key={s.ruta} a={s.ruta} aria-current={s.ruta === ruta ? 'page' : undefined}>
            {s.nombre}
          </Enlace>
        ))}
      </nav>
      <main className="consola__cuerpo">
        {ruta === '/superadmin/negocios' ? <Negocios /> : ruta === '/superadmin/indicadores' ? <Indicadores /> : <Pagos />}
      </main>
    </div>
  );
}
