// Página de muestra del sistema de diseño (solo desarrollo, ruta `/__muestra`).
// Todos los datos son ficticios.
import { colores, contraste, pares } from './styles/pares';
import { Aviso } from './ui/Aviso';
import { Boton } from './ui/Boton';
import { Campo } from './ui/Campo';
import { Casilla } from './ui/Casilla';
import { Monto } from './ui/Monto';
import { Progreso } from './ui/Progreso';
import { Sello, type EstadoSello } from './ui/Sello';
import { Tarjeta } from './ui/Tarjeta';
import { Tirilla } from './ui/Tirilla';
import './Muestra.css';

const estados: EstadoSello[] = ['AL_DIA', 'PROMESA_PAGO', 'EN_MORA', 'LISTA_NEGRA', 'CON_SALDO'];

const deudores: { codigo: string; nombre: string; apodo: string; saldo: number; estado: EstadoSello }[] = [
  { codigo: 'TLN-0042', nombre: 'Carlos Arturo Peñaloza', apodo: 'don Carlos el del taller', saldo: 84900, estado: 'EN_MORA' },
  { codigo: 'TLN-0007', nombre: 'Yuleidy Marcela Ospina', apodo: 'la del 302', saldo: 23500, estado: 'PROMESA_PAGO' },
  { codigo: 'TLN-0113', nombre: 'Wilmar Quiceno', apodo: 'el mono de la moto', saldo: 12000, estado: 'CON_SALDO' },
  { codigo: 'TLN-0019', nombre: 'Rubiela Zapata', apodo: 'doña Rubi', saldo: 0, estado: 'AL_DIA' },
  { codigo: 'TLN-0088', nombre: 'Édinson Mosquera', apodo: 'el primo de Yeison', saldo: 316400, estado: 'LISTA_NEGRA' },
];

