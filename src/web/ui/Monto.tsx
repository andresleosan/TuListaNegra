import { formatoCOP } from '../../shared/dinero';
import './Monto.css';

// `valor` es un entero en pesos colombianos. El tono rojo solo se usa sobre fondo blanco (ver DESIGN.md).
type Props = { valor: number; tono?: 'verde' | 'rojo' };

export function Monto({ valor, tono }: Props) {
  return <span className={tono ? `monto monto--${tono}` : 'monto'}>{formatoCOP(valor)}</span>;
}
