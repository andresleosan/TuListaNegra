// Cliente de la API del Worker. Cada petición lleva el ID token del proveedor de sesión.
import type { EstadoNegocio, Permisos } from '../shared/acceso';
import { cargarProveedor } from './sesion';

/** Respuesta de error de la API: `error` es el código del servidor (`sin_negocio`, `telefono_en_uso`…). */
export class ErrorApi extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    /** Lo envía el guardián al bloquear (`acceso_denegado`). */
    readonly estado?: EstadoNegocio,
    /** Campos rechazados (`datos_invalidos`). */
    readonly campos?: string[],
  ) {
    super(`${status} ${error}`);
  }
}

/** `GET /api/negocio` y la respuesta del alta. */
export type Negocio = {
  id: string;
  name: string;
  estado: Exclude<EstadoNegocio, 'SUSPENDED_BY_ADMIN'>;
  permisos: Permisos;
  plan: string;
  gratis: boolean;
  /** Milisegundos UTC; `null` en una cuenta gratis. */
  vence_en: number | null;
  desbloqueo_hasta: number | null;
  /** Cuotas del plan; `deudores: null` = sin límite. */
  limites: { deudores: number | null; ocr: number; ia: number; cobros: number };
  whatsapp_phone: string | null;
};

/** Un negocio suspendido solo recibe el aviso y cómo contactar. */
export type NegocioSuspendido = { estado: 'SUSPENDED_BY_ADMIN'; permisos: Permisos; contacto: string | null };

/** Pide `/api<ruta>` con la sesión actual. Devuelve el JSON o lanza `ErrorApi` (status 0 = sin conexión). */
export async function api<T>(ruta: string, { metodo = 'GET', cuerpo }: { metodo?: string; cuerpo?: unknown } = {}): Promise<T> {
  const proveedor = await cargarProveedor();
  if (!proveedor?.usuario()) throw new ErrorApi(401, 'sin_sesion');
  let respuesta: Response;
  try {
    respuesta = await fetch(`/api${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${await proveedor.token()}`, ...(cuerpo === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  } catch {
    throw new ErrorApi(0, 'sin_conexion');
  }
  const datos: unknown = await respuesta.json().catch(() => null);
  if (respuesta.ok) return datos as T;
  const fallo = (datos ?? {}) as { error?: string; estado?: EstadoNegocio; campos?: string[] };
  throw new ErrorApi(respuesta.status, fallo.error ?? 'error_desconocido', fallo.estado, fallo.campos);
}
