// Importación histórica — FASE 1 (vista previa). Sin BD real: base en memoria que REGISTRA cualquier escritura.
const XLSX = require('xlsx');
const S = require('./importacionHistorica');
const { ESTADOS } = S;

// ── Base en memoria (solo lectura; toda escritura se anota y hace fallar los tests) ──
function crearDb(tablas) {
    const escrituras = [];
    const from = (tabla) => {
        const q = { filtros: [], desde: 0, hasta: 1e9 };
        const ejecutar = () => {
            let filas = (tablas[tabla] || []).slice();
            for (const f of q.filtros) filas = filas.filter(f);
            return { data: filas.slice(q.desde, q.hasta + 1), error: null };
        };
        const api = {
            select() { return api; },
            eq(k, v) { q.filtros.push(r => r[k] === v); return api; },
            neq(k, v) { q.filtros.push(r => r[k] !== v); return api; },
            gte(k, v) { q.filtros.push(r => r[k] >= v); return api; },
            lte(k, v) { q.filtros.push(r => r[k] <= v); return api; },
            in(k, vs) { q.filtros.push(r => vs.includes(r[k])); return api; },
            order() { return api; },
            range(d, h) { q.desde = d; q.hasta = h; return api; },
            maybeSingle() { const { data } = ejecutar(); return Promise.resolve({ data: data[0] || null, error: null }); },
            then(ok, ko) { return Promise.resolve(ejecutar()).then(ok, ko); }
        };
        for (const m of ['insert', 'update', 'upsert', 'delete']) api[m] = (...a) => { escrituras.push({ tabla, op: m, a }); return api; };
        return api;
    };
    return { from, rpc: (...a) => { escrituras.push({ op: 'rpc', a }); return Promise.resolve({ data: null, error: null }); }, escrituras };
}

const TEMP = { id: 'T1', nombre: '2025-2026', fecha_inicio: '2025-04-01', fecha_fin: '2026-03-31', activa: false };
const base = () => ({
    temporadas: [TEMP, { id: 'T2', nombre: '2026-2027', fecha_inicio: '2026-04-01', fecha_fin: '2027-03-31', activa: true }, { id: 'T0', nombre: '2024-2025', fecha_inicio: '2024-04-01', fecha_fin: '2025-03-31', activa: false }],
    asociaciones: [
        { id: 'A1', nombre: 'Asociación Osorno', nombre_normalizado: 'osorno', activa: true },
        { id: 'A2', nombre: 'Asociación Valdivia', nombre_normalizado: 'valdivia', activa: true },
        { id: 'A3', nombre: 'Asociación Chillán', nombre_normalizado: 'chillan', activa: true },
        { id: 'A4', nombre: 'Asociación Chillan Viejo', nombre_normalizado: 'chillan viejo', activa: true }
    ],
    asociacion_alias: [{ asociacion_id: 'A2', alias: 'Valdivia Sur', alias_normalizado: 'valdivia sur' }, { asociacion_id: 'A1', alias: 'Choque', alias_normalizado: 'choque' }, { asociacion_id: 'A2', alias: 'Choque', alias_normalizado: 'choque' }],
    categorias_rodeo: [{ id: 'C1', nombre: 'Primera', activo: true }, { id: 'C2', nombre: 'Segunda', activo: true }, { id: 'C3', nombre: 'Tercera', activo: true }, { id: 'C4', nombre: 'Cuarta', activo: true }, { id: 'C5', nombre: 'Especial', activo: true }],
    tipos_rodeo: [
        { id: 'TP1', nombre: 'Rodeo Libre', duracion_dias: 1, categoria_rodeo_id: 'C3', activo: true },
        { id: 'TP2', nombre: 'Clasificatorio Zona', duracion_dias: 2, categoria_rodeo_id: 'C1', activo: true },
        { id: 'TP3', nombre: 'Rodeo Mixto', duracion_dias: 1, categoria_rodeo_id: null, activo: true },
        { id: 'TP4', nombre: 'Rodeo Doble', duracion_dias: 1, categoria_rodeo_id: 'C2', activo: true },
        { id: 'TP5', nombre: 'rodeo doble', duracion_dias: 1, categoria_rodeo_id: 'C4', activo: true }
    ],
    usuarios_pagados: [
        { id: 'J1', nombre_completo: 'Juan Pérez', categoria: 'Primera', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J2', nombre_completo: 'María González', categoria: 'Segunda', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J3', nombre_completo: 'Pedro Inactivo', categoria: 'Tercera', activo: false, estado_usuario: 'inactivo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J4', nombre_completo: 'Ana Receso', categoria: 'Cuarta', activo: true, estado_usuario: 'receso', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J5', nombre_completo: 'Homónimo Uno', categoria: 'Primera', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J6', nombre_completo: 'Homonimo uno', categoria: 'Segunda', activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' },
        { id: 'J7', nombre_completo: 'Usuario Prueba', categoria: 'Primera', activo: true, estado_usuario: 'activo', es_prueba: true, tipo_persona: 'jurado' },
        { id: 'J8', nombre_completo: 'Sin Categoria', categoria: null, activo: true, estado_usuario: 'activo', es_prueba: false, tipo_persona: 'jurado' }
    ],
    rodeos: [], asignaciones: [], rodeo_notas_secundarias: [], evaluaciones: [], notas_rodeo: []
});

const COLS = S.ENCABEZADOS;
const fila = (o = {}) => ({ Temporada: '', Fecha: '15-02-2026', Club: 'Club Rio Bueno', 'Asociación': 'Osorno', 'Tipo Rodeo': 'Rodeo Libre', 'Categoría del Rodeo': '', 'Nombre Jurado': 'Juan Pérez', 'Nota Delegado': '', 'Nota Comisión': '', 'Nota Deportiva': '', 'Casos por WhatsApp': '', ...o });
function excel(filas, { hoja = 'CARGA_HISTORICA', cols = COLS } = {}) {
    const aoa = [cols, ...filas.map(f => cols.map(c => (c in f ? f[c] : '')))];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), hoja);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function preview(filas, tablas = base(), opts = {}) {
    const db = crearDb(tablas);
    const r = await S.generarPreview({ buffer: opts.buffer || excel(filas, opts), nombreArchivo: 'x.xlsx', temporadaId: 'temporadaId' in opts ? opts.temporadaId : 'T1' }, db);
    return { r, db };
}
const est = r => r.filas.map(f => f.estado);
const codigos = f => [...f.errores, ...f.conflictos].map(x => x.codigo);

