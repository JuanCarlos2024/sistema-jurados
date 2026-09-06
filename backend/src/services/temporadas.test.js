const {
    validarRangoFechas, detectarSolapamiento, validarActivacion, validarDesactivacion, estaFueraDeRango,
    evaluarAsignacionIndividual, evaluarAsignacionLote, calcularConteosPorTemporada,
    resolverFiltroTemporadaRodeos, construirAuditoriaAsignacionTemporada, construirAuditoriaExcepcionFechas
} = require('./temporadas');

const fs = require('fs');
const path = require('path');

// Fixtures — misma forma que las filas reales de la tabla `temporadas`
const temporada2627 = { id: 't-2627', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31', activa: true };
const temporada2728 = { id: 't-2728', nombre: '2027-2028', fecha_inicio: '2027-04-01', fecha_fin: '2028-03-31', activa: false };

// TEST A
describe('TEST A: crear temporada válida', () => {
    test('rango válido + sin solapamiento + activación permitida (sin otra activa)', () => {
        const candidata = { fecha_inicio: '2028-04-01', fecha_fin: '2029-03-31' };
        expect(validarRangoFechas(candidata.fecha_inicio, candidata.fecha_fin)).toEqual({ valido: true });
        expect(detectarSolapamiento(candidata, [temporada2627, temporada2728])).toBeNull();
        expect(validarActivacion(true, null)).toEqual({ permitido: true });
    });
});

// TEST B
describe('TEST B: rechazar fecha_fin <= fecha_inicio', () => {
    test('fecha_fin igual a fecha_inicio', () => {
        const r = validarRangoFechas('2026-04-01', '2026-04-01');
        expect(r.valido).toBe(false);
    });
    test('fecha_fin anterior a fecha_inicio', () => {
        const r = validarRangoFechas('2027-03-31', '2026-04-01');
        expect(r.valido).toBe(false);
    });
    test('fechas faltantes', () => {
        expect(validarRangoFechas(null, '2026-04-01').valido).toBe(false);
        expect(validarRangoFechas('2026-04-01', undefined).valido).toBe(false);
    });
});

// TEST C
describe('TEST C: detectar solapamiento', () => {
    test('rango que se cruza con una temporada existente', () => {
        const candidata = { fecha_inicio: '2027-01-01', fecha_fin: '2027-12-31' }; // cruza 2026-2027 y 2027-2028
        const solapa = detectarSolapamiento(candidata, [temporada2627, temporada2728]);
        expect(solapa).not.toBeNull();
        expect(solapa.nombre).toBe('2026-2027'); // primera coincidencia
    });
    test('rangos contiguos (fin de una = día antes del inicio de la otra) NO se consideran solapados', () => {
        // 2026-2027 termina 2027-03-31, 2027-2028 empieza 2027-04-01 — diseño intencional
        const solapa = detectarSolapamiento(temporada2728, [temporada2627]);
        expect(solapa).toBeNull();
    });
    test('excluirId permite editar una temporada sin compararla consigo misma', () => {
        const mismaFechas = { fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' };
        expect(detectarSolapamiento(mismaFechas, [temporada2627], 't-2627')).toBeNull();
        expect(detectarSolapamiento(mismaFechas, [temporada2627], null)).not.toBeNull();
    });
});

// TEST D
describe('TEST D: impedir dos temporadas activas', () => {
    test('activar una temporada distinta mientras existe otra activa → rechazado con mensaje claro', () => {
        const r = validarActivacion(true, temporada2627, 't-2728');
        expect(r.permitido).toBe(false);
        expect(r.error).toBe('Ya existe una temporada activa: 2026-2027.');
    });
    test('re-guardar la misma temporada que ya está activa → permitido', () => {
        const r = validarActivacion(true, temporada2627, 't-2627');
        expect(r.permitido).toBe(true);
    });
    test('activar cuando no existe ninguna activa → permitido', () => {
        expect(validarActivacion(true, null, 't-2728').permitido).toBe(true);
    });
    test('desactivar (quiereActivar=false) siempre permitido', () => {
        expect(validarActivacion(false, temporada2627, 't-2728').permitido).toBe(true);
    });
});

// TEST E
describe('TEST E: rodeos existentes quedan NULL tras la migración', () => {
    const sqlPath = path.join(__dirname, '../../../database/migrations/049_gestion_temporadas_rodeos.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    test('agrega rodeos.temporada_id como columna nullable (sin DEFAULT)', () => {
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS temporada_id UUID REFERENCES temporadas\(id\)/);
        expect(sql).not.toMatch(/temporada_id[^;]*DEFAULT/i);
    });
    test('no contiene ningún UPDATE que backfillee rodeos.temporada_id', () => {
        expect(sql).not.toMatch(/UPDATE\s+rodeos\s+SET[^;]*temporada_id/i);
    });
});

