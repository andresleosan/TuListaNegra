// Elige la implementación de `SarinGateway`. Con WHATSAPP_SEND_READY apagado (A3) es SIEMPRE el simulador.
import { SimulatedGateway } from './simulado';
import type { SarinGateway } from './tipos';

/**
 * `negocio`: la tienda en cuyo nombre se envía (fuera de la interfaz del contrato, que no lleva negocio). Cada envío
 * guardado lo lleva desde el principio; el gateway real tendrá que hacer lo mismo.
 */
export function gatewayPara(env: Env, ahora: () => number = Date.now, negocio: string | null = null): SarinGateway {
  if (env.WHATSAPP_SEND_READY !== '1') return new SimulatedGateway(env, ahora, negocio);
  // Aquí irá el gateway real, cuando el dueño elija la variante (contrato-sarin.md, sección c):
  //   A → `MetaCloudGateway`: fetch a Graph API con el token del número; lo entrante reutiliza ./meta.ts.
  //   B → `SarinForwardGateway`: eventos reenviados y vueltos a firmar por Sarin Bot; envío por un servicio que hoy no existe.
  // Hasta entonces, encender el interruptor no envía nada: falla cerrado.
  throw new Error('gateway_real_sin_implementar');
}
