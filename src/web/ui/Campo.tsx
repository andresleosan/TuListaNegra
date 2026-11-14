import { type ComponentProps, useId } from 'react';
import './Campo.css';

type Props = ComponentProps<'input'> & {
  etiqueta: string;
  /** Texto visible bajo la etiqueta: formato esperado o por qué se pide el dato. */
  ayuda?: string;
  /** Qué pasa y cómo arreglarlo. Con error, el campo se marca y el mensaje se anuncia. */
  error?: string | null;
};

/** Etiqueta visible encima, ayuda, entrada y error junto al campo. */
export function Campo({ etiqueta, ayuda, error, id, ...resto }: Props) {
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
      <input id={campo} aria-invalid={error ? true : undefined} aria-describedby={descrito || undefined} {...resto} />
      {error && (
        <p id={`${campo}-error`} className="campo__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