// ── Archivo ──────────────────────────────────────────────────────────────
describe('lectura del archivo', () => {
    test('archivo corrupto / vacío → ARCHIVO_CORRUPTO', async () => {
        const e = await preview([], base(), { buffer: Buffer.from('esto no es un excel') }).catch(x => x);
        expect(['ARCHIVO_CORRUPTO', 'HOJA_NO_ENCONTRADA']).toContain(e.codigo);   // texto plano: nunca produce una vista previa
        expect(e.status).toBe(400);
        await expect(preview([], base(), { buffer: Buffer.alloc(0) })).rejects.toMatchObject({ codigo: 'ARCHIVO_CORRUPTO' });
    });
    test('hoja CARGA_HISTORICA inexistente', async () => {
        await expect(preview([fila()], base(), { hoja: 'Hoja1' })).rejects.toMatchObject({ codigo: 'HOJA_NO_ENCONTRADA' });
    });
    test('encabezados faltantes / no reconocidos', async () => {
        const e = await preview([fila()], base(), { cols: COLS.filter(c => c !== 'Nota Comisión') }).catch(x => x);
        expect(e.codigo).toBe('ENCABEZADOS_INCORRECTOS');
        expect(e.detalle.faltantes).toEqual(['Nota Comisión']);
        const e2 = await preview([fila()], base(), { cols: [...COLS, 'Columna Extra'] }).catch(x => x);
        expect(e2.detalle.inesperados).toEqual(['Columna Extra']);
    });
    test('encabezados con distinta capitalización/tildes se aceptan', async () => {
        const cols = COLS.map(c => c.toUpperCase()), f = fila(), g = {};
        COLS.forEach((c, i) => { g[cols[i]] = f[c]; });
        const { r } = await preview([g], base(), { cols });
        expect(r.filas[0].estado).toBe(ESTADOS.LISTO);
    });
    test('hoja sin filas de datos → SIN_FILAS; filas vacías se ignoran', async () => {
        await expect(preview([])).rejects.toMatchObject({ codigo: 'SIN_FILAS' });
        const { r } = await preview([fila(), {}, fila({ 'Nombre Jurado': 'María González' })]);
        expect(r.resumen.filas_excel).toBe(2);
        expect(r.filas.map(f => f.fila)).toEqual([2, 4]);   // números de fila reales de Excel
    });
});

