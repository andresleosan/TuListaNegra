import { type FormEvent, useEffect, useState } from 'react';
import { type DeudorDetalle, TIPOS_DOCUMENTO } from '../../shared/deudor';
import { formatoCOP, MONTO_MAXIMO_COP } from '../../shared/dinero';
import { normalizarTelefonoCO } from '../../shared/telefono';
import { api, ErrorApi, type Negocio } from '../api';
import { refrescarCartera } from '../cartera';
import { Enlace } from '../ruta';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { BotonCobrar } from '../ui/BotonCobrar';
import { Campo } from '../ui/Campo';
import { Monto } from '../ui/Monto';
import { type EstadoSello, Sello } from '../ui/Sello';
import { Tarjeta } from '../ui/Tarjeta';
import { Tirilla } from '../ui/Tirilla';
import { fechaLarga } from '../vigencia';
import './Ficha.css';

type Deudor = DeudorDetalle & { estado: EstadoSello };

type Movimiento = {
  id: string;
  type: 'FIADO' | 'ABONO' | 'AJUSTE_SUMA' | 'AJUSTE_RESTA';
  amount_cop: number;
  status: 'CONFIRMADO' | 'PENDIENTE_VERIFICACION_WHATSAPP' | 'RECHAZADO';
  /** Saldo corrido que calcula el servidor; vacío mientras no esté confirmado. */
  balance_after_cop: number | null;
  description: string;
  created_at: number;
};

/** FIADO y AJUSTE_SUMA aumentan la deuda; ABONO y AJUSTE_RESTA la reducen (igual que el libro del servidor). */
const delta = (m: Movimiento) => (m.type === 'FIADO' || m.type === 'AJUSTE_SUMA' ? 1 : -1) * m.amount_cop;

const fechaCorta = (ms: number) =>
  new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' }).format(ms);
const fechaDia = (ms: number) => new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Bogota' }).format(ms);

