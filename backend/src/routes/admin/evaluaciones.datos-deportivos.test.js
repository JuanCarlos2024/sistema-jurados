// "Casos por WhatsApp" en PATCH /admin/evaluaciones/:id/datos-deportivos (sin BD real: supabase en memoria).
const mockStore = {};
const mockMutaciones = [];
jest.mock('../../config/supabase', () => {
    function from(tabla) {
        const q = { tabla, op: 'select', filtros: {}, payload: null };
        const ejecutar = (unico) => {
            const filas = mockStore[tabla] || [];
            const coinciden = filas.filter(f => Object.entries(q.filtros).every(([k, v]) => f[k] === v));
            if (q.op === 'update') {
                mockMutaciones.push({ tabla, op: 'update', payload: q.payload, filtros: { ...q.filtros } });
                coinciden.forEach(f => Object.assign(f, q.payload));
                return { data: unico ? (coinciden[0] || null) : coinciden, error: null };
            }
            return { data: unico ? (coinciden[0] || null) : coinciden, error: null };
        };
        const api = {
            select() { return api; },
            update(p) { q.op = 'update'; q.payload = p; return api; },
            insert(p) { mockMutaciones.push({ tabla, op: 'insert', payload: p }); return api; },
            eq(k, v) { q.filtros[k] = v; return api; },
            in() { return api; }, order() { return api; }, limit() { return api; },
            single() { return Promise.resolve(ejecutar(true)); },
            maybeSingle() { return Promise.resolve(ejecutar(true)); },
            then(ok, ko) { return Promise.resolve(ejecutar(false)).then(ok, ko); }
        };
        return api;
    }
    return { from, rpc: jest.fn() };
});

const fs = require('fs');
const path = require('path');
const router = require('./evaluaciones');

function llamar(metodo, url, rol, body = {}) {
    return new Promise((resolve) => {
        const req = { method: metodo, url, originalUrl: url, query: {}, params: {}, headers: {}, body, ip: '127.0.0.1', usuario: { id: 'u1', nombre: 'Usuario', rol_evaluacion: rol }, get() { return undefined; } };
        const res = { statusCode: 200, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; resolve(this); return this; } };
        router(req, res, (err) => { res.statusCode = err ? 500 : 404; res.body = err ? { error: err.message } : {}; resolve(res); });
    });
}
const patch = (body, rol = 'analista', id = 'E1') => llamar('PATCH', `/${id}/datos-deportivos`, rol, body);
const evaluacion = (id) => mockStore.evaluaciones.find(e => e.id === id);

beforeEach(() => {
    mockMutaciones.length = 0;
    mockStore.evaluaciones = [
        // análisis actual (ya con la columna nueva)
        { id: 'E1', rodeo_id: 'R1', estado: 'en_proceso', nota_final: 5.5, puntaje_final: 40, puntaje_analista_1er: '30', observacion_general: 'inicial', resultados_alterados: false, comentario_resultados_alterados: null, casos_whatsapp: 2 },
        // registro histórico anterior a la funcionalidad: NO tiene la propiedad
        { id: 'E-OLD', rodeo_id: 'R2', estado: 'aprobado', nota_final: 6.1, puntaje_final: 45, puntaje_analista_1er: null, observacion_general: null, resultados_alterados: true, comentario_resultados_alterados: 'x' }
    ];
    mockStore.notas_rodeo = [{ id: 'N1', asignacion_id: 'A1', nota: 6.0 }];
    mockStore.rodeo_notas_secundarias = [{ id: 1, rodeo_id: 'R1', nota_comision: 6.5, nota_delegado: 6.0 }];
    mockStore.asignaciones = []; mockStore.datos_monitor_rodeo = [];
});

