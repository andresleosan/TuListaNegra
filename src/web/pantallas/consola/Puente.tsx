// WAP-08: puente de WhatsApp. Salud del webhook, último evento firmado, cuentas de 24 h y envío de prueba al WhatsApp
// verificado de la tienda propia. El servidor no manda secretos, teléfonos ni textos: aquí solo hay fechas y cifras.
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { api, ErrorApi, type EstadoPuente, type EstadoWa, type PruebaPuente } from '../../api';
import { Enlace } from '../../ruta';
import { Aviso } from '../../ui/Aviso';
import { Boton } from '../../ui/Boton';
import { Tarjeta } from '../../ui/Tarjeta';
import { fecha, mensajeDeError, Renglon } from './comun';

type Carga = { tipo: 'cargando' } | { tipo: 'error'; mensaje: string } | { tipo: 'lista'; datos: EstadoPuente };

const SALUD: Record<EstadoPuente['salud'], { sello: string; texto: string }> = {
  ok: { sello: 'Funciona', texto: 'Llegaron eventos firmados en las últimas 24 horas y no hay más fallos de lo normal.' },
  atencion: {
    sello: 'Revisar',
    texto: 'En las últimas 24 horas, 1 de cada 4 envíos o más se rechazó o falló, o la mitad o más de los mensajes que llegaron se quedó sin tienda. Mira las cuentas.',
  },
  sin_eventos: { sello: 'Sin eventos', texto: 'El webhook está listo, pero no ha llegado ningún evento firmado en las últimas 24 horas.' },
  sin_configurar: {
    sello: 'Sin configurar',
    texto: 'Falta configurar el puente en Cloudflare (el secreto de la app de Meta; con el envío real, también el token y el id del número): el webhook rechaza todo lo que llega.',
  },
};

const ESTADOS_WA: [EstadoWa, string][] = [
  ['accepted', 'Aceptados'],
  ['sent', 'Enviados'],
  ['delivered', 'Entregados'],
  ['read', 'Leídos'],
  ['unknown', 'Sin confirmar'],
  ['rejected', 'Rechazados'],
  ['failed', 'Fallidos'],
];
const NOMBRE_ESTADO = Object.fromEntries(ESTADOS_WA) as Record<EstadoWa, string>;

const HORA = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

export function Puente() {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
  // `enSilencio`: tras una prueba se actualizan las cifras sin quitar de la pantalla su resultado (ni cambiarlo por un error).
  const cargar = useCallback((enSilencio = false) => {
    let vigente = true;
    if (!enSilencio) setCarga({ tipo: 'cargando' });
    api<EstadoPuente>('/superadmin/puente').then(
      (datos) => vigente && setCarga({ tipo: 'lista', datos }),
      (e: unknown) => vigente && !enSilencio && setCarga({ tipo: 'error', mensaje: mensajeDeError(e) }),
    );
    return () => {
      vigente = false;
    };
  }, []);
  useEffect(() => cargar(), [cargar]);

  return (
    <>
      <div className="consola__titulo">
        <h1>Puente de WhatsApp</h1>
        {carga.tipo === 'lista' && (
          <Boton variante="secundaria" onClick={() => cargar()}>
            Actualizar
          </Boton>
        )}
      </div>
      {carga.tipo === 'cargando' && <p role="status">Revisando el puente…</p>}
      {carga.tipo === 'error' && (
        <>
          <Aviso tono="error" titulo="No pudimos revisar el puente">
            <p>{carga.mensaje}</p>
          </Aviso>
          <Boton onClick={() => cargar()}>Volver a intentar</Boton>
        </>
      )}
      {carga.tipo === 'lista' && (
        <div className="consola__puente">
          <Estado datos={carga.datos}>
            <Prueba alEnviar={() => cargar(true)} />
          </Estado>
        </div>
      )}
    </>
  );
}