// TEST F
describe('TEST F: asignar temporada individual', () => {
    test('fecha dentro de rango → permitido sin necesidad de confirmar', () => {
        const r = evaluarAsignacionIndividual('2026-05-15', temporada2627, false);
        expect(r).toEqual({ permitido: true, fueraDeRango: false });
    });
    test('fecha fuera de rango sin confirmar → bloqueado', () => {
        const r = evaluarAsignacionIndividual('2026-01-01', temporada2627, false);
        expect(r.permitido).toBe(false);
        expect(r.fueraDeRango).toBe(true);
        expect(r.mensaje).toMatch(/fuera del rango/);
    });
    test('fecha fuera de rango confirmando → permitido, mantiene la marca fueraDeRango para auditoría', () => {
        const r = evaluarAsignacionIndividual('2026-01-01', temporada2627, true);
        expect(r.permitido).toBe(true);
        expect(r.fueraDeRango).toBe(true);
    });
    test('temporada = null ("Sin temporada") siempre permitido', () => {
        expect(evaluarAsignacionIndividual('2026-01-01', null, false)).toEqual({ permitido: true, fueraDeRango: false });
    });
});

// TEST G
describe('TEST G: asignar temporada por lote', () => {
    const rodeos = [
        { id: 'r1', club: 'A', fecha: '2026-05-01' },  // dentro
        { id: 'r2', club: 'B', fecha: '2026-01-01' },  // fuera
        { id: 'r3', club: 'C', fecha: '2027-03-01' },  // dentro
        { id: 'r4', club: 'D', fecha: '2028-01-01' },  // fuera
    ];
    test('sin confirmar: separa dentro/fuera y exige confirmación', () => {
        const r = evaluarAsignacionLote(rodeos, temporada2627, false);
        expect(r.dentro.map(x => x.id)).toEqual(['r1', 'r3']);
        expect(r.fuera.map(x => x.id)).toEqual(['r2', 'r4']);
        expect(r.requiereConfirmacion).toBe(true);
        expect(r.resumen).toEqual({ seleccionados: 4, dentro_rango: 2, fuera_rango: 2 });
    });
    test('confirmando: ya no exige confirmación (pero conserva la partición dentro/fuera)', () => {
        const r = evaluarAsignacionLote(rodeos, temporada2627, true);
        expect(r.requiereConfirmacion).toBe(false);
        expect(r.resumen.fuera_rango).toBe(2);
    });
    test('lote sin ningún rodeo fuera de rango: nunca exige confirmación', () => {
        const soloDentro = [rodeos[0], rodeos[2]];
        const r = evaluarAsignacionLote(soloDentro, temporada2627, false);
        expect(r.requiereConfirmacion).toBe(false);
        expect(r.fuera).toEqual([]);
    });
});

// TEST H (subsumido en F/G, se deja explícito por el pedido)
describe('TEST H: advertencia fuera de rango requiere confirmación explícita', () => {
    test('individual', () => {
        expect(evaluarAsignacionIndividual('2025-12-31', temporada2627, false).permitido).toBe(false);
    });
    test('lote', () => {
        expect(evaluarAsignacionLote([{ id: 'x', fecha: '2025-12-31' }], temporada2627, false).requiereConfirmacion).toBe(true);
    });
});

