import './Progreso.css';

type Props = { paso: number; total: number; nombre: string };

/** Barra de pasos de un formulario: los pasos hechos van llenos y el actual, a medias. Siempre con «Paso X de N». */
export function Progreso({ paso, total, nombre }: Props) {
  const texto = `Paso ${paso} de ${total}`;
  return (
    <div className="progreso">
      <p>
        <strong>{texto}</strong> · {nombre}
      </p>
      <div className="progreso__barra" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={paso} aria-valuetext={`${texto}: ${nombre}`}>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={i + 1 < paso ? 'progreso__tramo progreso__tramo--hecho' : i + 1 === paso ? 'progreso__tramo progreso__tramo--actual' : 'progreso__tramo'} />
        ))}
      </div>
    </div>
  );
}