/** `children`: el envío de prueba, que va después del último evento y antes de las cuentas (mismo orden en pantalla y al tabular). */
function Estado({ datos: d, children }: { datos: EstadoPuente; children: ReactNode }) {
  const c = d.configuracion;
  const h = d.ultimas_24h;
  return (
    <>
      <section className="consola__bloque" aria-labelledby="pue-salud">
        <Tarjeta>
          <h2 id="pue-salud">Salud del webhook</h2>
          <p>
            <span className={`sello consola__sello--${d.salud}`}>{SALUD[d.salud].sello}</span>
          </p>
          <p>{SALUD[d.salud].texto}</p>
          {d.salud === 'sin_configurar' && !c.envio_real && (
            <p className="consola__nota">Con el bot apagado, el puente solo acepta el secreto de desarrollo del simulador: nada del público entra.</p>
          )}
          <dl className="consola__renglones">
            <div className="consola__renglon">
              <dt>Envío real</dt>
              <dd>{c.envio_real ? 'Encendido' : 'Apagado · simulador'}</dd>
            </div>
            <div className="consola__renglon">
              <dt>Secreto de la app</dt>
              <dd>{c.secreto_app ? 'Puesto' : 'Falta'}</dd>
            </div>
            <div className="consola__renglon">
              <dt>Token de verificación</dt>
              <dd>{c.token_verificacion ? 'Puesto' : 'Falta'}</dd>
            </div>
          </dl>
        </Tarjeta>
      </section>

      <section className="consola__bloque" aria-labelledby="pue-evento">
        <Tarjeta>
          <h2 id="pue-evento">Último evento firmado</h2>
          <p className="consola__fecha">{d.ultimo_evento ? fecha(d.ultimo_evento.en) : 'Ninguno todavía'}</p>
          <p className="consola__nota">
            {d.ultimo_evento
              ? d.ultimo_evento.tipo === 'mensaje' ? 'Un mensaje que llegó por WhatsApp.' : 'Un aviso de estado de un envío nuestro.'
              : 'Cuando Meta (o el simulador) envíe un evento con firma válida, saldrá aquí.'}
          </p>
          <h3 className="consola__subtitulo">Último envío</h3>
          <p>{d.ultimo_saliente ? `${fecha(d.ultimo_saliente.en)} · ${NOMBRE_ESTADO[d.ultimo_saliente.estado]}` : 'Ninguno todavía'}</p>
        </Tarjeta>
      </section>

      {children}

      <section className="consola__bloque consola__bloque--cuentas" aria-labelledby="pue-24h">
        <Tarjeta>
          <h2 id="pue-24h">Últimas 24 horas</h2>
          <div className="consola__columnas">
            <div>
              <h3 className="consola__subtitulo">Mensajes que llegaron</h3>
              <dl className="consola__renglones">
                <Renglon nombre="Recibidos" valor={h.entrantes} />
                <Renglon nombre="Sin tienda (no se pudo enrutar)" valor={h.sin_enrutar} />
                <Renglon nombre="Esperando que elijan tienda" valor={h.en_eleccion} />
              </dl>
            </div>
            <div>
              <h3 className="consola__subtitulo">Envíos, por estado</h3>
              <dl className="consola__renglones">
                {ESTADOS_WA.map(([estado, nombre]) => (
                  <Renglon key={estado} nombre={nombre} valor={h.salientes[estado]} />
                ))}
              </dl>
            </div>
          </div>
        </Tarjeta>
      </section>
    </>
  );
}

type Envio = { tipo: 'listo' } | { tipo: 'enviando' } | { tipo: 'hecho'; r: PruebaPuente } | { tipo: 'fallo'; error: ErrorApi };