describe('validación del valor', () => {
    test.each([[0], [1], [7], [10], [150]])('valor %s se guarda', async (n) => {
        const r = await patch({ casos_whatsapp: n });
        expect(r.statusCode).toBe(200);
        expect(evaluacion('E1').casos_whatsapp).toBe(n);
    });

    test.each([[-1], [1.5], ['tres'], [NaN], [Infinity], ['1e3'], [true], [{}], [2147483648]])('valor inválido %p → 400 y no se guarda nada', async (v) => {
        const r = await patch({ casos_whatsapp: v, observacion_general: 'no debe guardarse' });
        expect(r.statusCode).toBe(400);
        expect(r.body.error).toMatch(/entero mayor o igual a 0/);
        expect(mockMutaciones).toEqual([]);                       // ni siquiera se intenta el UPDATE
        expect(evaluacion('E1').casos_whatsapp).toBe(2);          // valor anterior intacto
        expect(evaluacion('E1').observacion_general).toBe('inicial');
    });

    test('texto de solo dígitos se acepta y se guarda como entero', async () => {
        expect((await patch({ casos_whatsapp: '4' })).statusCode).toBe(200);
        expect(evaluacion('E1').casos_whatsapp).toBe(4);
    });

    test('NULL o vacío = 0; undefined = no toca el valor guardado', async () => {
        await patch({ casos_whatsapp: null });
        expect(evaluacion('E1').casos_whatsapp).toBe(0);
        evaluacion('E1').casos_whatsapp = 5;
        await patch({ observacion_general: 'solo observación' });   // sin casos_whatsapp
        expect(evaluacion('E1').casos_whatsapp).toBe(5);
        expect(mockMutaciones.at(-1).payload).not.toHaveProperty('casos_whatsapp');
        await patch({ casos_whatsapp: '' });
        expect(evaluacion('E1').casos_whatsapp).toBe(0);
    });
});

describe('persistencia, edición y recuperación', () => {
    test('guardar 4 → volver a consultar el análisis devuelve 4; luego modificar a 9 devuelve 9', async () => {
        expect((await patch({ casos_whatsapp: 4 })).statusCode).toBe(200);
        const lectura = await llamar('GET', '/E1', 'analista');
        expect(lectura.statusCode).toBe(200);
        expect(lectura.body.casos_whatsapp).toBe(4);
        await patch({ casos_whatsapp: 9 });
        expect((await llamar('GET', '/E1', 'analista')).body.casos_whatsapp).toBe(9);
    });

    test('los demás campos del análisis se siguen guardando normalmente junto con el nuevo', async () => {
        const r = await patch({ puntaje_analista_1er: ' 36 ', puntaje_analista_2do: '30 + 5', observacion_general: 'obs nueva', resultados_alterados: true, comentario_resultados_alterados: 'indicios', casos_whatsapp: 3 });
        expect(r.statusCode).toBe(200);
        expect(evaluacion('E1')).toMatchObject({ puntaje_analista_1er: '36', puntaje_analista_2do: '30+5', observacion_general: 'obs nueva', resultados_alterados: true, comentario_resultados_alterados: 'indicios', casos_whatsapp: 3 });
    });

    test('las reglas existentes siguen igual (alteración exige comentario; puntaje inválido se rechaza)', async () => {
        expect((await patch({ resultados_alterados: true, casos_whatsapp: 1 })).statusCode).toBe(400);
        expect((await patch({ puntaje_analista_1er: 'abc', casos_whatsapp: 1 })).statusCode).toBe(400);
        expect(mockMutaciones).toEqual([]);
    });

    test('registro histórico anterior a la funcionalidad (sin la propiedad): se consulta y se edita sin fallar', async () => {
        const lectura = await llamar('GET', '/E-OLD', 'analista');
        expect(lectura.statusCode).toBe(200);
        expect(lectura.body.casos_whatsapp).toBeUndefined();     // la pantalla lo interpreta como 0 (ver casosWhatsapp.test.js)
        expect((await patch({ observacion_general: 'edición sin tocar el dato nuevo' }, 'analista', 'E-OLD')).statusCode).toBe(200);
        expect((await patch({ casos_whatsapp: 0 }, 'analista', 'E-OLD')).statusCode).toBe(200);
        expect(evaluacion('E-OLD').casos_whatsapp).toBe(0);
    });
});

