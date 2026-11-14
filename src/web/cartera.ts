// Copia local de solo lectura de los deudores (MOS-01): con ella se busca sin esperar a la red.
// Solo lleva lo necesario para buscar y pintar la lista (`DeudorResumen`): nunca el documento completo ni el teléfono.
// Se guarda también en IndexedDB para que, si la red falla, se pueda buscar en la última copia. Se borra al salir.
// Junto a ella va el último negocio (MOS-05): así la app instalada abre sin red con la tienda de esta cuenta.
import { useSyncExternalStore } from 'react';
import type { DeudorResumen } from '../shared/deudor';
import { api, ErrorApi, type Negocio, type NegocioSuspendido } from './api';
import { cargarProveedor } from './sesion';

export type Cartera = {
  deudores: DeudorResumen[];
  /** `cargando`: aún no hay copia. `lista`: copia al día. `sin_conexion`: se muestra la última copia que hubo. */
  estado: 'cargando' | 'lista' | 'sin_conexion';
  /** Cuándo se trajo la copia del servidor (ms UTC), o `null` si nunca. */
  actualizada_en: number | null;
};

let cartera: Cartera = { deudores: [], estado: 'cargando', actualizada_en: null };
const oyentes = new Set<() => void>();

function publicar(nueva: Cartera) {
  cartera = nueva;
  for (const avisar of oyentes) avisar();
}

/** La copia local; la pantalla se repinta cuando cambia. */
export const useCartera = () =>
  useSyncExternalStore(
    (avisar) => (oyentes.add(avisar), () => void oyentes.delete(avisar)),
    () => cartera,
  );

// --- Copia persistente. Si IndexedDB no está (modo privado, bloqueado), la app sigue igual, solo sin copia guardada.
const BASE = 'tln-cartera';
const ALMACEN = 'copia';
type Guardada = { uid: string; deudores: DeudorResumen[]; actualizada_en: number };
type NegocioGuardado = { uid: string; negocio: Negocio | NegocioSuspendido };

// Sube al borrar: una copia que se estaba guardando mientras se salía no vuelve a escribirse.
let generacion = 0;

const uidActual = async () => (await cargarProveedor())?.usuario()?.uid ?? null;

function abrir(): Promise<IDBDatabase> {
  return new Promise((resolver, fallar) => {
    const pedido = indexedDB.open(BASE, 1);
    pedido.onupgradeneeded = () => pedido.result.createObjectStore(ALMACEN);
    pedido.onsuccess = () => resolver(pedido.result);
    pedido.onerror = () => fallar(pedido.error);
  });
}

/** Guarda `valor` en `clave`, ligado a la cuenta de la sesión actual. */
async function guardar<T extends { uid: string }>(clave: 'actual' | 'negocio', valor: Omit<T, 'uid'>) {
  const antes = generacion;
  try {
    const uid = await uidActual();
    if (!uid || antes !== generacion) return;
    const db = await abrir();
    if (antes !== generacion) return db.close();
    const tx = db.transaction(ALMACEN, 'readwrite');
    tx.objectStore(ALMACEN).put({ ...valor, uid }, clave);
    tx.oncomplete = tx.onerror = () => db.close();
  } catch {
    // Sin copia persistente: se busca igual mientras la pestaña siga abierta.
  }
}

/** Lo último guardado en `clave` por esta misma cuenta, o `null`. */
async function leerGuardada<T extends { uid: string }>(clave: 'actual' | 'negocio'): Promise<T | null> {
  try {
    const uid = await uidActual();
    const db = await abrir();
    const copia = await new Promise<T | undefined>((resolver, fallar) => {
      const pedido = db.transaction(ALMACEN).objectStore(ALMACEN).get(clave);
      pedido.onsuccess = () => resolver(pedido.result as T | undefined);
      pedido.onerror = () => fallar(pedido.error);
    });
    db.close();
    return copia && copia.uid === uid ? copia : null;
  } catch {
    return null;
  }
}

/** Vuelve a traer la lista del servidor. Llamar tras crear o editar un deudor, fiar, abonar o cobrar. */
// Solo publica la última petición: una respuesta vieja que llega tarde no pisa a una más nueva (p. ej. el «sin conexión»).
let ultimaPeticion = 0;

export async function refrescarCartera(): Promise<void> {
  const esta = ++ultimaPeticion;
  try {
    const { deudores } = await api<{ deudores: DeudorResumen[] }>('/deudores');
    if (esta !== ultimaPeticion) return;
    const actualizada_en = Date.now();
    publicar({ deudores, estado: 'lista', actualizada_en });
    void guardar<Guardada>('actual', { deudores, actualizada_en });
  } catch (e) {
    if (esta !== ultimaPeticion) return;
    if (!(e instanceof ErrorApi && e.status === 0)) throw e;
    // Sin red: lo que ya hay en memoria, o si no la última copia guardada en este navegador.
    const guardada = cartera.actualizada_en === null ? await leerGuardada<Guardada>('actual') : null;
    if (esta !== ultimaPeticion) return;
    publicar(guardada ? { deudores: guardada.deudores, estado: 'sin_conexion', actualizada_en: guardada.actualizada_en } : { ...cartera, estado: 'sin_conexion' });
  }
}

/** Guarda el último negocio que dio el servidor, para abrir sin red. */
export const guardarNegocio = (negocio: Negocio | NegocioSuspendido) => void guardar<NegocioGuardado>('negocio', { negocio });

/** El último negocio guardado por esta misma cuenta en este navegador, o `null`. */
export const negocioGuardado = async () => (await leerGuardada<NegocioGuardado>('negocio'))?.negocio ?? null;

/** Al cerrar sesión no queda nada de la tienda en este navegador. */
export async function borrarCartera(): Promise<void> {
  generacion++;
  ultimaPeticion++; // una lista que aún venga en camino ya no se publica
  publicar({ deudores: [], estado: 'cargando', actualizada_en: null });
  try {
    await new Promise<void>((resolver) => {
      const pedido = indexedDB.deleteDatabase(BASE);
      // `blocked`: otra pestaña la tiene abierta; el borrado se completa al cerrarla. Salir no espera por eso.
      pedido.onsuccess = pedido.onerror = pedido.onblocked = () => resolver();
    });
  } catch {
    // Sin IndexedDB no hay nada guardado que borrar.
  }
}
