// Fase 3.1 (cierre): helper compartido que traduce el error del trigger de
// base de datos (migración 067) a una respuesta 409 clara. Se usa desde
// admin/asignaciones.js (PATCH /:id, POST /:id/estado) y admin/rodeos.js
// (POST /:id/publicar-designaciones) — archivos sin arnés de pruebas propio
// para sus endpoints de escritura (no se construyó uno nuevo para esto, fuera
// del alcance mínimo de este cierre); esta suite prueba el helper en sí,
// aislado, que es la lógica nueva agregada en los tres puntos de escritura.
const { responderSiConflictoDesignacionRentado, CODIGO_CONFLICTO_DESIGNACION_RENTADO } = require('./designacionRentadoConflicto');

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}

describe('responderSiConflictoDesignacionRentado', () => {
    test('error con el código del trigger -> responde 409 con el código y un mensaje claro, devuelve true', () => {
        const res = crearResFake();
        const manejado = responderSiConflictoDesignacionRentado(
            { message: 'DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL' }, res
        );
        expect(manejado).toBe(true);
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe(CODIGO_CONFLICTO_DESIGNACION_RENTADO);
        expect(res.jsonBody.error).toMatch(/cartilla institucional en curso/);
    });

    test('error distinto (sin relación) -> no responde nada, devuelve false', () => {
        const res = crearResFake();
        const manejado = responderSiConflictoDesignacionRentado({ message: 'otro error cualquiera' }, res);
        expect(manejado).toBe(false);
        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });

    test('con mensaje personalizado -> lo usa en vez del genérico, mantiene el mismo código', () => {
        const res = crearResFake();
        responderSiConflictoDesignacionRentado(
            { message: 'DESIGNACION_RENTADO_BLOQUEADA_POR_CARTILLA_INSTITUCIONAL' }, res,
            'mensaje específico de publicación masiva'
        );
        expect(res.jsonBody.error).toBe('mensaje específico de publicación masiva');
        expect(res.jsonBody.code).toBe(CODIGO_CONFLICTO_DESIGNACION_RENTADO);
    });

    test('error sin mensaje (undefined/null) -> nunca lanza, devuelve false', () => {
        const res = crearResFake();
        expect(responderSiConflictoDesignacionRentado(undefined, res)).toBe(false);
        expect(responderSiConflictoDesignacionRentado({}, res)).toBe(false);
        expect(res.status).not.toHaveBeenCalled();
    });
});
