// DEU-01: código único bajo altas simultáneas; documento duplicado rechazado; límite de 15 en prueba.
import { describe, expect, test } from 'vitest';
import { EN_ESTADO, sembrarNegocio } from '../test/datos';
import { api } from '../test/sesion';

const crear = (datos: unknown, uid = 'uid_1') => api('/api/deudores', { uid }, { method: 'POST', body: JSON.stringify(datos) });
const editar = (id: string, datos: object, uid = 'uid_1') => api(`/api/deudores/${id}`, { uid }, { method: 'PATCH', body: JSON.stringify(datos) });
const json = async <T = any>(res: Response | Promise<Response>) => (await res).json() as Promise<T>;

describe('crear', () => {
  test('basta el nombre o apodo; el código empieza en TLN-0001', async () => {
    await sembrarNegocio();
    const res = await crear({ full_name: '  don Carlos el del taller ' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      unique_code: 'TLN-0001', full_name: 'don Carlos el del taller', doc_number: null, doc_last4: null,
      current_balance_cop: 0, credit_limit_cop: null, estado: 'AL_DIA', tiene_whatsapp: false, wa_consent_at: null,
    });
  });

  test('20 altas simultáneas reciben 20 códigos distintos y consecutivos', async () => {
    await sembrarNegocio();
    const respuestas = await Promise.all(Array.from({ length: 20 }, (_, i) => crear({ full_name: `Deudor ${i}` })));
    expect(respuestas.map((r) => r.status)).toEqual(Array(20).fill(201));
    const codigos = (await Promise.all(respuestas.map((r) => json(r)))).map((d) => d.unique_code).sort();
    expect(codigos).toEqual(Array.from({ length: 20 }, (_, i) => `TLN-${String(i + 1).padStart(4, '0')}`));
  });

  test('el consecutivo es por negocio y no se reutiliza al archivar', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    const a1 = await json(crear({ full_name: 'A1' }, 'uid_1'));
    await editar(a1.id, { archivado: true });
    expect((await json(crear({ full_name: 'A2' }, 'uid_1'))).unique_code).toBe('TLN-0002');
    expect((await json(crear({ full_name: 'B1' }, 'uid_2'))).unique_code).toBe('TLN-0001');
  });

  test('documento opcional: se guarda limpio, con sus últimos 4', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'Yuleidy', doc_type: 'CC', doc_number: '1.032.456.789' }));
    expect(d).toMatchObject({ doc_type: 'CC', doc_number: '1032456789', doc_last4: '6789' });
  });

  test('documento duplicado en el mismo negocio, rechazado; en otro negocio, permitido', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    expect((await crear({ full_name: 'Uno', doc_type: 'CC', doc_number: '1032456789' })).status).toBe(201);
    const dup = await crear({ full_name: 'Otro', doc_type: 'CC', doc_number: '1.032.456.789' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'documento_duplicado' });
    expect((await crear({ full_name: 'Otro tipo', doc_type: 'CE', doc_number: '1032456789' })).status).toBe(201);
    expect((await crear({ full_name: 'Vecino', doc_type: 'CC', doc_number: '1032456789' }, 'uid_2')).status).toBe(201);
    // Muchos sin documento conviven.
    expect((await crear({ full_name: 'Sin doc 1' })).status).toBe(201);
    expect((await crear({ full_name: 'Sin doc 2' })).status).toBe(201);
  });

  test('límite de 15 deudores en prueba, también bajo altas simultáneas; los archivados cuentan', async () => {
    await sembrarNegocio('uid_1', EN_ESTADO.TRIAL());
    const respuestas = await Promise.all(Array.from({ length: 18 }, (_, i) => crear({ full_name: `Deudor ${i}` })));
    const estados = respuestas.map((r) => r.status);
    expect(estados.filter((s) => s === 201)).toHaveLength(15);
    expect(estados.filter((s) => s === 409)).toHaveLength(3);
    const rechazo = respuestas.find((r) => r.status === 409)!;
    expect(await rechazo.json()).toEqual({ error: 'limite_deudores', limite: 15 });
    const { deudores } = await json(api('/api/deudores'));
    await editar(deudores[0].id, { archivado: true });
    expect((await crear({ full_name: 'El 16' })).status).toBe(409);
  });

  test('con pase o cuenta gratis no hay límite', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2', { ...EN_ESTADO.TRIAL(), free_forever_at: Date.now() });
    for (const uid of ['uid_1', 'uid_2']) {
      const r = await Promise.all(Array.from({ length: 17 }, (_, i) => crear({ full_name: `D${i}` }, uid)));
      expect(r.every((x) => x.status === 201)).toBe(true);
    }
  });

  test.each([
    ['sin nombre', {}],
    ['nombre vacío', { full_name: '   ' }],
    ['documento sin tipo', { full_name: 'X', doc_number: '12345' }],
    ['tipo de documento desconocido', { full_name: 'X', doc_type: 'DNI', doc_number: '12345' }],
    ['documento demasiado corto', { full_name: 'X', doc_type: 'CC', doc_number: '12' }],
    ['teléfono sin formato E.164', { full_name: 'X', whatsapp_phone: '300 123 4567' }],
    ['tope negativo', { full_name: 'X', credit_limit_cop: -1 }],
    ['tope con decimales', { full_name: 'X', credit_limit_cop: 1000.5 }],
    ['tope absurdo', { full_name: 'X', credit_limit_cop: 100_000_001 }],
    ['cuerpo que no es JSON', 'hola'],
  ])('entrada inválida: %s → 400 y no crea nada', async (_caso, datos) => {
    await sembrarNegocio();
    const res = await crear(datos);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'datos_invalidos' });
    expect((await json(api('/api/deudores'))).deudores).toEqual([]);
  });

  test('lo que el navegador no puede fijar se ignora: negocio, código, saldo', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    const d = await json(crear({ full_name: 'X', business_id: 'bus_uid_2', unique_code: 'TLN-9999', current_balance_cop: 500_000, id: 'deb_x' }));
    expect(d).toMatchObject({ unique_code: 'TLN-0001', current_balance_cop: 0 });
    expect(d.id).not.toBe('deb_x');
    expect((await json(api('/api/deudores', { uid: 'uid_2' }))).deudores).toEqual([]);
  });
});

