// Cliente de la API del Worker. Cada petición lleva el ID token del proveedor de sesión.
import type { EstadoNegocio, Permisos } from '../shared/acceso';
import type { Tono } from '../shared/cobro';
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
    /** El cuerpo completo del error, por si trae más datos (`saldo`, `tope`, `motivo`, `mensaje`…). */
    readonly datos: Record<string, unknown> = {},
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
  /** Lo gastado en el ciclo actual. */
  usados: { ocr: number; ia: number; cobros: number };
  /** Ajustes de la tienda (AJU-01). */
  default_alert_days: number;
  payment_methods_info: string | null;
  tono_cobro: Tono;
  whatsapp_phone: string | null;
  /** Cuándo se verificó el teléfono de la tienda (WAP-02); `null` = sin verificar: sus mensajes no son órdenes. */
  whatsapp_verificado_en: number | null;
  /** `false` mientras `WHATSAPP_SEND_READY` esté apagado: los cobros por bot son de prueba (simulados). */
  bot_whatsapp_activo: boolean;
  bot_whatsapp_simulado: boolean;
};

/** Un negocio suspendido solo recibe el aviso y cómo contactar. */
export type NegocioSuspendido = { estado: 'SUSPENDED_BY_ADMIN'; permisos: Permisos; contacto: string | null };

async function pedir(ruta: string, metodo: string, cuerpo?: unknown): Promise<Response> {
  const proveedor = await cargarProveedor();
  if (!proveedor?.usuario()) throw new ErrorApi(401, 'sin_sesion');
  const formulario = cuerpo instanceof FormData; // subida de archivos: el navegador pone el Content-Type con su separador
  try {
    return await fetch(`/api${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${await proveedor.token()}`, ...(cuerpo === undefined || formulario ? {} : { 'Content-Type': 'application/json' }) },
      body: cuerpo === undefined ? undefined : formulario ? cuerpo : JSON.stringify(cuerpo),
    });
  } catch {
    throw new ErrorApi(0, 'sin_conexion');
  }
}

async function fallo(respuesta: Response): Promise<never> {
  const datos = ((await respuesta.json().catch(() => null)) ?? {}) as { error?: string; estado?: EstadoNegocio; campos?: string[] };
  throw new ErrorApi(respuesta.status, datos.error ?? 'error_desconocido', datos.estado, datos.campos, datos);
}

/**
 * Pide `/api<ruta>` con la sesión actual. Devuelve el JSON o lanza `ErrorApi` (status 0 = sin conexión).
 * `cuerpo` puede ser un objeto (se envía como JSON) o un `FormData` (subida de archivos).
 */
export async function api<T>(ruta: string, { metodo = 'GET', cuerpo }: { metodo?: string; cuerpo?: unknown } = {}): Promise<T> {
  const respuesta = await pedir(ruta, metodo, cuerpo);
  return respuesta.ok ? ((await respuesta.json()) as T) : fallo(respuesta);
}

/** Un archivo privado (p. ej. una captura de pago): se pide con la sesión y se muestra con `URL.createObjectURL`. */
export async function apiArchivo(ruta: string): Promise<Blob> {
  const respuesta = await pedir(ruta, 'GET');
  return respuesta.ok ? respuesta.blob() : fallo(respuesta);
}
