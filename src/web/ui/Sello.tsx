import './Sello.css';

// Texto de cada estado: el sello nunca comunica solo con color.
const textos = {
  AL_DIA: 'Al día',
  PROMESA_PAGO: 'Promesa de pago',
  EN_MORA: 'En mora',
  LISTA_NEGRA: 'Lista negra',
  CON_SALDO: 'Con saldo',
};

export type EstadoSello = keyof typeof textos;

export function Sello({ estado }: { estado: EstadoSello }) {
  return <span className={`sello sello--${estado}`}>{textos[estado]}</span>;
}
