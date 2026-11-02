// Mejora del Portal del Jurado — "Fundamento visible para el jurado" (migración 090).
// PATCH /admin/evaluaciones/:id/datos-deportivos: fundamento_jurado y
// fundamento_jurado_publicado son independientes de comentario_resultados_alterados
// (análisis interno del analista, nunca expuesto al jurado — ver esa migración).
let mockDb;
jest.mock('../../config/supabase', () => new Proxy({}, { get: (_, k) => mockDb[k] }));

const { crearSupabaseMemoria, llamarRouter } = require('../../services/__fixtures__/supabaseMemoria');
const router = require('./evaluaciones');

function preparar(evaluaciones, notas_rodeo = []) {
    mockDb = crearSupabaseMemoria({ tablas: { evaluaciones, notas_rodeo } });
}

function patch(body, id = 'E1', rol = 'analista') {
    return llamarRouter(router, {
        metodo: 'PATCH', url: `/${id}/datos-deportivos`, params: { id },
        body, usuario: { id: 'u1', nombre: 'Analista Uno', rol_evaluacion: rol }
    });
}

function fila(id = 'E1') { return mockDb.tablas.evaluaciones.find(e => e.id === id); }

test('guardar fundamento_jurado sin publicar: se guarda el texto, publicado sigue false', async () => {
    preparar([{ id: 'E1', resultados_alterados: true, comentario_resultados_alterados: 'análisis interno', fundamento_jurado: null, fundamento_jurado_publicado: false }]);
    const r = await patch({ fundamento_jurado: 'Texto para el jurado' });
    expect(r.statusCode).toBe(200);
    expect(fila().fundamento_jurado).toBe('Texto para el jurado');
    expect(fila().fundamento_jurado_publicado).toBe(false);
});

test('publicar en el mismo PATCH que fija resultados_alterados=true y el fundamento: 200, queda publicado', async () => {
    preparar([{ id: 'E1', resultados_alterados: false, fundamento_jurado: null, fundamento_jurado_publicado: false }]);
    const r = await patch({
        resultados_alterados: true, comentario_resultados_alterados: 'análisis interno',
        fundamento_jurado: 'Se confirmó el error de conteo', fundamento_jurado_publicado: true
    });
    expect(r.statusCode).toBe(200);
    expect(fila().fundamento_jurado_publicado).toBe(true);
    expect(fila().fundamento_jurado).toBe('Se confirmó el error de conteo');
});

test('no se puede publicar si resultados_alterados queda en false: 400, no se escribe nada', async () => {
    preparar([{ id: 'E1', resultados_alterados: false, fundamento_jurado: 'algo', fundamento_jurado_publicado: false }]);
    const r = await patch({ resultados_alterados: false, fundamento_jurado_publicado: true });
    expect(r.statusCode).toBe(400);
    expect(fila().fundamento_jurado_publicado).toBe(false);
});

test('no se puede publicar un fundamento vacío aunque resultados_alterados ya sea true', async () => {
    preparar([{ id: 'E1', resultados_alterados: true, comentario_resultados_alterados: 'x', fundamento_jurado: null, fundamento_jurado_publicado: false }]);
    const r = await patch({ fundamento_jurado_publicado: true });
    expect(r.statusCode).toBe(400);
    expect(fila().fundamento_jurado_publicado).toBe(false);
});

test('publicar reutilizando el fundamento ya guardado antes (no se reenvía en este PATCH): 200', async () => {
    preparar([{ id: 'E1', resultados_alterados: true, comentario_resultados_alterados: 'x', fundamento_jurado: 'Ya redactado antes', fundamento_jurado_publicado: false }]);
    const r = await patch({ fundamento_jurado_publicado: true });
    expect(r.statusCode).toBe(200);
    expect(fila().fundamento_jurado_publicado).toBe(true);
    expect(fila().fundamento_jurado).toBe('Ya redactado antes');
});

test('nunca modifica comentario_resultados_alterados (independiente, análisis interno intacto)', async () => {
    preparar([{ id: 'E1', resultados_alterados: true, comentario_resultados_alterados: 'análisis interno original', fundamento_jurado: null, fundamento_jurado_publicado: false }]);
    await patch({ fundamento_jurado: 'Fundamento para el jurado', fundamento_jurado_publicado: true });
    expect(fila().comentario_resultados_alterados).toBe('análisis interno original');
});

