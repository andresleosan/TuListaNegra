// SUP-03: buscador de negocios y acciones de la consola. Cada acción pide confirmación y motivo, y queda en la auditoría.
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { EstadoNegocio } from '../../../shared/acceso';
import { api } from '../../api';
import { Aviso } from '../../ui/Aviso';
import { Boton } from '../../ui/Boton';
import { Campo } from '../../ui/Campo';
import { Tarjeta } from '../../ui/Tarjeta';
import { Confirmacion, fecha, mensajeDeError, SelloEstado } from './comun';

/** Una fila de `GET /api/superadmin/negocios` (y la respuesta de cada acción). */
type NegocioConsola = {
  id: string;
  name: string;
  owner_email: string;
  whatsapp_phone: string | null;
  created_at: number;
  estado: EstadoNegocio;
  plan: string;
  gratis: boolean;
  suspendido: boolean;
  vence_en: number | null;
  usados: { ocr: number; ia: number; cobros: number };
};

type Accion = {
  clave: string;
  ruta: 'cortesia' | 'gratis' | 'reiniciar-contadores' | 'suspender' | 'reactivar';
  datos: { dias?: number; activar?: boolean };
  boton: string;
  /** Nombre accesible si el texto del botón no basta (los «+7» de cortesía). */
  nombre?: string;
  /** Texto del botón que confirma; por defecto «Sí, <boton>». */
  confirma?: string;
  titulo: string;
  explica: string;
  peligro?: boolean;
  hecho: string;
};

const PLANES: Record<string, string> = { TRIAL_3D: 'Prueba de 3 días', PASS_7D: 'Pase de 7 días', PASS_15D: 'Pase de 15 días', PASS_30D: 'Pase de 30 días' };
const TOPE = 50; // lo que devuelve el servidor como máximo

function acciones(n: NegocioConsola): Accion[] {
  const cortesias = ([3, 7, 15, 30] as const).map(
    (dias): Accion => ({
      clave: `cortesia-${dias}`,
      ruta: 'cortesia',
      datos: { dias },
      boton: `+${dias}`,
      nombre: `+${dias} días de cortesía`,
      confirma: `Sí, dar ${dias} días`,
      titulo: `¿Dar ${dias} días de cortesía a ${n.name}?`,
      explica: 'Se suman a su vencimiento; si ya venció, cuentan desde ahora. No cambian el plan.',
      hecho: `${n.name} recibió ${dias} días de cortesía.`,
    }),
  );
  return [
    ...cortesias,
    n.gratis
      ? { clave: 'gratis', ruta: 'gratis', datos: { activar: false }, boton: 'Quitar gratis', titulo: `¿Quitar la suscripción gratis a ${n.name}?`, explica: 'Vuelve a regirse por sus fechas: si ya pasaron, queda vencida.', hecho: `${n.name} ya no es gratis.` }
      : { clave: 'gratis', ruta: 'gratis', datos: { activar: true }, boton: 'Marcar gratis', titulo: `¿Marcar a ${n.name} como gratis sin vencimiento?`, explica: 'Queda activa sin fecha de fin ni aviso de renovación. Se cuenta aparte y no suma ingresos.', hecho: `${n.name} quedó gratis sin vencimiento.` },
    { clave: 'reiniciar', ruta: 'reiniciar-contadores', datos: {}, boton: 'Reiniciar contadores', titulo: `¿Reiniciar los contadores de ${n.name}?`, explica: 'Pone en cero las lecturas de captura, los mensajes a la IA y los cobros por WhatsApp de su ciclo.', hecho: `Los contadores de ${n.name} quedaron en cero.` },
    n.suspendido
      ? { clave: 'suspension', ruta: 'reactivar', datos: {}, boton: 'Reactivar', titulo: `¿Reactivar a ${n.name}?`, explica: 'Vuelve a ver y anotar fiados según su plan.', hecho: `${n.name} quedó reactivada.` }
      : { clave: 'suspension', ruta: 'suspender', datos: {}, boton: 'Suspender', peligro: true, titulo: `¿Suspender a ${n.name}?`, explica: 'Deja de ver y anotar fiados hasta que la reactives. Sus datos se guardan.', hecho: `${n.name} quedó suspendida.` },
  ];
}

type Carga = { tipo: 'cargando' } | { tipo: 'error'; mensaje: string } | { tipo: 'lista'; negocios: NegocioConsola[]; q: string };

