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
