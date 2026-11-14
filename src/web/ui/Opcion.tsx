import type { ComponentProps, ReactNode } from 'react';
import './Opcion.css';

type Props = Omit<ComponentProps<'input'>, 'type' | 'children'> & { titulo: ReactNode; children?: ReactNode };

/** Opción de un grupo (radio) en forma de ficha: toda la ficha se pulsa. La elegida lleva el cuadro lleno y sombra, no solo color. */
export function Opcion({ titulo, children, ...resto }: Props) {
  return (
    <label className="opcion">
      <input type="radio" {...resto} />
      <span className="opcion__texto">
        <span className="opcion__titulo">{titulo}</span>
        {children}
      </span>
    </label>
  );
}