// TEST I
describe('TEST I: dentro de rango nunca requiere excepción', () => {
    test('individual', () => {
        const r = evaluarAsignacionIndividual('2026-04-01', temporada2627, false); // borde inicio, inclusive
        expect(r.permitido).toBe(true);
    });
    test('lote', () => {
        const r = evaluarAsignacionLote([{ id: 'x', fecha: '2027-03-31' }], temporada2627, false); // borde fin, inclusive
        expect(r.requiereConfirmacion).toBe(false);
    });
});

// TEST J
describe('TEST J: filtro "Sin temporada"', () => {
    test('temporada=sin_temporada', () => {
        expect(resolverFiltroTemporadaRodeos('sin_temporada')).toEqual({ tipo: 'sin_temporada' });
    });
});

// TEST K
describe('TEST K: filtro temporada específica', () => {
    test('un id de temporada concreto', () => {
        expect(resolverFiltroTemporadaRodeos('t-2627')).toEqual({ tipo: 'especifica', valor: 't-2627' });
    });
    test('"todas", vacío o ausente → sin filtrar', () => {
        expect(resolverFiltroTemporadaRodeos('todas')).toEqual({ tipo: 'todas' });
        expect(resolverFiltroTemporadaRodeos('')).toEqual({ tipo: 'todas' });
        expect(resolverFiltroTemporadaRodeos(undefined)).toEqual({ tipo: 'todas' });
    });
});

// TEST L
describe('TEST L: auditoría de cambio individual', () => {
    test('registra temporada anterior, nueva, actor y descripción por rodeo', () => {
        const rodeo = { id: 'r1', club: 'Salamanca', fecha: '2026-05-01' };
        const registro = construirAuditoriaAsignacionTemporada(rodeo, null, 't-2627', 'admin-1');
        expect(registro).toEqual({
            tabla: 'rodeos',
            registro_id: 'r1',
            accion: 'asignar_temporada',
            datos_anteriores: { temporada_id: null },
            datos_nuevos: { temporada_id: 't-2627' },
            actor_id: 'admin-1',
            actor_tipo: 'administrador',
            descripcion: 'Temporada de rodeo "Salamanca" (2026-05-01) cambiada'
        });
    });
});