// ── Temporada ────────────────────────────────────────────────────────────
describe('temporada', () => {
    test('sin temporada, inexistente o no habilitada', async () => {
        await expect(preview([fila()], base(), { temporadaId: '' })).rejects.toMatchObject({ codigo: 'TEMPORADA_REQUERIDA' });
        await expect(preview([fila()], base(), { temporadaId: 'XX' })).rejects.toMatchObject({ codigo: 'TEMPORADA_INEXISTENTE' });
        await expect(preview([fila()], base(), { temporadaId: 'T2' })).rejects.toMatchObject({ codigo: 'TEMPORADA_NO_HABILITADA' });
    });
    test('Temporada vacía en Excel → usa la seleccionada; igual OK; distinta → error', async () => {
        const { r } = await preview([fila({ Temporada: '' }), fila({ Temporada: '2025-2026', 'Nombre Jurado': 'María González' }), fila({ Temporada: '2024-2025', 'Nombre Jurado': 'Ana Receso' })]);
        expect(est(r)[0]).toBe(ESTADOS.LISTO);
        expect(est(r)[1]).toBe(ESTADOS.LISTO);
        expect(est(r)[2]).toBe(ESTADOS.TEMPORADA_NO_COINCIDE);
    });
    test('NO crea temporadas ni escribe nada', async () => {
        const { db } = await preview([fila()]);
        expect(db.escrituras).toEqual([]);
    });
});

// ── Fecha ────────────────────────────────────────────────────────────────
describe('fecha (DD-MM-AAAA)', () => {
    test.each([['15-02-2026'], ['15/02/2026'], ['01-01-2026'], ['31-03-2026'], ['2026-02-15']])('%s válida', async (f) => {
        const { r } = await preview([fila({ Fecha: f })]);
        expect(r.filas[0].errores).toEqual([]);
    });
    test('serial de Excel válido', async () => {
        const serial = 46068; // 15-02-2026
        expect(S.parsearFecha(serial)).toEqual({ ok: true, iso: '2026-02-15' });
    });
    test.each([['31-02-2026'], ['99-99-2026'], ['abc'], [''], ['2026/13/01']])('%j inválida', async (f) => {
        const { r } = await preview([fila({ Fecha: f })]);
        expect(r.filas[0].estado).toBe(ESTADOS.FECHA_INVALIDA);
    });
    test('DD-MM y MM-DD no se confunden: 03-04-2026 es 3 de abril (fuera del período)', async () => {
        expect(S.parsearFecha('03-04-2026').iso).toBe('2026-04-03');
        const { r } = await preview([fila({ Fecha: '03-04-2026' })]);
        expect(r.filas[0].estado).toBe(ESTADOS.FECHA_FUERA);
    });
    test('fuera del período', async () => {
        const { r } = await preview([fila({ Fecha: '31-12-2025' }), fila({ Fecha: '01-04-2026', 'Nombre Jurado': 'María González' })]);
        expect(est(r)).toEqual([ESTADOS.FECHA_FUERA, ESTADOS.FECHA_FUERA]);
    });
});

