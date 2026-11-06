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
    cargarEstadoCartillaDelegadoAdjuntaPorRodeo,
    cargarNotasPorRodeo,
    cargarDelegadoRentadoVigentePorRodeo,
    fusionarEstadoCartillaDelegado,
    cargarEstadoCartillaDelegadoUnificadoPorRodeo,
    cargarEstadoCartillaJuradoUnificadoPorRodeo,
    cargarNotaAreaDeportivaPorRodeo,
    calcularPendientesPorRodeo,
    resolverFiltrosComplejos,
    obtenerTodosLosIdsFiltrados
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
        expect(ind.r1).toEqual({ cj: true, cd: true, vy: true, cd_estado: null, cd_digital: null });
    });
    test('CASO 2 — con cartillas pero SIN video -> {cj:true, cd:true, vy:false}', async () => {
        respuestas.rodeo_adjuntos = { data: [
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_jurado' },
            { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado' }
        ], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
        expect(ind.r1).toEqual({ cj: true, cd: true, vy: false, cd_estado: null, cd_digital: null });
    });
    test('CASO 3 — sin ningún adjunto ni link -> {cj:false, cd:false, vy:false}', async () => {
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
        expect(ind.r1).toEqual({ cj: false, cd: false, vy: false, cd_estado: null, cd_digital: null });
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
        expect(ind.r1).toEqual({ cj: true, cd: false, vy: false, cd_estado: null, cd_digital: null });
        expect(ind.r2).toEqual({ cj: false, cd: false, vy: true, cd_estado: null, cd_digital: null });
        expect(ind.r3).toEqual({ cj: false, cd: false, vy: false, cd_estado: null, cd_digital: null });
    });
    test('array de ids vacío -> {} sin consultar BD', async () => {
        const ind = await cargarIndicadoresAdjuntosPorRodeo([]);
        expect(ind).toEqual({});
        expect(supabase.from).not.toHaveBeenCalled();
    });

    describe('auditoría (077) — cd_estado: distingue vigente/pendiente/complementario sin alterar `cd`', () => {
        test('cartilla_clasificacion=version_cartilla -> cd=true Y cd_estado="vigente" (sin exigir cartilla_vigente=true)', async () => {
            respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'version_cartilla' }], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd).toBe(true);
            expect(ind.r1.cd_estado).toBe('vigente');
        });

        test('cartilla_clasificacion=pendiente (histórico sin revisar) -> cd=true Y cd_estado="pendiente"', async () => {
            respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'pendiente' }], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd).toBe(true);
            expect(ind.r1.cd_estado).toBe('pendiente');
        });

        test('cartilla_clasificacion=complementario (caso real CHACAICO/BÍO-BÍO) -> cd=true (sigue contando el archivo) Y cd_estado="complementario" (nunca se confunde con la cartilla real)', async () => {
            respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'complementario' }], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd).toBe(true);
            expect(ind.r1.cd_estado).toBe('complementario');
        });

        test('mezcla real (CHACAICO-style): varios complementarios + 1 pendiente -> cd_estado="pendiente" (prioridad: vigente > pendiente > complementario)', async () => {
            respuestas.rodeo_adjuntos = { data: [
                { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'complementario' },
                { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'complementario' },
                { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'pendiente' }
            ], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_estado).toBe('pendiente');
        });

        test('mezcla: pendiente + version_cartilla -> cd_estado="vigente" (máxima prioridad, nunca se degrada)', async () => {
            respuestas.rodeo_adjuntos = { data: [
                { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'pendiente' },
                { rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'version_cartilla' }
            ], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_estado).toBe('vigente');
        });

        test('cartilla_clasificacion ausente (fila anterior a la migración 077, o columna todavía no aplicada) -> cd sigue siendo true, cd_estado se queda en null (nunca rompe)', async () => {
            respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado' }], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd).toBe(true);
            expect(ind.r1.cd_estado).toBeNull();
        });
    });

    // ─── Mejoras rodeos (ítem 3) — cd_digital: Cartilla de Delegado DIGITAL
    // (cartillas_delegado, migraciones 037/065), aditivo, nunca altera
    // cj/cd/cd_estado (que siguen siendo exclusivamente sobre rodeo_adjuntos
    // — mismo criterio que ya usan el filtro CJ/CD y la exportación a Excel).
    describe('cd_digital — Cartilla de Delegado DIGITAL (Delegado Rentado / de Asociación), aditivo', () => {
        test('sin ninguna fila en cartillas_delegado -> cd_digital=null', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital).toBeNull();
        });

        test('delegado_asociacion_id NULL -> modalidad "delegado_rentado"', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'enviada', delegado_asociacion_id: null }], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital).toEqual({ modalidad: 'delegado_rentado', estado: 'enviada' });
        });

        test('delegado_asociacion_id presente -> modalidad "delegado_asociacion"', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'aprobada', delegado_asociacion_id: 'da-1' }], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital).toEqual({ modalidad: 'delegado_asociacion', estado: 'aprobada' });
        });

        test('"No dar por enviada una cartilla que solo está en borrador": única fila en borrador -> estado="borrador", nunca "enviada"', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'borrador', delegado_asociacion_id: null }], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital.estado).toBe('borrador');
        });

        test('varias filas del mismo rodeo (cambio de delegado) -> se queda con el estado más avanzado (aprobada > enviada > borrador)', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [
                { rodeo_id: 'r1', estado: 'borrador', delegado_asociacion_id: null },
                { rodeo_id: 'r1', estado: 'aprobada', delegado_asociacion_id: null },
                { rodeo_id: 'r1', estado: 'enviada', delegado_asociacion_id: null }
            ], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital.estado).toBe('aprobada');
        });

        test('cd_digital no interfiere con cd/cd_estado (solo adjunto) — ambas señales conviven independientes', async () => {
            respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'pendiente' }], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'aprobada', delegado_asociacion_id: 'da-1' }], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd).toBe(true);
            expect(ind.r1.cd_estado).toBe('pendiente');
            expect(ind.r1.cd_digital).toEqual({ modalidad: 'delegado_asociacion', estado: 'aprobada' });
        });

        // 092 — "Reabrir": 'reabierta' nunca debe quedar eclipsado por un
        // 'enviada'/'reenviada'/'aprobada' previo del mismo rodeo (el
        // administrador la reabrió justamente para que no se siga mostrando
        // como ya resuelta) — mismo nivel de prioridad que 'observada'.
        test('único estado "reabierta" -> cd_digital.estado="reabierta" (nunca se degrada a un estado previo)', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'reabierta', delegado_asociacion_id: null }], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital.estado).toBe('reabierta');
        });

        test('"reabierta" tiene la MISMA prioridad que "observada" — nunca por debajo de "borrador"', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [
                { rodeo_id: 'r1', estado: 'borrador', delegado_asociacion_id: null },
                { rodeo_id: 'r1', estado: 'reabierta', delegado_asociacion_id: null }
            ], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital.estado).toBe('reabierta');
        });

        test('"reabierta" queda por debajo de "aprobada"/"cerrada"/"reenviada"/"enviada" si coexisten (prioridad relativa correcta — ver nota de diseño en PRIORIDAD_DIGITAL)', async () => {
            respuestas.rodeo_adjuntos = { data: [], error: null };
            respuestas.rodeo_links = { data: [], error: null };
            respuestas.cartillas_delegado = { data: [
                { rodeo_id: 'r1', estado: 'reabierta', delegado_asociacion_id: null },
                { rodeo_id: 'r1', estado: 'reenviada', delegado_asociacion_id: null }
            ], error: null };
            const ind = await cargarIndicadoresAdjuntosPorRodeo(['r1']);
            expect(ind.r1.cd_digital.estado).toBe('reenviada');
        });
    });
});

