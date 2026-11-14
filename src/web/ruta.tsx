// Enrutador mínimo sobre la History API. Sin dependencia: la app tiene un puñado de pantallas.
import { type ComponentProps, useSyncExternalStore } from 'react';

function suscribir(alCambiar: () => void) {
  addEventListener('popstate', alCambiar);
  return () => removeEventListener('popstate', alCambiar);
}

/** Ruta actual (`location.pathname`); la pantalla se repinta al navegar. */
export const useRuta = () => useSyncExternalStore(suscribir, () => location.pathname);

export function navegar(a: string) {
  if (a === location.pathname) return;
  history.pushState(null, '', a);
  dispatchEvent(new PopStateEvent('popstate'));
  scrollTo(0, 0);
}

/** Enlace interno: navega sin recargar. Con `target`, Ctrl o clic central se comporta como un enlace normal. */
export function Enlace({ a, onClick, ...resto }: Omit<ComponentProps<'a'>, 'href'> & { a: string }) {
  return (
    <a
      href={a}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || resto.target || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navegar(a);
      }}
      {...resto}
    />
  );
}