/** `+573001234567` → `300 123 4567`. */
const telefonoLocal = (e164: string) => e164.replace(/^\+57(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3');

const ESTADO_PENDIENTE = { PENDIENTE_VERIFICACION_WHATSAPP: 'Por verificar', RECHAZADO: 'Rechazado' } as const;

/** Texto plano del recibo, para compartirlo por WhatsApp o el menú del sistema. */
function textoRecibo(tienda: string, codigo: string, m: Movimiento, medios: string | null) {
  const saldo = m.balance_after_cop ?? 0;
  return [
    tienda,
    `Recibo · Código ${codigo}`,
    fechaLarga(m.created_at),
    `Saldo anterior: ${formatoCOP(saldo - delta(m))}`,
    `${m.description}: ${formatoCOP(delta(m))}`,
    `Total: ${formatoCOP(saldo)}`,
    medios ? `Medios de pago: ${medios}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function compartir(texto: string) {
  if (typeof navigator.share === 'function') {
    try {
      return await navigator.share({ text: texto });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return; // la persona cerró el menú
    }
  }
  const ventana = window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, '_blank');
  if (ventana) ventana.opener = null;
}

function Recibo({ negocio, deudor, movimiento, alCerrar }: { negocio: Negocio; deudor: Deudor; movimiento: Movimiento | undefined; alCerrar: () => void }) {
  if (!movimiento || movimiento.balance_after_cop === null) {
    return (
      <Aviso titulo="No encontramos ese recibo">
        <p>Puede que el movimiento no esté confirmado todavía. Busca el recibo en los movimientos de abajo.</p>
        <Boton variante="secundaria" onClick={alCerrar}>
          Cerrar
        </Boton>
      </Aviso>
    );
  }
  const saldo = movimiento.balance_after_cop;
  return (
    <section className="ficha__recibo" aria-label="Recibo">
      <div className="ficha__papel">
        <Tirilla
          tienda={negocio.name}
          codigo={deudor.unique_code}
          lineas={[
            { concepto: 'Saldo anterior', monto: saldo - delta(movimiento) },
            { concepto: movimiento.description, monto: delta(movimiento) },
          ]}
          total={saldo}
          fecha={fechaLarga(movimiento.created_at)}
        />
        {negocio.payment_methods_info && (
          <p className="ficha__medios">
            <strong>Medios de pago</strong>
            {negocio.payment_methods_info}
          </p>
        )}
      </div>
      <div className="ficha__botones">
        <Boton onClick={() => compartir(textoRecibo(negocio.name, deudor.unique_code, movimiento, negocio.payment_methods_info))}>Compartir recibo</Boton>
        <Boton variante="secundaria" onClick={alCerrar}>
          Cerrar recibo
        </Boton>
      </div>
    </section>
  );
}

type Formulario = { full_name: string; alias_reference: string; whatsapp_phone: string; doc_type: string; doc_number: string; credit_limit_cop: string };
type Errores = Partial<Record<keyof Formulario, string>>;

function revisar(f: Formulario): Errores {
  const e: Errores = {};
  if (!f.full_name.trim()) e.full_name = 'Escribe el nombre o el apodo.';
  if (f.whatsapp_phone.trim() && !normalizarTelefonoCO(f.whatsapp_phone)) e.whatsapp_phone = 'Debe ser un celular de Colombia: 10 dígitos que empiezan por 3. Ejemplo: 300 123 4567.';
  const doc = f.doc_number.replace(/[\s.-]/g, '');
  if (doc && !/^[0-9A-Za-z]{4,15}$/.test(doc)) e.doc_number = 'Escribe entre 4 y 15 letras o números, sin puntos.';
  if (doc && !f.doc_type) e.doc_type = 'Elige el tipo de documento.';
  const tope = f.credit_limit_cop.replace(/\D/g, '');
  if (tope && Number(tope) > MONTO_MAXIMO_COP) e.credit_limit_cop = `El tope máximo es ${formatoCOP(MONTO_MAXIMO_COP)}.`;
  return e;
}

function Editar({ deudor, alGuardar, alCancelar }: { deudor: Deudor; alGuardar: (d: Deudor) => void; alCancelar: () => void }) {
  const [f, setF] = useState<Formulario>({
    full_name: deudor.full_name,
    alias_reference: deudor.alias_reference ?? '',
    whatsapp_phone: deudor.whatsapp_phone ? telefonoLocal(deudor.whatsapp_phone) : '',
    doc_type: deudor.doc_type ?? '',
    doc_number: deudor.doc_number ?? '',
    credit_limit_cop: deudor.credit_limit_cop === null ? '' : String(deudor.credit_limit_cop),
  });
  const [errores, setErrores] = useState<Errores>({});
  const [fallo, setFallo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const cambiar = (campo: keyof Formulario, valor: string) => setF((x) => ({ ...x, [campo]: valor }));

  async function guardar(e: FormEvent) {
    e.preventDefault();
    const hallados = revisar(f);
    setErrores(hallados);
    const primero = Object.keys(hallados)[0];
    if (primero) return void document.getElementById(`ficha-${primero}`)?.focus();
    const doc = f.doc_number.replace(/[\s.-]/g, '');
    const tope = f.credit_limit_cop.replace(/\D/g, '');
    setEnviando(true);
    setFallo(null);
    try {
      alGuardar(
        await api<Deudor>(`/deudores/${deudor.id}`, {
          metodo: 'PATCH',
          cuerpo: {
            full_name: f.full_name.trim(),
            alias_reference: f.alias_reference.trim() || null,
            whatsapp_phone: f.whatsapp_phone.trim() ? normalizarTelefonoCO(f.whatsapp_phone) : null,
            doc_type: doc ? f.doc_type : null,
            doc_number: doc || null,
            credit_limit_cop: tope ? Number(tope) : null,
          },
        }),
      );
    } catch (error) {
      const err = error instanceof ErrorApi ? error : new ErrorApi(0, 'error_desconocido');
      if (err.error === 'documento_duplicado') {
        setErrores({ doc_number: 'Ese documento ya lo tiene otro deudor de tu tienda. Revisa el número.' });
        document.getElementById('ficha-doc_number')?.focus();
      } else if (err.error === 'datos_invalidos' && err.campos?.length) {
        setErrores(Object.fromEntries(err.campos.map((c) => [c, 'No pudimos aceptar este dato. Revísalo y vuelve a intentar.'])));
      } else {
        setFallo(err.status === 0 ? 'No hay conexión. Revisa tu internet y vuelve a tocar Guardar: lo que escribiste sigue aquí.' : 'No pudimos guardar. Vuelve a intentar en un momento.');
      }
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="ficha__formulario" onSubmit={guardar} noValidate>
      <Campo id="ficha-full_name" etiqueta="Nombre o apodo" maxLength={80} autoCapitalize="words" value={f.full_name} onChange={(e) => cambiar('full_name', e.target.value)} error={errores.full_name} />
      <Campo
        id="ficha-alias_reference"
        etiqueta="Cómo lo reconoces (opcional)"
        ayuda="Ejemplo: el del taller, la del 302."
        maxLength={80}
        value={f.alias_reference}
        onChange={(e) => cambiar('alias_reference', e.target.value)}
        error={errores.alias_reference}
      />
      <Campo
        id="ficha-whatsapp_phone"
        etiqueta="WhatsApp (opcional)"
        ayuda="Para cobrarle por WhatsApp. Ejemplo: 300 123 4567."
        type="tel"
        inputMode="tel"
        value={f.whatsapp_phone}
        onChange={(e) => cambiar('whatsapp_phone', e.target.value)}
        error={errores.whatsapp_phone}
      />
      <div className="campo">
        <label htmlFor="ficha-doc_type">Tipo de documento (opcional)</label>
        <select
          id="ficha-doc_type"
          className="ficha__select"
          value={f.doc_type}
          onChange={(e) => cambiar('doc_type', e.target.value)}
          aria-invalid={errores.doc_type ? true : undefined}
          aria-describedby={errores.doc_type ? 'ficha-doc_type-error' : undefined}
        >
          <option value="">Sin documento</option>
          {TIPOS_DOCUMENTO.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {errores.doc_type && (
          <p id="ficha-doc_type-error" className="campo__error" role="alert">
            {errores.doc_type}
          </p>
        )}
      </div>
      <Campo id="ficha-doc_number" etiqueta="Número de documento (opcional)" inputMode="text" value={f.doc_number} onChange={(e) => cambiar('doc_number', e.target.value)} error={errores.doc_number} />
      <Campo
        id="ficha-credit_limit_cop"
        etiqueta="Tope de crédito (opcional)"
        ayuda="Hasta cuánto le fías. Vacío: sin tope."
        inputMode="numeric"
        value={f.credit_limit_cop}
        onChange={(e) => cambiar('credit_limit_cop', e.target.value)}
        error={errores.credit_limit_cop}
      />
      {fallo && (
        <Aviso tono="error" titulo="No se guardó">
          <p>{fallo}</p>
        </Aviso>
      )}
      <div className="ficha__botones">
        <Boton type="submit" disabled={enviando}>
          {enviando ? 'Guardando…' : 'Guardar datos'}
        </Boton>
        <Boton variante="secundaria" onClick={alCancelar}>
          Cancelar
        </Boton>
      </div>
    </form>
  );
}

/** Ficha del deudor (`/deudor/<id>`): saldo, movimientos con saldo corrido, recibos, datos y marcas. `?recibo=<id>` abre una tirilla. */
export function Ficha({ negocio, id }: { negocio: Negocio; id: string }) {
  const [deudor, setDeudor] = useState<Deudor | null>(null);
  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  const [intento, setIntento] = useState(0);
  const [recibo, setRecibo] = useState(() => new URLSearchParams(location.search).get('recibo'));
  const [editando, setEditando] = useState(false);
  const [confirmarArchivo, setConfirmarArchivo] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [falloAccion, setFalloAccion] = useState<string | null>(null);
  const escribir = negocio.permisos.escribir;

  useEffect(() => {
    let vigente = true;
    setFallo(null);
    Promise.all([api<Deudor>(`/deudores/${id}`), api<{ movimientos: Movimiento[] }>(`/deudores/${id}/movimientos`)])
      .then(([d, m]) => vigente && (setDeudor(d), setMovimientos(m.movimientos)))
      .catch((e) => vigente && setFallo(e instanceof ErrorApi ? e : new ErrorApi(0, 'error_desconocido')));
    return () => void (vigente = false);
  }, [id, intento]);

  function verRecibo(movimiento: string | null) {
    setRecibo(movimiento);
    history.replaceState(null, '', movimiento ? `${location.pathname}?recibo=${movimiento}` : location.pathname);
    scrollTo(0, 0);
  }

  function actualizado(d: Deudor) {
    setDeudor(d);
    void refrescarCartera().catch(() => {}); // la copia local del mostrador
  }

  async function cambiar(cuerpo: Record<string, boolean>) {
    setEnviando(true);
    setFalloAccion(null);
    try {
      actualizado(await api<Deudor>(`/deudores/${id}`, { metodo: 'PATCH', cuerpo }));
      setConfirmarArchivo(false);
    } catch (e) {
      setFalloAccion(e instanceof ErrorApi && e.status === 0 ? 'No hay conexión. Revisa tu internet y vuelve a intentar.' : 'No pudimos guardar el cambio. Vuelve a intentar en un momento.');
    } finally {
      setEnviando(false);
    }
  }

  if (fallo) {
    const noEsta = fallo.status === 404;
    return (
      <>
        <Enlace a="/" className="ficha__volver">
          Volver al mostrador
        </Enlace>
        <h1>{noEsta ? 'No encontramos a este deudor' : fallo.status === 0 ? 'No hay conexión' : 'No pudimos abrir la ficha'}</h1>
        <Aviso tono={noEsta ? 'atencion' : 'error'} titulo={noEsta ? 'Puede que la dirección esté mal escrita' : 'La ficha no cargó'}>
          <p>{noEsta ? 'Búscalo en el mostrador por su nombre, apodo o código.' : fallo.status === 0 ? 'Revisa tu internet y vuelve a intentar.' : 'Es un problema nuestro, no tuyo. Vuelve a intentar en un momento.'}</p>
        </Aviso>
        {!noEsta && (
          <div>
            <Boton onClick={() => setIntento((n) => n + 1)}>Volver a intentar</Boton>
          </div>
        )}
      </>
    );
  }
  if (!deudor) {
    return (
      <>
        <h1>Ficha del deudor</h1>
        <p role="status">Abriendo la ficha…</p>
      </>
    );
  }

  const ahora = Date.now();
  const promesaVencida = deudor.promised_payment_date !== null && deudor.promised_payment_date + 86_400_000 <= ahora;

  return (
    <div className="ficha">
      <Enlace a="/" className="ficha__volver">
        Volver al mostrador
      </Enlace>

      {recibo && <Recibo negocio={negocio} deudor={deudor} movimiento={movimientos.find((m) => m.id === recibo)} alCerrar={() => verRecibo(null)} />}

      <header className="ficha__cabecera">
        <h1>{deudor.full_name}</h1>
        <p className="ficha__identidad">
          <code>{deudor.unique_code}</code>
          <Sello estado={deudor.estado} />
        </p>
        {deudor.alias_reference && <p>{deudor.alias_reference}</p>}
        {!escribir && (
          <Aviso titulo="Solo puedes consultar">
            <p>
              Para editar, cobrar, marcar o archivar, renueva tu plan en <Enlace a="/suscripcion">Suscripción</Enlace>.
            </p>
          </Aviso>
        )}
        {deudor.archived_at !== null && (
          <Aviso titulo="Deudor archivado">
            <p>No sale en el mostrador. Sus movimientos siguen guardados y puedes recuperarlo abajo.</p>
          </Aviso>
        )}
      </header>

      <div className="ficha__columnas">
        <section className="ficha__seccion ficha__zona-saldo" aria-labelledby="ficha-cuenta">
          <h2 id="ficha-cuenta">Cuenta</h2>
          <Tarjeta>
            <div className="ficha__saldo">
              <p className="ficha__rotulo">{deudor.current_balance_cop > 0 ? 'Te debe' : 'Saldo'}</p>
              <p className="ficha__cifra" data-testid="saldo-actual">
                <Monto valor={deudor.current_balance_cop} tono={deudor.current_balance_cop === 0 ? 'verde' : undefined} />
              </p>
              <ul className="ficha__datos-saldo">
                {deudor.current_balance_cop === 0 && <li>Está al día: no te debe nada.</li>}
                {deudor.oldest_unpaid_date !== null && deudor.current_balance_cop > 0 && <li>Fiado sin pagar más viejo: {fechaDia(deudor.oldest_unpaid_date)}</li>}
                {deudor.promised_payment_date !== null && (
                  <li>
                    {promesaVencida ? 'Prometió pagar el' : 'Promete pagar el'} {fechaDia(deudor.promised_payment_date)}
                  </li>
                )}
                <li>
                  Tope de crédito: {deudor.credit_limit_cop === null ? 'sin tope' : <Monto valor={deudor.credit_limit_cop} />}
                </li>
                {deudor.last_reminder_sent_at !== null && <li>Último cobro: {fechaCorta(deudor.last_reminder_sent_at)}</li>}
              </ul>
              {deudor.current_balance_cop > 0 && deudor.archived_at === null && (
                <BotonCobrar negocio={negocio} deudor={deudor} alCobrar={(cuando) => actualizado({ ...deudor, last_reminder_sent_at: cuando })} />
              )}
            </div>
          </Tarjeta>
        </section>

        <section className="ficha__seccion ficha__zona-movimientos" aria-labelledby="ficha-movimientos">
          <h2 id="ficha-movimientos">Movimientos</h2>
          {movimientos.length === 0 ? (
            <Tarjeta crema>
              <p>Todavía no le has fiado nada. Cuando le fíes o te abone desde el mostrador, cada movimiento queda aquí con su saldo.</p>
            </Tarjeta>
          ) : (
            <ol className="ficha__libro" aria-label="Movimientos con saldo corrido">
              <li className="ficha__renglon ficha__renglon--cabeza" aria-hidden="true">
                <span>Fecha</span>
                <span>Concepto</span>
                <span>Valor</span>
                <span>Saldo</span>
                <span />
              </li>
              {movimientos.map((m) => (
                <li key={m.id} className="ficha__renglon" data-testid="movimiento">
                  <span className="ficha__fecha">{fechaCorta(m.created_at)}</span>
                  <span className="ficha__concepto">{m.description}</span>
                  <span className="ficha__valor">
                    <Monto valor={delta(m)} tono={delta(m) < 0 ? 'verde' : undefined} />
                  </span>
                  <span className="ficha__corrido">
                    <span className="ficha__etiqueta-movil">Saldo </span>
                    {m.balance_after_cop === null ? ESTADO_PENDIENTE[m.status as keyof typeof ESTADO_PENDIENTE] : <Monto valor={m.balance_after_cop} />}
                  </span>
                  <span className="ficha__accion">
                    {m.balance_after_cop !== null && (
                      <button type="button" className="ficha__ver-recibo" onClick={() => verRecibo(m.id)} aria-label={`Ver recibo: ${m.description} del ${fechaCorta(m.created_at)}`}>
                        Recibo
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="ficha__seccion ficha__zona-datos" aria-labelledby="ficha-datos">
          <h2 id="ficha-datos">Datos</h2>
          <Tarjeta>
            {editando ? (
              <Editar deudor={deudor} alGuardar={(d) => (actualizado(d), setEditando(false))} alCancelar={() => setEditando(false)} />
            ) : (
              <div className="ficha__bloque">
                <dl className="ficha__lista">
                  <div>
                    <dt>WhatsApp</dt>
                    <dd>{deudor.whatsapp_phone ? <code>{telefonoLocal(deudor.whatsapp_phone)}</code> : 'Sin número'}</dd>
                  </div>
                  <div>
                    <dt>Documento</dt>
                    <dd>{deudor.doc_number ? <code>{`${deudor.doc_type} ${deudor.doc_number}`}</code> : 'Sin documento'}</dd>
                  </div>
                  <div>
                    <dt>En tu libro desde</dt>
                    <dd>{fechaDia(deudor.created_at)}</dd>
                  </div>
                </dl>
                {escribir && (
                  <Boton variante="secundaria" onClick={() => setEditando(true)}>
                    Editar datos
                  </Boton>
                )}
              </div>
            )}
          </Tarjeta>
        </section>

        <section className="ficha__seccion ficha__zona-permiso" aria-labelledby="ficha-whatsapp">
          <h2 id="ficha-whatsapp">Permiso de WhatsApp</h2>
          <Tarjeta crema>
            <div className="ficha__bloque">
              {deudor.wa_opt_out_at !== null ? (
                <p>Pidió no recibir más mensajes (respondió SALIR) el {fechaDia(deudor.wa_opt_out_at)}. No se le puede cobrar por WhatsApp.</p>
              ) : deudor.wa_consent_at !== null ? (
                <>
                  <p>Autorizó que le escribas por WhatsApp el {fechaDia(deudor.wa_consent_at)}.</p>
                  {escribir && (
                    <Boton variante="secundaria" disabled={enviando} onClick={() => cambiar({ wa_consentimiento: false })}>
                      Quitar autorización
                    </Boton>
                  )}
                </>
              ) : (
                <>
                  <p>No ha autorizado mensajes por WhatsApp. Pregúntale primero; si dice que sí, regístralo aquí.</p>
                  {escribir && (
                    <Boton variante="secundaria" disabled={enviando} onClick={() => cambiar({ wa_consentimiento: true })}>
                      Registrar que autorizó
                    </Boton>
                  )}
                </>
              )}
            </div>
          </Tarjeta>
        </section>

        <section className="ficha__seccion ficha__zona-marcas" aria-labelledby="ficha-marcas">
          <h2 id="ficha-marcas">Lista negra y archivo</h2>
          <Tarjeta crema>
            <div className="ficha__bloque">
              <p>La lista negra es una marca privada: solo la ves tú y nunca se le dice al deudor.</p>
              {escribir && (
                <Boton variante={deudor.blacklisted_at === null ? 'peligro' : 'secundaria'} disabled={enviando} onClick={() => cambiar({ lista_negra: deudor.blacklisted_at === null })}>
                  {deudor.blacklisted_at === null ? 'Marcar en lista negra' : 'Quitar de la lista negra'}
                </Boton>
              )}
              {escribir && deudor.archived_at !== null && (
                <Boton variante="secundaria" disabled={enviando} onClick={() => cambiar({ archivado: false })}>
                  Recuperar deudor
                </Boton>
              )}
              {escribir && deudor.archived_at === null && !confirmarArchivo && (
                <Boton variante="secundaria" onClick={() => setConfirmarArchivo(true)}>
                  Archivar deudor
                </Boton>
              )}
              {confirmarArchivo && (
                <Aviso titulo={`¿Archivar a ${deudor.full_name}?`}>
                  <p>Deja de salir en el mostrador. No se borra nada: sus movimientos quedan guardados y lo puedes recuperar.</p>
                  {deudor.current_balance_cop > 0 && (
                    <p>
                      Todavía te debe <Monto valor={deudor.current_balance_cop} />.
                    </p>
                  )}
                  <div className="ficha__botones">
                    <Boton disabled={enviando} onClick={() => cambiar({ archivado: true })}>
                      Sí, archivar
                    </Boton>
                    <Boton variante="secundaria" onClick={() => setConfirmarArchivo(false)}>
                      No, dejarlo
                    </Boton>
                  </div>
                </Aviso>
              )}
              {falloAccion && (
                <Aviso tono="error" titulo="No se guardó el cambio">
                  <p>{falloAccion}</p>
                </Aviso>
              )}
            </div>
          </Tarjeta>
        </section>
      </div>
    </div>
  );
}