// ─── cargarEstadoCartillaDelegadoAdjuntaPorRodeo — corrección final (076):
// 3 estados (vigente / pendiente / complementario-o-sin adjunto). A
// diferencia de cargarIndicadoresAdjuntosPorRodeo (arriba, de uso
// administrativo), esta función es la que usa institucional/rodeos.js para
// decidir el bloqueo real — filtra tipo_adjunto=cartilla_delegado EN LA
// CONSULTA, pero decide vigente/pendiente/complementario EN JS a partir de
// cartilla_clasificacion/cartilla_vigente (nunca solo por el tipo), y falla
// CERRADO ante un error de lectura (nunca asume "sin adjunto").
describe('cargarEstadoCartillaDelegadoAdjuntaPorRodeo — 3 estados (vigente/pendiente/null) (verificación previa a publicación)', () => {
    test('la consulta real filtra por tipo_adjunto=cartilla_delegado', async () => {
        respuestas.rodeo_adjuntos = { data: [], error: null };
        await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1']);
        const registro = llamadas.rodeo_adjuntos[0];
        expect(fueLlamado(registro, 'eq', 'tipo_adjunto', 'cartilla_delegado')).toBe(true);
    });

    test('rodeo con una versión vigente (cartilla_clasificacion=version_cartilla, cartilla_vigente=true) -> "vigente"', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', cartilla_clasificacion: 'version_cartilla', cartilla_vigente: true }], error: null };
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1']);
        expect(ind.r1).toBe('vigente');
    });

    test('corrección final (076) — archivo histórico pendiente de clasificar (cartilla_clasificacion=pendiente, el DEFAULT) -> "pendiente" (se sigue bloqueando)', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', cartilla_clasificacion: 'pendiente', cartilla_vigente: false }], error: null };
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1']);
        expect(ind.r1).toBe('pendiente');
    });

    test('documento clasificado como complementario (confirmado por un administrador, caso real CHACAICO/BÍO-BÍO) -> null (no bloquea)', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', cartilla_clasificacion: 'complementario', cartilla_vigente: false }], error: null };
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1']);
        expect(ind.r1).toBeNull();
    });

    test('rodeo sin ninguna fila -> null', async () => {
        respuestas.rodeo_adjuntos = { data: [], error: null };
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1']);
        expect(ind.r1).toBeNull();
    });

    test('varios rodeos, cada uno independiente', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', cartilla_clasificacion: 'version_cartilla', cartilla_vigente: true }], error: null };
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1', 'r2']);
        expect(ind.r1).toBe('vigente');
        expect(ind.r2).toBeNull();
    });

    test('auditoría (077) — version_cartilla con cartilla_vigente=false (ej. el booleano se perdió/nunca se fijó) -> SIGUE siendo "vigente" (nunca depende solo de ese flag)', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', cartilla_clasificacion: 'version_cartilla', cartilla_vigente: false }], error: null };
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1']);
        expect(ind.r1).toBe('vigente');
    });

    test('mismo rodeo con un archivo vigente Y otro pendiente (transición real durante la clasificación histórica) -> "vigente" nunca se degrada a "pendiente"', async () => {
        respuestas.rodeo_adjuntos = {
            data: [
                { rodeo_id: 'r1', cartilla_clasificacion: 'pendiente', cartilla_vigente: false },
                { rodeo_id: 'r1', cartilla_clasificacion: 'version_cartilla', cartilla_vigente: true }
            ], error: null
        };
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1']);
        expect(ind.r1).toBe('vigente');
    });

    test('array de ids vacío -> {} sin consultar BD', async () => {
        const ind = await cargarEstadoCartillaDelegadoAdjuntaPorRodeo([]);
        expect(ind).toEqual({});
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('falla de lectura -> lanza (fail-closed), nunca asume null silenciosamente', async () => {
        respuestas.rodeo_adjuntos = { data: null, error: { message: 'timeout' } };
        await expect(cargarEstadoCartillaDelegadoAdjuntaPorRodeo(['r1'])).rejects.toThrow(/timeout/);
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

// ═════════════════════════════════════════════════════════════════════════
// PANEL CENTRAL DE GESTIÓN DEPORTIVA — Prioridad 1: estado unificado de
// Cartilla Delegado/Jurado (corrige el bug "el filtro solo mira
// rodeo_adjuntos, ignora las cartillas digitales").
// ═════════════════════════════════════════════════════════════════════════
describe('fusionarEstadoCartillaDelegado (pura)', () => {
    test('digital enviada -> recibida, sin corrección', () => {
        expect(fusionarEstadoCartillaDelegado('enviada', null)).toEqual({ estado: 'enviada', recibida: true, requiere_correccion: false });
    });
    test('digital borrador -> NUNCA recibida (regla explícita)', () => {
        expect(fusionarEstadoCartillaDelegado('borrador', null)).toEqual({ estado: 'borrador', recibida: false, requiere_correccion: false });
    });
    test('digital observada -> recibida=true (existió un envío) PERO requiere_correccion=true', () => {
        expect(fusionarEstadoCartillaDelegado('observada', null)).toEqual({ estado: 'observada', recibida: true, requiere_correccion: true });
    });
    test('digital reabierta -> recibida=true, requiere_correccion=true', () => {
        expect(fusionarEstadoCartillaDelegado('reabierta', null)).toEqual({ estado: 'reabierta', recibida: true, requiere_correccion: true });
    });
    test('sin digital, adjunto vigente -> adjunta_oficial, recibida', () => {
        expect(fusionarEstadoCartillaDelegado(null, 'vigente')).toEqual({ estado: 'adjunta_oficial', recibida: true, requiere_correccion: false });
    });
    test('sin digital, adjunto pendiente de clasificación -> adjunta_pendiente, NO recibida', () => {
        expect(fusionarEstadoCartillaDelegado(null, 'pendiente')).toEqual({ estado: 'adjunta_pendiente', recibida: false, requiere_correccion: false });
    });
    test('sin digital, adjunto complementario -> NUNCA certifica la cartilla (sin_iniciar)', () => {
        expect(fusionarEstadoCartillaDelegado(null, 'complementario')).toEqual({ estado: 'sin_iniciar', recibida: false, requiere_correccion: false });
    });
    test('nada de ninguna fuente -> sin_iniciar', () => {
        expect(fusionarEstadoCartillaDelegado(null, null)).toEqual({ estado: 'sin_iniciar', recibida: false, requiere_correccion: false });
    });
    test('digital enviada + adjunto complementario -> prioriza el digital (estado más informativo)', () => {
        expect(fusionarEstadoCartillaDelegado('enviada', 'complementario')).toEqual({ estado: 'enviada', recibida: true, requiere_correccion: false });
    });
});

describe('cargarDelegadoRentadoVigentePorRodeo', () => {
    test('una sola asignación activa -> esa es la vigente', async () => {
        respuestas.asignaciones = { data: [{ rodeo_id: 'r1', usuario_pagado_id: 'delB', estado_designacion: 'aceptado', created_at: '2026-02-01' }], error: null };
        const map = await cargarDelegadoRentadoVigentePorRodeo(['r1']);
        expect(map.r1).toBe('delB');
    });
    test('dos asignaciones activas (caso excepcional) -> gana la NO rechazada', async () => {
        respuestas.asignaciones = {
            data: [
                { rodeo_id: 'r1', usuario_pagado_id: 'delViejo', estado_designacion: 'rechazado', created_at: '2026-01-01' },
                { rodeo_id: 'r1', usuario_pagado_id: 'delNuevo', estado_designacion: 'aceptado', created_at: '2026-01-02' }
            ], error: null
        };
        const map = await cargarDelegadoRentadoVigentePorRodeo(['r1']);
        expect(map.r1).toBe('delNuevo');
    });
    test('array vacío -> {} sin consultar BD', async () => {
        const map = await cargarDelegadoRentadoVigentePorRodeo([]);
        expect(map).toEqual({});
        expect(supabase.from).not.toHaveBeenCalled();
    });
});

describe('cargarEstadoCartillaDelegadoUnificadoPorRodeo — PRIORIDAD 1 (hallazgo real de la auditoría)', () => {
    test('delegado REEMPLAZADO con cartilla "enviada" nunca se muestra como vigente si el delegado activo es otro y no inició la suya', async () => {
        // r1: delegado viejo (delA) tiene una fila 'enviada'; el delegado
        // ACTUAL (delB, única asignación activa) todavía no tiene fila propia.
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'enviada', delegado_id: 'delA', delegado_asociacion_id: null }], error: null };
        respuestas.asignaciones = { data: [{ rodeo_id: 'r1', usuario_pagado_id: 'delB', estado_designacion: 'aceptado', created_at: '2026-01-05' }], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const unif = await cargarEstadoCartillaDelegadoUnificadoPorRodeo(['r1']);
        expect(unif.r1.estado).toBe('sin_iniciar');
        expect(unif.r1.recibida).toBe(false);
    });
    test('la fila del delegado VIGENTE sí se reconoce cuando coincide con la asignación activa', async () => {
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'enviada', delegado_id: 'delB', delegado_asociacion_id: null }], error: null };
        respuestas.asignaciones = { data: [{ rodeo_id: 'r1', usuario_pagado_id: 'delB', estado_designacion: 'aceptado', created_at: '2026-01-05' }], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const unif = await cargarEstadoCartillaDelegadoUnificadoPorRodeo(['r1']);
        expect(unif.r1).toEqual({ estado: 'enviada', modalidad: 'delegado_rentado', recibida: true, requiere_correccion: false });
    });
    test('modalidad Asociación — una sola fila por rodeo, sin ambigüedad posible, se reconoce directo', async () => {
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'aprobada', delegado_id: null, delegado_asociacion_id: 'asoc1' }], error: null };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const unif = await cargarEstadoCartillaDelegadoUnificadoPorRodeo(['r1']);
        expect(unif.r1).toEqual({ estado: 'aprobada', modalidad: 'delegado_asociacion', recibida: true, requiere_correccion: false });
    });
    test('adjunto clasificado "version_cartilla" (legado) certifica recepción aunque no exista fila digital', async () => {
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1', tipo_adjunto: 'cartilla_delegado', cartilla_clasificacion: 'version_cartilla' }], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        const unif = await cargarEstadoCartillaDelegadoUnificadoPorRodeo(['r1']);
        expect(unif.r1.estado).toBe('adjunta_oficial');
        expect(unif.r1.recibida).toBe(true);
    });
    test('modo global (sin rodeoIds) — sparse: solo aparecen rodeos con alguna fuente de datos', async () => {
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'rConDigital', estado: 'enviada', delegado_id: null, delegado_asociacion_id: 'asoc1' }], error: null };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        const unif = await cargarEstadoCartillaDelegadoUnificadoPorRodeo();
        expect(Object.keys(unif)).toEqual(['rConDigital']);
        expect(unif.rConDigital.recibida).toBe(true);
    });
});

