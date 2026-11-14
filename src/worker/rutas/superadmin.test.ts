// SUP-02 por la API: bandeja, captura, aprobar y rechazar. (El control de acceso de cada ruta está en superadmin.test.ts.)
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import { EN_ESTADO, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';

const ADMIN = { email: 'admin@ejemplo.test', uid: 'uid_admin' };
const entorno = { ...env, SUPERADMIN_EMAILS: ADMIN.email };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;
const admin = (ruta: string, cuerpo?: unknown) =>
  api(ruta, ADMIN, cuerpo === undefined ? {} : { method: 'POST', body: JSON.stringify(cuerpo) }, entorno);

async function subirCaptura(uid: string) {
  const formulario = new FormData();
  formulario.set('plan', 'PASS_15D');
  formulario.set('captura', new File([PNG], 'pago.png', { type: 'image/png' }));
  const serializado = new Response(formulario);
  const body = await serializado.arrayBuffer();
  const res = await api('/api/suscripcion/pagos', { uid }, { method: 'POST', body, headers: { 'Content-Type': serializado.headers.get('Content-Type')!, 'Content-Length': String(body.byteLength) } });
  return (await res.json<any>()).pago.id as string;
}

describe('bandeja de pagos', () => {
  test('lista los pendientes con el negocio, el monto esperado y la clave de la captura', async () => {
    await sembrarNegocio('uid_1', { ...EN_ESTADO.EXPIRED_READONLY(), name: 'La Esquina de Rubi' });
    const id = await subirCaptura('uid_1');
    const { pagos } = await json(admin('/api/superadmin/pagos'));
    expect(pagos).toEqual([expect.objectContaining({
      id, negocio: 'La Esquina de Rubi', plan_requested: 'PASS_15D', days_to_add: 15, amount_cop: 27_900, status: 'PENDING_REVIEW',
      receipt_r2_key: `negocios/bus_uid_1/pagos/${id}.png`, monto_no_coincide: false, referencia_repetida: false,
    })]);
    expect((await json(admin('/api/superadmin/pagos?estado=PAID'))).pagos).toEqual([]);
  });

  test('alerta si el monto leído no coincide o si la referencia ya apareció en otro pago', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    await sembrarNegocio('uid_2', EN_ESTADO.EXPIRED_READONLY());
    const a = await subirCaptura('uid_1');
    const b = await subirCaptura('uid_2');
    // Lo que dejaría la lectura de la captura (IAS-03): mismo número de referencia en dos pagos, y un monto menor.
    await env.DB.prepare("UPDATE subscription_payments SET ocr_reference_number = 'REF-777', ocr_extracted_amount = CASE id WHEN ?1 THEN 27900 ELSE 2790 END WHERE id IN (?1, ?2)").bind(a, b).run();
    const { pagos } = await json(admin('/api/superadmin/pagos'));
    expect(pagos.find((p: any) => p.id === a)).toMatchObject({ monto_no_coincide: false, referencia_repetida: true });
    expect(pagos.find((p: any) => p.id === b)).toMatchObject({ monto_no_coincide: true, referencia_repetida: true });
  });

  test('el superadministrador ve la captura de cualquier negocio; otro tendero no', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    await sembrarNegocio('uid_2');
    const id = await subirCaptura('uid_1');
    const clave = `negocios/bus_uid_1/pagos/${id}.png`;
    const res = await admin(`/api/superadmin/archivos/${clave}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect((await api(`/api/superadmin/archivos/${clave}`, { uid: 'uid_2' }, {}, entorno)).status).toBe(403);
    expect((await api(`/api/archivos/${clave}`, { uid: 'uid_2' }, {}, entorno)).status).toBe(404);
    expect((await api(`/api/archivos/${clave}`, { uid: 'uid_1' }, {}, entorno)).status).toBe(200); // su dueño
    expect((await admin('/api/superadmin/archivos/negocios/bus_uid_1/../x')).status).toBe(404);
  });
});

describe('aprobar y rechazar', () => {
  test('aprobar activa el negocio; repetir no vuelve a sumar', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    const id = await subirCaptura('uid_1');
    expect(await json(api('/api/negocio', { uid: 'uid_1' }))).toMatchObject({ estado: 'GRACE_UNLOCK_24H' });
    const primera = await admin(`/api/superadmin/pagos/${id}/aprobar`, {});
    expect(primera.status).toBe(200);
    expect(await primera.json()).toMatchObject({ aplicado: true, pago: { status: 'PAID', reviewed_by_email: ADMIN.email } });
    const tras = await json(api('/api/negocio', { uid: 'uid_1' }));
    expect(tras).toMatchObject({ estado: 'ACTIVE', plan: 'PASS_15D', desbloqueo_hasta: null, usados: { ocr: 0, ia: 0, cobros: 0 } });
    expect(await json(admin(`/api/superadmin/pagos/${id}/aprobar`, {}))).toMatchObject({ aplicado: false });
    expect((await json(api('/api/negocio', { uid: 'uid_1' }))).vence_en).toBe(tras.vence_en);
    expect(await json(api('/api/suscripcion', { uid: 'uid_1' }))).toMatchObject({ pago_pendiente: null, ultimo_revisado: { status: 'PAID' } });
  });

  test('rechazar exige motivo, termina el desbloqueo y el dueño ve el motivo en la app', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    const id = await subirCaptura('uid_1');
    for (const sinMotivo of [{}, { motivo: '' }, { motivo: '  ' }]) {
      expect((await admin(`/api/superadmin/pagos/${id}/rechazar`, sinMotivo)).status).toBe(400);
    }
    expect(await json(api('/api/negocio', { uid: 'uid_1' }))).toMatchObject({ estado: 'GRACE_UNLOCK_24H' });
    expect((await admin(`/api/superadmin/pagos/${id}/rechazar`, { motivo: 'El monto no coincide con el pase' })).status).toBe(200);
    expect(await json(api('/api/negocio', { uid: 'uid_1' }))).toMatchObject({ estado: 'EXPIRED_READONLY' });
    expect(await json(api('/api/suscripcion', { uid: 'uid_1' }))).toMatchObject({ ultimo_revisado: { status: 'REJECTED', review_note: 'El monto no coincide con el pase' } });
    // Tras un rechazo, el siguiente pago espera la aprobación sin desbloqueo (SUS-02).
    await subirCaptura('uid_1');
    expect(await json(api('/api/negocio', { uid: 'uid_1' }))).toMatchObject({ estado: 'EXPIRED_READONLY' });
    expect((await admin(`/api/superadmin/pagos/${id}/aprobar`, {})).status).toBe(409);
  });

  test('pago inexistente → 404; cada revisión queda en la auditoría', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    expect((await admin('/api/superadmin/pagos/pay_nada/aprobar', {})).status).toBe(404);
    const id = await subirCaptura('uid_1');
    await admin(`/api/superadmin/pagos/${id}/aprobar`, { nota: 'Nequi verificado' });
    const { results } = await env.DB.prepare('SELECT actor_email, action, business_id FROM admin_audit_log').all();
    expect(results).toEqual([{ actor_email: ADMIN.email, action: 'PAGO_APROBADO', business_id: 'bus_uid_1' }]);
  });
});

describe('negocios: acciones de la consola (SUP-03)', () => {
  const accion = (nombre: string, cuerpo: unknown, id = 'bus_uid_1') => admin(`/api/superadmin/negocios/${id}/${nombre}`, cuerpo);
  const propio = (uid = 'uid_1') => json(api('/api/negocio', { uid }));
  const auditoria = async () => (await env.DB.prepare('SELECT actor_email, action, business_id, detail_json FROM admin_audit_log ORDER BY created_at, id').all<any>()).results;
  const DIA = 86_400_000;

  test('marcar gratis deja activo un negocio vencido, sin fecha ni aviso de renovación; desmarcar lo devuelve a sus fechas', async () => {
    const sembrado = await sembrarNegocio('uid_1', { ...EN_ESTADO.EXPIRED_READONLY(), ai_chat_used_count: 9 });
    expect(await propio()).toMatchObject({ estado: 'EXPIRED_READONLY' });
    const res = await accion('gratis', { activar: true, motivo: 'Tienda aliada del piloto' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'ACTIVE', gratis: true, vence_en: null, usados: { ia: 0 } });
    expect(await propio()).toMatchObject({ estado: 'ACTIVE', gratis: true, vence_en: null, limites: { deudores: null, ocr: 60, ia: 300, cobros: 250 } });
    // Volver a marcar no reinicia el ciclo ni los contadores.
    await env.DB.prepare("UPDATE businesses SET ai_chat_used_count = 5 WHERE id = 'bus_uid_1'").run();
    expect(await json(accion('gratis', { activar: true, motivo: 'Repetido por error' }))).toMatchObject({ usados: { ia: 5 } });
    expect(await json(accion('gratis', { activar: false, motivo: 'Terminó el convenio' }))).toMatchObject({ estado: 'EXPIRED_READONLY', gratis: false, vence_en: sembrado.subscription_expires_at });
    expect(await propio()).toMatchObject({ estado: 'EXPIRED_READONLY', vence_en: sembrado.subscription_expires_at });
  });

  test('suspender gana a gratis y a un pase vigente; reactivar lo devuelve', async () => {
    await sembrarNegocio('uid_1');
    await accion('gratis', { activar: true, motivo: 'Cortesía' });
    expect(await json(accion('suspender', { motivo: 'Uso indebido reportado' }))).toMatchObject({ estado: 'SUSPENDED_BY_ADMIN', gratis: true, suspendido: true });
    expect(await propio()).toEqual({ estado: 'SUSPENDED_BY_ADMIN', permisos: { ver: false, escribir: false, ia: false }, contacto: null });
    expect((await api('/api/deudores', { uid: 'uid_1' })).status).toBe(403);
    expect(await json(accion('reactivar', { motivo: 'Aclarado con el dueño' }))).toMatchObject({ estado: 'ACTIVE', suspendido: false, gratis: true });
  });

  test.each([3, 7, 15, 30])('días de cortesía: +%i desde ahora si está vencido', async (dias) => {
    await sembrarNegocio('uid_1', EN_ESTADO.EXPIRED_READONLY());
    const antes = Date.now();
    const n = await json(accion('cortesia', { dias, motivo: 'Compensación por caída' }));
    expect(n.estado).toBe('ACTIVE');
    expect(n.vence_en).toBeGreaterThanOrEqual(antes + dias * DIA);
    expect(n.vence_en).toBeLessThanOrEqual(Date.now() + dias * DIA);
  });

  test('días de cortesía se suman al vencimiento si aún está activo; solo valen 3, 7, 15 o 30', async () => {
    const sembrado = await sembrarNegocio('uid_1');
    expect((await json(accion('cortesia', { dias: 7, motivo: 'Regalo' }))).vence_en).toBe(sembrado.subscription_expires_at + 7 * DIA);
    for (const dias of [0, 1, 5, 31, -7, '7', 7.5]) expect((await accion('cortesia', { dias, motivo: 'Regalo' })).status).toBe(400);
  });

  test('reiniciar contadores', async () => {
    await sembrarNegocio('uid_1', { ai_ocr_used_count: 4, ai_chat_used_count: 40, wa_reminders_used_count: 12 });
    expect(await json(accion('reiniciar-contadores', { motivo: 'Fallo de la IA los gastó' }))).toMatchObject({ usados: { ocr: 0, ia: 0, cobros: 0 } });
  });

  test.each([
    ['cortesia', { dias: 7 }], ['gratis', { activar: true }], ['reiniciar-contadores', {}], ['suspender', {}], ['reactivar', {}],
  ])('%s exige motivo y queda en auditoría', async (nombre, datos) => {
    const sembrado = await sembrarNegocio('uid_1', { ai_chat_used_count: 3 });
    for (const sinMotivo of [datos, { ...datos, motivo: '' }, { ...datos, motivo: ' x ' }]) {
      expect((await accion(nombre, sinMotivo)).status, JSON.stringify(sinMotivo)).toBe(400);
    }
    expect(await auditoria()).toEqual([]);
    expect(await propio()).toMatchObject({ estado: 'ACTIVE', gratis: false, vence_en: sembrado.subscription_expires_at, usados: { ia: 3 } });
    expect((await accion(nombre, { ...datos, motivo: 'Motivo de prueba' })).status).toBe(200);
    const filas = await auditoria();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ actor_email: ADMIN.email, business_id: 'bus_uid_1' });
    expect(JSON.parse(filas[0].detail_json)).toEqual({ ...datos, motivo: 'Motivo de prueba' });
  });

  test('negocio o acción inexistente → 404 sin dejar auditoría; solo se toca el negocio indicado', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    expect((await accion('suspender', { motivo: 'No existe' }, 'bus_nada')).status).toBe(404);
    expect((await accion('borrar', { motivo: 'No existe' })).status).toBe(404);
    expect(await auditoria()).toEqual([]);
    await accion('suspender', { motivo: 'Solo este' });
    expect(await propio('uid_2')).toMatchObject({ estado: 'ACTIVE' });
  });

  test('buscador por nombre, correo o teléfono, con el estado calculado', async () => {
    await sembrarNegocio('uid_1', { name: 'La Esquina de Rubi', whatsapp_phone: '+573001112233' });
    await sembrarNegocio('uid_2', { name: 'Tienda 100%', ...EN_ESTADO.EXPIRED_READONLY() });
    const buscar = async (q: string) => (await json(admin(`/api/superadmin/negocios?q=${encodeURIComponent(q)}`))).negocios.map((n: any) => n.id);
    expect(await buscar('rubi')).toEqual(['bus_uid_1']);
    expect(await buscar('uid_2@ejemplo')).toEqual(['bus_uid_2']);
    expect(await buscar('3001112233')).toEqual(['bus_uid_1']);
    expect(await buscar('100%')).toEqual(['bus_uid_2']); // el % se busca literal
    expect((await buscar('')).sort()).toEqual(['bus_uid_1', 'bus_uid_2']);
    expect((await json(admin('/api/superadmin/negocios?q=100'))).negocios[0]).toMatchObject({ estado: 'EXPIRED_READONLY', gratis: false, suspendido: false });
  });
});

test('una acción con nombre de propiedad heredada (constructor, toString, __proto__) → 404, no 500', async () => {
  await sembrarNegocio('uid_1');
  for (const nombre of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    expect((await admin(`/api/superadmin/negocios/bus_uid_1/${nombre}`, { motivo: 'Prueba' })).status).toBe(404);
  }
});
