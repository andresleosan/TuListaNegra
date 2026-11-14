import { type FormEvent, useState } from 'react';
import { NOMBRE_TONO, textoDeCobro, TONOS, type Tono } from '../../shared/cobro';
import { api, ErrorApi, type Negocio } from '../api';
import { Enlace } from '../ruta';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { Campo } from '../ui/Campo';
import { CampoTexto } from '../ui/CampoTexto';
import { Opcion } from '../ui/Opcion';
import './Ajustes.css';

// Una frase por tono para elegir rápido; el mensaje completo sale en la muestra de al lado.
const EJEMPLO: Record<Tono, string> = {
  VECINO_AMIGABLE: 'Cordial, para el cliente de confianza: «Le recordamos con mucho gusto…».',
  CORTE_DE_QUINCENA: 'Para el día de pago: «Llegó la quincena y su saldo pendiente es…».',
  AVISO_FIRME: 'Serio y sin amenazas: «Ya pasó el plazo acordado…».',
};

const ERROR_MEDIOS = 'Déjalo en 300 letras o menos.';
const ERROR_DIAS = 'Escribe un número entero de días entre 1 y 365. Ejemplo: 30.';

type CampoAjuste = 'medios' | 'dias' | 'tono';
const DEL_SERVIDOR: Record<string, CampoAjuste> = { payment_methods_info: 'medios', default_alert_days: 'dias', tono_cobro: 'tono' };
const MENSAJE: Record<CampoAjuste, string> = { medios: ERROR_MEDIOS, dias: ERROR_DIAS, tono: 'Elige uno de los tres tonos.' };

const revisarDias = (v: string) => (/^\d{1,3}$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 365 ? null : ERROR_DIAS);