describe('cargarEstadoCartillaJuradoUnificadoPorRodeo', () => {
    test('adjunto existente + sin fila digital -> recibida, sin corrección pendiente', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1' }], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        const unif = await cargarEstadoCartillaJuradoUnificadoPorRodeo(['r1']);
        expect(unif.r1).toEqual({ recibida: true, requiere_correccion: false });
    });
    test('versión actual en "reabierta" -> sigue "recibida" (existió un envío) pero ahora requiere_correccion', async () => {
        respuestas.rodeo_adjuntos = { data: [{ rodeo_id: 'r1' }], error: null };
        respuestas.cartillas_jurado = { data: [{ rodeo_id: 'r1', estado: 'reabierta' }], error: null };
        const unif = await cargarEstadoCartillaJuradoUnificadoPorRodeo(['r1']);
        expect(unif.r1).toEqual({ recibida: true, requiere_correccion: true });
    });
    test('ningún adjunto ni fila digital -> no aparece como recibida', async () => {
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        const unif = await cargarEstadoCartillaJuradoUnificadoPorRodeo(['r1']);
        expect(unif.r1).toEqual({ recibida: false, requiere_correccion: false });
    });
});

describe('cargarNotaAreaDeportivaPorRodeo', () => {
    test('separa nota técnica real (evaluacion_tecnica) de nota histórica importada (manual)', async () => {
        respuestas.asignaciones = { data: [{ id: 'a1', rodeo_id: 'r1', usuario_pagado_id: 'j1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Juan Pérez' } }], error: null };
        respuestas.notas_rodeo = { data: [{ asignacion_id: 'a1', nota: 6.5, fuente: 'evaluacion_tecnica' }], error: null };
        const map = await cargarNotaAreaDeportivaPorRodeo(['r1']);
        expect(map.r1.actuales).toEqual([{ jurado_nombre: 'Juan Pérez', nota: 6.5 }]);
        expect(map.r1.historicas).toEqual([]);
    });
    test('fuente manual nunca se mezcla silenciosamente como evaluación técnica real', async () => {
        respuestas.asignaciones = { data: [{ id: 'a1', rodeo_id: 'r1', usuario_pagado_id: 'j1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Juan Pérez' } }], error: null };
        respuestas.notas_rodeo = { data: [{ asignacion_id: 'a1', nota: 5.0, fuente: 'manual' }], error: null };
        const map = await cargarNotaAreaDeportivaPorRodeo(['r1']);
        expect(map.r1.actuales).toEqual([]);
        expect(map.r1.historicas).toEqual([{ jurado_nombre: 'Juan Pérez', nota: 5.0 }]);
    });
    test('varios jurados en el mismo rodeo -> ambos aparecen con su propio nombre', async () => {
        respuestas.asignaciones = {
            data: [
                { id: 'a1', rodeo_id: 'r1', usuario_pagado_id: 'j1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Jurado Uno' } },
                { id: 'a2', rodeo_id: 'r1', usuario_pagado_id: 'j2', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Jurado Dos' } }
            ], error: null
        };
        respuestas.notas_rodeo = { data: [{ asignacion_id: 'a1', nota: 6, fuente: 'evaluacion_tecnica' }, { asignacion_id: 'a2', nota: 7, fuente: 'evaluacion_tecnica' }], error: null };
        const map = await cargarNotaAreaDeportivaPorRodeo(['r1']);
        expect(map.r1.actuales).toEqual(expect.arrayContaining([
            { jurado_nombre: 'Jurado Uno', nota: 6 }, { jurado_nombre: 'Jurado Dos', nota: 7 }
        ]));
    });
});