export function Negocios() {
  const [q, setQ] = useState('');
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
  const [abierto, setAbierto] = useState<{ id: string; clave: string } | null>(null);
  const [hecho, setHecho] = useState<{ id: string; texto: string } | null>(null);

  const buscar = useCallback((texto: string) => {
    let vigente = true;
    setCarga({ tipo: 'cargando' });
    setAbierto(null);
    setHecho(null);
    api<{ negocios: NegocioConsola[] }>(`/superadmin/negocios?q=${encodeURIComponent(texto.trim())}`).then(
      ({ negocios }) => vigente && setCarga({ tipo: 'lista', negocios, q: texto.trim() }),
      (e: unknown) => vigente && setCarga({ tipo: 'error', mensaje: mensajeDeError(e) }),
    );
    return () => {
      vigente = false;
    };
  }, []);
  useEffect(() => buscar(''), [buscar]);

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    buscar(q);
  };

  async function aplicar(n: NegocioConsola, accion: Accion, motivo: string) {
    const nuevo = await api<NegocioConsola>(`/superadmin/negocios/${encodeURIComponent(n.id)}/${accion.ruta}`, { metodo: 'POST', cuerpo: { ...accion.datos, motivo } });
    setCarga((c) => (c.tipo === 'lista' ? { ...c, negocios: c.negocios.map((x) => (x.id === n.id ? nuevo : x)) } : c));
    setAbierto(null);
    setHecho({ id: n.id, texto: accion.hecho });
  }

  return (
    <>
      <div className="consola__titulo">
        <h1>Negocios</h1>
      </div>
      <form className="consola__buscador" role="search" onSubmit={enviar}>
        <Campo etiqueta="Buscar negocio" ayuda="Por nombre, correo del dueño, WhatsApp o código del negocio." type="search" enterKeyHint="search" value={q} onChange={(e) => setQ(e.target.value)} />
        <Boton type="submit" disabled={carga.tipo === 'cargando'}>
          Buscar
        </Boton>
      </form>
      {carga.tipo === 'cargando' && <p role="status">Buscando…</p>}
      {carga.tipo === 'error' && (
        <>
          <Aviso tono="error" titulo="No pudimos buscar">
            <p>{carga.mensaje}</p>
          </Aviso>
          <Boton onClick={() => buscar(q)}>Volver a intentar</Boton>
        </>
      )}
      {carga.tipo === 'lista' && carga.negocios.length === 0 && (
        <Tarjeta crema>
          <p className="consola__vacio-titulo">{carga.q ? `Nada con «${carga.q}»` : 'Todavía no hay negocios'}</p>
          <p>{carga.q ? 'Prueba con otra parte del nombre, el correo o los últimos dígitos del WhatsApp.' : 'Cuando una tienda se registre, aparece aquí.'}</p>
        </Tarjeta>
      )}
      {carga.tipo === 'lista' && carga.negocios.length > 0 && (
        <>
          <p className="consola__cuenta-filas">
            <code>{carga.negocios.length}</code> {carga.negocios.length === 1 ? 'negocio' : 'negocios'}
            {carga.q ? ` con «${carga.q}»` : ', del más nuevo al más antiguo'}
            {carga.negocios.length === TOPE && '. Se muestran los primeros 50: afina la búsqueda.'}
          </p>
          <div className="consola__libro consola__libro--negocios">
            <div className="consola__encabezado" aria-hidden="true">
              <span>Negocio</span>
              <span>Estado</span>
              <span>Plan y vencimiento</span>
              <span className="consola__num">Consumo del ciclo</span>
            </div>
            <ul className="consola__filas">
              {carga.negocios.map((n) => {
                const lista = acciones(n);
                const accion = abierto?.id === n.id ? lista.find((a) => a.clave === abierto.clave) : undefined;
                const boton = (a: Accion) => (
                  <Boton key={a.clave} variante={a.peligro ? 'peligro' : 'secundaria'} aria-label={a.nombre} disabled={accion === a} onClick={() => (setHecho(null), setAbierto({ id: n.id, clave: a.clave }))}>
                    {a.boton}
                  </Boton>
                );
                return (
                  <li key={n.id} className="consola__fila">
                    <dl className="consola__datos">
                      <div>
                        <dt>Negocio</dt>
                        <dd>
                          <strong className="consola__nombre">{n.name}</strong>
                          <span className="consola__dato-menor">{n.owner_email}</span>
                          <span className="consola__dato-menor">
                            <code>{n.whatsapp_phone ?? 'Sin WhatsApp'}</code>
                          </span>
                          <span className="consola__dato-menor">
                            <code>{n.id}</code>
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt>Estado</dt>
                        <dd className="consola__sellos">
                          <SelloEstado estado={n.estado} />
                          {n.gratis && <SelloEstado estado="GRATIS" />}
                        </dd>
                      </div>
                      <div>
                        <dt>Plan y vencimiento</dt>
                        <dd>
                          {n.gratis ? 'Gratis' : (PLANES[n.plan] ?? n.plan)}
                          <span className="consola__dato-menor">{n.vence_en === null ? 'Sin vencimiento' : `Vence ${fecha(n.vence_en)}`}</span>
                        </dd>
                      </div>
                      <div>
                        <dt>Consumo del ciclo</dt>
                        <dd className="consola__num consola__consumo">
                          <span>
                            Capturas <code>{n.usados.ocr}</code>
                          </span>
                          <span>
                            IA <code>{n.usados.ia}</code>
                          </span>
                          <span>
                            Cobros <code>{n.usados.cobros}</code>
                          </span>
                        </dd>
                      </div>
                    </dl>
                    {hecho?.id === n.id && (
                      <Aviso tono="bien" titulo="Listo">
                        <p>{hecho.texto}</p>
                      </Aviso>
                    )}
                    <div className="consola__acciones">
                      <div className="consola__cortesia" role="group" aria-label="Días de cortesía">
                        <span className="consola__grupo" aria-hidden="true">
                          Días de cortesía
                        </span>
                        {lista.filter((a) => a.ruta === 'cortesia').map(boton)}
                      </div>
                      <div className="consola__botones">{lista.filter((a) => a.ruta !== 'cortesia').map(boton)}</div>
                    </div>
                    {accion && (
                      <Confirmacion key={accion.clave} titulo={accion.titulo} boton={accion.confirma ?? `Sí, ${accion.boton.toLowerCase()}`} peligro={accion.peligro} alConfirmar={(motivo) => aplicar(n, accion, motivo)} alCancelar={() => setAbierto(null)}>
                        <p>{accion.explica}</p>
                      </Confirmacion>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </>
  );
}
