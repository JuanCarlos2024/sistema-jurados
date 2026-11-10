// Resumen por jurado con detalle por rodeo — servicio compartido por la
// pantalla (Reportes → Resumen por jurado) y la exportación Excel/CSV.
// Usa un Supabase falso en memoria que SÍ aplica filtros (ver testkit).
jest.mock('../config/supabase', () => require('./resumenJurados.testkit').fake);

const kit = require('./resumenJurados.testkit');
const {
    obtenerResumenJurados, construirRango, describirPeriodo, calcularBonoAprobado, construirResumen,
} = require('./resumenJurados');
const { calcularResumenMensual } = require('./calculo');

const OCT = { año: '2026', mes: '10' };
const porCodigo = (r, cod) => r.jurados.find(j => j.codigo_interno === cod);

// ── Oráculo: copia LITERAL del agrupamiento anterior de reportes.js
// (calcularTotalesPorJurado + agregarBonos) para demostrar que los totales
// por jurado y globales no cambian.
function legadoTotales(asignaciones, bonos, pct) {
    const bonoMap = {};
    bonos.forEach(b => { (bonoMap[b.asignacion_id] = bonoMap[b.asignacion_id] || []).push(b); });
    const conBonos = asignaciones.map(a => {
        const bs = bonoMap[a.id] || [];
        const bono_aprobado = bs.filter(b => ['aprobado', 'modificado', 'aprobado_auto'].includes(b.estado))
            .reduce((s, b) => s + (b.monto_aprobado || b.monto_solicitado || 0), 0);
        return { ...a, bono_aprobado };
    });
    const mapa = {};
    for (const a of conBonos) {
        const u = a.usuarios_pagados; if (!u) continue;
        if (!mapa[u.id]) mapa[u.id] = { codigo_interno: u.codigo_interno, nombre_completo: u.nombre_completo, cant_rodeos: 0, total_pago_base: 0, total_bono_aprobado: 0 };
        if (a.estado_designacion !== 'rechazado') {
            mapa[u.id].cant_rodeos++;
            mapa[u.id].total_pago_base += (a.pago_base_calculado || 0);
            mapa[u.id].total_bono_aprobado += (a.bono_aprobado || 0);
        }
    }
    return Object.values(mapa).map(j => {
        const bruto = j.total_pago_base + j.total_bono_aprobado;
        const ret = Math.round(bruto * pct / 100);
        return { ...j, bruto, retencion_monto: ret, liquido: bruto - ret };
    }).sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));
}

beforeEach(() => kit.cargarDataset());

describe('rango de fechas y período', () => {
    test('mes: octubre 2026 = 01 al 31, sin depender de la zona horaria', () => {
        expect(construirRango(OCT)).toMatchObject({ inicio: '2026-10-01', fin: '2026-10-31' });
        expect(construirRango({ año: '2028', mes: '2' })).toMatchObject({ inicio: '2028-02-01', fin: '2028-02-29' });
        expect(construirRango({ año: '2026', mes: '4' })).toMatchObject({ inicio: '2026-04-01', fin: '2026-04-30' });
    });
    test('desde/hasta tiene prioridad; año solo = año completo; nada = sin filtro', () => {
        expect(construirRango({ ...OCT, fechaDesde: '2026-10-05', fechaHasta: '2026-10-20' })).toMatchObject({ inicio: '2026-10-05', fin: '2026-10-20' });
        expect(construirRango({ año: '2026' })).toMatchObject({ inicio: '2026-01-01', fin: '2026-12-31' });
        expect(construirRango({})).toBeNull();
    });
    test('descripción legible', () => {
        expect(describirPeriodo(construirRango(OCT))).toBe('Octubre 2026 (01/10/2026 al 31/10/2026)');
        expect(describirPeriodo(null)).toBe('Todos los períodos');
    });
});

describe('bonos — misma regla que calcularResumenMensual', () => {
    test('suman aprobado / modificado (monto aprobado) / aprobado_auto ($0)', () => {
        expect(calcularBonoAprobado([{ estado: 'aprobado', monto_aprobado: 35000 }])).toBe(35000);
        expect(calcularBonoAprobado([{ estado: 'modificado', monto_aprobado: 25000, monto_solicitado: 35000 }])).toBe(25000);
        expect(calcularBonoAprobado([{ estado: 'aprobado_auto', monto_aprobado: 0, monto_solicitado: 0 }])).toBe(0);
    });
    test('no suman pendiente, rechazado ni desvinculado por reemplazo', () => {
        expect(calcularBonoAprobado([
            { estado: 'pendiente', monto_solicitado: 50000 },
            { estado: 'rechazado', monto_solicitado: 50000 },
            { estado: 'desvinculado_por_cambio_designacion', monto_solicitado: 50000 },
        ])).toBe(0);
    });
});