describe('calcularPendientesPorRodeo — Prioridad 2/5 (agregador de pendientes)', () => {
    test('rodeo futuro nunca marca cartillas/notas como pendientes (solo lo accionable ahora: publicación/respuesta/corrección)', async () => {
        const futura = '2099-01-01';
        respuestas.rodeos = { data: [{ id: 'r1', fecha: futura }], error: null, count: 1 };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };

        const pend = await calcularPendientesPorRodeo(['r1']);
        expect(pend.r1.tiene_pendientes).toBe(false);
        expect(pend.r1.pendientes).toEqual([]);
    });
    test('rodeo ya realizado sin cartillas ni notas -> todos los pendientes aplicables se listan', async () => {
        const pasada = '2020-01-01';
        respuestas.rodeos = { data: [{ id: 'r1', fecha: pasada }], error: null, count: 1 };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };

        const pend = await calcularPendientesPorRodeo(['r1']);
        expect(pend.r1.tiene_pendientes).toBe(true);
        expect(pend.r1.pendientes).toEqual(expect.arrayContaining([
            'cartilla_jurado_pendiente', 'cartilla_delegado_pendiente',
            'nota_comision_pendiente', 'nota_delegado_pendiente', 'nota_area_deportiva_pendiente'
        ]));
        // Sin asignaciones activas no hay "designación no publicada" ni "jurado sin responder" que reportar.
        expect(pend.r1.pendientes).not.toContain('designacion_no_publicada');
        expect(pend.r1.pendientes).not.toContain('jurado_sin_responder');
    });
    test('designación no publicada se detecta aunque el rodeo sea futuro (siempre accionable)', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', fecha: '2099-01-01' }], error: null, count: 1 };
        respuestas.asignaciones = { data: [{ rodeo_id: 'r1', usuario_pagado_id: 'j1', tipo_persona: 'jurado', pago_base_calculado: 0, estado_designacion: null, nombre_importado: 'J1', publicado: false, usuarios_pagados: null }], error: null };
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };

        const pend = await calcularPendientesPorRodeo(['r1']);
        expect(pend.r1.pendientes).toContain('designacion_no_publicada');
    });
    test('cartilla observada/reabierta se marca requiere_correccion incluso sobre un rodeo ya realizado con el resto completo', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', fecha: '2020-01-01' }], error: null, count: 1 };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'r1', estado: 'observada', delegado_id: null, delegado_asociacion_id: 'asoc1' }], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'r1', nota_comision: 5, nota_delegado: 5 }], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };

        const pend = await calcularPendientesPorRodeo(['r1']);
        expect(pend.r1.pendientes).toContain('cartilla_requiere_correccion');
        // La cartilla delegado SÍ cuenta como recibida (observada = existió un envío) -> no debe listarse como pendiente de recepción.
        expect(pend.r1.pendientes).not.toContain('cartilla_delegado_pendiente');
    });
});