export default function Muestra() {
  return (
    <main className="muestra">
      <header>
        <h1>Muestra de piezas</h1>
        <p>Sistema «Libro mayor y recibo térmico». Solo desarrollo, datos ficticios.</p>
      </header>

      <section>
        <h2>Colores</h2>
        <ul className="muestra__colores">
          {Object.entries(colores).map(([nombre, hex]) => (
            <li key={nombre}>
              <span className="muestra__color" style={{ background: hex }} />
              {nombre}
              <code>{hex}</code>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Tipografía</h2>
        <p className="muestra__xl">Fiados claros, cuentas al día</p>
        <p className="muestra__l">Plus Jakarta Sans para el texto</p>
        <p>Doña Rubiela fía el mercado y cobra en la quincena. ¿Cuánto le deben hoy?</p>
        <p className="muestra__s">Texto pequeño para etiquetas y notas.</p>
        <p>
          <code>JetBrains Mono · TLN-0042 · CC ···4821 · 0123456789</code>
        </p>
      </section>

      <section>
        <h2>Botones</h2>
        <div className="muestra__fila">
          <Boton>Guardar fiado</Boton>
          <Boton variante="secundaria">Cancelar</Boton>
          <Boton variante="peligro">Marcar lista negra</Boton>
        </div>
        <div className="muestra__fila">
          <Boton disabled>Guardar fiado</Boton>
          <Boton variante="secundaria" disabled>
            Cancelar
          </Boton>
          <Boton variante="peligro" disabled>
            Marcar lista negra
          </Boton>
        </div>
        <div className="muestra__acciones">
          <Boton>+{'\u00A0'}FIAR</Boton>
          <Boton variante="secundaria">−{'\u00A0'}ABONAR</Boton>
          <Boton variante="secundaria">COBRAR</Boton>
        </div>
      </section>

      <section>
        <h2>Sellos</h2>
        <ul className="muestra__sellos">
          {estados.map((estado) => (
            <li key={estado}>
              <Sello estado={estado} />
              <code>{estado}</code>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Montos</h2>
        <Tarjeta>
          <dl className="muestra__montos">
            <div>
              <dt>Saldo</dt>
              <dd className="muestra__xl">
                <Monto valor={49900} />
              </dd>
            </div>
            <div>
              <dt>Abono (verde)</dt>
              <dd>
                <Monto valor={-20000} tono="verde" />
              </dd>
            </div>
            <div>
              <dt>En mora (rojo)</dt>
              <dd>
                <Monto valor={1284900} tono="rojo" />
              </dd>
            </div>
            <div>
              <dt>Fiado</dt>
              <dd>
                <Monto valor={5000} />
              </dd>
            </div>
          </dl>
        </Tarjeta>
      </section>

      <section>
        <h2>Tirilla</h2>
        <Tirilla
          tienda="Tienda La Esquina de Rubi"
          codigo="TLN-0042"
          lineas={[
            { concepto: 'Saldo anterior', monto: 84900 },
            { concepto: 'Abono en efectivo', monto: -35000 },
          ]}
          total={49900}
          fecha="14 nov 2026 · 3:42 p. m."
        />
      </section>

      <section>
        <h2>Tarjetas</h2>
        <Tarjeta>
          <ul className="muestra__deudores">
            {deudores.map((d) => (
              <li key={d.codigo}>
                <div>
                  <strong>{d.nombre}</strong>
                  <p className="muestra__s">
                    <code>{d.codigo}</code> · {d.apodo}
                  </p>
                </div>
                <div className="muestra__saldo">
                  <Monto valor={d.saldo} tono={d.estado === 'EN_MORA' || d.estado === 'LISTA_NEGRA' ? 'rojo' : undefined} />
                  <Sello estado={d.estado} />
                </div>
              </li>
            ))}
          </ul>
        </Tarjeta>
        <Tarjeta crema>
          <p className="muestra__s">Tarjeta crema · resumen del día</p>
          <p>
            Fiado hoy: <Monto valor={137500} /> · Abonado hoy: <Monto valor={62000} tono="verde" />
          </p>
        </Tarjeta>
      </section>

      <section>
        <h2>Formularios</h2>
        <Progreso paso={2} total={3} nombre="Los datos de tu tienda" />
        <Campo etiqueta="Nombre de la tienda" ayuda="Como la conoce el barrio." defaultValue="Tienda La Esquina de Rubi" />
        <Campo
          etiqueta="WhatsApp de la tienda"
          type="tel"
          defaultValue="601 234"
          error="Debe ser un celular de Colombia: 10 dígitos que empiezan por 3. Ejemplo: 300 123 4567."
        />
        <Casilla defaultChecked>Acepto los términos y la política de datos</Casilla>
        <Casilla error="Marca la casilla para aceptar y poder empezar.">Casilla sin marcar, con error</Casilla>
      </section>

      <section>
        <h2>Avisos</h2>
        <Aviso titulo="Texto pendiente de publicación">
          <p>Aviso de atención: franja ámbar y texto en tinta.</p>
        </Aviso>
        <Aviso tono="error" titulo="No pudimos crear tu tienda">
          <p>Aviso de error: franja roja. Dice qué pasó y cómo seguir.</p>
        </Aviso>
        <Aviso tono="bien" titulo="Abono guardado">
          <p>Aviso de confirmación: franja verde.</p>
        </Aviso>
      </section>

      <section>
        <h2>Contraste</h2>
        <Tarjeta>
          <table className="muestra__contraste">
            <thead>
              <tr>
                <th>Par (texto sobre fondo)</th>
                <th>Razón</th>
              </tr>
            </thead>
            <tbody>
              {pares.map((par) => (
                <tr key={par.uso}>
                  <td>
                    {par.uso}
                    <span className="muestra__s"> · {par.texto} / {par.fondo}</span>
                  </td>
                  <td>
                    <code>{contraste(colores[par.texto], colores[par.fondo]).toFixed(2)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tarjeta>
      </section>
    </main>
  );
}
