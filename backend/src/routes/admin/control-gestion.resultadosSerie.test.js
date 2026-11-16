// Ruta /admin/control-gestion/confirmar — validación de las decisiones de
// resultados Serie de Campeones, por HTTP real (Express + multipart real).
// El servicio se sustituye para inspeccionar exactamente qué recibe.
const express = require('express');

jest.mock('../../services/controlGestion', () => ({
    generarPreview: jest.fn(async () => ({ filas: [], resumen: {} })),
    confirmarImportacion: jest.fn(async () => ({ procesados: 0 })),
    obtenerSituacionesDeRodeo: jest.fn(async () => [])
}));
const servicio = require('../../services/controlGestion');
const router = require('./control-gestion');

let servidor, base;
beforeAll(async () => {
    const app = express();
    app.use((req, res, next) => { req.usuario = { id: 'ADMIN-1', tipo: 'administrador', rol_evaluacion: req.headers['x-rol'] || null }; next(); });
    app.use('/cg', router);
    await new Promise(r => { servidor = app.listen(0, r); });
    base = `http://127.0.0.1:${servidor.address().port}/cg`;
});
afterAll(() => new Promise(r => servidor.close(r)));
beforeEach(() => jest.clearAllMocks());

async function confirmar(decisiones, rol) {
    const fd = new FormData();
    fd.append('archivo', new Blob([Buffer.from('xlsx')]), 'cg.xlsx');
    fd.append('decisiones', JSON.stringify(decisiones));
    const res = await fetch(`${base}/confirmar`, { method: 'POST', body: fd, headers: rol ? { 'x-rol': rol } : {} });
    return { status: res.status, body: await res.json() };
}

test('cliente antiguo (sin accion_resultados) sigue funcionando igual', async () => {
    const r = await confirmar([{ fila_index: 0, accion: 'agregar' }]);
    expect(r.status).toBe(200);
    expect(servicio.confirmarImportacion).toHaveBeenCalledWith(expect.any(Buffer), [{ fila_index: 0, accion: 'agregar' }], 'cg.xlsx', 'ADMIN-1');
});

test.each(['completar', 'omitir'])('accion_resultados=%s aceptada', async (a) => {
    expect((await confirmar([{ fila_index: 0, accion: 'omitir', accion_resultados: a }])).status).toBe(200);
});

test('reemplazar con los 3 valores vistos -> aceptada y se entrega al servicio tal cual', async () => {
    const d = [{ fila_index: 2, accion: 'omitir', accion_resultados: 'reemplazar', resultados_actuales_vistos: ['27+8', null, '20'] }];
    expect((await confirmar(d)).status).toBe(200);
    expect(servicio.confirmarImportacion.mock.calls[0][1]).toEqual(d);
});

test.each([
    ['acción desconocida', { accion_resultados: 'sobrescribir' }],
    ['reemplazar sin vistos', { accion_resultados: 'reemplazar' }],
    ['reemplazar con 2 vistos', { accion_resultados: 'reemplazar', resultados_actuales_vistos: ['1', '2'] }],
    ['reemplazar con valor no texto', { accion_resultados: 'reemplazar', resultados_actuales_vistos: [27, null, null] }]
])('%s -> 400 y el servicio NO se invoca', async (_, extra) => {
    const r = await confirmar([{ fila_index: 0, accion: 'omitir', ...extra }]);
    expect(r.status).toBe(400);
    expect(servicio.confirmarImportacion).not.toHaveBeenCalled();
});

test('permisos sin cambios: un rol distinto de Monitor/Admin pleno es rechazado', async () => {
    const r = await confirmar([{ fila_index: 0, accion: 'omitir', accion_resultados: 'completar' }], 'analista');
    expect(r.status).toBe(403);
    expect(servicio.confirmarImportacion).not.toHaveBeenCalled();
});
