import type { ReactNode } from 'react';
import { Boton } from '../ui/Boton';
import './Hoja.css';

/** El nombre de la app, con «Negra» en bloque de tinta. */
export function Marca() {
  return (
    <p className="marca">
      TuLista<span>Negra</span>
    </p>
  );
}

type Props = { children?: ReactNode; cargando?: boolean; alSalir?: () => void };

/** Pantalla de una sola columna estrecha: ingreso, alta, avisos y textos legales. */
export function Hoja({ children, cargando = false, alSalir }: Props) {
  return (
    <div className="hoja">
      <header className="hoja__cabecera">
        <Marca />
        {alSalir && (
          <Boton variante="secundaria" onClick={alSalir}>
            Salir
          </Boton>
        )}
      </header>
      <main className="hoja__cuerpo">{cargando ? <p role="status">Cargando…</p> : children}</main>
    </div>
  );
}
