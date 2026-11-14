import { type ComponentProps, type ReactNode, useId } from 'react';
import './Campo.css'; // comparte el mensaje de error
import './Casilla.css';

type Props = Omit<ComponentProps<'input'>, 'type' | 'children'> & { children: ReactNode; error?: string | null };

/** Casilla con su texto al lado (puede llevar enlaces) y error debajo. Toda la fila se puede pulsar. */
export function Casilla({ children, error, id, ...resto }: Props) {
  const propio = useId();
  const casilla = id ?? propio;
  return (
    <div className="casilla">
      <label className="casilla__fila">
        <input type="checkbox" id={casilla} aria-invalid={error ? true : undefined} aria-describedby={error ? `${casilla}-error` : undefined} {...resto} />
        <span>{children}</span>
      </label>
      {error && (
        <p id={`${casilla}-error`} className="campo__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