describe('Resumen octubre 2026 — estructura por jurado y por rodeo', () => {
    let r;
    beforeEach(async () => { r = await obtenerResumenJurados(OCT); });

    test('varios jurados en un mismo reporte, ordenados por nombre (es)', () => {
        expect(r.jurados.map(j => j.codigo_interno)).toEqual(['USR-0001', 'USR-0002', 'USR-0003', 'USR-0004']);
    });

    test('jurado con un rodeo (obtenido por reemplazo): bono del titular anterior no suma', () => {
        const j = porCodigo(r, 'USR-0001');
        expect(j.rodeos_detalle).toHaveLength(1);
        expect(j.rodeos_detalle[0]).toMatchObject({
            n: 1, asignacion_id: 'A01', rodeo_id: 'R1', fecha: '2026-10-03',
            asociacion: 'Los Dominicos de Las Condes', club: 'Los Dominicos',
            pago_base: 245000, bono_aprobado: 0, bruto: 245000, retencion_monto: null, liquido: null,
        });
    });

    test('jurado reemplazado no aparece', () => {
        expect(porCodigo(r, 'USR-0005')).toBeUndefined();
    });

    test('jurado con cuatro rodeos: bono aprobado, pendiente y rechazado; rodeo de 2 días = 1 fila', () => {
        const j = porCodigo(r, 'USR-0002');
        expect(j.rodeos_detalle.map(f => [f.n, f.fecha, f.club, f.pago_base, f.bono_aprobado, f.bruto])).toEqual([
            [1, '2026-10-03', 'Los Dominicos', 245000, 0, 245000],
            [2, '2026-10-10', 'San Joaquín', 305000, 35000, 340000],   // 2 días + bono aprobado
            [3, '2026-10-18', 'San Joaquín', 245000, 0, 245000],       // bono pendiente → 0
            [4, '2026-10-24', 'Longotoro', 430000, 0, 430000],         // bono rechazado → 0
        ]);
        const dosDias = j.rodeos_detalle[1];
        expect(dosDias.duracion_dias).toBe(2);
        expect(dosDias.asociacion).toBe('Puente Alto');
        expect(j.rodeos_detalle.filter(f => f.rodeo_id === 'R2')).toHaveLength(1);
        expect(dosDias.estado_bono).toBe('aprobado');
        expect(j.rodeos_detalle[2].estado_bono).toBe('pendiente');
    });

    test('anuladas y rodeos de otro mes no aparecen', () => {
        const ids = r.jurados.flatMap(j => j.rodeos_detalle.map(f => f.asignacion_id));
        expect(ids).not.toContain('A06'); // septiembre
        expect(ids).not.toContain('A07'); // anulada
        expect(ids).not.toContain('A14'); // noviembre
    });

    test('jurado con tres rodeos: categoría APLICADA en la asignación (B), no la actual (C); rechazada excluida', () => {
        const j = porCodigo(r, 'USR-0003');
        expect(j.categoria).toBe('C');
        expect(j.rodeos_detalle).toHaveLength(3);
        expect(j.rodeos_detalle.every(f => f.categoria === 'B')).toBe(true);
        expect(j.rodeos_detalle.map(f => f.asignacion_id)).not.toContain('A11');
        expect(j.designaciones_rechazadas).toBe(1);
        expect(j.rodeos_detalle[0]).toMatchObject({ bono_aprobado: 25000, estado_bono: 'modificado' });
    });

    test('jurado solo con designación rechazada: se conserva sin rodeos ni montos (indicador Jurados sin cambios)', () => {
        const j = porCodigo(r, 'USR-0004');
        expect(j).toMatchObject({ cant_rodeos: 0, total_pago_base: 0, bruto: 0, retencion_monto: 0, liquido: 0, designaciones_rechazadas: 1 });
        expect(j.rodeos_detalle).toEqual([]);
    });

    test('subtotales por jurado (valores calculados a mano)', () => {
        expect(porCodigo(r, 'USR-0001')).toMatchObject({ cant_rodeos: 1, total_pago_base: 245000, total_bono_aprobado: 0, bruto: 245000, retencion_monto: 37363, liquido: 207637 });
        expect(porCodigo(r, 'USR-0002')).toMatchObject({ cant_rodeos: 4, total_pago_base: 1225000, total_bono_aprobado: 35000, bruto: 1260000, retencion_monto: 192150, liquido: 1067850 });
        expect(porCodigo(r, 'USR-0003')).toMatchObject({ cant_rodeos: 3, total_pago_base: 795000, total_bono_aprobado: 25000, bruto: 820000, retencion_monto: 125050, liquido: 694950 });
    });

    test('retención sobre el bruto AGREGADO: sin diferencia de 1 peso por redondeo por rodeo', () => {
        const j = porCodigo(r, 'USR-0002');
        const porFila = j.rodeos_detalle.reduce((s, f) => s + Math.round(f.bruto * kit.PCT_RETENCION / 100), 0);
        expect(porFila).toBe(192151);              // lo que daría un redondeo por rodeo
        expect(j.retencion_monto).toBe(192150);    // cálculo oficial
        expect(j.rodeos_detalle.every(f => f.retencion_monto === null && f.liquido === null)).toBe(true);
    });

    test('total general', () => {
        expect(r.totales_global).toEqual({
            cant_jurados: 4, cant_rodeos: 8,
            total_pago_base: 2265000, total_bono_aprobado: 60000, bruto: 2325000,
            retencion_monto: 354563, liquido: 1970437,
        });
        expect(r.retencion_porcentaje).toBe(kit.PCT_RETENCION);
        expect(r.periodo.descripcion).toBe('Octubre 2026 (01/10/2026 al 31/10/2026)');
    });

    test('conciliación interna OK; advierte la fila importada sin persona', () => {
        expect(r.conciliacion.ok).toBe(true);
        expect(r.conciliacion.errores).toEqual([]);
        expect(r.conciliacion.asignaciones_sin_usuario).toBe(1);
    });

    test('invariantes: Σ base = base total, Σ bonos = bonos, base+bono = bruto, Σ brutos = bruto, bruto − ret = líquido', () => {
        for (const j of r.jurados) {
            const f = j.rodeos_detalle;
            expect(f.reduce((s, x) => s + x.pago_base, 0)).toBe(j.total_pago_base);
            expect(f.reduce((s, x) => s + x.bono_aprobado, 0)).toBe(j.total_bono_aprobado);
            f.forEach(x => expect(x.pago_base + x.bono_aprobado).toBe(x.bruto));
            expect(f.reduce((s, x) => s + x.bruto, 0)).toBe(j.bruto);
            expect(j.bruto - j.retencion_monto).toBe(j.liquido);
        }
    });
});

