// Cobertura mínima del middleware real usado para restringir Temporadas
// (admin/temporadas.js) y la asignación de temporada dentro de admin/rodeos.js
// a "administrador pleno" — TEST N del pedido de Gestión de Temporadas
// (usuario no administrador → 403). No reimplementa el middleware: importa
// y ejecuta la función real exportada por auth.js.
const { soloRolEvaluacion } = require('./auth');

function fakeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

describe('TEST N: soloRolEvaluacion() sin argumentos = solo administrador pleno', () => {
    test('rol_evaluacion = null (admin pleno) → permitido, llama next()', () => {
        const middleware = soloRolEvaluacion();
        const req = { usuario: { rol_evaluacion: null } };
        const res = fakeRes();
        const next = jest.fn();
        middleware(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
    });

    test.each(['monitor', 'analista', 'comision_tecnica', 'director', 'capacitador'])(
        'rol_evaluacion = %s → 403, nunca llama next()',
        (rol) => {
            const middleware = soloRolEvaluacion();
            const req = { usuario: { rol_evaluacion: rol } };
            const res = fakeRes();
            const next = jest.fn();
            middleware(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
        }
    );
});
