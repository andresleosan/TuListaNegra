import { Monto } from './Monto';
import './Tirilla.css';

type Props = {
  tienda: string;
  codigo: string; // código del deudor, p. ej. `TLN-0042`
  lineas: { concepto: string; monto: number }[];
  total: number;
  fecha: string; // ya formateada
};

export function Tirilla({ tienda, codigo, lineas, total, fecha }: Props) {
  return (
    <article className="tirilla">
      <p className="tirilla__tienda">{tienda}</p>
      <p className="tirilla__codigo">Código {codigo}</p>
      <dl className="tirilla__lineas">
        {lineas.map((linea, i) => (
          <div className="tirilla__linea" key={i}>
            <dt>{linea.concepto}</dt>
            <dd>
              <Monto valor={linea.monto} />
            </dd>
          </div>
        ))}
        <div className="tirilla__linea tirilla__total">
          <dt>Total</dt>
          <dd>
            <Monto valor={total} />
          </dd>
        </div>
      </dl>
      <p className="tirilla__pie">{fecha}</p>
    </article>
  );
}
