import { type ComponentProps, useId } from 'react';
import './Campo.css';
import './CampoTexto.css';

type Props = ComponentProps<'textarea'> & {
  etiqueta: string;
  ayuda?: string;
  error?: string | null;
};

/** Como `Campo`, pero de varias líneas: para textos que no caben en un renglón (p. ej. medios de pago). */
export function CampoTexto({ etiqueta, ayuda, error, id, ...resto }: Props) {
  const propio = useId();
  const campo = id ?? propio;
  const descrito = [ayuda && `${campo}-ayuda`, error && `${campo}-error`].filter(Boolean).join(' ');
  return (
    <div className="campo">
      <label htmlFor={campo}>{etiqueta}</label>
      {ayuda && (
        <p id={`${campo}-ayuda`} className="campo__ayuda">
          {ayuda}
        </p>
      )}
      <textarea id={campo} aria-invalid={error ? true : undefined} aria-describedby={descrito || undefined} {...resto} />
      {error && (
        <p id={`${campo}-error`} className="campo__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