/** Ajustes de la tienda (AJU-01): medios de pago, días para pasar a mora y tono de cobro por defecto. */
export function Ajustes({ negocio, alGuardar }: { negocio: Negocio; alGuardar: (negocio: Negocio) => void }) {
  const [medios, setMedios] = useState(negocio.payment_methods_info ?? '');
  const [dias, setDias] = useState(String(negocio.default_alert_days));
  const [tono, setTono] = useState<Tono>(negocio.tono_cobro);
  const [errores, setErrores] = useState<Partial<Record<CampoAjuste, string | null>>>({});
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [guardado, setGuardado] = useState(false);

  // Vencida (o vencida mientras tenía la pantalla abierta): se ve todo, pero cambiar lleva a Suscripción.
  const soloLectura = !negocio.permisos.escribir || fallo?.status === 403;

  const cambiar = (poner: () => void) => {
    poner();
    setGuardado(false);
  };

  const marcar = (campo: CampoAjuste, mensaje: string) => {
    setErrores((e) => ({ ...e, [campo]: mensaje }));
    document.getElementById(`ajustes-${campo}`)?.focus();
  };

  async function guardar(e: FormEvent) {
    e.preventDefault();
    const errorDias = revisarDias(dias);
    setErrores({ dias: errorDias });
    if (errorDias) return void document.getElementById('ajustes-dias')?.focus();

    setFallo(null);
    setEnviando(true);
    try {
      const nuevo = await api<Negocio>('/negocio', { metodo: 'PATCH', cuerpo: { payment_methods_info: medios, default_alert_days: Number(dias), tono_cobro: tono } });
      setMedios(nuevo.payment_methods_info ?? '');
      setGuardado(true);
      alGuardar(nuevo);
    } catch (error) {
      const fallo = error instanceof ErrorApi ? error : new ErrorApi(0, 'error_desconocido');
      // El formulario aplica las mismas reglas que el servidor: esto solo pasa si alguna vez dejan de coincidir.
      const rechazado = fallo.error === 'datos_invalidos' && fallo.campos?.map((c) => DEL_SERVIDOR[c]).find(Boolean);
      if (rechazado) marcar(rechazado, MENSAJE[rechazado]);
      else setFallo(fallo);
    } finally {
      setEnviando(false);
    }
  }

  const muestra = textoDeCobro(tono, { tienda: negocio.name, nombre: 'don Carlos', saldo_cop: 84_900, medios_de_pago: medios.trim() || null });

  return (
    <>
      <h1>Ajustes</h1>
      <p>Lo que pongas aquí sale en los cobros que les mandas a tus clientes.</p>
      {soloLectura && (
        <Aviso tono="error" titulo="Tu plan venció: puedes ver tus ajustes, pero no cambiarlos">
          <p>
            Para volver a cambiarlos, renueva tu plan en <Enlace a="/suscripcion">Suscripción</Enlace>.
          </p>
        </Aviso>
      )}
      <div className="ajustes">
        <form className="ajustes__formulario" onSubmit={guardar} noValidate>
          <fieldset className="ajustes__grupo" disabled={soloLectura}>
            <CampoTexto
              id="ajustes-medios"
              etiqueta="Cómo te pueden pagar"
              ayuda="Nequi, Daviplata, una cuenta o «en la tienda». Sale al final de cada cobro. Máximo 300 letras."
              maxLength={300}
              rows={3}
              autoComplete="off"
              placeholder="Ejemplo: Nequi 300 123 4567 a nombre de Rubiela"
              value={medios}
              onChange={(e) => cambiar(() => setMedios(e.target.value))}
              error={errores.medios}
            />
            <Campo
              id="ajustes-dias"
              etiqueta="Días para pasar a mora"
              ayuda="Si un fiado lleva más de estos días sin pagarse, el cliente pasa a «En mora». Entre 1 y 365."
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="done"
              maxLength={3}
              value={dias}
              onChange={(e) => {
                const valor = e.target.value;
                cambiar(() => setDias(valor));
                if (errores.dias) setErrores((er) => ({ ...er, dias: revisarDias(valor) }));
              }}
              onBlur={(e) => setErrores((er) => ({ ...er, dias: revisarDias(e.target.value) }))}
              error={errores.dias}
            />
            <fieldset className="ajustes__grupo ajustes__tonos" aria-describedby="ajustes-tono-ayuda">
              <legend>Tono de cobro por defecto</legend>
              <p id="ajustes-tono-ayuda" className="ajustes__ayuda">
                El que sale elegido cuando vas a cobrar. Ninguno amenaza ni menciona listas.
              </p>
              {TONOS.map((t) => (
                <Opcion key={t} id={t === TONOS[0] ? 'ajustes-tono' : undefined} name="tono" value={t} checked={tono === t} onChange={() => cambiar(() => setTono(t))} titulo={NOMBRE_TONO[t]}>
                  <span className="ajustes__ayuda">{EJEMPLO[t]}</span>
                </Opcion>
              ))}
              {errores.tono && (
                <p className="campo__error" role="alert">
                  {errores.tono}
                </p>
              )}
            </fieldset>
          </fieldset>
          {guardado && (
            <Aviso tono="bien" titulo="Ajustes guardados">
              <p>Los próximos cobros ya salen con estos datos.</p>
            </Aviso>
          )}
          {fallo && fallo.status !== 403 && (
            <Aviso tono="error" titulo={fallo.status === 0 ? 'No hay conexión' : 'No pudimos guardar'}>
              <p>
                {fallo.status === 0
                  ? 'Revisa tu internet y vuelve a tocar «Guardar ajustes». Lo que escribiste sigue aquí.'
                  : fallo.status === 401
                    ? 'Tu sesión venció. Sal, vuelve a entrar e inténtalo de nuevo.'
                    : 'Es un problema nuestro, no tuyo. Vuelve a tocar el botón en un momento.'}
              </p>
            </Aviso>
          )}
          {soloLectura ? (
            <Enlace a="/suscripcion" className="boton boton--primaria">
              Renovar mi plan
            </Enlace>
          ) : (
            <Boton type="submit" disabled={enviando}>
              {enviando ? 'Guardando…' : 'Guardar ajustes'}
            </Boton>
          )}
        </form>
        <aside className="ajustes__muestra" aria-labelledby="ajustes-muestra">
          <h2 id="ajustes-muestra">Así sale tu cobro</h2>
          <p className="ajustes__ayuda">Ejemplo con un cliente inventado. Cambia al escribir.</p>
          <p className="ajustes__mensaje">{muestra}</p>
        </aside>
      </div>
    </>
  );
}
