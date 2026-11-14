// Sesión en el navegador. La app solo conoce esta interfaz; quién la cumple se decide al arrancar.
// La sesión de verdad la decide el Worker al verificar el ID token: aquí no se guarda ni se cree nada.

export type Usuario = { uid: string; email: string | null };

export interface ProveedorSesion {
  /** Usuario actual, o `null` sin sesión. Mismo objeto mientras no cambie. */
  usuario(): Usuario | null;
  /** Avisa de cada cambio de sesión. Devuelve cómo dejar de escuchar. */
  suscribir(alCambiar: () => void): () => void;
  /** ID token vigente para `Authorization: Bearer`. Falla sin sesión. */
  token(): Promise<string>;
  entrarConGoogle(): Promise<void>;
  entrarConCorreo(correo: string, clave: string): Promise<void>;
  registrarConCorreo(correo: string, clave: string): Promise<void>;
  salir(): Promise<void>;
  /** Solo el simulador local: la pantalla de ingreso muestra su formulario de desarrollo. */
  readonly simulado?: true;
}

/** Fallo de ingreso con un mensaje ya escrito para el tendero. */
export class ErrorDeIngreso extends Error {}

async function crear(): Promise<ProveedorSesion | null> {
  const config: string | undefined = import.meta.env.VITE_FIREBASE_CONFIG;
  if (config) return (await import('./firebase')).crearFirebase(JSON.parse(config));
  // Solo desarrollo: en producción la condición es `false` y el simulador no entra en el bundle.
  if (import.meta.env.DEV) return (await import('./simulador')).crearSimulador();
  return null;
}

let proveedor: Promise<ProveedorSesion | null> | undefined;

/** El proveedor de sesión (uno por pestaña), o `null` si el ingreso aún no está configurado. */
export const cargarProveedor = () => (proveedor ??= crear());