describe('editar, archivar y lista negra', () => {
  test('edita datos, consentimiento y tope', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'Wilmar' }));
    const res = await editar(d.id, { alias_reference: 'el mono de la moto', whatsapp_phone: '+573001234567', wa_consentimiento: true, credit_limit_cop: 50_000 });
    expect(res.status).toBe(200);
    const e = await res.json<any>();
    expect(e).toMatchObject({ full_name: 'Wilmar', alias_reference: 'el mono de la moto', whatsapp_phone: '+573001234567', credit_limit_cop: 50_000, tiene_whatsapp: true });
    expect(e.wa_consent_at).toBeTypeOf('number');
    expect((await json(editar(d.id, { wa_consentimiento: false }))).wa_consent_at).toBeNull();
  });

  test('la baja se registra y la tienda no puede deshacerla', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'X' }));
    expect((await json(editar(d.id, { wa_baja: true }))).wa_opt_out_at).toBeTypeOf('number');
    expect((await editar(d.id, { wa_baja: false })).status).toBe(400);
  });

  test('lista negra: marca privada que cambia el estado y se puede quitar', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'Édinson' }));
    expect(await json(editar(d.id, { lista_negra: true }))).toMatchObject({ estado: 'LISTA_NEGRA' });
    expect(await json(editar(d.id, { lista_negra: false }))).toMatchObject({ estado: 'AL_DIA', blacklisted_at: null });
  });

  test('archivar lo saca de la lista sin borrarlo; se puede recuperar', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'Rubiela' }));
    await editar(d.id, { archivado: true });
    expect((await json(api('/api/deudores'))).deudores).toEqual([]);
    expect((await json(api('/api/deudores?archivados=1'))).deudores).toHaveLength(1);
    expect((await api(`/api/deudores/${d.id}`)).status).toBe(200);
    await editar(d.id, { archivado: false });
    expect((await json(api('/api/deudores'))).deudores).toHaveLength(1);
  });

  test('no existe borrar', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'X' }));
    expect((await api(`/api/deudores/${d.id}`, {}, { method: 'DELETE' })).status).toBe(404);
    expect((await api(`/api/deudores/${d.id}`)).status).toBe(200);
  });

  test('cambiar el documento a uno que ya existe, rechazado; quitarlo limpia tipo y últimos 4', async () => {
    await sembrarNegocio();
    await crear({ full_name: 'Uno', doc_type: 'CC', doc_number: '11112222' });
    const dos = await json(crear({ full_name: 'Dos', doc_type: 'CC', doc_number: '33334444' }));
    expect((await editar(dos.id, { doc_number: '11112222' })).status).toBe(409);
    expect(await json(editar(dos.id, { doc_number: null }))).toMatchObject({ doc_number: null, doc_type: null, doc_last4: null });
    expect((await editar(dos.id, { doc_number: '55556666' })).status).toBe(400); // ya no tiene tipo
  });

  test('ni el saldo ni el código se pueden editar por aquí', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'X' }));
    expect((await editar(d.id, { current_balance_cop: 99, unique_code: 'TLN-7777', oldest_unpaid_date: 1 })).status).toBe(400);
    // Mezclados con un campo válido, se ignoran.
    expect(await json(editar(d.id, { full_name: 'Y', current_balance_cop: 99, unique_code: 'TLN-7777' }))).toMatchObject({ full_name: 'Y', current_balance_cop: 0, unique_code: 'TLN-0001' });
    expect(await json(api(`/api/deudores/${d.id}`))).toMatchObject({ current_balance_cop: 0, unique_code: 'TLN-0001', oldest_unpaid_date: null });
  });
});

