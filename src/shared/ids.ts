// Identificadores ULID con prefijo (bus_, deb_, mov_, pay_…): ordenables por fecha de creación.
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

export type PrefijoId = 'bus' | 'deb' | 'mov' | 'pay' | 'aud' | 'wam';

export function ulid(ahora = Date.now()): string {
  let tiempo = '';
  for (let t = ahora, i = 0; i < 10; i++, t = Math.floor(t / 32)) tiempo = ALFABETO[t % 32] + tiempo;
  const azar = crypto.getRandomValues(new Uint8Array(16));
  let cola = '';
  for (const byte of azar) cola += ALFABETO[byte % 32]; // 256 es múltiplo de 32: sin sesgo
  return tiempo + cola;
}

export const nuevoId = (prefijo: PrefijoId, ahora?: number) => `${prefijo}_${ulid(ahora)}`;
