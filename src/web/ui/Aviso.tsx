import type { ReactNode } from 'react';
import './Aviso.css';

type Props = { tono?: 'error' | 'atencion' | 'bien'; titulo: string; children?: ReactNode };

/** Nota al margen: franja de color a la izquierda y título en texto; el color nunca va solo. Un error se anuncia. */
export function Aviso({ tono = 'atencion', titulo, children }: Props) {
  return (
    <div className={`aviso aviso--${tono}`} role={tono === 'error' ? 'alert' : 'status'}>
      <p className="aviso__titulo">{titulo}</p>
      {children}
    </div>
  );
}
