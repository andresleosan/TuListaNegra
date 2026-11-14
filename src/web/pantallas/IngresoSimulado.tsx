// Formulario del simulador local de ingreso. SOLO desarrollo: `Ingreso.tsx` lo importa tras `import.meta.env.DEV`.
import { type FormEvent, useState } from 'react';
import { ErrorDeIngreso } from '../sesion';
import type { IdentidadSimulada, Simulador } from '../sesion/simulador';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { Campo } from '../ui/Campo';
import { Casilla } from '../ui/Casilla';
import { Tarjeta } from '../ui/Tarjeta';
import './IngresoSimulado.css';

const PROVEEDORES: { valor: IdentidadSimulada['proveedor']; nombre: string }[] = [
  { valor: 'google.com', nombre: 'Google' },
  { valor: 'password', nombre: 'Correo y contraseña' },
];

export default function IngresoSimulado({ simulador }: { simulador: Simulador }) {
  const [email, setEmail] = useState('piloto@ejemplo.test');
  const [uid, setUid] = useState('');
  const [proveedor, setProveedor] = useState<IdentidadSimulada['proveedor']>('google.com');
  const [verificado, setVerificado] = useState(true);
  const [fallo, setFallo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setFallo(null);
    setEnviando(true);
    try {
      await simulador.entrarComo({ email, email_verified: verificado, proveedor, ...(uid.trim() ? { uid: uid.trim() } : {}) });
    } catch (error) {
      setFallo(error instanceof ErrorDeIngreso ? error.message : 'El simulador no respondió.');
      setEnviando(false);
    }
  }

  return (
    <Tarjeta crema>
      <form className="hoja__formulario" onSubmit={enviar} noValidate>
        <h2>Simulador local de ingreso (solo desarrollo)</h2>
        <p className="hoja__nota">
          Firma un ID token con la llave local y el Worker lo verifica igual que uno de Firebase. No existe en producción.
        </p>
        {fallo && <Aviso tono="error" titulo={fallo} />}
        <Campo
          etiqueta="Correo de la cuenta"
          ayuda="Pilotos: piloto@ejemplo.test y piloto2@ejemplo.test."
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Campo
          etiqueta="UID (opcional)"
          ayuda="Vacío: uno fijo derivado del correo."
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={uid}
          onChange={(e) => setUid(e.target.value)}
        />
        <fieldset className="simulado__opciones">
          <legend>Proveedor</legend>
          {PROVEEDORES.map(({ valor, nombre }) => (
            <label key={valor}>
              <input type="radio" name="proveedor" checked={proveedor === valor} onChange={() => setProveedor(valor)} />
              {nombre}
            </label>
          ))}
        </fieldset>
        <Casilla checked={verificado} onChange={(e) => setVerificado(e.target.checked)}>
          Correo verificado
        </Casilla>
        <Boton type="submit" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar con esta cuenta'}
        </Boton>
      </form>
    </Tarjeta>
  );
}
