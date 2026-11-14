// Migrador de cuadernos (IAS-04): foto → R2 → lectura propuesta → el tendero corrige la tabla → importar al confirmar.
// Cada saldo entra como FIADO «Saldo anterior (cuaderno)» con la foto como evidencia (B4).
import { Hono } from 'hono';
import { z } from 'zod';
import { nuevoId } from '../../shared/ids';
import { claveValida } from '../archivos';
import type { AppEnv } from '../auth';
import { FilaCuaderno, leerCuaderno, MAX_FILAS } from '../cuadernos';
import { conCuota } from '../cuotas';
import { IaNoDisponible } from '../ia';
import { sentenciasMovimiento } from '../libro';
import { limitar } from '../limite';
import { MAX_CAPTURA_BYTES, tipoDeImagen } from '../pagos';
import { cuotasDe } from '../planes';
import { cuerpo } from '../validar';

export const cuadernos = new Hono<AppEnv>();

const MARGEN_FORMULARIO = 64 * 1024;
export const DESCRIPCION_CUADERNO = 'Saldo anterior (cuaderno)';

/** `leida`: la IA propuso filas. `apagada`: AI_READY apagado, el tendero escribe la tabla mirando su foto. */
type Lectura = 'leida' | 'apagada' | 'fallida' | 'sin_cuota';

cuadernos.post('/fotos', limitar('LIMITE_SUBIDAS', (c) => c.var.negocio.id), async (c) => {
  const largo = Number(c.req.header('Content-Length') || NaN);
  if (Number.isNaN(largo)) return c.json({ error: 'falta_content_length' }, 411);
  if (largo > MAX_CAPTURA_BYTES + MARGEN_FORMULARIO) return c.json({ error: 'foto_muy_grande' }, 413);
  const foto = (await c.req.formData().catch(() => null))?.get('foto');
  if (!(foto instanceof File)) return c.json({ error: 'foto_invalida' }, 400);
  if (foto.size > MAX_CAPTURA_BYTES) return c.json({ error: 'foto_muy_grande' }, 413);
  const bytes = new Uint8Array(await foto.arrayBuffer());
  const tipo = tipoDeImagen(bytes);
  if (!tipo) return c.json({ error: 'foto_invalida' }, 400);

  const negocio = c.var.negocio;
  const clave = `negocios/${negocio.id}/cuadernos/${nuevoId('cua')}.${tipo.ext}`;
  await c.env.ARCHIVOS.put(clave, bytes, { httpMetadata: { contentType: tipo.contentType } });

  let lectura: Lectura = 'apagada';
  let filas: FilaCuaderno[] = [];
  let mensaje: string | undefined;
  if (c.env.AI_READY === '1' && c.env.AI) {
    try {
      const r = await conCuota(c.env, negocio, 'ocr', () => leerCuaderno(c.env, bytes, tipo));
      if (r.ok) [lectura, filas] = ['leida', r.valor];
      else [lectura, mensaje] = ['sin_cuota', r.mensaje];
    } catch (e) {
      if (!(e instanceof IaNoDisponible)) throw e;
      lectura = 'fallida'; // la cuota ya se devolvió; la foto queda y la tabla se llena a mano
    }
  }
  return c.json({ foto: clave, lectura, filas, mensaje }, 201);
});

const Importar = z.object({
  foto: z.string().max(200),
  /** Lo genera la app una vez por importación: reintentar con el mismo no duplica nada. */
  request_id: z.string().regex(/^[A-Za-z0-9_-]{8,56}$/),
  filas: z.array(FilaCuaderno).min(1).max(MAX_FILAS),
});

/** Deudores creados por una importación, encontrados por el prefijo de sus request_id. */
const importados = (db: D1Database, negocioId: string, requestId: string) =>
  db.prepare(
    `SELECT d.id, d.unique_code, d.full_name, d.alias_reference, d.current_balance_cop
     FROM ledger_transactions l JOIN debtors d ON d.id = l.debtor_id AND d.business_id = l.business_id
     WHERE l.business_id = ?1 AND substr(l.request_id, 1, ?2) = ?3 ORDER BY d.unique_code`,
  ).bind(negocioId, requestId.length + 1, `${requestId}-`).all();

cuadernos.post('/importar', async (c) => {
  const d = await cuerpo(c, Importar);
  const negocio = c.var.negocio;
  const db = c.env.DB;
  // La evidencia tiene que ser una foto de cuaderno de ESTE negocio que de verdad exista.
  if (!d.foto.startsWith(`negocios/${negocio.id}/cuadernos/`) || !claveValida(d.foto) || !(await c.env.ARCHIVOS.head(d.foto))) {
    return c.json({ error: 'datos_invalidos', campos: ['foto'] }, 400);
  }
  const limite = cuotasDe(negocio).deudores;
  const ahora = Date.now();
  // Todo en un solo batch: o entran todos los deudores con su saldo, o ninguno.
  const sentencias = d.filas.flatMap((f, i) => {
    const deudor = nuevoId('deb', ahora);
    return [
      // Si el plan ya no admite otro deudor, el código queda NULL, la restricción NOT NULL corta y el batch entero se deshace.
      db.prepare(
        `INSERT INTO debtors (id, business_id, unique_code, full_name, alias_reference, created_at)
         SELECT ?1, ?2, CASE WHEN ?6 IS NULL OR COUNT(*) < ?6
           THEN printf('TLN-%04d', COALESCE(MAX(CAST(substr(unique_code, 5) AS INTEGER)), 0) + 1) END, ?3, ?4, ?5
         FROM debtors WHERE business_id = ?2`,
      ).bind(deudor, negocio.id, f.full_name, f.alias_reference ?? null, ahora, limite),
      ...sentenciasMovimiento(db, {
        business_id: negocio.id, debtor_id: deudor, request_id: `${d.request_id}-${i}`, type: 'FIADO', amount_cop: f.saldo_cop,
        description: DESCRIPCION_CUADERNO, evidence_r2_key: d.foto, source: 'SARIN_IMAGE_OCR',
      }, `mov_${crypto.randomUUID().replaceAll('-', '')}`, ahora),
    ];
  });
  try {
    await db.batch(sentencias);
  } catch (e) {
    const texto = e instanceof Error ? e.message : '';
    if (texto.includes('NOT NULL') && texto.includes('unique_code')) return c.json({ error: 'limite_deudores', limite }, 409);
    // Reintento de la misma importación: ya estaba hecha, se devuelve lo que creó.
    if (texto.includes('movimiento repetido')) return c.json({ deudores: (await importados(db, negocio.id, d.request_id)).results, repetido: true });
    throw e;
  }
  return c.json({ deudores: (await importados(db, negocio.id, d.request_id)).results, repetido: false }, 201);
});
