// ═════════════════════════════════════════════════════════════════════════
// Tests de rodeosListado.js — regresión del bug "Exportar no respeta los
// filtros" (Administrador > Rodeos). Cubre exactamente lo pedido:
// fecha_desde/fecha_hasta se aplican (juntas y solas), extremos inclusivos,
// otros filtros se respetan, sin filtros sigue funcionando, jurado se
// exporta, ausencia de jurado no rompe, estado de designación se obtiene
// correctamente — todo sobre la MISMA función que usan listado y
// exportación (construirQueryRodeosFiltrada / cargarStatsAsignacionesPorRodeo),
// nunca una reimplementación paralela en el test.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const {
    construirQueryRodeosFiltrada,
    cargarStatsAsignacionesPorRodeo,
    textoEstadoDesignacion,
    cargarIndicadoresAdjuntosPorRodeo,
    cargarNotasPorRodeo
} = require('./rodeosListado');

// ─── Mock chainable/registrador — cada .from(tabla) abre una cadena nueva,
// registra CADA método encadenado con sus argumentos (para poder afirmar
// "se llamó a .gte('fecha', X)"), y es "thenable" (await la resuelve con la
// respuesta configurada para esa tabla). ───────────────────────────────────
let llamadas;     // { tabla: [ {method,args}[], ... ] } — un array de registro por cada .from(tabla) distinto
let respuestas;   // { tabla: {data,error,count} } — respuesta fija para esa tabla (todas sus llamadas)

function crearChain(tabla) {
    const registro = [];
    llamadas[tabla] = llamadas[tabla] || [];
    llamadas[tabla].push(registro);
    const metodos = ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order', 'range', 'single', 'maybeSingle'];
    const chain = {};
    metodos.forEach(m => {
        chain[m] = (...args) => { registro.push({ method: m, args }); return chain; };
    });
    chain.then = (resolve, reject) => {
        const resp = respuestas[tabla] || { data: [], error: null, count: 0 };
        return Promise.resolve(resp).then(resolve, reject);
    };
    return chain;
}

beforeEach(() => {
    llamadas = {};
    respuestas = { rodeos: { data: [], error: null, count: 0 } };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
});

function llamadasRodeos() {
    // construirQueryRodeosFiltrada hace EXACTAMENTE un .from('rodeos') por
    // llamada — tomamos ese único registro.
    return (llamadas.rodeos && llamadas.rodeos[0]) || [];
}
function fueLlamado(registro, metodo, ...args) {
    return registro.some(c => c.method === metodo && JSON.stringify(c.args) === JSON.stringify(args));
}

describe('construirQueryRodeosFiltrada — fechas (CASO A del pedido)', () => {
    test('fecha_desde se aplica como gte inclusivo', async () => {
        await construirQueryRodeosFiltrada({ fecha_desde: '2026-09-17' }, 'id');
        expect(fueLlamado(llamadasRodeos(), 'gte', 'fecha', '2026-09-17')).toBe(true);
    });
    test('fecha_hasta se aplica como lte inclusivo', async () => {
        await construirQueryRodeosFiltrada({ fecha_hasta: '2026-09-20' }, 'id');
        expect(fueLlamado(llamadasRodeos(), 'lte', 'fecha', '2026-09-20')).toBe(true);
    });
    test('fecha_desde y fecha_hasta juntas — ambos límites presentes, ninguno sustituido por año/mes', async () => {
        await construirQueryRodeosFiltrada({ fecha_desde: '2026-09-17', fecha_hasta: '2026-09-20', año: '2026', mes: '05' }, 'id');
        const reg = llamadasRodeos();
        expect(fueLlamado(reg, 'gte', 'fecha', '2026-09-17')).toBe(true);
        expect(fueLlamado(reg, 'lte', 'fecha', '2026-09-20')).toBe(true);
        // año/mes NUNCA debe pisar el rango explícito (evita el bug reportado:
        // "el Excel incluye rodeos de mayo aunque filtro solo septiembre").
        expect(fueLlamado(reg, 'gte', 'fecha', '2026-05-01')).toBe(false);
    });
    test('sin fecha_desde/hasta, cae a año+mes (comportamiento previo preservado)', async () => {
        await construirQueryRodeosFiltrada({ año: '2026', mes: '9' }, 'id');
        const reg = llamadasRodeos();
        expect(fueLlamado(reg, 'gte', 'fecha', '2026-09-01')).toBe(true);
        expect(fueLlamado(reg, 'lte', 'fecha', '2026-09-30')).toBe(true);
    });
    test('sin ningún filtro de fecha, no se agrega ningún gte/lte sobre fecha', async () => {
        await construirQueryRodeosFiltrada({}, 'id');
        const reg = llamadasRodeos();
        expect(reg.some(c => c.method === 'gte' && c.args[0] === 'fecha')).toBe(false);
        expect(reg.some(c => c.method === 'lte' && c.args[0] === 'fecha')).toBe(false);
    });
});