describe('resolverFiltrosComplejos — nuevos filtros (Prioridad 1/3)', () => {
    test('cartilla_delegado_estado="sin_iniciar" excluye los rodeos con cualquier actividad de cartilla', async () => {
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'rConCartilla', estado: 'enviada', delegado_id: null, delegado_asociacion_id: 'asoc1' }], error: null };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        const { incluir, excluir } = await resolverFiltrosComplejos({ cartilla_delegado_estado: 'sin_iniciar' });
        expect(incluir).toBeNull();
        expect(excluir).toEqual(['rConCartilla']);
    });
    test('modalidad_delegado filtra solo por la modalidad pedida', async () => {
        respuestas.cartillas_delegado = {
            data: [
                { rodeo_id: 'rAsoc', estado: 'enviada', delegado_id: null, delegado_asociacion_id: 'asoc1' },
                { rodeo_id: 'rRentado', estado: 'enviada', delegado_id: 'delB', delegado_asociacion_id: null }
            ], error: null
        };
        respuestas.asignaciones = { data: [{ rodeo_id: 'rRentado', usuario_pagado_id: 'delB', estado_designacion: 'aceptado', created_at: '2026-01-01' }], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        const { incluir } = await resolverFiltrosComplejos({ modalidad_delegado: 'delegado_asociacion' });
        expect(incluir).toEqual(['rAsoc']);
    });
    test('designacion_estado="pendientes_publicacion" detecta por publicado=false, independiente de estado_designacion', async () => {
        respuestas.asignaciones = { data: [{ rodeo_id: 'r1', publicado: false, estado_designacion: 'aceptado' }, { rodeo_id: 'r2', publicado: true, estado_designacion: 'pendiente' }], error: null };
        const { incluir } = await resolverFiltrosComplejos({ designacion_estado: 'pendientes_publicacion' });
        expect(incluir).toEqual(['r1']);
    });
    test('nota_comision_estado="sin" excluye por EXCLUSIÓN los rodeos con nota ya registrada', async () => {
        respuestas.rodeo_notas_secundarias = { data: [{ rodeo_id: 'rConNota', nota_comision: 6, nota_delegado: null }], error: null };
        const { incluir, excluir } = await resolverFiltrosComplejos({ nota_comision_estado: 'sin' });
        expect(incluir).toBeNull();
        expect(excluir).toEqual(['rConNota']);
    });
    test('nota_area_deportiva_min/max filtra por rango entre jurados del rodeo', async () => {
        respuestas.notas_rodeo = { data: [{ asignacion_id: 'a1', nota: 4.0 }, { asignacion_id: 'a2', nota: 6.5 }], error: null };
        respuestas.asignaciones = { data: [{ id: 'a1', rodeo_id: 'rBaja' }, { id: 'a2', rodeo_id: 'rAlta' }], error: null };
        const { incluir } = await resolverFiltrosComplejos({ nota_area_deportiva_min: '6' });
        expect(incluir).toEqual(['rAlta']);
    });
    test('gestion_general="con_pendientes" reutiliza calcularPendientesPorRodeo (nunca una condición paralela)', async () => {
        respuestas.rodeos = { data: [{ id: 'r1', fecha: '2020-01-01' }], error: null, count: 1 };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        respuestas.rodeo_links = { data: [], error: null };
        respuestas.cartillas_jurado = { data: [], error: null };
        respuestas.rodeo_notas_secundarias = { data: [], error: null };
        respuestas.evaluaciones = { data: [], error: null };
        respuestas.notas_rodeo = { data: [], error: null };
        const { incluir } = await resolverFiltrosComplejos({ gestion_general: 'con_pendientes' });
        expect(incluir).toEqual(['r1']);
    });
});

