import { useRef, useState } from 'react';
import { NOMBRE_TONO, textoDeCobro, type Tono, TONOS } from '../../shared/cobro';
import type { MotivoBloqueo } from '../../shared/contacto';
import { api, ErrorApi, type Negocio } from '../api';
import { Enlace } from '../ruta';
import { Aviso } from './Aviso';
import { Boton } from './Boton';
import './BotonCobrar.css';

type Props = {
  negocio: Negocio;
  deudor: { id: string; full_name: string; current_balance_cop: number };
  /** El servidor anotó el cobro (ms UTC). */
  alCobrar?: (cuando: number) => void;
};

// Por qué no se pudo cobrar, en palabras de tendero. El detalle lo trae el servidor en `mensaje`.
const TITULO: Record<MotivoBloqueo, string> = {
  SIN_CONSENTIMIENTO: 'Falta su autorización',
  BAJA: 'Pidió no recibir mensajes',
  DOMINGO: 'Hoy es domingo',
  FESTIVO: 'Hoy es festivo',
  FUERA_DE_HORARIO: 'Fuera del horario de cobro',
  YA_COBRADO_HOY: 'Ya le cobraste hoy',
  FRECUENCIA: 'Le cobraste hace poco',
  FESTIVOS_SIN_DATOS: 'Por ahora no se puede cobrar',
};

type Bloqueo = { titulo: string; texto: string; aSuscripcion?: boolean };

function explicar(e: unknown): Bloqueo {
  const fallo = e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido');
  if (fallo.error === 'contacto_bloqueado') {
    return { titulo: TITULO[fallo.datos.motivo as MotivoBloqueo] ?? 'No se puede cobrar ahora', texto: String(fallo.datos.mensaje ?? '') };
  }
  if (fallo.error === 'sin_telefono') return { titulo: 'No tiene WhatsApp anotado', texto: 'Anota su número en la ficha para poder cobrarle.' };
  if (fallo.error === 'sin_saldo') return { titulo: 'No debe nada', texto: 'Está al día: no hay nada que cobrar.' };
  if (fallo.error === 'sin_cuota') return { titulo: 'Se acabaron tus cobros por bot', texto: String(fallo.datos.mensaje ?? ''), aSuscripcion: true };
  if (fallo.error === 'envio_rechazado') {
    return { titulo: 'WhatsApp no aceptó el mensaje', texto: 'No se gastó tu cupo. Cóbrale con «Abrir WhatsApp» o vuelve a intentar más tarde.' };
  }
  if (fallo.status === 403) return { titulo: 'Tu plan está vencido', texto: 'Puedes consultar, pero para cobrar renueva tu plan en Suscripción.' };
  if (fallo.status === 0) return { titulo: 'No hay conexión', texto: 'Revisa tu internet y vuelve a tocar Cobrar.' };
  return { titulo: 'No pudimos preparar el cobro', texto: 'Es un problema nuestro, no tuyo. Vuelve a intentar en un momento.' };
}

/** Respuesta de `POST /api/cobros-bot/:id`: 200 `enviado` o 202 `sin_confirmar` (pudo salir; no se reintenta). */
type EnvioBot = { estado: 'enviado' | 'sin_confirmar'; simulado: boolean; last_reminder_sent_at: number };

/**
 * Cobrar por el WhatsApp del tendero: elige el tono, mira el mensaje y lo abre en WhatsApp. O lo envía el bot (WAP-03),
 * que gasta un cobro por bot; con el bot apagado el envío es de prueba y se dice así.
 * Las reglas de contacto las aplica el servidor; si bloquea, no se abre ni se envía nada y se explica por qué.
 */