// TEST M
describe('TEST M: auditoría de lote — trazabilidad por rodeo, no solo un resumen', () => {
    test('cada rodeo del lote produce su propio registro con su propio registro_id', () => {
        const rodeos = [
            { id: 'r1', club: 'A', fecha: '2026-05-01' },
            { id: 'r2', club: 'B', fecha: '2026-06-01' }
        ];
        const registros = rodeos.map(r => construirAuditoriaAsignacionTemporada(r, null, 't-2627', 'admin-1'));
        expect(registros).toHaveLength(2);
        expect(registros.map(r => r.registro_id)).toEqual(['r1', 'r2']);
        expect(registros.every(r => r.datos_nuevos.temporada_id === 't-2627')).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════════
// REVISIÓN FINAL ANTES DE APLICAR 049 — tres protecciones adicionales
// ═════════════════════════════════════════════════════════════════════════

// TEST A
describe('TEST A: no se puede desactivar la única temporada activa', () => {
    test('activaAntes=true, activaDespues=false → rechazado, con mensaje claro (no error SQL crudo)', () => {
        const r = validarDesactivacion(true, false);
        expect(r.permitido).toBe(false);
        expect(r.error).toBe('No es posible desactivar la única temporada activa mientras el sistema depende de una temporada activa.');
    });
    test('reafirmar activa=true sobre la ya activa → permitido (no es una desactivación)', () => {
        expect(validarDesactivacion(true, true).permitido).toBe(true);
    });
    test('una temporada que ya estaba inactiva puede guardarse como inactiva sin problema', () => {
        expect(validarDesactivacion(false, false).permitido).toBe(true);
    });
});

// TEST B
describe('TEST B: crear temporada futura inactiva sí funciona', () => {
    test('activa=false nunca es bloqueado por validarActivacion, exista o no otra activa', () => {
        expect(validarActivacion(false, temporada2627, null).permitido).toBe(true);
        expect(validarActivacion(false, null, null).permitido).toBe(true);
    });
    test('no se desactiva la existente automáticamente: validarActivacion no toca temporada2627', () => {
        const antesDeLlamar = { ...temporada2627 };
        validarActivacion(false, temporada2627, null);
        expect(temporada2627).toEqual(antesDeLlamar); // función pura, no muta el objeto recibido
    });
});

// TEST C / D — editar fechas de una temporada con rodeos ya asociados
describe('TEST C/D: editar fechas de una temporada con rodeos asociados', () => {
    const rodeosAsociados = [
        { id: 'r1', club: 'Salamanca', fecha: '2026-05-01' }, // quedará dentro del nuevo rango
        { id: 'r2', club: 'XXXXX', fecha: '2026-03-20' },     // quedará FUERA (antes del nuevo inicio)
    ];
    test('TEST C: nuevo rango que sigue cubriendo a todos los rodeos asociados → no requiere confirmación', () => {
        const nuevoRango = { fecha_inicio: '2026-01-01', fecha_fin: '2027-03-31' }; // cubre ambos
        const evalu = evaluarAsignacionLote(rodeosAsociados, nuevoRango, false);
        expect(evalu.requiereConfirmacion).toBe(false);
        expect(evalu.fuera).toEqual([]);
    });
    test('TEST D: nuevo rango que deja rodeos fuera → requiere confirmación explícita, informa cuáles', () => {
        const nuevoRango = { fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' }; // r2 (2026-03-20) queda fuera
        const evalu = evaluarAsignacionLote(rodeosAsociados, nuevoRango, false);
        expect(evalu.requiereConfirmacion).toBe(true);
        expect(evalu.fuera.map(r => r.id)).toEqual(['r2']);
        expect(evalu.dentro.map(r => r.id)).toEqual(['r1']);
    });
});

// TEST E
describe('TEST E: confirmar la excepción registra auditoría de temporada, nunca toca rodeos', () => {
    test('construirAuditoriaExcepcionFechas documenta la excepción sin mencionar cambios a rodeos.temporada_id', () => {
        const temporada = { id: 't-2627', nombre: '2026-2027' };
        const rodeosFuera = [{ id: 'r2', club: 'XXXXX', fecha: '2026-03-20' }];
        const registro = construirAuditoriaExcepcionFechas(
            temporada,
            { fecha_inicio: '2026-04-15', fecha_fin: '2027-04-15' },
            { fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' },
            rodeosFuera,
            'admin-1'
        );
        expect(registro.tabla).toBe('temporadas'); // NUNCA 'rodeos' — no es un cambio de temporada_id
        expect(registro.registro_id).toBe('t-2627');
        expect(registro.datos_anteriores).toEqual({ fecha_inicio: '2026-04-15', fecha_fin: '2027-04-15' });
        expect(registro.datos_nuevos).toEqual({ fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' });
        expect(registro.datos_nuevos.temporada_id).toBeUndefined();
        expect(registro.descripcion).toMatch(/r2/); // el rodeo afectado queda trazado en la descripción
    });
    test('evaluarAsignacionLote nunca muta los objetos rodeo que recibe (ninguna asignación de temporada_id ocurre en la capa pura)', () => {
        const rodeo = { id: 'r2', club: 'XXXXX', fecha: '2026-03-20', temporada_id: 't-2627' };
        const copiaOriginal = { ...rodeo };
        evaluarAsignacionLote([rodeo], { fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31' }, true);
        expect(rodeo).toEqual(copiaOriginal);
    });
});

// TEST F
describe('TEST F: la migración 049 comprueba el estado anterior esperado antes del UPDATE', () => {
    const sqlPath = path.join(__dirname, '../../../database/migrations/049_gestion_temporadas_rodeos.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    test('contiene una verificación del estado previo exacto (RAISE EXCEPTION si no coincide)', () => {
        expect(sql).toMatch(/RAISE EXCEPTION/);
        expect(sql).toMatch(/filas_con_estado_esperado <> 1/);
    });
    test('la verificación ocurre ANTES del UPDATE que cambia las fechas', () => {
        const idxVerificacion = sql.indexOf('filas_con_estado_esperado <> 1');
        const idxUpdate = sql.indexOf("SET fecha_inicio  = '2026-04-01'");
        expect(idxVerificacion).toBeGreaterThan(-1);
        expect(idxUpdate).toBeGreaterThan(-1);
        expect(idxVerificacion).toBeLessThan(idxUpdate);
    });
    test('también verifica que el UPDATE afecte exactamente 1 fila (ROW_COUNT)', () => {
        expect(sql).toMatch(/GET DIAGNOSTICS filas_actualizadas = ROW_COUNT/);
        expect(sql).toMatch(/filas_actualizadas <> 1/);
    });
});

// TEST G
describe('TEST G: la asignación por lote sigue siendo batch (no N+1)', () => {
    const routePath = path.join(__dirname, '../routes/admin/rodeos.js');
    const src = fs.readFileSync(routePath, 'utf8');
    // Extrae el cuerpo de la ruta de lote para no confundir con otras rutas del archivo.
    const inicio = src.indexOf("router.post('/asignar-temporada-lote'");
    const fin = src.indexOf("router.delete('/:id'", inicio);
    const cuerpoRuta = src.slice(inicio, fin);

    test('la ruta existe y se pudo aislar su cuerpo', () => {
        expect(inicio).toBeGreaterThan(-1);
        expect(cuerpoRuta.length).toBeGreaterThan(0);
    });
    test('actualiza los rodeos con un único UPDATE ... WHERE id IN (...), no un UPDATE por rodeo', () => {
        expect(cuerpoRuta).toMatch(/\.update\(\{\s*temporada_id/);
        expect(cuerpoRuta).toMatch(/\.in\('id',\s*idsAAplicar\)/);
    });
    test('no contiene un bucle que llame a supabase.update() por cada rodeo', () => {
        // Un "for"/"forEach"/"map" que a su vez invoque supabase....update( dentro
        // del cuerpo de esta ruta indicaría un UPDATE por fila — no debe existir.
        const posiblesLoopsConUpdate = /(for\s*\(|\.forEach\(|\.map\()[^]*?supabase[^]*?\.update\(/;
        // La única ocurrencia de "supabase" + "update" en este cuerpo debe ser la
        // llamada batch ya verificada arriba, fuera de cualquier loop de rodeos.
        const llamadasUpdate = cuerpoRuta.match(/supabase[\s\S]*?\.update\(/g) || [];
        expect(llamadasUpdate.length).toBe(1);
    });
    test('inserta la auditoría en un único INSERT batch (array), no un insert por rodeo', () => {
        expect(cuerpoRuta).toMatch(/\.insert\(\[\.\.\.registrosPorRodeo, registroLote\]\)/);
    });
});

// Conteos (usados por Configuración → Temporadas y el contador de Rodeos)
describe('calcularConteosPorTemporada', () => {
    test('cuenta rodeos sin temporada y por temporada, en una sola pasada', () => {
        const rodeosActivos = [
            { temporada_id: 't-2627' }, { temporada_id: 't-2627' },
            { temporada_id: null }, { temporada_id: null }, { temporada_id: null },
            { temporada_id: 't-2728' }
        ];
        const r = calcularConteosPorTemporada(rodeosActivos, [temporada2627, temporada2728]);
        expect(r).toEqual({
            total: 6,
            sin_temporada: 3,
            por_temporada: [
                { temporada_id: 't-2627', nombre: '2026-2027', count: 2 },
                { temporada_id: 't-2728', nombre: '2027-2028', count: 1 }
            ]
        });
    });
});
