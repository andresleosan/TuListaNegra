// Simulador local de ingreso. SOLO desarrollo: se importa tras `import.meta.env.DEV` y no llega a producción
// (lo vigila `check:release`). No salta la autenticación: pide al servidor de desarrollo de Vite un ID token
// firmado con la llave local (`POST /__dev/token`) y el Worker lo verifica como uno de Firebase.
import { ErrorDeIngreso, type ProveedorSesion, type Usuario } from './index';

export type IdentidadSimulada = { uid?: string; email: string; email_verified: boolean; proveedor: 'google.com' | 'password' };
export type Simulador = ProveedorSesion & { entrarComo(identidad: IdentidadSimulada): Promise<void> };

const RUTA = '/__dev/token';
// La identidad simulada (ficticia; nunca el token) vive en sessionStorage para que recargar no cierre la sesión,
// como hace Firebase con la suya. Se borra al salir y al cerrar la pestaña.
const CLAVE = 'tln-simulador';

const uidDe = (token: string): string => JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).sub;

/** `null` si el servidor de desarrollo no tiene llave local: no hay simulador. */
export async function crearSimulador(): Promise<Simulador | null> {
  if ((await fetch(RUTA)).status !== 204) return null;

  let identidad: IdentidadSimulada | null = null;
  let usuario: Usuario | null = null;
  let vigente: { token: string; hasta: number } | null = null;
  const oyentes = new Set<() => void>();

  async function pedirToken(de: IdentidadSimulada) {
    const res = await fetch(RUTA, { method: 'POST', body: JSON.stringify(de) });
    if (!res.ok) throw new ErrorDeIngreso('El simulador no pudo emitir el token. Revisa que el correo esté completo.');
    return ((await res.json()) as { token: string }).token;
  }

  async function entrarComo(nueva: IdentidadSimulada) {
    const token = await pedirToken(nueva);
    identidad = nueva;
    vigente = { token, hasta: Date.now() + 50 * 60_000 }; // el token dura 1 h: se renueva antes
    usuario = { uid: uidDe(token), email: nueva.email.trim().toLowerCase() };
    sessionStorage.setItem(CLAVE, JSON.stringify(nueva));
    oyentes.forEach((avisar) => avisar());
  }

  const guardada = sessionStorage.getItem(CLAVE);
  if (guardada) await entrarComo(JSON.parse(guardada)).catch(() => sessionStorage.removeItem(CLAVE));

  return {
    simulado: true,
    usuario: () => usuario,
    suscribir(alCambiar) {
      oyentes.add(alCambiar);
      return () => oyentes.delete(alCambiar);
    },
    async token() {
      if (!identidad) throw new ErrorDeIngreso('Sin sesión');
      if (!vigente || Date.now() > vigente.hasta) vigente = { token: await pedirToken(identidad), hasta: Date.now() + 50 * 60_000 };
      return vigente.token;
    },
    entrarComo,
    entrarConGoogle: () => entrarComo({ email: 'piloto@ejemplo.test', email_verified: true, proveedor: 'google.com' }),
    entrarConCorreo: (correo) => entrarComo({ email: correo, email_verified: true, proveedor: 'password' }),
    registrarConCorreo: (correo) => entrarComo({ email: correo, email_verified: false, proveedor: 'password' }),
    async salir() {
      identidad = usuario = vigente = null;
      sessionStorage.removeItem(CLAVE);
      oyentes.forEach((avisar) => avisar());
    },
  };
}