export function BotonCobrar({ negocio, deudor, alCobrar }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [tono, setTono] = useState<Tono>(negocio.tono_cobro);
  const [enviando, setEnviando] = useState<'enlace' | 'bot' | null>(null);
  const [bloqueo, setBloqueo] = useState<Bloqueo | null>(null);
  // `url` solo si el navegador no dejó abrir la ventana: se ofrece el enlace para tocarlo.
  const [listo, setListo] = useState<{ url: string | null } | null>(null);
  const [enviado, setEnviado] = useState<EnvioBot | null>(null);
  // Un toque al bot conserva su request_id hasta que el servidor responda: si se cortó la conexión, reintentar no envía dos veces.
  const toque = useRef<string | null>(null);

  if (!negocio.permisos.escribir) {
    return (
      <p className="cobrar__nota">
        Para cobrar, renueva tu plan en <Enlace a="/suscripcion">Suscripción</Enlace>.
      </p>
    );
  }

  const texto = textoDeCobro(tono, { tienda: negocio.name, nombre: deudor.full_name, saldo_cop: deudor.current_balance_cop, medios_de_pago: negocio.payment_methods_info });

  function limpiar() {
    setBloqueo(null);
    setListo(null);
    setEnviado(null);
  }

  async function cobrar() {
    setEnviando('enlace');
    limpiar();
    try {
      const r = await api<{ url: string; last_reminder_sent_at: number }>(`/deudores/${deudor.id}/cobros`, { metodo: 'POST', cuerpo: { tono } });
      const ventana = window.open(r.url, '_blank');
      if (ventana) ventana.opener = null;
      setListo({ url: ventana ? null : r.url });
      setAbierto(false);
      alCobrar?.(r.last_reminder_sent_at);
    } catch (e) {
      setBloqueo(explicar(e));
    } finally {
      setEnviando(null);
    }
  }

  async function enviarConBot() {
    setEnviando('bot');
    limpiar();
    toque.current ??= crypto.randomUUID();
    try {
      const r = await api<EnvioBot>(`/cobros-bot/${deudor.id}`, { metodo: 'POST', cuerpo: { tono, request_id: toque.current } });
      toque.current = null;
      setEnviado(r);
      setAbierto(false);
      alCobrar?.(r.last_reminder_sent_at);
    } catch (e) {
      if (!(e instanceof ErrorApi && e.status === 0)) toque.current = null;
      setBloqueo(explicar(e));
    } finally {
      setEnviando(null);
    }
  }

  return (
    <div className="cobrar">
      {!abierto && (
        <Boton onClick={() => (setAbierto(true), limpiar())} aria-label={`Cobrar a ${deudor.full_name}`}>
          Cobrar
        </Boton>
      )}
      {abierto && (
        <div className="cobrar__panel">
          <fieldset className="cobrar__tonos">
            <legend>¿Cómo le escribes?</legend>
            {TONOS.map((t) => (
              <label key={t} className="cobrar__tono">
                <input type="radio" name={`tono-${deudor.id}`} value={t} checked={tono === t} onChange={() => setTono(t)} />
                {NOMBRE_TONO[t]}
              </label>
            ))}
          </fieldset>
          <div className="cobrar__mensaje">
            <p className="cobrar__etiqueta">Así le llega</p>
            <p data-testid="mensaje-cobro">{texto}</p>
          </div>
          <div className="cobrar__botones">
            <Boton onClick={cobrar} disabled={enviando !== null}>
              {enviando === 'enlace' ? 'Preparando…' : 'Abrir WhatsApp'}
            </Boton>
            {negocio.permisos.ia && (negocio.bot_whatsapp_activo || negocio.bot_whatsapp_simulado) && (
              <Boton variante="secundaria" onClick={enviarConBot} disabled={enviando !== null}>
                {enviando === 'bot' ? 'Enviando…' : negocio.bot_whatsapp_activo ? 'Enviar con el bot' : 'Enviar con el bot (simulado)'}
              </Boton>
            )}
            <Boton variante="secundaria" onClick={() => setAbierto(false)}>
              Cancelar
            </Boton>
          </div>
        </div>
      )}
      {bloqueo && (
        <Aviso tono="error" titulo={bloqueo.titulo}>
          <p>{bloqueo.texto}</p>
          {bloqueo.aSuscripcion && (
            <p>
              Renueva tu pase en <Enlace a="/suscripcion">Suscripción</Enlace>.
            </p>
          )}
        </Aviso>
      )}
      {listo && (
        <Aviso tono="bien" titulo="Mensaje listo en tu WhatsApp">
          {listo.url ? (
            <p>
              Tu navegador no abrió WhatsApp solo.{' '}
              <a href={listo.url} target="_blank" rel="noopener">
                Ábrelo aquí
              </a>
              .
            </p>
          ) : (
            <p>Revísalo y envíalo desde tu WhatsApp.</p>
          )}
        </Aviso>
      )}
      {enviado?.estado === 'enviado' && (
        <Aviso tono="bien" titulo={enviado.simulado ? 'Enviado (simulado)' : 'Enviado'}>
          <p>
            {enviado.simulado
              ? `Fue un envío de prueba: el bot de WhatsApp todavía no está encendido, así que a ${deudor.full_name} no le llegó nada.`
              : `El bot le envió el cobro a ${deudor.full_name} por WhatsApp.`}
          </p>
        </Aviso>
      )}
      {enviado?.estado === 'sin_confirmar' && (
        <Aviso titulo="WhatsApp no confirmó el envío">
          <p>Puede que sí le haya llegado. Para no escribirle dos veces, no lo intentes de nuevo hoy.</p>
        </Aviso>
      )}
    </div>
  );
}
