import { type FormEvent, useState } from 'react';
import { normalizarTelefonoCO } from '../../shared/telefono';
import { api, ErrorApi, type Negocio } from '../api';
import { Aviso } from '../ui/Aviso';
import { Boton } from '../ui/Boton';
import { Campo } from '../ui/Campo';
import { Casilla } from '../ui/Casilla';
import { Progreso } from '../ui/Progreso';
import { Hoja } from './Hoja';

type Datos = { name: string; whatsapp_phone: string; acepta_terminos: boolean };
type CampoAlta = keyof Datos;

// Cada mensaje dice qué falta y cómo arreglarlo. Las mismas reglas las vuelve a aplicar el servidor.
const REVISAR: { [C in CampoAlta]: (valor: Datos[C]) => string | null } = {
  name: (v) =>
    v.trim().length < 2 ? 'Escribe el nombre de tu tienda (mínimo 2 letras).' : v.trim().length > 80 ? 'El nombre es muy largo: déjalo en 80 letras o menos.' : null,
  whatsapp_phone: (v) =>
    !v.trim()
      ? 'Escribe el número de WhatsApp de la tienda.'
      : normalizarTelefonoCO(v)
        ? null
        : 'Debe ser un celular de Colombia: 10 dígitos que empiezan por 3. Ejemplo: 300 123 4567.',
  acepta_terminos: (v) => (v ? null : 'Marca la casilla para aceptar y poder empezar.'),
};
const ORDEN: CampoAlta[] = ['name', 'whatsapp_phone', 'acepta_terminos'];

type Props = {
  correo: string | null;
  alCrear: (negocio: Negocio) => void;
  /** La cuenta ya tenía tienda: hay que volver a cargarla. */
  alRecargar: () => void;
  alSalir: () => void;
};