describe('Conciliación exacta con los cálculos financieros vigentes', () => {
    test('totales por jurado y globales = agrupamiento anterior de reportes.js', async () => {
        const db = kit.cargarDataset();
        const r = await obtenerResumenJurados(OCT);
        const octubre = db.asignaciones.filter(a => a.estado === 'activo' && a.rodeos.fecha >= '2026-10-01' && a.rodeos.fecha <= '2026-10-31');
        const legado = legadoTotales(octubre, db.bonos_solicitados, kit.PCT_RETENCION);
        const campos = ['codigo_interno', 'cant_rodeos', 'total_pago_base', 'total_bono_aprobado', 'bruto', 'retencion_monto', 'liquido'];
        const pick = j => Object.fromEntries(campos.map(c => [c, j[c]]));
        expect(r.jurados.map(pick)).toEqual(legado.map(pick));
    });

    test('cada subtotal = calcularResumenMensual() (cálculo oficial del pago mensual del jurado)', async () => {
        const r = await obtenerResumenJurados(OCT);
        for (const j of r.jurados) {
            const oficial = await calcularResumenMensual(j.id, '2026', '10');
            expect({ id: j.id, base: j.total_pago_base, bono: j.total_bono_aprobado, bruto: j.bruto, ret: j.retencion_monto, liq: j.liquido })
                .toEqual({ id: j.id, base: oficial.total_pago_base, bono: oficial.total_bono_aprobado, bruto: oficial.bruto, ret: oficial.retencion_monto, liq: oficial.liquido });
        }
    });
});