describe('construirQueryRodeosFiltrada — otros filtros simples (CASO C del pedido)', () => {
    test('asociacion se aplica con ilike', async () => {
        await construirQueryRodeosFiltrada({ asociacion: 'AYSÉN' }, 'id');
        expect(fueLlamado(llamadasRodeos(), 'ilike', 'asociacion', '%AYSÉN%')).toBe(true);
    });
    test('tipo_rodeo_id se aplica con eq', async () => {
        await construirQueryRodeosFiltrada({ tipo_rodeo_id: 'tipo-123' }, 'id');
        expect(fueLlamado(llamadasRodeos(), 'eq', 'tipo_rodeo_id', 'tipo-123')).toBe(true);
    });
    test('origen se aplica con eq', async () => {
        await construirQueryRodeosFiltrada({ origen: 'importado' }, 'id');
        expect(fueLlamado(llamadasRodeos(), 'eq', 'origen', 'importado')).toBe(true);
    });
    test('club + fecha combinados — ambos presentes simultáneamente (combinación de filtros)', async () => {
        await construirQueryRodeosFiltrada({ club: 'LA CELIA', fecha_desde: '2026-09-17', fecha_hasta: '2026-09-20' }, 'id');
        const reg = llamadasRodeos();
        expect(fueLlamado(reg, 'ilike', 'club', '%LA CELIA%')).toBe(true);
        expect(fueLlamado(reg, 'gte', 'fecha', '2026-09-17')).toBe(true);
        expect(fueLlamado(reg, 'lte', 'fecha', '2026-09-20')).toBe(true);
    });
});

describe('construirQueryRodeosFiltrada — sin filtros (CASO B del pedido)', () => {
    test('sin ningún filtro, sigue funcionando: filtra solo por estado=activo por defecto', async () => {
        const { vacioPorFiltro, query } = await construirQueryRodeosFiltrada({}, 'id');
        expect(vacioPorFiltro).toBe(false);
        expect(query).toBeTruthy();
        expect(fueLlamado(llamadasRodeos(), 'eq', 'estado', 'activo')).toBe(true);
    });
});

describe('construirQueryRodeosFiltrada — filtro por jurado (CASO D del pedido)', () => {
    test('jurado_id resuelve primero los rodeo_id vía asignaciones, y filtra rodeos con .in', async () => {
        respuestas.asignaciones = { data: [{ rodeo_id: 'r1' }, { rodeo_id: 'r2' }], error: null };
        await construirQueryRodeosFiltrada({ jurado_id: 'jurado-1' }, 'id');
        const reg = llamadasRodeos();
        expect(reg.some(c => c.method === 'in' && c.args[0] === 'id' &&
            [...c.args[1]].sort().join(',') === 'r1,r2')).toBe(true);
    });
    test('jurado_id sin ningún rodeo asociado -> vacioPorFiltro=true, NUNCA se consulta rodeos', async () => {
        respuestas.asignaciones = { data: [], error: null };
        const r = await construirQueryRodeosFiltrada({ jurado_id: 'jurado-sin-rodeos' }, 'id');
        expect(r.vacioPorFiltro).toBe(true);
        expect(r.query).toBeNull();
        expect(llamadas.rodeos).toBeUndefined();
    });
});

describe('textoEstadoDesignacion — fuente de "Estado designación" (CASO E del pedido)', () => {
    test('no publicado -> "No publicado", sin importar estado_designacion', () => {
        expect(textoEstadoDesignacion(false, 'aceptado')).toBe('No publicado');
        expect(textoEstadoDesignacion(false, null)).toBe('No publicado');
        expect(textoEstadoDesignacion(false, 'pendiente')).toBe('No publicado');
    });
    test('publicado + rechazado -> "Rechazado"', () => {
        expect(textoEstadoDesignacion(true, 'rechazado')).toBe('Rechazado');
    });
    test('publicado + pendiente -> "Pendiente"', () => {
        expect(textoEstadoDesignacion(true, 'pendiente')).toBe('Pendiente');
    });
    test('publicado + aceptado -> "Confirmado"', () => {
        expect(textoEstadoDesignacion(true, 'aceptado')).toBe('Confirmado');
    });
    test('publicado + NULL (legacy = aceptado) -> "Confirmado"', () => {
        expect(textoEstadoDesignacion(true, null)).toBe('Confirmado');
    });
});

