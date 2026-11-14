import type { ReactNode } from 'react';
import './Tarjeta.css';

type Props = { children: ReactNode; crema?: boolean };

export function Tarjeta({ children, crema = false }: Props) {
  return <div className={crema ? 'tarjeta tarjeta--crema' : 'tarjeta'}>{children}</div>;
}