// ── Asociación, club, tipo, categoría ───────────────────────────────────
describe('asociación / club / tipo / categoría', () => {
    test('asociación: canónica, alias, tildes y mayúsculas; no encontrada; ambigua', async () => {
        const { r } = await preview([
            fila({ 'Asociación': 'ASOCIACIÓN OSORNO' }),
            fila({ 'Asociación': 'valdivia sur', 'Nombre Jurado': 'María González' }),
            fila({ 'Asociación': 'Chillán', 'Nombre Jurado': 'Ana Receso' }),
            fila({ 'Asociación': 'Marte', 'Nombre Jurado': 'Pedro Inactivo' }),
            fila({ 'Asociación': 'Choque', 'Nombre Jurado': 'Sin Categoria' })
        ]);
        expect(r.filas[0].asociacion).toMatchObject({ canonica: 'Asociación Osorno', id: 'A1' });
        expect(r.filas[1].asociacion.id).toBe('A2');
        expect(r.filas[2].asociacion.id).toBe('A3');
        expect(r.filas[3].estado).toBe(ESTADOS.ASOC_NO_ENCONTRADA);
        expect(r.filas[4].estado).toBe(ESTADOS.ASOC_AMBIGUA);
    });
    test('club libre: "Sin club" y vacío son válidos, nunca "club no encontrado"', async () => {
        const { r } = await preview([fila({ Club: 'Sin club' }), fila({ Club: '', 'Nombre Jurado': 'María González' }), fila({ Club: 'Club Inventado XYZ', 'Nombre Jurado': 'Ana Receso' })]);
        expect(est(r)).toEqual([ESTADOS.LISTO, ESTADOS.LISTO, ESTADOS.LISTO]);
        expect(r.filas[1].club).toBe('Sin club');
        expect(JSON.stringify(r)).not.toMatch(/club no encontrado/i);
    });
    test('tipo: encontrado con ID, duración y categoría derivada; no encontrado; ambiguo', async () => {
        const { r } = await preview([
            fila({ 'Tipo Rodeo': 'clasificatorio zona' }),
            fila({ 'Tipo Rodeo': 'Nada', 'Nombre Jurado': 'María González' }),
            fila({ 'Tipo Rodeo': 'RODEO  DOBLE', 'Nombre Jurado': 'Ana Receso' }),
            fila({ 'Tipo Rodeo': 'rodeo doble', 'Nombre Jurado': 'Pedro Inactivo' })
        ]);
        expect(r.filas[0].tipo).toMatchObject({ id: 'TP2', nombre: 'Clasificatorio Zona', duracion_dias: 2, categoria_derivada: 'Primera' });
        expect(r.filas[1].estado).toBe(ESTADOS.TIPO_NO_ENCONTRADO);
        expect(r.filas[2].estado).toBe(ESTADOS.TIPO_AMBIGUO);
        expect(r.filas[3].tipo.id).toBe('TP5');                 // coincidencia exacta única gana
    });
    test('categoría: válida, inválida, derivada del tipo cuando viene vacía', async () => {
        const { r } = await preview([
            fila({ 'Categoría del Rodeo': 'primera' }),
            fila({ 'Categoría del Rodeo': 'Quinta', 'Nombre Jurado': 'María González' }),
            fila({ 'Categoría del Rodeo': '', 'Nombre Jurado': 'Ana Receso' }),
            fila({ 'Tipo Rodeo': 'Rodeo Mixto', 'Categoría del Rodeo': '', 'Nombre Jurado': 'Pedro Inactivo' })
        ]);
        expect(r.filas[0].categoria).toMatchObject({ nombre: 'Primera', derivada: false });
        expect(r.filas[1].estado).toBe(ESTADOS.CATEGORIA_INVALIDA);
        expect(r.filas[2].categoria).toMatchObject({ nombre: 'Tercera', derivada: true });
        expect(r.filas[3].categoria.nombre).toBeNull();
        expect(r.filas[3].advertencias.some(a => /no define una categoría/.test(a.mensaje))).toBe(true);
    });
});

// ── Jurados ──────────────────────────────────────────────────────────────
describe('jurados', () => {
    test('encontrado (tildes/mayúsculas), inactivo y receso aceptados con su estado actual', async () => {
        const { r } = await preview([
            fila({ 'Nombre Jurado': 'JUAN PEREZ' }),
            fila({ 'Nombre Jurado': 'Pedro Inactivo' }),
            fila({ 'Nombre Jurado': 'Ana Receso' })
        ]);
        expect(r.filas[0].jurado).toMatchObject({ id: 'J1', estado_actual: 'activo', categoria_actual: 'Primera', categoria_aplicada_futura: 'Primera' });
        expect(r.filas[1]).toMatchObject({ estado: ESTADOS.LISTO });
        expect(r.filas[1].jurado.estado_actual).toBe('inactivo');
        expect(r.filas[2].jurado.estado_actual).toBe('receso');
        expect(r.filas[1].advertencias.length).toBeGreaterThan(0);
    });
    test('no encontrado, ambiguo (no se elige), es_prueba excluido, vacío', async () => {
        const { r } = await preview([
            fila({ 'Nombre Jurado': 'Fulano Inexistente' }),
            fila({ 'Nombre Jurado': 'Homónimo Uno' }),
            fila({ 'Nombre Jurado': 'Usuario Prueba' }),
            fila({ 'Nombre Jurado': '' })
        ]);
        expect(r.filas[0].estado).toBe(ESTADOS.JURADO_NO_ENCONTRADO);
        expect(r.filas[0].errores[0].mensaje).toMatch(/No se encontró un jurado llamado Fulano Inexistente en el sistema/);
        expect(r.filas[1].estado).toBe(ESTADOS.JURADO_AMBIGUO);
        expect(r.filas[1].jurado.id).toBeNull();
        expect(r.filas[2].estado).toBe(ESTADOS.JURADO_NO_ENCONTRADO);
        expect(r.filas[3].estado).toBe(ESTADOS.ERROR);
        expect(r.resumen.jurados_no_encontrados).toBe(2);
        expect(r.resumen.jurados_ambiguos).toBe(1);
    });
    test('usa la categoría ACTUAL del jurado; sin categoría → advertencia', async () => {
        const { r } = await preview([fila({ 'Nombre Jurado': 'Sin Categoria' })]);
        expect(r.filas[0].jurado.categoria_aplicada_futura).toBeNull();
        expect(r.filas[0].advertencias.some(a => /sin categoría/.test(a.mensaje))).toBe(true);
    });
    test('un rodeo con dos jurados = un rodeo y dos asignaciones; el mismo jurado en dos rodeos distintos es válido', async () => {
        const { r } = await preview([fila(), fila({ 'Nombre Jurado': 'María González' }), fila({ Fecha: '16-02-2026' })]);
        expect(r.resumen).toMatchObject({ filas_excel: 3, rodeos_unicos: 2, rodeos_nuevos: 2, jurados_a_relacionar: 3 });
        expect(r.rodeos.find(x => x.jurados.length === 2)).toBeTruthy();
    });
    test('dos rodeos el mismo día, mismo club pero distinta asociación / tipo son rodeos distintos', async () => {
        const { r } = await preview([fila(), fila({ 'Asociación': 'Valdivia', 'Nombre Jurado': 'María González' }), fila({ 'Tipo Rodeo': 'Clasificatorio Zona', 'Nombre Jurado': 'Ana Receso' })]);
        expect(r.resumen.rodeos_unicos).toBe(3);
    });
    test('duplicado exacto (mismo rodeo + mismo jurado)', async () => {
        const { r } = await preview([fila(), fila({ Club: ' club  RIO bueno ' })]);
        expect(est(r)).toEqual([ESTADOS.DUPLICADO_ARCHIVO, ESTADOS.DUPLICADO_ARCHIVO]);
    });
});

