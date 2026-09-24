jest.mock('../../config/supabase', () => ({ from: jest.fn() }));

const XLSX = require('xlsx');
const { analizarActividadAsociaciones, etiquetarVariacion, construirIndiceCatalogo, resolverAsociacion } = require('./asociaciones');
const { previewAsociaciones, confirmarAsociaciones, canonico } = require('./importAsociaciones');

const aso = (id, nombre, extra = {}) => ({ id, nombre, nombre_normalizado: nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''), zona: null, activa: true, es_especial: false, incluir_en_alertas: true, ...extra });
const rodeo = (fecha, asociacion) => ({ fecha, asociacion });

describe('analizarActividadAsociaciones', () => {
    const catalogo = [
        aso('1', 'ARAUCO'), aso('2', 'CHILOE'), aso('3', 'MAGALLANES'), aso('4', 'COLCHAGUA'), aso('5', 'OSORNO'),
        aso('6', 'FEDERACION', { es_especial: true, incluir_en_alertas: false }),
        aso('7', 'ZONA PRUEBA', { incluir_en_alertas: false }),
        aso('8', 'INACTIVA', { activa: false })
    ];
    const alias = [{ asociacion_id: '6', alias: 'FEDERACION DEL RODEO CHILENO', alias_normalizado: 'federacion del rodeo chileno' }];
    const actuales = [rodeo('2026-09-05', 'Arauco'), rodeo('2026-09-12', 'ARAUCO'), rodeo('2026-09-19', 'COLCHAGUA'), rodeo('2026-09-19', 'ASOCIACION OSORNO'), rodeo('2026-09-19', 'DESCONOCIDA')];
    const historico = [
        { asociacion_id: '1' }, { asociacion_id: '1' }, { asociacion_id: '1' }, { asociacion_id: '1' },   // ARAUCO: 4
        { asociacion_id: '2' }, { asociacion_id: '2' },                                                     // CHILOE: 2 (hoy 0)
        { asociacion_normalizada: 'colchagua' }, { asociacion_normalizada: 'colchagua' },                   // COLCHAGUA: 2 (hoy 1)
        { asociacion_normalizada: 'osorno' }                                                                // OSORNO: 1 (hoy 1)
    ];
    const r = analizarActividadAsociaciones({ catalogo, alias, rodeosActuales: actuales, historicoEquivalente: historico, hasta: '2026-09-20' });
    const por = n => r.asociaciones.find(a => a.asociacion === n);

    test('el universo es el CATÁLOGO completo (no un DISTINCT de rodeos): aparecen las de 0 rodeos', () => {
        expect(r.asociaciones.map(a => a.asociacion)).toEqual(expect.arrayContaining(['CHILOE', 'MAGALLANES']));
        expect(por('MAGALLANES')).toMatchObject({ rodeos_actuales: 0, rodeos_historicos_equivalentes: 0, estado: 'SIN_ACTIVIDAD', historicamente_similar: true });
    });

    test('0 actual con histórico > 0 = SIN_ACTIVIDAD (alerta real) frente a 0 vs 0 (históricamente similar)', () => {
        expect(por('CHILOE')).toMatchObject({ estado: 'SIN_ACTIVIDAD', diferencia: -2, variacion_pct: -100, historicamente_similar: false, alertable: true });
    });

    test('estados: caída relevante (≥30 %), similar y aumento; variación porcentual', () => {
        expect(por('COLCHAGUA')).toMatchObject({ rodeos_actuales: 1, rodeos_historicos_equivalentes: 2, variacion_pct: -50, estado: 'CAIDA_RELEVANTE' });
        expect(por('ARAUCO')).toMatchObject({ rodeos_actuales: 2, rodeos_historicos_equivalentes: 4, variacion_pct: -50, estado: 'CAIDA_RELEVANTE' });
        expect(por('OSORNO')).toMatchObject({ rodeos_actuales: 1, estado: 'SIMILAR', variacion_pct: 0 });   // "ASOCIACION OSORNO" resuelve por normalizarAsociacion
        expect(etiquetarVariacion(3, 2).estado).toBe('AUMENTO');
        expect(etiquetarVariacion(3, 0).estado).toBe('AUMENTO');
        expect(etiquetarVariacion(2, null).estado).toBe('SIN_HISTORICO');
    });

    test('el umbral de caída es configurable (no está hardcodeado)', () => {
        expect(etiquetarVariacion(7, 10, { ASOCIACION: { CAIDA_RELEVANTE_PCT: 30, AUMENTO_PCT: 30 } }).estado).toBe('CAIDA_RELEVANTE');
        expect(etiquetarVariacion(7, 10, { ASOCIACION: { CAIDA_RELEVANTE_PCT: 40, AUMENTO_PCT: 30 } }).estado).toBe('SIMILAR');
    });

    test('asociaciones especiales o con incluir_en_alertas=false no son alertables ni entran al resumen de alertas', () => {
        expect(por('FEDERACION')).toMatchObject({ estado: 'SIN_ACTIVIDAD', alertable: false });
        expect(por('ZONA PRUEBA').alertable).toBe(false);
        expect(r.resumen.sin_actividad_alertables).toBe(2);           // CHILOE y MAGALLANES (no FEDERACION ni ZONA PRUEBA)
        expect(r.resumen.especiales_excluidas_de_alertas).toBe(2);
    });

    test('las inactivas no se analizan; nombres de rodeos sin correspondencia se informan', () => {
        expect(por('INACTIVA')).toBeUndefined();
        expect(r.resumen.inactivas).toBe(1);
        expect(r.sin_correspondencia_catalogo).toEqual([{ nombre: 'DESCONOCIDA', rodeos: 1 }]);
    });

    test('alias: "FEDERACION DEL RODEO CHILENO" resuelve a la asociación FEDERACION', () => {
        const idx = construirIndiceCatalogo(catalogo, alias);
        expect(resolverAsociacion('Federación del Rodeo Chileno', idx).id).toBe('6');
    });

    test('última fecha de actividad y días desde el último rodeo', () => {
        expect(por('ARAUCO')).toMatchObject({ ultima_fecha_actividad: '2026-09-12', dias_desde_ultimo_rodeo: 8 });
        expect(por('CHILOE').dias_desde_ultimo_rodeo).toBeNull();
    });

    test('sin histórico cargado: estados SIN_HISTORICO (y SIN_ACTIVIDAD para las de cero)', () => {
        const x = analizarActividadAsociaciones({ catalogo, alias, rodeosActuales: actuales, historicoEquivalente: null, hasta: '2026-09-20' });
        expect(x.asociaciones.find(a => a.asociacion === 'ARAUCO').estado).toBe('SIN_HISTORICO');
        expect(x.asociaciones.find(a => a.asociacion === 'CHILOE').estado).toBe('SIN_ACTIVIDAD');
        expect(x.historico_disponible).toBe(false);
    });

    test('sin catálogo (migración no aplicada o vacío): no se improvisa un universo', () => {
        const x = analizarActividadAsociaciones({ catalogo: null, rodeosActuales: actuales, historicoEquivalente: [], hasta: '2026-09-20' });
        expect(x).toMatchObject({ catalogo_disponible: false, asociaciones: [], resumen: null });
    });
});