describe('cargarStatsAsignacionesPorRodeo — Jurado + Estado designación (CASO E/F del pedido)', () => {
    test('rodeo con jurado asignado -> nombre correcto y estado_designacion_texto correcto', async () => {
        respuestas.asignaciones = {
            data: [{
                rodeo_id: 'r1', usuario_pagado_id: 'u1', tipo_persona: 'jurado',
                pago_base_calculado: 50000, estado_designacion: 'aceptado',
                nombre_importado: null, publicado: true,
                usuarios_pagados: { nombre_completo: 'JUAN PÉREZ' }
            }],
            error: null
        };
        const sp = await cargarStatsAsignacionesPorRodeo(['r1']);
        expect(sp.r1.jurados_lista).toEqual([{ id: 'u1', nombre: 'JUAN PÉREZ', estado_designacion_texto: 'Confirmado' }]);
        expect(sp.r1.total_pago_base).toBe(50000);
    });
    test('rodeo con DOS jurados -> ambos presentes, alineados en el mismo orden (nada se pierde)', async () => {
        respuestas.asignaciones = {
            data: [
                { rodeo_id: 'r1', usuario_pagado_id: 'u1', tipo_persona: 'jurado', pago_base_calculado: 10000, estado_designacion: 'aceptado', nombre_importado: null, publicado: true, usuarios_pagados: { nombre_completo: 'JUAN PÉREZ' } },
                { rodeo_id: 'r1', usuario_pagado_id: 'u2', tipo_persona: 'jurado', pago_base_calculado: 10000, estado_designacion: 'pendiente', nombre_importado: null, publicado: true, usuarios_pagados: { nombre_completo: 'PEDRO GONZÁLEZ' } }
            ],
            error: null
        };
        const sp = await cargarStatsAsignacionesPorRodeo(['r1']);
        expect(sp.r1.jurados_lista.map(j => j.nombre)).toEqual(['JUAN PÉREZ', 'PEDRO GONZÁLEZ']);
        expect(sp.r1.jurados_lista.map(j => j.estado_designacion_texto)).toEqual(['Confirmado', 'Pendiente']);
    });
    test('rodeo SIN ninguna asignación -> jurados_lista vacía, sin lanzar excepción (no rompe el Excel)', async () => {
        respuestas.asignaciones = { data: [], error: null };
        const sp = await cargarStatsAsignacionesPorRodeo(['r1', 'r2']);
        expect(sp.r1.jurados_lista).toEqual([]);
        expect(sp.r2.jurados_lista).toEqual([]);
        expect(sp.r1.total_pago_base).toBe(0);
    });
    test('array de ids vacío -> {} sin consultar BD', async () => {
        const sp = await cargarStatsAsignacionesPorRodeo([]);
        expect(sp).toEqual({});
        expect(supabase.from).not.toHaveBeenCalled();
    });
    test('jurado importado sin usuario_pagado vinculado (nombre_importado) -> igual aparece con id null', async () => {
        respuestas.asignaciones = {
            data: [{
                rodeo_id: 'r1', usuario_pagado_id: null, tipo_persona: 'jurado',
                pago_base_calculado: 0, estado_designacion: 'pendiente',
                nombre_importado: 'MARÍA SILVA (pendiente de vincular)', publicado: false,
                usuarios_pagados: null
            }],
            error: null
        };
        const sp = await cargarStatsAsignacionesPorRodeo(['r1']);
        expect(sp.r1.jurados_lista).toEqual([
            { id: null, nombre: 'MARÍA SILVA (pendiente de vincular)', estado_designacion_texto: 'No publicado' }
        ]);
    });
});

// ─── cargarIndicadoresAdjuntosPorRodeo — MISMA fuente que GET /admin/
// adjuntos/resumen (indicador "CJ/CD/VY" de la tabla de Rodeos en pantalla),
// ahora también reutilizada por la exportación a Excel (columnas Cartilla
// Jurado/Cartilla Delegado/Video). Este bloque cubre exactamente los 3
// casos de prueba obligatorios del pedido (CJ/CD/VV en todas las
// combinaciones) más el caso legacy 'cartilla' sin sufijo.
describe('cargarIndicadoresAdjuntosPorRodeo — Cartilla Jurado / Cartilla Delegado / Video (misma fuente que la pantalla)', () => {
    test('CASO 1 — con cartilla jurado + cartilla delegado + video -> {cj:true, cd:true, vy:true}', async () => {
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado' }
        ], error: null };
        respuestas.rodeo_links = { data: [{ rodeo_id: 'r1' }], error: null };
        const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
        expect(ind.r1).toEqual({ cj: true, cd: true, vy: true });
    });
    test('CASO 2 — con cartillas pero SIN video -> {cj:true, cd:true, vy:false}', async () => {
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado' }
        ], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
        expect(ind.r1).toEqual({ cj: true, cd: true, vy: false });
    });
    test('CASO 3 — sin ningún adjunto ni link -> {cj:false, cd:false, vy:false}', async () => {
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
        expect(ind.r1).toEqual({ cj: false, cd: false, vy: false });
    });
    test('tipo_adjunto legacy "cartilla" (sin sufijo) también cuenta como Cartilla Jurado — mismo criterio que GET /admin/adjuntos/resumen', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla' }], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
        expect(ind.r1.cj).toBe(true);
    });
    test('varios rodeos a la vez, cada uno con su propio resultado independiente', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' }], error: null };
        respuestas.rodeo_links = { data: [{ rodeo_id: 'r2' }], error: null };
        const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1', 'r2', 'r3']);
        expect(ind.r1).toEqual({ cj: true, cd: false, vy: false });
        expect(ind.r2).toEqual({ cj: false, cd: false, vy: true });
        expect(ind.r3).toEqual({ cj: false, cd: false, vy: false });
    });
    test('array de ids vacío -> {} sin consultar BD', async () => {
        const ind = await cargarIndicadoresAdjuntosPorRodeo([]);
        expect(ind).toEqual({});
        expect(supabase.from).not.toHaveBeenCalled();
    });
});

