// Elige la implementación de `SarinGateway`. Con WHATSAPP_SEND_READY apagado (A3) es SIEMPRE el simulador.
import { MetaCloudGateway } from './meta-gateway';
import { SimulatedGateway } from './simulado';
import type { SarinGateway } from './tipos';

/**
 * `negocio`: la tienda en cuyo nombre se envía (fuera de la interfaz del contrato, que no lleva negocio). Cada envío
 * guardado lo lleva desde el principio.
 */
export function gatewayPara(env: Env, ahora: () => number = Date.now, negocio: string | null = null): SarinGateway {
  if (env.WHATSAPP_SEND_READY !== '1') return new SimulatedGateway(env, ahora, negocio);
  // Variante A (contrato-sarin.md, sección c; decisión del dueño): número propio contra la Cloud API de Meta.
  // Sin configuración completa y real, el constructor lanza `WhatsappSinConfigurar` (falla cerrado): quien envía no
  // reserva ni gasta nada, y el webhook responde 401.
  return new MetaCloudGateway(env, ahora, negocio);
}