// ── Importación / preview del catálogo (con XLSX real) ─────────────────────
function libroResumen(filasA) {
    const filas = [['ASOCIACIONES Y CLUBES', 'CARNET', 'CANTIDAD DE RODEOS'], ...filasA, ['RESUMEN POR CATEGORÍA', '', ''], ['ESPECIAL', '11', '']];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Hoja1');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), 'Resumen');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('previewAsociaciones (no siembra en silencio)', () => {
    const buf = libroResumen([
        ['ARAUCO', '', 10], ['   Club A', '', 5], ['   Club B', '', 5],
        ['SANTIAGO', '', 15], ['SANTIAGO ORIENTE', '', 10], ['MAIPO', '', 7], ['MAIPO NORTE', '', 9],
        ['FEDERACION DEL RODEO CHILENO', '', 1], ['ARAUCO', '', 10]
    ]);

    test('detecta asociaciones, clubes, especiales, duplicados y NO confunde SANTIAGO/MAIPO con sus variantes', () => {
        const p = previewAsociaciones(buf, { catalogo: [], alias: [], nombresEnUso: ['FEDERACION', 'ARAUCO'] });
        const f = n => p.filas.find(x => x.nombre_original === n);
        expect(p.resumen.total).toBe(7);
        expect(f('SANTIAGO').clasificacion).toBe('NUEVA');
        expect(f('SANTIAGO ORIENTE').clasificacion).toBe('NUEVA');
        expect(f('MAIPO NORTE').clasificacion).toBe('NUEVA');
        expect(p.filas[0]).toMatchObject({ nombre_original: 'ARAUCO', clubes: 2, rodeos_historicos: 10 });
        expect(p.resumen.duplicados_en_archivo).toBe(1);
    });

    test('FEDERACION y FEDERACION DEL RODEO CHILENO se detectan como posible misma entidad y caso especial', () => {
        const p = previewAsociaciones(buf, { nombresEnUso: ['FEDERACION'] });
        const fed = p.filas.find(x => x.nombre_original === 'FEDERACION DEL RODEO CHILENO');
        expect(fed.clasificacion).toBe('CASO_ESPECIAL');
        expect(fed.coincidencias).toEqual([{ nombre: 'FEDERACION', origen: 'rodeos_actuales' }]);
        expect(fed.sugerencia).toMatchObject({ es_especial: true, incluir_en_alertas: false, accion: 'alias' });
        expect(p.nombres_en_uso_sin_correspondencia).toEqual([{ nombre: 'FEDERACION', posibles_coincidencias_en_archivo: ['FEDERACION DEL RODEO CHILENO'] }]);
        expect(canonico('federacion del rodeo chileno')).toBe('federacion');
    });

    test('con catálogo existente: YA_EXISTE, ALIAS_EXISTENTE y POSIBLE_COINCIDENCIA', () => {
        const p = previewAsociaciones(buf, {
            catalogo: [aso('1', 'ARAUCO'), aso('9', 'FEDERACION', { es_especial: true })],
            alias: [{ asociacion_id: '1', alias: 'SANTIAGO', alias_normalizado: 'santiago' }]
        });
        const c = n => p.filas.find(x => x.nombre_original === n).clasificacion;
        expect(c('ARAUCO')).toBe('YA_EXISTE');
        expect(c('SANTIAGO')).toBe('ALIAS_EXISTENTE');
        expect(c('FEDERACION DEL RODEO CHILENO')).toBe('CASO_ESPECIAL');
        expect(p.filas.find(x => x.nombre_original === 'FEDERACION DEL RODEO CHILENO').coincidencias[0]).toEqual({ nombre: 'FEDERACION', origen: 'catalogo' });
    });

    test('archivo sin hoja "Resumen" es rechazado', () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'Otra');
        expect(() => previewAsociaciones(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))).toThrow(/Resumen/);
    });
});

