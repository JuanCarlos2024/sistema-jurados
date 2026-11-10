/**
 * Kit de pruebas del Resumen por jurado: un Supabase FALSO en memoria que
 * aplica de verdad los filtros usados por los reportes (eq/neq/gte/lte/
 * ilike/in sobre columnas propias o embebidas tipo `rodeos.fecha`, order,
 * range) e imita el límite max-rows=1000 de PostgREST. Más un dataset
 * sintético (octubre 2026) que cubre los casos financieros exigidos.
 *
 * Uso: jest.mock('<ruta>/config/supabase', () => require('<ruta>/services/resumenJurados.testkit').fake);
 * NUNCA se conecta a una base real.
 */

const MAX_ROWS = 1000;

function valorEn(row, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
}

function crearBuilder(fake, tabla) {
    const filtros = [];
    let orden = null;
    let rango = null;
    let limite = null;
    let modo = 'many';
    const b = {
        select() { return b; },
        eq(c, v)  { filtros.push(r => valorEn(r, c) === v); return b; },
        neq(c, v) { filtros.push(r => valorEn(r, c) !== v); return b; },
        gte(c, v) { filtros.push(r => valorEn(r, c) != null && valorEn(r, c) >= v); return b; },
        lte(c, v) { filtros.push(r => valorEn(r, c) != null && valorEn(r, c) <= v); return b; },
        in(c, vs) { filtros.push(r => vs.includes(valorEn(r, c))); return b; },
        ilike(c, patron) {
            const needle = String(patron).replace(/%/g, '').toLowerCase();
            filtros.push(r => String(valorEn(r, c) ?? '').toLowerCase().includes(needle));
            return b;
        },
        order(c, opts = {}) { if (!/\(/.test(c)) orden = { c, asc: opts.ascending !== false }; return b; },
        range(desde, hasta) { rango = [desde, hasta]; return b; },
        limit(n) { limite = n; return b; },
        maybeSingle() { modo = 'maybe'; return b; },
        single() { modo = 'single'; return b; },
        then(resolve, reject) {
            return Promise.resolve().then(() => {
                fake.llamadas.push(tabla);
                let rows = (fake.db[tabla] || []).filter(r => filtros.every(f => f(r)));
                if (orden) {
                    rows = rows.slice().sort((x, y) => {
                        const a = valorEn(x, orden.c), z = valorEn(y, orden.c);
                        return (a < z ? -1 : a > z ? 1 : 0) * (orden.asc ? 1 : -1);
                    });
                }
                if (rango) rows = rows.slice(rango[0], rango[1] + 1);
                if (limite != null) rows = rows.slice(0, limite);
                rows = rows.slice(0, MAX_ROWS);
                const copia = JSON.parse(JSON.stringify(rows));
                if (modo === 'maybe') return { data: copia[0] || null, error: null };
                if (modo === 'single') return copia[0] ? { data: copia[0], error: null } : { data: null, error: { message: 'no rows' } };
                return { data: copia, error: null, count: copia.length };
            }).then(resolve, reject);
        },
    };
    return b;
}

const fake = {
    db: {},
    llamadas: [],
    from(tabla) { return crearBuilder(fake, tabla); },
    rpc() { return Promise.resolve({ data: null, error: null }); },
};

// ─── Dataset sintético ────────────────────────────────────────────────────
// Montos de fantasía para pruebas: no corresponden a datos reales.
const PCT_RETENCION = 15.25; // provoca .5 en retenciones por rodeo (prueba de redondeo)

const USUARIOS = {
    U1: { id: 'U1', codigo_interno: 'USR-0001', nombre_completo: 'Agustín Correa Guzmán', rut: '11.111.111-1', categoria: 'A', tipo_persona: 'jurado' },
    U2: { id: 'U2', codigo_interno: 'USR-0002', nombre_completo: 'Alberto Esteban Saravia Retamal', rut: '22.222.222-2', categoria: 'B', tipo_persona: 'jurado' },
    U3: { id: 'U3', codigo_interno: 'USR-0003', nombre_completo: 'Ñuble Peña Muñoz', rut: '33.333.333-3', categoria: 'C', tipo_persona: 'jurado' },
    U4: { id: 'U4', codigo_interno: 'USR-0004', nombre_completo: 'Zoe Rechazos Solo', rut: '44.444.444-4', categoria: 'B', tipo_persona: 'jurado' },
    U5: { id: 'U5', codigo_interno: 'USR-0005', nombre_completo: 'Bruno Reemplazado Díaz', rut: '55.555.555-5', categoria: 'A', tipo_persona: 'jurado' },
};

const RODEOS = {
    R1: { id: 'R1', fecha: '2026-10-03', asociacion: 'Los Dominicos de Las Condes', club: 'Los Dominicos', tipo_rodeo_nombre: 'Rodeo Libre', duracion_dias: 1, tipo_rodeo_id: 'T1', categoria_rodeo_id: 'CR1', categoria_rodeo_nombre: 'Primera' },
    R2: { id: 'R2', fecha: '2026-10-10', asociacion: 'Puente Alto', club: 'San Joaquín', tipo_rodeo_nombre: 'Rodeo Para Criadores', duracion_dias: 2, tipo_rodeo_id: 'T2', categoria_rodeo_id: 'CR2', categoria_rodeo_nombre: 'Segunda' },
    R3: { id: 'R3', fecha: '2026-10-18', asociacion: 'San Joaquín', club: 'San Joaquín', tipo_rodeo_nombre: 'Rodeo Libre', duracion_dias: 1, tipo_rodeo_id: 'T1', categoria_rodeo_id: 'CR1', categoria_rodeo_nombre: 'Primera' },
    R4: { id: 'R4', fecha: '2026-10-24', asociacion: 'Longotoro', club: 'Longotoro', tipo_rodeo_nombre: 'Rodeo Libre', duracion_dias: 1, tipo_rodeo_id: 'T1', categoria_rodeo_id: 'CR1', categoria_rodeo_nombre: 'Primera' },
    R5: { id: 'R5', fecha: '2026-10-31', asociacion: 'Puente Alto', club: 'Puente Alto', tipo_rodeo_nombre: 'Rodeo Libre', duracion_dias: 1, tipo_rodeo_id: 'T1', categoria_rodeo_id: 'CR1', categoria_rodeo_nombre: 'Primera' },
    R9: { id: 'R9', fecha: '2026-09-27', asociacion: 'Puente Alto', club: 'Puente Alto', tipo_rodeo_nombre: 'Rodeo Libre', duracion_dias: 1, tipo_rodeo_id: 'T1', categoria_rodeo_id: 'CR1', categoria_rodeo_nombre: 'Primera' },
    R10: { id: 'R10', fecha: '2026-11-01', asociacion: 'Nochaco', club: 'Puerto Octay', tipo_rodeo_nombre: 'Rodeo Libre', duracion_dias: 1, tipo_rodeo_id: 'T1', categoria_rodeo_id: 'CR1', categoria_rodeo_nombre: 'Primera' },
};

function asig(id, usuario, rodeo, extra = {}) {
    return {
        id, rodeo_id: rodeo, usuario_pagado_id: usuario, tipo_persona: 'jurado',
        categoria_aplicada: usuario ? USUARIOS[usuario].categoria : null,
        valor_diario_aplicado: 245000, duracion_dias_aplicada: RODEOS[rodeo].duracion_dias,
        pago_base_calculado: 245000 * RODEOS[rodeo].duracion_dias,
        estado: 'activo', estado_designacion: 'aceptado', nombre_importado: null, publicado: true,
        created_at: '2026-09-01T12:00:00Z',
        usuarios_pagados: usuario ? { ...USUARIOS[usuario] } : null,
        rodeos: { ...RODEOS[rodeo] },
        ...extra,
    };
}

function datasetBase() {
    const asignaciones = [
        // U1 — un rodeo, que obtuvo por REEMPLAZO de U5 (misma fila reescrita).
        asig('A01', 'U1', 'R1', { pago_base_calculado: 245000 }),
        // U2 — cuatro rodeos en octubre + uno en septiembre + uno anulado.
        asig('A02', 'U2', 'R1', { pago_base_calculado: 245000 }),
        asig('A03', 'U2', 'R2', { valor_diario_aplicado: 152500, pago_base_calculado: 305000 }), // 2 días
        asig('A04', 'U2', 'R3', { pago_base_calculado: 245000 }),
        asig('A05', 'U2', 'R4', { valor_diario_aplicado: 430000, pago_base_calculado: 430000 }),
        asig('A06', 'U2', 'R9', { pago_base_calculado: 245000 }),                  // otro mes
        asig('A07', 'U2', 'R5', { estado: 'anulado', pago_base_calculado: 999999 }), // anulada
        // U3 — tres rodeos + una designación rechazada; categoría aplicada B (hoy es C).
        asig('A08', 'U3', 'R2', { categoria_aplicada: 'B', valor_diario_aplicado: 152500, pago_base_calculado: 305000 }),
        asig('A09', 'U3', 'R3', { categoria_aplicada: 'B', pago_base_calculado: 245000 }),
        asig('A10', 'U3', 'R5', { categoria_aplicada: 'B', pago_base_calculado: 245000 }),
        asig('A11', 'U3', 'R4', { estado_designacion: 'rechazado', pago_base_calculado: 430000 }),
        // U4 — solo una designación rechazada.
        asig('A12', 'U4', 'R4', { estado_designacion: 'rechazado', pago_base_calculado: 245000 }),
        // Fila importada sin persona vinculada.
        asig('A13', null, 'R3', { nombre_importado: 'Jurado Importado', pago_base_calculado: 245000 }),
        // Noviembre (fuera de octubre).
        asig('A14', 'U1', 'R10', { pago_base_calculado: 305000 }),
    ];
    const bonos_solicitados = [
        { id: 'B1', asignacion_id: 'A01', usuario_pagado_id: 'U5', estado: 'desvinculado_por_cambio_designacion', monto_solicitado: 50000, monto_aprobado: null, created_at: '2026-09-20T00:00:00Z' },
        { id: 'B2', asignacion_id: 'A03', usuario_pagado_id: 'U2', estado: 'aprobado', monto_solicitado: 35000, monto_aprobado: 35000, created_at: '2026-10-11T00:00:00Z' },
        { id: 'B3', asignacion_id: 'A04', usuario_pagado_id: 'U2', estado: 'pendiente', monto_solicitado: 50000, monto_aprobado: null, created_at: '2026-10-19T00:00:00Z' },
        { id: 'B4', asignacion_id: 'A05', usuario_pagado_id: 'U2', estado: 'rechazado', monto_solicitado: 50000, monto_aprobado: null, created_at: '2026-10-25T00:00:00Z' },
        { id: 'B5', asignacion_id: 'A08', usuario_pagado_id: 'U3', estado: 'modificado', monto_solicitado: 35000, monto_aprobado: 25000, created_at: '2026-10-11T00:00:00Z' },
        { id: 'B6', asignacion_id: 'A09', usuario_pagado_id: 'U3', estado: 'aprobado_auto', monto_solicitado: 0, monto_aprobado: 0, created_at: '2026-10-19T00:00:00Z' },
        { id: 'B7', asignacion_id: 'A11', usuario_pagado_id: 'U3', estado: 'aprobado', monto_solicitado: 50000, monto_aprobado: 50000, created_at: '2026-10-25T00:00:00Z' },
        { id: 'B8', asignacion_id: 'A06', usuario_pagado_id: 'U2', estado: 'aprobado', monto_solicitado: 35000, monto_aprobado: 35000, created_at: '2026-09-28T00:00:00Z' },
    ];
    return {
        asignaciones,
        bonos_solicitados,
        configuracion_retencion: [{ porcentaje: String(PCT_RETENCION) }],
        categorias_rodeo: [{ id: 'CR1', nombre: 'Primera', activo: true }, { id: 'CR2', nombre: 'Segunda', activo: true }],
        usuarios_pagados: Object.values(USUARIOS),
    };
}

function cargarDataset(db = datasetBase()) {
    fake.db = db;
    fake.llamadas = [];
    return db;
}

module.exports = { fake, cargarDataset, datasetBase, asig, USUARIOS, RODEOS, PCT_RETENCION, MAX_ROWS };
