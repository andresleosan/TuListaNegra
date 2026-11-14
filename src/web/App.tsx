import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, ErrorApi, type Negocio, type NegocioSuspendido } from './api';
import { borrarCartera, guardarNegocio, negocioGuardado } from './cartera';
import { Alta } from './pantallas/Alta';
import { Esqueleto } from './pantallas/Esqueleto';
import { Hoja } from './pantallas/Hoja';
import { Ingreso } from './pantallas/Ingreso';
import { Legal } from './pantallas/Legal';
import { useRuta } from './ruta';
import { cargarProveedor, type ProveedorSesion } from './sesion';
import { Aviso } from './ui/Aviso';
import { Boton } from './ui/Boton';

// Página de muestra del sistema de diseño. Solo existe en desarrollo: en producción
// `import.meta.env.DEV` es `false`, la condición se elimina y la muestra no entra en el bundle.
const Muestra =
  import.meta.env.DEV && location.pathname === '/__muestra' ? lazy(() => import('./Muestra')) : null;

// La consola va en su propio trozo: un tendero nunca la descarga.
const Consola = lazy(() => import('./pantallas/consola/Consola'));

export function App() {
  const ruta = useRuta();
  if (Muestra) {
    return (
      <Suspense>
        <Muestra />
      </Suspense>
    );
  }
  // Textos legales: se leen con o sin sesión.
  if (ruta === '/terminos' || ruta === '/privacidad') return <Legal ruta={ruta} />;
  return <Sesion />;
}

/** Sin sesión → ingreso. Con sesión → la tienda de esa cuenta. */
function Sesion() {
  // `undefined` mientras carga; `null` si el ingreso aún no está configurado.
  const [proveedor, setProveedor] = useState<ProveedorSesion | null>();
  useEffect(() => {
    cargarProveedor().then(setProveedor, () => setProveedor(null));
  }, []);

  if (proveedor === undefined) return <Hoja cargando />;
  if (proveedor === null) return <Ingreso proveedor={null} />;
  return <ConProveedor proveedor={proveedor} />;
}

function ConProveedor({ proveedor }: { proveedor: ProveedorSesion }) {
  const usuario = useSyncExternalStore(proveedor.suscribir, proveedor.usuario);
  const ruta = useRuta();
  if (!usuario) return <Ingreso proveedor={proveedor} />;
  if (ruta === '/superadmin' || ruta.startsWith('/superadmin/')) {
    return (
      <Suspense fallback={<Hoja cargando />}>
        <Consola key={usuario.uid} alSalir={() => void proveedor.salir()} />
      </Suspense>
    );
  }
  // `key`: al salir o cambiar de cuenta se desmonta todo y no queda en memoria nada de la tienda anterior.
  return <Tienda key={usuario.uid} proveedor={proveedor} />;
}

type Carga = { tipo: 'cargando' } | { tipo: 'sin_negocio' } | { tipo: 'error'; error: ErrorApi } | { tipo: 'lista'; negocio: Negocio | NegocioSuspendido };

/** Con sesión: sin negocio → alta; con negocio → la app; suspendido → solo el aviso. */
function Tienda({ proveedor }: { proveedor: ProveedorSesion }) {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
  const [esSuperadmin, setEsSuperadmin] = useState(false);
  // Al salir no queda en este navegador nada de la tienda.
  const salir = () => void borrarCartera().finally(() => proveedor.salir());

  useEffect(() => {
    api<{ es_superadmin: boolean }>('/sesion').then((s) => setEsSuperadmin(s.es_superadmin), () => {});
  }, []);

  // Vuelve a pedir el negocio sin pasar por la pantalla de carga.
  const refrescar = useCallback(() => {
    api<Negocio | NegocioSuspendido>('/negocio').then((negocio) => setCarga({ tipo: 'lista', negocio }), () => {});
  }, []);
  // Si abrió sin red con el negocio guardado, al volver la red se trae el de verdad.
  useEffect(() => {
    addEventListener('online', refrescar);
    return () => removeEventListener('online', refrescar);
  }, [refrescar]);
  // El último negocio queda guardado junto a la copia de la cartera (ligado a esta cuenta; se borra al salir).
  useEffect(() => {
    if (carga.tipo === 'lista') guardarNegocio(carga.negocio);
  }, [carga]);

  const cargar = useCallback(() => {
    let vigente = true;
    setCarga({ tipo: 'cargando' });
    api<Negocio | NegocioSuspendido>('/negocio').then(
      (negocio) => vigente && setCarga({ tipo: 'lista', negocio }),
      async (e: unknown) => {
        if (!vigente) return;
        const error = e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido');
        // Sin red (MOS-05): se abre con el último negocio de esta cuenta guardado en este navegador. Las pantallas ven
        // la cartera «sin conexión» y no dejan escribir; sin red tampoco llega nada al servidor.
        const guardado = error.status === 0 ? await negocioGuardado() : null;
        if (!vigente) return;
        if (guardado) return setCarga({ tipo: 'lista', negocio: guardado });
        setCarga(error.status === 404 && error.error === 'sin_negocio' ? { tipo: 'sin_negocio' } : { tipo: 'error', error });
      },
    );
    return () => {
      vigente = false;
    };
  }, []);
  useEffect(cargar, [cargar]);

  if (carga.tipo === 'cargando') return <Hoja cargando />;
  if (carga.tipo === 'sin_negocio') return <Alta correo={proveedor.usuario()?.email ?? null} alCrear={(negocio) => setCarga({ tipo: 'lista', negocio })} alRecargar={cargar} alSalir={salir} />;
  if (carga.tipo === 'error') {
    return (
      <Hoja alSalir={salir}>
        <Aviso tono="error" titulo={carga.error.status === 0 ? 'No hay conexión' : 'No pudimos abrir tu tienda'}>
          <p>
            {carga.error.status === 0
              ? 'Revisa tu internet y vuelve a intentar.'
              : carga.error.status === 401
                ? 'Tu sesión venció. Sal y vuelve a entrar.'
                : 'Es un problema nuestro, no tuyo. Intenta de nuevo en un momento.'}
          </p>
        </Aviso>
        <Boton onClick={cargar}>Volver a intentar</Boton>
      </Hoja>
    );
  }
  if (carga.negocio.estado === 'SUSPENDED_BY_ADMIN') {
    return (
      <Hoja alSalir={salir}>
        <Aviso tono="error" titulo="Tu tienda está suspendida">
          <p>Por ahora no puedes ver ni anotar fiados. Tus datos siguen guardados.</p>
          <p>{carga.negocio.contacto ? `Para resolverlo, escríbenos: ${carga.negocio.contacto}` : 'Para resolverlo, escríbele a quien te dio acceso a TuListaNegra.'}</p>
        </Aviso>
      </Hoja>
    );
  }
  return <Esqueleto negocio={carga.negocio} alSalir={salir} alRecargar={refrescar} alActualizar={(negocio) => setCarga({ tipo: 'lista', negocio })} esSuperadmin={esSuperadmin} />;
}