describe('confirmarAsociaciones (solo decisiones explícitas sobre nombres del archivo)', () => {
    const buf = libroResumen([['ARAUCO', '', 10], ['FEDERACION DEL RODEO CHILENO', '', 1]]);
    function dbFake() {
        const llamadas = [];
        const db = { llamadas, from: jest.fn(tabla => {
            const c = { tabla };
            c.insert = v => { llamadas.push({ tabla, op: 'insert', v }); return c; };
            c.upsert = (v, o) => { llamadas.push({ tabla, op: 'upsert', v, o }); c.ultimo = v; return c; };
            c.update = v => { llamadas.push({ tabla, op: 'update', v }); return c; };
            c.select = () => c; c.eq = () => c; c.limit = () => c;
            c.single = () => Promise.resolve({ data: { id: 'imp-1' }, error: null });
            c.then = (res) => Promise.resolve({ data: c.ultimo ? [{ id: 'nuevo-' + tabla }] : [], error: null }).then(res);
            return c;
        }) };
        return db;
    }
    test('crea solo lo decidido, ignora nombres que no están en el archivo y registra la importación', async () => {
        const db = dbFake();
        const r = await confirmarAsociaciones(buf, [
            { nombre_normalizado: 'arauco', accion: 'crear', zona: 'SUR' },
            { nombre_normalizado: 'federacion del rodeo chileno', accion: 'crear', es_especial: true },
            { nombre_normalizado: 'inventada', accion: 'crear' },
            { nombre_normalizado: 'arauco', accion: 'borrar' }
        ], { db, actorId: 'admin-1' });
        expect(r.creadas).toBe(2);
        expect(r.rechazadas.length).toBe(2);
        const ups = db.llamadas.filter(c => c.tabla === 'asociaciones' && c.op === 'upsert');
        expect(ups[1].v).toMatchObject({ es_especial: true, incluir_en_alertas: false });
        expect(ups[0].o).toEqual({ onConflict: 'nombre_normalizado', ignoreDuplicates: true });
        expect(db.llamadas.find(c => c.tabla === 'importaciones' && c.op === 'insert').v).toMatchObject({ tipo: 'catalogo_asociaciones', created_by: 'admin-1' });
    });

    test('alias de un nombre en uso que NO está en el archivo ("FEDERACION" → FEDERACION DEL RODEO CHILENO); nunca se crea como asociación propia', async () => {
        const db = dbFake();
        const r = await confirmarAsociaciones(buf, [
            { nombre_normalizado: 'federacion del rodeo chileno', accion: 'crear', es_especial: true },
            { nombre_normalizado: 'federacion', accion: 'alias', destino_normalizado: 'federacion del rodeo chileno' },
            { nombre_normalizado: 'otra cosa', accion: 'alias', destino_normalizado: 'arauco' },
            { nombre_normalizado: 'federacion', accion: 'crear' }
        ], { db, actorId: 'admin-1', nombresEnUso: ['FEDERACION', 'ARAUCO'] });
        const alias = db.llamadas.filter(c => c.tabla === 'asociacion_alias' && c.op === 'upsert');
        expect(alias.length).toBe(1);
        expect(alias[0].v).toMatchObject({ alias: 'FEDERACION', alias_normalizado: 'federacion' });
        expect(r.alias).toBe(1);
        expect(r.rechazadas.length).toBe(2);     // "otra cosa" no está en uso ni en el archivo; "federacion" no se puede crear como propia
        expect(db.llamadas.filter(c => c.tabla === 'asociaciones' && c.op === 'upsert').length).toBe(1);
    });
});
