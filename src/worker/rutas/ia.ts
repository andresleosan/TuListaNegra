// Sarin dentro de la app (IAS-02, B4): frase del tendero → orden interpretada `{ accion, monto, deudor_buscado }`.
// Esta ruta NO escribe en el libro: la app busca al deudor en su copia local, muestra la propuesta y, si la persona
// confirma, anota con el mismo POST /api/deudores/:id/movimientos del mostrador (A1.3: la IA propone, una persona confirma).
// Solo texto: para hablar, el tendero usa el micrófono del teclado de su teléfono, que escribe en el campo.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../auth';
import { conCuota } from '../cuotas';
import { IaApagada, IaNoDisponible, interpretarFrase } from '../ia';
import { limitar } from '../limite';
import { cuerpo } from '../validar';

const Pedido = z.object({ frase: z.string().trim().min(1).max(300) });

export const ia = new Hono<AppEnv>();

ia.post('/orden', limitar('LIMITE_IA', (c) => c.var.negocio.id), async (c) => {
  const { frase } = await cuerpo(c, Pedido);
  // Antes de tocar la cuota: con la IA apagada no se escribe nada en el negocio y el tendero ve el motivo real.
  if (c.env.AI_READY !== '1' || !c.env.DEEPSEEK_API_KEY) return c.json({ error: 'ia_apagada' }, 409);
  try {
    const r = await conCuota(c.env, c.var.negocio, 'ia', () => interpretarFrase(c.env, frase));
    if (!r.ok) return c.json({ error: r.error, mensaje: r.mensaje }, 409);
    return c.json(r.valor);
  } catch (e) {
    // En los dos casos `conCuota` ya devolvió la interacción: el tendero no paga por lo que no se hizo.
    if (e instanceof IaApagada) return c.json({ error: 'ia_apagada' }, 409);
    if (e instanceof IaNoDisponible) return c.json({ error: 'ia_no_disponible' }, 503);
    throw e;
  }
});
