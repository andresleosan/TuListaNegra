// Piezas que comparten las tres secciones de la consola.
import { type FormEvent, type ReactNode, useState } from 'react';
import type { EstadoNegocio } from '../../../shared/acceso';
import { ErrorApi } from '../../api';
import { Boton } from '../../ui/Boton';
import { Campo } from '../../ui/Campo';
import '../../ui/Sello.css';

/** Lo que pasó, en palabras, y qué hacer. Nunca el código crudo del servidor. */
export function mensajeDeError(e: unknown): string {
  const error = e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido');
  if (error.status === 0) return 'No hay conexión. Revisa tu internet y vuelve a intentar.';
  if (error.status === 401) return 'Tu sesión venció. Sal y vuelve a entrar.';
  if (error.status === 403) return 'Esta cuenta ya no tiene acceso a la consola.';
  if (error.error === 'no_encontrado') return 'Ya no existe. Recarga la lista.';
  if (error.error === 'datos_invalidos') return 'El servidor no aceptó el motivo. Escribe entre 3 y 300 letras.';
  return 'Algo falló de nuestro lado. Intenta de nuevo en un momento.';
}

const FECHA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Milisegundos UTC → «14 de nov de 2026, 18:05» en hora de Bogotá. */
export const fecha = (ms: number) => FECHA.format(ms);

const ESTADOS: Record<EstadoNegocio, string> = {
  TRIAL: 'En prueba',
  ACTIVE: 'Activo',
  GRACE_UNLOCK_24H: 'Desbloqueo 24 h',
  EXPIRED_READONLY: 'Vencido',
  SUSPENDED_BY_ADMIN: 'Suspendido',
};

/** Sello de caucho con el estado calculado de un negocio; siempre con texto. */
export function SelloEstado({ estado }: { estado: EstadoNegocio | 'GRATIS' }) {
  return <span className={`sello consola__sello--${estado}`}>{estado === 'GRATIS' ? 'Gratis' : ESTADOS[estado]}</span>;
}

type Confirmar = {
  titulo: string;
  children?: ReactNode;
  boton: string;
  peligro?: boolean;
  /** Toda acción de la consola pide motivo; aprobar un pago lo deja opcional. */
  motivoOpcional?: boolean;
  etiqueta?: string;
  /** Lanza si el servidor rechaza: el error se muestra aquí mismo. */
  alConfirmar: (motivo: string) => Promise<void>;
  alCancelar: () => void;
};

/** Confirmación en línea, bajo la fila: qué va a pasar, el motivo (queda en la auditoría) y dos botones. */
export function Confirmacion({ titulo, children, boton, peligro, motivoOpcional, etiqueta = 'Motivo', alConfirmar, alCancelar }: Confirmar) {
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const limpio = motivo.trim();
    if (limpio.length < 3 && !(motivoOpcional && limpio === '')) {
      setError(motivoOpcional ? 'Si escribes una nota, que tenga al menos 3 letras.' : 'Escribe el motivo (mínimo 3 letras). Queda guardado en el registro de la consola.');
      document.getElementById('consola-motivo')?.focus();
      return;
    }
    setError(null);
    setFallo(null);
    setEnviando(true);
    try {
      await alConfirmar(limpio);
    } catch (e) {
      setFallo(mensajeDeError(e));
      setEnviando(false);
    }
  }

  return (
    <form className="consola__confirmar" onSubmit={enviar} noValidate aria-label={titulo}>
      <p className="consola__confirmar-titulo">{titulo}</p>
      {children}
      <Campo
        id="consola-motivo"
        etiqueta={motivoOpcional ? `${etiqueta} (opcional)` : etiqueta}
        ayuda="Queda en el registro de la consola. Entre 3 y 300 letras."
        autoFocus
        maxLength={300}
        value={motivo}
        onChange={(e) => {
          setMotivo(e.target.value);
          if (error) setError(null);
        }}
        error={error}
      />
      {fallo && (
        <p className="campo__error" role="alert">
          {fallo}
        </p>
      )}
      <div className="consola__botones">
        <Boton type="submit" variante={peligro ? 'peligro' : 'primaria'} disabled={enviando}>
          {enviando ? 'Enviando…' : boton}
        </Boton>
        <Boton variante="secundaria" onClick={alCancelar} disabled={enviando}>
          Cancelar
        </Boton>
      </div>
    </form>
  );
}
