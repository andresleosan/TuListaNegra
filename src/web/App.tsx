import { lazy, Suspense } from 'react';

// Página de muestra del sistema de diseño. Solo existe en desarrollo: en producción
// `import.meta.env.DEV` es `false`, la condición se elimina y la muestra no entra en el bundle.
const Muestra =
  import.meta.env.DEV && location.pathname === '/__muestra' ? lazy(() => import('./Muestra')) : null;

export function App() {
  if (Muestra) {
    return (
      <Suspense>
        <Muestra />
      </Suspense>
    );
  }
  return <h1>TuListaNegra</h1>;
}