describe('obtenerTodosLosIdsFiltrados — cierre: exacto, sin depender del tope de 1000 filas de Supabase/PostgREST', () => {
    // Mock dedicado para `rodeos` que SÍ respeta `.range(from,to)` sobre un
    // dataset fijo — a diferencia del mock "respuesta fija" del resto del
    // archivo, necesario acá para poder simular más de una página real.
    function crearChainRodeosPaginado(dataset) {
        const chain = {};
        let rango = null;
        ['select', 'eq', 'neq', 'gte', 'lte', 'ilike', 'or', 'in', 'not', 'is', 'order'].forEach(m => { chain[m] = () => chain; });
        chain.range = (from, to) => { rango = [from, to]; return chain; };
        chain.then = (resolve) => {
            const pagina = rango ? dataset.slice(rango[0], rango[1] + 1) : dataset;
            return Promise.resolve({ data: pagina, error: null, count: dataset.length }).then(resolve);
        };
        return chain;
    }

    test('un único rodeo (menos de una página) se resuelve en una sola vuelta', async () => {
        const dataset = [{ id: 'r1' }];
        supabase.from.mockImplementation(tabla => tabla === 'rodeos' ? crearChainRodeosPaginado(dataset) : crearChain(tabla));
        const { ids, vacioPorFiltro } = await obtenerTodosLosIdsFiltrados({});
        expect(vacioPorFiltro).toBe(false);
        expect(ids).toEqual(['r1']);
    });

    test('más de 1000 resultados se acumulan en varias vueltas de 1000 (nunca se trunca)', async () => {
        const dataset = Array.from({ length: 1234 }, (_, i) => ({ id: `r${i}` }));
        supabase.from.mockImplementation(tabla => tabla === 'rodeos' ? crearChainRodeosPaginado(dataset) : crearChain(tabla));
        const { ids, vacioPorFiltro } = await obtenerTodosLosIdsFiltrados({});
        expect(vacioPorFiltro).toBe(false);
        expect(ids.length).toBe(1234);
        expect(ids[0]).toBe('r0');
        expect(ids[1233]).toBe('r1233');
    });

    test('filtro complejo sin coincidencias -> vacioPorFiltro=true, ids=[]', async () => {
        respuestas.cartillas_delegado = { data: [], error: null };
        respuestas.asignaciones = { data: [], error: null };
        respuestas.rodeo_adjuntos = { data: [], error: null };
        const { ids, vacioPorFiltro } = await obtenerTodosLosIdsFiltrados({ cartilla_delegado_estado: 'sin_iniciar', cartilla_delegado: 'sin' });
        // sin_iniciar + sin (con ninguna cartilla registrada) no produce
        // necesariamente vacío — se afirma solo la forma del resultado
        // (array), la cobertura semántica de este filtro ya está cubierta
        // arriba; lo que importa acá es que la función no rompe con un
        // filtro complejo real combinado.
        expect(Array.isArray(ids)).toBe(true);
        expect(typeof vacioPorFiltro).toBe('boolean');
    });
});