// ── Notas ────────────────────────────────────────────────────────────────
describe('notas y casos por WhatsApp', () => {
    test.each([['1.0', 1], ['7', 7], ['6,5', 6.5], [5.25, 5.25], ['', null]])('nota %j válida → %p', (n, esperado) => {
        expect(S.parsearNota(n)).toEqual({ ok: true, valor: esperado });
    });
    test.each([['0.9'], ['7.1'], ['abc'], ['-'], ['N/A'], ['-3'], ['6.5 pts']])('nota %j inválida', (n) => {
        expect(S.parsearNota(n).ok).toBe(false);
    });
    test('estados de nota inválida por campo', async () => {
        const { r } = await preview([
            fila({ 'Nota Delegado': '8' }),
            fila({ 'Nota Comisión': 'x', 'Nombre Jurado': 'María González' }),
            fila({ 'Nota Deportiva': '0.5', 'Nombre Jurado': 'Ana Receso' })
        ]);
        expect(est(r)).toEqual([ESTADOS.NOTA_DELEGADO_INVALIDA, ESTADOS.NOTA_COMISION_INVALIDA, ESTADOS.NOTA_DEPORTIVA_INVALIDA]);
    });
    test('Nota Deportiva es por jurado (dos jurados, dos notas) y no genera conflicto', async () => {
        const { r } = await preview([fila({ 'Nota Deportiva': 6.5 }), fila({ 'Nombre Jurado': 'María González', 'Nota Deportiva': 5.5 })]);
        expect(est(r)).toEqual([ESTADOS.LISTO, ESTADOS.LISTO]);
        expect(r.resumen.notas_deportivas_nuevas).toBe(2);
    });
    test('Delegado/Comisión son por rodeo: iguales OK, vacío junto a valor = complemento, distintas = conflicto en archivo', async () => {
        let x = await preview([fila({ 'Nota Delegado': 6 }), fila({ 'Nombre Jurado': 'María González', 'Nota Delegado': 6 })]);
        expect(est(x.r)).toEqual([ESTADOS.LISTO, ESTADOS.LISTO]);
        expect(x.r.resumen.notas_delegado_nuevas).toBe(1);        // una sola nota por rodeo
        x = await preview([fila({ 'Nota Comisión': 6 }), fila({ 'Nombre Jurado': 'María González' })]);
        expect(est(x.r)).toEqual([ESTADOS.LISTO, ESTADOS.LISTO]);
        expect(x.r.filas[1].advertencias.length).toBe(1);
        x = await preview([fila({ 'Nota Delegado': 6 }), fila({ 'Nombre Jurado': 'María González', 'Nota Delegado': 5 })]);
        expect(est(x.r)).toEqual([ESTADOS.CONFLICTO_DELEGADO_ARCHIVO, ESTADOS.CONFLICTO_DELEGADO_ARCHIVO]);
        x = await preview([fila({ 'Nota Comisión': 6 }), fila({ 'Nombre Jurado': 'María González', 'Nota Comisión': 5 })]);
        expect(est(x.r)[0]).toBe(ESTADOS.CONFLICTO_COMISION_ARCHIVO);
    });
    test('Casos por WhatsApp: vacío = 0, entero ≥ 0, inválidos rechazados', async () => {
        for (const [v, ok, val] of [['', true, 0], [0, true, 0], [3, true, 3], ['4', true, 4], [-1, false], [1.5, false], ['x', false]]) {
            const p = S.parsearCasos(v);
            expect(p.ok).toBe(ok); if (ok) expect(p.valor).toBe(val);
        }
        const { r } = await preview([fila({ 'Casos por WhatsApp': -1 })]);
        expect(r.filas[0].estado).toBe(ESTADOS.CASOS_INVALIDO);
    });
    test('Casos por WhatsApp es por rodeo: iguales OK, distintos entre jurados del mismo rodeo = conflicto', async () => {
        let x = await preview([fila({ 'Casos por WhatsApp': 2 }), fila({ 'Nombre Jurado': 'María González', 'Casos por WhatsApp': 2 })]);
        expect(est(x.r)).toEqual([ESTADOS.LISTO, ESTADOS.LISTO]);
        expect(x.r.resumen).toMatchObject({ casos_whatsapp_informados: 1, casos_whatsapp_total: 2 });
        x = await preview([fila({ 'Casos por WhatsApp': 2 }), fila({ 'Nombre Jurado': 'María González', 'Casos por WhatsApp': 3 })]);
        expect(est(x.r)).toEqual([ESTADOS.CONFLICTO_CASOS_ARCHIVO, ESTADOS.CONFLICTO_CASOS_ARCHIVO]);
    });
    test('casos > 0 sin evaluación → EVALUACIÓN REQUERIDA (informativo); casos 0 → no necesaria', async () => {
        const { r } = await preview([fila({ 'Casos por WhatsApp': 2 }), fila({ Fecha: '16-02-2026' })]);
        expect(r.filas[0].evaluacion.estado).toBe('REQUERIDA');
        expect(r.filas[0].etiquetas).toContain(ESTADOS.EVALUACION_REQUERIDA);
        expect(r.filas[1].evaluacion.estado).toBe('NO_NECESARIA');
        expect(r.resumen.evaluaciones_requeridas_casos_whatsapp).toBe(1);
    });
});

