import { type FormEvent, lazy, Suspense, useState } from 'react';
import { ErrorDeIngreso, type ProveedorSesion } from '../sesion';
import type { Simulador } from '../sesion/simulador';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { Campo } from '../ui/Campo';
import { Casilla } from '../ui/Casilla';
import { Tarjeta } from '../ui/Tarjeta';
import { Hoja } from './Hoja';

// Formulario del simulador local. Solo desarrollo: en producción la condición es `false` y no entra en el bundle.
const IngresoSimulado = import.meta.env.DEV ? lazy(() => import('./IngresoSimulado')) : null;

/** Sin sesión. `proveedor` es `null` cuando el ingreso aún no está configurado. */
export function Ingreso({ proveedor }: { proveedor: ProveedorSesion | null }) {
  return (
    <Hoja>
      <h1>El cuaderno de fiados de tu tienda</h1>
      <p>Anota quién te debe, encuéntralo en segundos y cobra sin enredos.</p>
      {!proveedor ? (
        <Aviso titulo="El ingreso aún no está configurado">
          <p>Todavía no se puede entrar. Vuelve pronto.</p>
        </Aviso>
      ) : proveedor.simulado && IngresoSimulado ? (
        <Suspense>
          <IngresoSimulado simulador={proveedor as Simulador} />
        </Suspense>
      ) : (
        <IngresoConCuenta proveedor={proveedor} />
      )}
    </Hoja>
  );
}

function IngresoConCuenta({ proveedor }: { proveedor: ProveedorSesion }) {
  const [nueva, setNueva] = useState(false); // false = ya tengo cuenta; true = crear cuenta
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [verClave, setVerClave] = useState(false);
  const [errores, setErrores] = useState<{ correo?: string; clave?: string }>({});
  const [fallo, setFallo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(accion: () => Promise<void>) {
    setFallo(null);
    setEnviando(true);
    try {
      await accion(); // si entra, la pantalla cambia sola
    } catch (e) {
      setFallo(e instanceof ErrorDeIngreso ? e.message : 'No pudimos entrar. Intenta de nuevo en un momento.');
    } finally {
      setEnviando(false);
    }
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    const faltan = {
      correo: /^\S+@\S+\.\S+$/.test(correo.trim()) ? undefined : 'Escribe tu correo completo, como nombre@correo.com.',
      clave: nueva ? (clave.length >= 6 ? undefined : 'Elige una contraseña de 6 caracteres o más.') : clave ? undefined : 'Escribe tu contraseña.',
    };
    setErrores(faltan);
    if (faltan.correo || faltan.clave) return void document.getElementById(faltan.correo ? 'ingreso-correo' : 'ingreso-clave')?.focus();
    void entrar(() => (nueva ? proveedor.registrarConCorreo(correo.trim(), clave) : proveedor.entrarConCorreo(correo.trim(), clave)));
  }

  return (
    <Tarjeta>
      <div className="hoja__formulario">
        <h2>{nueva ? 'Crea tu cuenta' : 'Entra a tu tienda'}</h2>
        {fallo && <Aviso tono="error" titulo={fallo} />}
        <Boton disabled={enviando} onClick={() => void entrar(() => proveedor.entrarConGoogle())}>
          {nueva ? 'Crear cuenta con Google' : 'Entrar con Google'}
        </Boton>
        <p className="hoja__corte">o con tu correo</p>
        <form className="hoja__formulario" onSubmit={enviar} noValidate>
          <Campo
            id="ingreso-correo"
            etiqueta="Correo"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={correo}
            onChange={(e) => setCorreo(e.target.value)}
            error={errores.correo}
          />
          <Campo
            id="ingreso-clave"
            etiqueta="Contraseña"
            ayuda={nueva ? 'Mínimo 6 caracteres.' : undefined}
            type={verClave ? 'text' : 'password'}
            autoComplete={nueva ? 'new-password' : 'current-password'}
            value={clave}
            onChange={(e) => setClave(e.target.value)}
            error={errores.clave}
          />
          <Casilla checked={verClave} onChange={(e) => setVerClave(e.target.checked)}>
            Mostrar la contraseña
          </Casilla>
          <Boton type="submit" variante="secundaria" disabled={enviando}>
            {enviando ? 'Entrando…' : nueva ? 'Crear mi cuenta' : 'Entrar con mi correo'}
          </Boton>
        </form>
        <button
          type="button"
          className="hoja__enlace"
          onClick={() => {
            setNueva(!nueva);
            setErrores({});
            setFallo(null);
          }}
        >
          {nueva ? 'Ya tengo cuenta: entrar' : '¿Primera vez? Crear una cuenta'}
        </button>
      </div>
    </Tarjeta>
  );
}