test('registro histórico sin las columnas nuevas (anterior a la migración 090): se puede editar sin fallar', async () => {
    preparar([{ id: 'E1', resultados_alterados: true, comentario_resultados_alterados: 'x' }]);
    const r = await patch({ fundamento_jurado: 'Nuevo fundamento', fundamento_jurado_publicado: true });
    expect(r.statusCode).toBe(200);
    expect(fila().fundamento_jurado_publicado).toBe(true);
});

describe('editable incluso en evaluaciones ya publicadas o cerradas, sin alterar notas ni resultados', () => {
    test('evaluación "publicado": se puede redactar y publicar el fundamento, sin tocar nota_final/puntaje_final/estado', async () => {
        preparar(
            [{ id: 'E1', estado: 'publicado', nota_final: 6.2, puntaje_final: 40, resultados_alterados: true,
               comentario_resultados_alterados: 'análisis interno', fundamento_jurado: null, fundamento_jurado_publicado: false, asignacion_id_ref: 'A1' }],
            [{ asignacion_id: 'A1', nota: 6.2, fuente: 'evaluacion_tecnica' }]
        );
        const r = await patch({ fundamento_jurado: 'Se confirmó el error de conteo tras revisar el video', fundamento_jurado_publicado: true });
        expect(r.statusCode).toBe(200);
        expect(fila().fundamento_jurado_publicado).toBe(true);
        // nada de lo propio de la evaluación/nota cambió
        expect(fila().estado).toBe('publicado');
        expect(fila().nota_final).toBe(6.2);
        expect(fila().puntaje_final).toBe(40);
        expect(mockDb.tablas.notas_rodeo).toEqual([{ asignacion_id: 'A1', nota: 6.2, fuente: 'evaluacion_tecnica' }]);
    });

    test('evaluación "cerrado" (ciclo de apelación ya terminado): mismo comportamiento, editable sin fallar', async () => {
        preparar([{ id: 'E1', estado: 'cerrado', nota_final: 5.5, resultados_alterados: true, comentario_resultados_alterados: 'x', fundamento_jurado: null, fundamento_jurado_publicado: false }]);
        const r = await patch({ fundamento_jurado: 'Fundamento redactado después del cierre', fundamento_jurado_publicado: true });
        expect(r.statusCode).toBe(200);
        expect(fila().estado).toBe('cerrado');
        expect(fila().nota_final).toBe(5.5);
        expect(fila().fundamento_jurado_publicado).toBe(true);
    });

    test('se puede despublicar (fundamento_jurado_publicado=false) y volver a editar el texto sin restricción', async () => {
        preparar([{ id: 'E1', estado: 'publicado', resultados_alterados: true, comentario_resultados_alterados: 'x', fundamento_jurado: 'versión 1', fundamento_jurado_publicado: true }]);
        const r = await patch({ fundamento_jurado_publicado: false });
        expect(r.statusCode).toBe(200);
        expect(fila().fundamento_jurado_publicado).toBe(false);
        expect(fila().fundamento_jurado).toBe('versión 1'); // el texto no se borra al despublicar
    });

    test('rol jefe_area (Jefe Deportivo) también puede redactar y publicar, mismos permisos que el resto del análisis', async () => {
        preparar([{ id: 'E1', estado: 'publicado', resultados_alterados: true, comentario_resultados_alterados: 'x', fundamento_jurado: null, fundamento_jurado_publicado: false }]);
        const r = await patch({ fundamento_jurado: 'Texto del jefe deportivo', fundamento_jurado_publicado: true }, 'E1', 'jefe_area');
        expect(r.statusCode).toBe(200);
        expect(fila().fundamento_jurado_publicado).toBe(true);
    });
});

test('monitor sigue bloqueado (403), sin tocar fundamento_jurado', async () => {
    preparar([{ id: 'E1', resultados_alterados: true, comentario_resultados_alterados: 'x', fundamento_jurado: null, fundamento_jurado_publicado: false }]);
    const r = await patch({ fundamento_jurado: 'intento', fundamento_jurado_publicado: true }, 'E1', 'monitor');
    expect(r.statusCode).toBe(403);
    expect(fila().fundamento_jurado_publicado).toBe(false);
});