// ── Comparación con la base ──────────────────────────────────────────────
function conRodeoExistente(extra = {}) {
    const t = base();
    t.rodeos = [{ id: 'R1', club: 'club rio bueno', asociacion: 'Asociación Osorno', fecha: '2026-02-15', tipo_rodeo_id: 'TP1', categoria_rodeo_nombre: 'Tercera', estado: 'activo', temporada_id: 'T1' }];
    Object.assign(t, extra);
    return t;
}
describe('comparación con datos existentes', () => {
    test('rodeo nuevo vs existente (club normalizado, asociación canónica/alias)', async () => {
        const { r } = await preview([fila({ 'Asociación': 'osorno' }), fila({ Fecha: '20-02-2026', 'Nombre Jurado': 'María González' })], conRodeoExistente());
        expect(r.filas[0].rodeo).toMatchObject({ estado: 'EXISTENTE', id: 'R1' });
        expect(r.filas[1].rodeo.estado).toBe('NUEVO');
        expect(r.resumen).toMatchObject({ rodeos_nuevos: 1, rodeos_existentes: 1 });
    });
    test('rodeo anulado no cuenta como existente', async () => {
        const t = conRodeoExistente(); t.rodeos[0].estado = 'anulado';
        const { r } = await preview([fila()], t);
        expect(r.filas[0].rodeo.estado).toBe('NUEVO');
    });
    test('rodeo existente + jurado nuevo → jurado a asociar; jurado ya asignado → ya asociado', async () => {
        const t = conRodeoExistente({ asignaciones: [{ id: 'AS1', rodeo_id: 'R1', usuario_pagado_id: 'J1', tipo_persona: 'jurado', estado: 'activo', estado_designacion: 'aceptado' }] });
        const { r } = await preview([fila(), fila({ 'Nombre Jurado': 'María González' })], t);
        expect(r.filas[0].asignacion.estado).toBe('EXISTENTE');
        expect(r.filas[0].estado).toBe(ESTADOS.RODEO_YA_EXISTE);
        expect(r.filas[0].etiquetas).toEqual(expect.arrayContaining([ESTADOS.JURADO_YA_ASOCIADO, ESTADOS.YA_REGISTRADO]));
        expect(r.filas[1].asignacion.estado).toBe('NUEVA');
        expect(r.filas[1].estado).toBe(ESTADOS.RODEO_EXISTE_FALTANTES);
        expect(r.filas[1].etiquetas).toContain(ESTADOS.JURADO_A_ASOCIAR);
        expect(r.resumen).toMatchObject({ jurados_ya_relacionados: 1, jurados_a_relacionar: 1, filas_sin_cambios: 1 });
    });
    test('nota deportiva existente: igual → sin cambios; distinta → conflicto; sin nota → dato faltante', async () => {
        const t = conRodeoExistente({
            asignaciones: [{ id: 'AS1', rodeo_id: 'R1', usuario_pagado_id: 'J1', tipo_persona: 'jurado', estado: 'activo' }, { id: 'AS2', rodeo_id: 'R1', usuario_pagado_id: 'J2', tipo_persona: 'jurado', estado: 'activo' }, { id: 'AS3', rodeo_id: 'R1', usuario_pagado_id: 'J4', tipo_persona: 'jurado', estado: 'activo' }],
            notas_rodeo: [{ asignacion_id: 'AS1', nota: 6.5 }, { asignacion_id: 'AS2', nota: 6.0 }]
        });
        const { r } = await preview([fila({ 'Nota Deportiva': 6.5 }), fila({ 'Nombre Jurado': 'María González', 'Nota Deportiva': 5.0 }), fila({ 'Nombre Jurado': 'Ana Receso', 'Nota Deportiva': 6 })], t);
        expect(r.filas[0].estado).toBe(ESTADOS.RODEO_YA_EXISTE);
        expect(r.filas[1].estado).toBe(ESTADOS.CONFLICTO_DEPORTIVA);
        expect(r.filas[2].estado).toBe(ESTADOS.RODEO_EXISTE_FALTANTES);
        expect(r.filas[2].acciones_futuras.join()).toMatch(/NOTA DEPORTIVA/);
    });
    test('Delegado/Comisión existentes: igual, faltante (NULL) y conflicto', async () => {
        let t = conRodeoExistente({ rodeo_notas_secundarias: [{ rodeo_id: 'R1', nota_delegado: 6.0, nota_comision: null }] });
        let x = await preview([fila({ 'Nota Delegado': 6, 'Nota Comisión': 5.5 })], t);
        expect(x.r.filas[0].estado).toBe(ESTADOS.RODEO_EXISTE_FALTANTES);
        expect(x.r.rodeos[0]).toMatchObject({ delegado_comparacion: 'IGUAL', comision_comparacion: 'FALTANTE' });
        x = await preview([fila({ 'Nota Delegado': 5 })], t);
        expect(x.r.filas[0].estado).toBe(ESTADOS.CONFLICTO_DELEGADO);
        t = conRodeoExistente({ rodeo_notas_secundarias: [{ rodeo_id: 'R1', nota_delegado: 6.0, nota_comision: 5.0 }] });
        x = await preview([fila({ 'Nota Comisión': 6 })], t);
        expect(x.r.filas[0].estado).toBe(ESTADOS.CONFLICTO_COMISION);
    });
    test('Casos por WhatsApp vs evaluación existente: igual → sin cambios; distinto → conflicto (incluso si existente es 0)', async () => {
        const t = conRodeoExistente({ evaluaciones: [{ id: 'E1', rodeo_id: 'R1', estado: 'borrador', casos_whatsapp: 2, anulada: false }] });
        let x = await preview([fila({ 'Casos por WhatsApp': 2 })], t);
        expect(x.r.filas[0].evaluacion.comparacion).toBe(ESTADOS.YA_REGISTRADO);
        expect(x.r.resumen.evaluaciones_existentes).toBe(1);
        x = await preview([fila({ 'Casos por WhatsApp': 5 })], t);
        expect(x.r.filas[0].estado).toBe(ESTADOS.CONFLICTO_CASOS);
        t.evaluaciones[0].casos_whatsapp = 0;
        x = await preview([fila({ 'Casos por WhatsApp': 5 })], t);
        expect(x.r.filas[0].estado).toBe(ESTADOS.CONFLICTO_CASOS);   // 0 no se asume sobrescribible
        expect(x.r.filas[0].conflictos[0].mensaje).toMatch(/valor por defecto/);
    });
    test('categoría distinta a la del rodeo existente: solo advertencia', async () => {
        const { r } = await preview([fila({ 'Categoría del Rodeo': 'Primera' })], conRodeoExistente());
        expect(r.filas[0].advertencias.some(a => /Tercera/.test(a.mensaje))).toBe(true);
        expect(r.filas[0].errores).toEqual([]);
    });
    test('dos rodeos existentes que coinciden → error (no se elige)', async () => {
        const t = conRodeoExistente(); t.rodeos.push({ ...t.rodeos[0], id: 'R9' });
        const { r } = await preview([fila()], t);
        expect(r.filas[0].estado).toBe(ESTADOS.ERROR);
    });
});

