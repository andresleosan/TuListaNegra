// Copia local de solo lectura de los deudores (MOS-01): con ella se busca sin esperar a la red.
// Solo lleva lo necesario para buscar y pintar la lista (`DeudorResumen`): nunca el documento completo ni el teléfono.
import { useSyncExternalStore } from 'react';
import type { DeudorResumen } from '../shared/deudor';
import { api, ErrorApi } from './api';

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

/** Vuelve a traer la lista del servidor. Llamar tras crear o editar un deudor, fiar, abonar o cobrar. */
export async function refrescarCartera(): Promise<void> {
  try {
    const { deudores } = await api<{ deudores: DeudorResumen[] }>('/deudores');
    publicar({ deudores, estado: 'lista', actualizada_en: Date.now() });
  } catch (e) {
    if (e instanceof ErrorApi && e.status === 0) publicar({ ...cartera, estado: 'sin_conexion' });
    else throw e;
  }
}

/** Al cerrar sesión no queda nada de la tienda en este navegador. */
export async function borrarCartera(): Promise<void> {
  publicar({ deudores: [], estado: 'cargando', actualizada_en: null });
}
