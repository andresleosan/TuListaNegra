import type { ComponentProps } from 'react';
import './Boton.css';

type Props = ComponentProps<'button'> & { variante?: 'primaria' | 'secundaria' | 'peligro' };

export function Boton({ variante = 'primaria', type = 'button', ...resto }: Props) {
  return <button type={type} className={`boton boton--${variante}`} {...resto} />;
}