describe('Filtros globales', () => {
    test('período: septiembre trae solo el rodeo de septiembre', async () => {
        const r = await obtenerResumenJurados({ año: '2026', mes: '9' });
        expect(r.jurados.map(j => j.codigo_interno)).toEqual(['USR-0002']);
        expect(porCodigo(r, 'USR-0002')).toMatchObject({ cant_rodeos: 1, total_pago_base: 245000, total_bono_aprobado: 35000, bruto: 280000 });
    });

    test('período desde/hasta', async () => {
        const r = await obtenerResumenJurados({ fechaDesde: '2026-10-10', fechaHasta: '2026-10-18' });
        expect(r.jurados.flatMap(j => j.rodeos_detalle.map(f => f.fecha)).sort()).toEqual(['2026-10-10', '2026-10-10', '2026-10-18', '2026-10-18']);
    });

    test('asociación: el subtotal corresponde solo a los rodeos de esa asociación', async () => {
        const r = await obtenerResumenJurados({ ...OCT, asociacion: 'puente alto' });
        const j2 = porCodigo(r, 'USR-0002');
        expect(j2.rodeos_detalle.map(f => f.asignacion_id)).toEqual(['A03']);
        expect(j2).toMatchObject({ cant_rodeos: 1, total_pago_base: 305000, total_bono_aprobado: 35000, bruto: 340000, retencion_monto: 51850, liquido: 288150 });
        expect(porCodigo(r, 'USR-0003').rodeos_detalle.map(f => f.asignacion_id)).toEqual(['A08', 'A10']);
        expect(porCodigo(r, 'USR-0001')).toBeUndefined();
    });

    test('club', async () => {
        const r = await obtenerResumenJurados({ ...OCT, club: 'San Joaquín' });
        expect(r.jurados.flatMap(j => j.rodeos_detalle.map(f => f.club))).toEqual(['San Joaquín', 'San Joaquín', 'San Joaquín', 'San Joaquín']);
        expect(r.totales_global.cant_rodeos).toBe(4);
    });

    test('jurado (usuario_pagado_id) — antes la pantalla lo ignoraba', async () => {
        const r = await obtenerResumenJurados({ ...OCT, usuario_pagado_id: 'U3' });
        expect(r.jurados.map(j => j.id)).toEqual(['U3']);
    });

    test('categoría aplicada, categoría de rodeo y tipo de rodeo', async () => {
        const cat = await obtenerResumenJurados({ ...OCT, categoria: 'B' });
        expect(cat.jurados.flatMap(j => j.rodeos_detalle).every(f => f.categoria === 'B')).toBe(true);
        expect(cat.jurados.map(j => j.codigo_interno)).toEqual(['USR-0002', 'USR-0003', 'USR-0004']);

        const cr = await obtenerResumenJurados({ ...OCT, categoria_rodeo_id: 'CR2' });
        expect(cr.jurados.flatMap(j => j.rodeos_detalle.map(f => f.rodeo_id))).toEqual(['R2', 'R2']);

        const tipo = await obtenerResumenJurados({ ...OCT, tipo_rodeo_id: 'T2' });
        expect(tipo.jurados.flatMap(j => j.rodeos_detalle.map(f => f.rodeo_id))).toEqual(['R2', 'R2']);
    });
});

describe('Volumen y duplicidades', () => {
    test('más de 1000 asignaciones: se pagina, nada se trunca ni se duplica', async () => {
        const db = kit.datasetBase();
        for (let i = 0; i < 2300; i++) {
            db.asignaciones.push(kit.asig(`X${String(i).padStart(5, '0')}`, 'U1', 'R4', { pago_base_calculado: 1000 }));
        }
        kit.cargarDataset(db);
        const r = await obtenerResumenJurados(OCT);
        const j = porCodigo(r, 'USR-0001');
        expect(j.cant_rodeos).toBe(2301);
        expect(j.total_pago_base).toBe(245000 + 2300 * 1000);
        expect(new Set(j.rodeos_detalle.map(f => f.asignacion_id)).size).toBe(2301);
        expect(r.conciliacion.ok).toBe(true);
    });

    test('dos asignaciones vigentes de la misma persona en el mismo rodeo: ambas filas, sin fusionar ni perder importes, con advertencia', () => {
        const filas = [
            kit.asig('D1', 'U1', 'R1', { pago_base_calculado: 245000, bonos: [] }),
            kit.asig('D2', 'U1', 'R1', { pago_base_calculado: 245000, bonos: [{ estado: 'aprobado', monto_aprobado: 35000 }] }),
        ];
        const r = construirResumen(filas, 10);
        const j = r.jurados[0];
        expect(j.rodeos_detalle.map(f => f.asignacion_id)).toEqual(['D1', 'D2']);
        expect(j.bruto).toBe(525000);
        expect(r.conciliacion.advertencias.some(a => a.includes('mismo rodeo'))).toBe(true);
    });

    test('bonos consultados en lotes (sin una consulta por rodeo o jurado)', async () => {
        kit.cargarDataset();
        await obtenerResumenJurados(OCT);
        expect(kit.fake.llamadas.filter(t => t === 'bonos_solicitados')).toHaveLength(1);
        expect(kit.fake.llamadas.filter(t => t === 'asignaciones')).toHaveLength(1);
    });
});