/** Alta de la tienda con prueba de 72 h. Con sesión pero sin negocio. */
export function Alta({ correo, alCrear, alRecargar, alSalir }: Props) {
  const [datos, setDatos] = useState<Datos>({ name: '', whatsapp_phone: '', acepta_terminos: false });
  const [errores, setErrores] = useState<Partial<Record<CampoAlta, string | null>>>({});
  const [fallo, setFallo] = useState<ErrorApi | null>(null);
  const [enviando, setEnviando] = useState(false);

  const revisar = <C extends CampoAlta>(campo: C, valor: Datos[C]) => setErrores((e) => ({ ...e, [campo]: REVISAR[campo](valor) }));

  function cambiar<C extends CampoAlta>(campo: C, valor: Datos[C]) {
    setDatos((d) => ({ ...d, [campo]: valor }));
    // Un error ya mostrado se quita en cuanto se corrige; uno nuevo espera a que se salga del campo.
    if (errores[campo]) revisar(campo, valor);
  }

  const marcar = (campo: CampoAlta, mensaje: string) => {
    setErrores((e) => ({ ...e, [campo]: mensaje }));
    document.getElementById(`alta-${campo}`)?.focus();
  };

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const hallados = { name: REVISAR.name(datos.name), whatsapp_phone: REVISAR.whatsapp_phone(datos.whatsapp_phone), acepta_terminos: REVISAR.acepta_terminos(datos.acepta_terminos) };
    setErrores(hallados);
    const primero = ORDEN.find((campo) => hallados[campo]);
    if (primero) return void document.getElementById(`alta-${primero}`)?.focus();

    setFallo(null);
    setEnviando(true);
    try {
      alCrear(await api<Negocio>('/negocio', { metodo: 'POST', cuerpo: datos }));
    } catch (error) {
      const fallo = error instanceof ErrorApi ? error : new ErrorApi(0, 'error_desconocido');
      setEnviando(false);
      if (fallo.error === 'telefono_en_uso') return marcar('whatsapp_phone', 'Ese WhatsApp ya está registrado en otra tienda. Escribe otro número, o sal y entra con la cuenta que lo registró.');
      // El formulario aplica las mismas reglas que el servidor: esto solo pasa si alguna vez dejan de coincidir.
      const rechazado = fallo.error === 'datos_invalidos' && ORDEN.find((campo) => fallo.campos?.includes(campo));
      if (rechazado) return marcar(rechazado, 'No pudimos aceptar este dato. Revísalo y vuelve a intentar.');
      setFallo(fallo);
    }
  }

  if (fallo?.error === 'registro_cerrado') {
    return (
      <Hoja alSalir={alSalir}>
        <h1>Todavía no abrimos</h1>
        <Aviso titulo="TuListaNegra todavía no está abierta al público">
          <p>Por ahora solo entran las tiendas invitadas a la prueba piloto{correo ? `, y ${correo} no está en la lista` : ''}.</p>
          <p>Si te invitaron con otro correo, sal y entra con ese. Si creaste la cuenta con contraseña, abre primero el enlace de verificación que te llegó al correo.</p>
        </Aviso>
        <Boton onClick={alSalir}>Salir y entrar con otro correo</Boton>
      </Hoja>
    );
  }
  if (fallo?.error === 'ya_tiene_negocio') {
    return (
      <Hoja alSalir={alSalir}>
        <h1>Ya tienes tu tienda</h1>
        <Aviso titulo="Esta cuenta ya tiene una tienda creada">
          <p>Cada cuenta lleva una sola tienda, así que no hace falta crear otra.</p>
        </Aviso>
        <Boton onClick={alRecargar}>Abrir mi tienda</Boton>
      </Hoja>
    );
  }

  return (
    <Hoja alSalir={alSalir}>
      <Progreso paso={2} total={2} nombre="Los datos de tu tienda" />
      <h1>Crea tu tienda</h1>
      <p>Dos datos y empiezas a anotar fiados. No pedimos tarjeta.</p>
      <form className="hoja__formulario" onSubmit={enviar} noValidate>
        <Campo
          id="alta-name"
          etiqueta="Nombre de la tienda"
          ayuda="Como la conoce el barrio. Máximo 80 letras."
          autoComplete="organization"
          autoCapitalize="words"
          enterKeyHint="next"
          maxLength={80}
          value={datos.name}
          onChange={(e) => cambiar('name', e.target.value)}
          onBlur={(e) => revisar('name', e.target.value)}
          error={errores.name}
        />
        <Campo
          id="alta-whatsapp_phone"
          etiqueta="WhatsApp de la tienda"
          ayuda="El celular donde atiendes a tus clientes. Ejemplo: 300 123 4567."
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          enterKeyHint="done"
          value={datos.whatsapp_phone}
          onChange={(e) => cambiar('whatsapp_phone', e.target.value)}
          onBlur={(e) => revisar('whatsapp_phone', e.target.value)}
          error={errores.whatsapp_phone}
        />
        <Casilla id="alta-acepta_terminos" checked={datos.acepta_terminos} onChange={(e) => cambiar('acepta_terminos', e.target.checked)} error={errores.acepta_terminos}>
          Acepto los{' '}
          <a href="/terminos" target="_blank" rel="noopener">
            términos
          </a>{' '}
          y la{' '}
          <a href="/privacidad" target="_blank" rel="noopener">
            política de datos
          </a>
        </Casilla>
        {fallo && (
          <Aviso tono="error" titulo={fallo.status === 429 ? 'Demasiados intentos seguidos' : fallo.status === 0 ? 'No hay conexión' : 'No pudimos crear tu tienda'}>
            <p>
              {fallo.status === 429
                ? 'Espera un minuto y vuelve a tocar el botón. Lo que escribiste sigue aquí.'
                : fallo.status === 0
                  ? 'Revisa tu internet y vuelve a tocar el botón. Lo que escribiste sigue aquí.'
                  : fallo.status === 401
                    ? 'Tu sesión venció. Sal, vuelve a entrar e inténtalo de nuevo.'
                    : 'Es un problema nuestro, no tuyo. Vuelve a tocar el botón en un momento.'}
            </p>
          </Aviso>
        )}
        <Boton type="submit" disabled={enviando}>
          {enviando ? 'Creando tu tienda…' : 'Empezar mi prueba de 3 días'}
        </Boton>
        <p className="hoja__nota">La prueba dura 72 horas desde que tocas el botón.</p>
      </form>
    </Hoja>
  );
}