// ── Preview / seguridad ──────────────────────────────────────────────────
describe('vista previa: estructura, pagos y CERO escrituras', () => {
    test('estructura de respuesta y criterios (pago futuro $0, asignación aceptada, no publicada)', async () => {
        const { r } = await preview([fila({ 'Nota Deportiva': 6, 'Nota Delegado': 6, 'Nota Comisión': 6, 'Casos por WhatsApp': 1 })]);
        expect(r).toMatchObject({ modo: 'VISTA_PREVIA', escribe_base_de_datos: false, puede_confirmar: true });
        expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.temporada).toMatchObject({ id: 'T1', nombre: '2025-2026' });
        expect(r.periodo_permitido).toEqual({ desde: '2026-01-01', hasta: '2026-03-31' });
        expect(r.criterios.asignacion_historica_futura).toEqual({ estado: 'activo', estado_designacion: 'aceptado', publicado: false, pago_base_calculado: 0 });
        expect(r.filas[0].pago_futuro).toBe(0);
        expect(r.resumen.pago_futuro_historico).toBe(0);
        for (const k of ['archivo', 'temporada_seleccionada', 'filas_excel', 'rodeos_unicos', 'rodeos_nuevos', 'rodeos_existentes', 'jurados_encontrados', 'jurados_a_relacionar', 'jurados_ya_relacionados', 'jurados_no_encontrados', 'jurados_ambiguos', 'notas_delegado_nuevas', 'notas_comision_nuevas', 'notas_deportivas_nuevas', 'casos_whatsapp_informados', 'casos_whatsapp_total', 'evaluaciones_existentes', 'evaluaciones_requeridas_casos_whatsapp', 'filas_listas', 'filas_sin_cambios', 'filas_con_advertencias', 'filas_con_errores', 'filas_con_conflictos']) expect(r.resumen).toHaveProperty(k);
    });
    test('Nota Deportiva no se mezcla con nota_final ni con evaluaciones (criterio explícito)', async () => {
        const { r } = await preview([fila({ 'Nota Deportiva': 6 })]);
        expect(r.criterios.nota_deportiva).toMatch(/notas_rodeo/);
        expect(r.criterios.nota_deportiva).toMatch(/No usa evaluaciones\.nota_final/);
    });
    test('el preview NUNCA escribe: ni insert/update/upsert/delete ni rpc (caso completo con conflictos)', async () => {
        const t = conRodeoExistente({ evaluaciones: [{ id: 'E1', rodeo_id: 'R1', estado: 'borrador', casos_whatsapp: 0 }] });
        const { db, r } = await preview([fila({ 'Casos por WhatsApp': 3 }), fila({ 'Nombre Jurado': 'Nadie' }), fila({ Fecha: 'zzz' })], t);
        expect(r.resumen.filas_excel).toBe(3);
        expect(db.escrituras).toEqual([]);
    });
    test('no muta los datos de la base en memoria', async () => {
        const t = conRodeoExistente(); const antes = JSON.stringify(t);
        await preview([fila(), fila({ 'Nombre Jurado': 'María González' })], t);
        expect(JSON.stringify(t)).toBe(antes);
    });
    test('un mismo archivo dos veces da la misma vista previa (idempotente)', async () => {
        const f = [fila({ 'Nota Deportiva': 6 }), fila({ 'Nombre Jurado': 'Nadie' })];
        const a = (await preview(f)).r, b = (await preview(f)).r;
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });
    test('volumen: 1.200 filas se procesan en una sola vista previa', async () => {
        const filas = [];
        for (let i = 0; i < 1200; i++) filas.push(fila({ Fecha: `${String(1 + (i % 28)).padStart(2, '0')}-02-2026`, Club: `Club ${i}`, 'Nombre Jurado': i % 2 ? 'Juan Pérez' : 'María González' }));
        const { r } = await preview(filas);
        expect(r.resumen.filas_excel).toBe(1200);
        expect(r.resumen.rodeos_unicos).toBe(1200);
    });
    test('el módulo no contiene operaciones de escritura', () => {
        const src = require('fs').readFileSync(require.resolve('./importacionHistorica'), 'utf8');
        const sinHash = src.replace("createHash('sha256').update(buffer)", '');   // .update() del hash, no de la base
        expect(sinHash).not.toMatch(/\.(insert|update|upsert|delete)\(|\.rpc\(/);
    });
});

describe('temporadasHabilitadas', () => {
    test('solo lista temporadas existentes habilitadas (no crea)', async () => {
        const db = crearDb(base());
        const r = await S.temporadasHabilitadas(db);
        expect(r.temporadas.map(t => t.nombre)).toEqual(['2025-2026']);
        expect(r.temporadas[0].periodo_permitido).toEqual({ desde: '2026-01-01', hasta: '2026-03-31' });
        expect(db.escrituras).toEqual([]);
    });
});