// ─── cargarNotasPorRodeo — Nota Comisión (rodeo_notas_secundarias),
// Nota Delegado (rodeo_notas_secundarias) y Nota Final (evaluaciones,
// filtrada por anulada=false, MISMO filtro que usa GET /admin/rodeos/:id y
// GET /admin/evaluaciones). Devuelve el valor CRUDO (incluido null
// explícito) — la conversión a "Pendiente" es responsabilidad de quien
// consume el mapa (exportacion.js), nunca de esta función.
describe('cargarNotasPorRodeo — Nota Comisión / Nota Delegado / Nota Final (misma fuente que "Notas secundarias" y el listado de Evaluaciones)', () => {
    test('rodeo con las 3 notas -> valores numéricos exactos, tal cual están en BD', async () => {
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 7, nota_delegado: 6.5 }], error: null };
        respuestas.evaluaciones = { data: [{ rodeo_id: 'r1', nota_final: 5.5 }], error: null };
        const notas = await cargarNotasPorRodeo(['r1']);
        expect(notas.r1).toEqual({ nota_comision: 7, nota_delegado: 6.5, nota_final: 5.5 });
    });
    test('nota_delegado NULL en la fila -> se conserva null (no se convierte a 0 ni se omite)', async () => {
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 7, nota_delegado: null }], error: null };
        respuestas.evaluaciones = { data: [{ rodeo_id: 'r1', nota_final: 5.5 }], error: null };
        const notas = await cargarNotasPorRodeo(['r1']);
        expect(notas.r1.nota_delegado).toBeNull();
        expect(notas.r1.nota_delegado).not.toBe(0);
    });
    test('rodeo sin fila en rodeo_notas_secundarias -> ambas notas secundarias null (no lanza excepción)', async () => {
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        respuestas.evaluaciones = { data: [{ rodeo_id: 'r1', nota_final: 5.5 }], error: null };
        const notas = await cargarNotasPorRodeo(['r1']);
        expect(notas.r1.nota_comision).toBeNull();
        expect(notas.r1.nota_delegado).toBeNull();
    });
    test('rodeo sin evaluación asociada (0 filas en evaluaciones) -> nota_final null', async () => {
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 7, nota_delegado: 6 }], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        const notas = await cargarNotasPorRodeo(['r1']);
        expect(notas.r1.nota_final).toBeNull();
    });
    test('nota mínima real (1.0) nunca se confunde con ausencia — no cae a null/0', async () => {
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 1.0, nota_delegado: 1.0 }], error: null };
        respuestas.evaluaciones = { data: [{ rodeo_id: 'r1', nota_final: 1.0 }], error: null };
        const notas = await cargarNotasPorRodeo(['r1']);
        expect(notas.r1).toEqual({ nota_comision: 1, nota_delegado: 1, nota_final: 1 });
    });
    test('varios rodeos -> 2 consultas fijas (nunca una por rodeo / sin N+1)', async () => {
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        await cargarNotasPorRodeo(['r1', 'r2', 'r3', 'r4', 'r5']);
        const llamadas = supabase.from.mock.calls.map(c => c[0]);
        expect(llamadas.filter(t => t === 'rodeo_notas_secundarias').length).toBe(1);
        expect(llamadas.filter(t => t === 'evaluaciones').length).toBe(1);
    });
    test('array de ids vacío -> {} sin consultar BD', async () => {
        const notas = await cargarNotasPorRodeo([]);
        expect(notas).toEqual({});
        expect(supabase.from).not.toHaveBeenCalled();
    });
});
