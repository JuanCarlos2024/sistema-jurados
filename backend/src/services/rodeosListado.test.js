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
    textoEstadoDesignacion
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
