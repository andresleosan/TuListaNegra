// SUP-04: indicadores globales. Cifras en monoespaciada tabular, sin gráficos.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { Enlace } from '../../ruta';
import { Aviso } from '../../ui/Aviso';
import { Boton } from '../../ui/Boton';
import { Monto } from '../../ui/Monto';
import { Tarjeta } from '../../ui/Tarjeta';
import { cifra, mensajeDeError, Renglon } from './comun';

/** `GET /api/superadmin/indicadores`. */
type Datos = {
  negocios: { total: number; prueba: number; activos: { PASS_7D: number; PASS_15D: number; PASS_30D: number; otros: number }; gratis: number; desbloqueo: number; vencidos: number; suspendidos: number };
  ingresos_mes_cop: number;
  pagos_mes: number;
  pagos_pendientes: number;
  conversion: { pagaron: number; base: number; porcentaje: number };
  consumo: { ocr: number; ia: number; cobros: number };
};

type Carga = { tipo: 'cargando' } | { tipo: 'error'; mensaje: string } | { tipo: 'lista'; datos: Datos };

export function Indicadores() {
  const [carga, setCarga] = useState<Carga>({ tipo: 'cargando' });
  const cargar = useCallback(() => {
    let vigente = true;
    setCarga({ tipo: 'cargando' });
    api<Datos>('/superadmin/indicadores').then(
      (datos) => vigente && setCarga({ tipo: 'lista', datos }),
      (e: unknown) => vigente && setCarga({ tipo: 'error', mensaje: mensajeDeError(e) }),
    );
    return () => {
      vigente = false;
    };
  }, []);
  useEffect(cargar, [cargar]);

  return (
    <>
      <div className="consola__titulo">
        <h1>Indicadores</h1>
        {carga.tipo === 'lista' && (
          <Boton variante="secundaria" onClick={cargar}>
            Actualizar
          </Boton>
        )}
      </div>
      {carga.tipo === 'cargando' && <p role="status">Sumando las cifras…</p>}
      {carga.tipo === 'error' && (
        <>
          <Aviso tono="error" titulo="No pudimos traer los indicadores">
            <p>{carga.mensaje}</p>
          </Aviso>
          <Boton onClick={cargar}>Volver a intentar</Boton>
        </>
      )}
      {carga.tipo === 'lista' && <Cifras datos={carga.datos} />}
    </>
  );
}

function Cifras({ datos: d }: { datos: Datos }) {
  const n = d.negocios;
  return (
    <div className="consola__indicadores">
      <section className="consola__bloque consola__bloque--dinero" aria-labelledby="ind-ingresos">
        <Tarjeta>
          <h2 id="ind-ingresos">Ingresos confirmados del mes</h2>
          <p className="consola__grande">
            <Monto valor={d.ingresos_mes_cop} />
          </p>
          <p className="consola__nota">
            <code>{cifra(d.pagos_mes)}</code> {d.pagos_mes === 1 ? 'pago aprobado' : 'pagos aprobados'} desde el día 1 (hora de Bogotá). Solo pagos aprobados; los gratis no suman.
          </p>
        </Tarjeta>
      </section>

      <section className="consola__bloque" aria-labelledby="ind-pendientes">
        <Tarjeta>
          <h2 id="ind-pendientes">Pagos por revisar</h2>
          <p className="consola__grande">
            <code>{cifra(d.pagos_pendientes)}</code>
          </p>
          <p className="consola__nota">{d.pagos_pendientes ? <Enlace a="/superadmin/pagos">Abrir la bandeja</Enlace> : 'La bandeja está al día.'}</p>
        </Tarjeta>
      </section>

      <section className="consola__bloque" aria-labelledby="ind-conversion">
        <Tarjeta>
          <h2 id="ind-conversion">Conversión de prueba a pago</h2>
          <p className="consola__grande">
            <code>{String(d.conversion.porcentaje).replace('.', ',')} %</code>
          </p>
          <p className="consola__nota">
            <code>{cifra(d.conversion.pagaron)}</code> de <code>{cifra(d.conversion.base)}</code> negocios (sin contar los gratis) han pagado al menos un pase.
          </p>
        </Tarjeta>
      </section>

      <section className="consola__bloque consola__bloque--estados" aria-labelledby="ind-estados">
        <Tarjeta>
          <h2 id="ind-estados">Negocios por estado</h2>
          <dl className="consola__renglones">
            <Renglon nombre="En prueba" valor={n.prueba} />
            <Renglon nombre="Activos · pase de 7 días" valor={n.activos.PASS_7D} />
            <Renglon nombre="Activos · pase de 15 días" valor={n.activos.PASS_15D} />
            <Renglon nombre="Activos · pase de 30 días" valor={n.activos.PASS_30D} />
            {n.activos.otros > 0 && <Renglon nombre="Activos · otro plan" valor={n.activos.otros} />}
            <Renglon nombre="Con desbloqueo de 24 h" valor={n.desbloqueo} />
            <Renglon nombre="Vencidos (solo lectura)" valor={n.vencidos} />
            <Renglon nombre="Suspendidos" valor={n.suspendidos} />
            <Renglon nombre="Gratis sin vencimiento" valor={n.gratis} />
            <Renglon nombre="Total" valor={n.total} total />
          </dl>
          <p className="consola__nota">Los gratis van aparte: no son clientes de pago y no suman ingresos. Un suspendido cuenta como suspendido aunque sea gratis.</p>
        </Tarjeta>
      </section>

      <section className="consola__bloque consola__bloque--consumo" aria-labelledby="ind-consumo">
        <Tarjeta>
          <h2 id="ind-consumo">Consumo de IA y WhatsApp</h2>
          <dl className="consola__renglones">
            <Renglon nombre="Lecturas de captura" valor={d.consumo.ocr} />
            <Renglon nombre="Mensajes a la IA" valor={d.consumo.ia} />
            <Renglon nombre="Cobros por WhatsApp" valor={d.consumo.cobros} />
          </dl>
          <p className="consola__nota">Suma de lo gastado en el ciclo actual de cada negocio.</p>
        </Tarjeta>
      </section>
    </div>
  );
}