describe('lista para la copia local', () => {
  test('no lleva el documento completo ni el teléfono', async () => {
    await sembrarNegocio();
    await crear({ full_name: 'Carlos', doc_type: 'CC', doc_number: '1032456789', whatsapp_phone: '+573001234567' });
    const { deudores } = await json(api('/api/deudores'));
    expect(deudores[0]).toMatchObject({ full_name: 'Carlos', doc_last4: '6789', tiene_whatsapp: true });
    expect(JSON.stringify(deudores)).not.toMatch(/1032456789|3001234567/);
  });
});

describe('aislamiento y permisos', () => {
  test('un negocio no ve, ni edita, ni lista los deudores de otro', async () => {
    await sembrarNegocio('uid_1');
    await sembrarNegocio('uid_2');
    const d = await json(crear({ full_name: 'De la tienda 1' }, 'uid_1'));
    expect((await api(`/api/deudores/${d.id}`, { uid: 'uid_2' })).status).toBe(404);
    expect((await editar(d.id, { full_name: 'Robado', lista_negra: true }, 'uid_2')).status).toBe(404);
    expect((await json(api('/api/deudores', { uid: 'uid_2' }))).deudores).toEqual([]);
    expect(await json(api(`/api/deudores/${d.id}`, { uid: 'uid_1' }))).toMatchObject({ full_name: 'De la tienda 1', blacklisted_at: null });
  });

  test('vencido: ve su cartera pero no crea ni edita', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'X' }));
    await sembrarNegocio('uid_2', EN_ESTADO.EXPIRED_READONLY());
    expect((await api('/api/deudores', { uid: 'uid_2' })).status).toBe(200);
    expect((await crear({ full_name: 'Y' }, 'uid_2')).status).toBe(403);
    expect((await editar(d.id, { full_name: 'Z' }, 'uid_2')).status).toBe(403);
  });
});

describe('revisión independiente del lote de dinero', () => {
  test('cambiar el teléfono retira el consentimiento (B6: jamás a terceros), salvo que se dé otra vez en el mismo cambio', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'Wilmar', whatsapp_phone: '+573001234567', wa_consentimiento: true }));
    expect(d.wa_consent_at).toBeTypeOf('number');
    expect((await json(editar(d.id, { alias_reference: 'el mono', whatsapp_phone: '+573001234567' }))).wa_consent_at).toBe(d.wa_consent_at); // mismo número: se conserva
    expect((await json(editar(d.id, { whatsapp_phone: '+573009998877' }))).wa_consent_at).toBeNull();
    expect((await json(editar(d.id, { whatsapp_phone: '+573005556677', wa_consentimiento: true }))).wa_consent_at).toBeTypeOf('number');
    expect((await json(editar(d.id, { whatsapp_phone: null }))).wa_consent_at).toBeNull();
  });

  test('tipo de documento sin número → 400 con el campo, no 500', async () => {
    await sembrarNegocio();
    const d = await json(crear({ full_name: 'Sin documento' }));
    const res = await editar(d.id, { doc_type: 'CC' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'datos_invalidos', campos: ['doc_number'] });
  });
});