function Resultado({ envio }: { envio: Envio }) {
  if (envio.tipo === 'hecho') {
    const { r } = envio;
    if (r.resultado === 'enviada') {
      return (
        <Aviso tono="bien" titulo={r.simulado ? 'Prueba enviada al simulador' : 'Prueba enviada a tu WhatsApp'}>
          <p>{r.simulado ? 'El bot está apagado: quedó en la bandeja de salida y no le llega a nadie.' : 'Revisa tu teléfono: debe llegar en unos segundos.'}</p>
        </Aviso>
      );
    }
    if (r.resultado === 'rechazada') {
      return (
        <Aviso tono="error" titulo="WhatsApp rechazó la prueba">
          <p>No salió nada. Código: {r.codigo ?? 'sin código'}. Revisa la plantilla y el número en Meta.</p>
        </Aviso>
      );
    }
    return (
      <Aviso titulo="No sabemos si salió">
        <p>WhatsApp no respondió a tiempo. Mira tu teléfono antes de volver a probar.</p>
      </Aviso>
    );
  }
  if (envio.tipo !== 'fallo') return null;
  const e = envio.error;
  if (e.error === 'sin_telefono_verificado') {
    return (
      <Aviso titulo="No tienes un WhatsApp verificado">
        <p>
          La prueba solo va al WhatsApp verificado de tu propia tienda. Crea tu tienda con esta cuenta y, en <Enlace a="/ajustes">Ajustes</Enlace>, genera el código y
          envíalo por WhatsApp desde ese número. Luego vuelve aquí.
        </p>
      </Aviso>
    );
  }
  if (e.error === 'bot_apagado') {
    return (
      <Aviso titulo="El bot de WhatsApp está apagado">
        <p>No se envió nada. La prueba real sale cuando se enciende WHATSAPP_SEND_READY en Cloudflare.</p>
      </Aviso>
    );
  }
  if (e.error === 'puente_sin_configurar') {
    return (
      <Aviso titulo="El puente no está configurado">
        <p>No se envió nada. Con el envío real encendido faltan datos de Meta en Cloudflare: mira «Salud del webhook».</p>
      </Aviso>
    );
  }
  if (e.error === 'tope_diario') {
    return (
      <Aviso titulo="Ya enviaste muchas pruebas hoy">
        <p>Se permiten 10 en 24 horas, porque cada plantilla real cuesta. Vuelve a intentar mañana.</p>
      </Aviso>
    );
  }
  if (e.error === 'espera_prueba') {
    const en = Number(e.datos.reintentar_en);
    return (
      <Aviso titulo="Acabas de enviar una prueba">
        <p>Se permite una por minuto. Vuelve a intentar {Number.isFinite(en) ? `a las ${HORA.format(en)}` : 'en un minuto'}.</p>
      </Aviso>
    );
  }
  return (
    <Aviso tono="error" titulo="No pudimos enviar la prueba">
      <p>{mensajeDeError(e)}</p>
    </Aviso>
  );
}

function Prueba({ alEnviar }: { alEnviar: () => void }) {
  const [envio, setEnvio] = useState<Envio>({ tipo: 'listo' });

  async function enviar() {
    setEnvio({ tipo: 'enviando' });
    try {
      const r = await api<PruebaPuente>('/superadmin/puente/prueba', { metodo: 'POST', cuerpo: {} });
      setEnvio({ tipo: 'hecho', r });
      alEnviar();
    } catch (e) {
      setEnvio({ tipo: 'fallo', error: e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido') });
    }
  }

  return (
    <section className="consola__bloque consola__bloque--prueba" aria-labelledby="pue-prueba">
      <Tarjeta>
        <h2 id="pue-prueba">Envío de prueba</h2>
        <p>Manda una plantilla de prueba solo al WhatsApp verificado de tu propia tienda. No se puede elegir otro número.</p>
        <Boton onClick={enviar} disabled={envio.tipo === 'enviando'}>
          {envio.tipo === 'enviando' ? 'Enviando…' : 'Enviar prueba a mi WhatsApp'}
        </Boton>
        <Resultado envio={envio} />
      </Tarjeta>
    </section>
  );
}