describe('alcance: no toca notas, evaluación ni cálculos', () => {
    test('solo se actualiza la tabla evaluaciones, con columnas del análisis (no notas, no nota_final, no estado)', async () => {
        await patch({ puntaje_analista_1er: '36', observacion_general: 'o', resultados_alterados: false, casos_whatsapp: 6 });
        expect(mockMutaciones.length).toBe(1);
        expect(mockMutaciones[0].tabla).toBe('evaluaciones');
        expect(mockMutaciones.filter(m => m.tabla !== 'evaluaciones')).toEqual([]);
        const permitidas = ['updated_at', 'puntaje_analista_1er', 'puntaje_analista_2do', 'puntaje_analista_3er', 'observacion_general', 'resultados_alterados', 'comentario_resultados_alterados', 'casos_whatsapp'];
        expect(Object.keys(mockMutaciones[0].payload).every(k => permitidas.includes(k))).toBe(true);
        for (const prohibida of ['nota_final', 'puntaje_final', 'puntaje_base', 'estado', 'nota_publicada', 'decision_jefe']) expect(mockMutaciones[0].payload).not.toHaveProperty(prohibida);
    });

    test('notas_rodeo (nota del jurado) y rodeo_notas_secundarias (Comisión / Delegado) quedan idénticas', async () => {
        const antesNotas = JSON.stringify(mockStore.notas_rodeo), antesSec = JSON.stringify(mockStore.rodeo_notas_secundarias);
        await patch({ casos_whatsapp: 8 });
        expect(JSON.stringify(mockStore.notas_rodeo)).toBe(antesNotas);
        expect(JSON.stringify(mockStore.rodeo_notas_secundarias)).toBe(antesSec);
        expect(evaluacion('E1')).toMatchObject({ nota_final: 5.5, puntaje_final: 40, estado: 'en_proceso' });   // cálculos y estado sin cambios
    });

    test('la cantidad no se usa para calcular nada: el código de cálculo/publicación no la referencia', () => {
        const base = path.join(__dirname, '..', '..');
        for (const f of ['services/calculo.js', 'services/publicacion.js', 'services/motorPropuestaDesignacion.js', 'services/matrizParticipacion.js']) {
            expect(fs.readFileSync(path.join(base, f), 'utf8')).not.toMatch(/casos_whatsapp/);
        }
    });
});

describe('permisos (los mismos que ya tenía el análisis deportivo)', () => {
    test.each([[null], ['analista'], ['jefe_area']])('rol %s puede guardar', async (rol) => {
        expect((await patch({ casos_whatsapp: 1 }, rol)).statusCode).toBe(200);
    });

    test('monitor recibe 403 y no se guarda nada (regla existente)', async () => {
        const r = await patch({ casos_whatsapp: 5 }, 'monitor');
        expect(r.statusCode).toBe(403);
        expect(mockMutaciones).toEqual([]);
        expect(evaluacion('E1').casos_whatsapp).toBe(2);
    });

    test('director (solo lectura) y capacitador siguen bloqueados por el middleware global de /admin (sin cambios)', () => {
        const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        expect(index).toMatch(/rol_evaluacion === 'director' && req\.method !== 'GET'/);
        expect(index).toMatch(/rol_evaluacion === 'capacitador' && !req\.path\.startsWith\('\/capacitaciones'\)/);
    });

    test('el endpoint no agregó middlewares de rol nuevos (misma firma que antes)', () => {
        const fuente = fs.readFileSync(path.join(__dirname, 'evaluaciones.js'), 'utf8').replace(/\r\n/g, '\n');
        expect(fuente).toMatch(/router\.patch\('\/:id\/datos-deportivos', async \(req, res\) => \{/);
    });
});
