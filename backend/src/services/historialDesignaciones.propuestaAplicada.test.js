// ═════════════════════════════════════════════════════════════════════════
// Historial Unificado + Excel sobre una propuesta YA APLICADA — réplica del
// estado verificado (solo lectura) de la propuesta 27c6bc5d… el 11/11/2026:
//   - sigue en BORRADOR;
//   - 5 filas ACEPTADO/MOTOR sin movimientos individuales;
//   - 12 MODIFICADO/MANUAL_CON_ADVERTENCIA con el MISMO jurado, sin movimientos;
//   - 8 MODIFICADO con jurado distinto + 1 bitácora modificacion_manual_borrador c/u;
//   - 25 asignaciones reales (bitácora aplicacion_propuesta + auditoría 'crear'):
//     23 activas y publicadas, 2 anuladas;
//   - 33 movimientos de bitácora (25 + 8).
// Verifica: fuente real de cada evento, sin duplicados, y que las 17 filas
// sin evidencia NO aparezcan como decisiones del administrador.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../config/supabase', () => require('./resumenJurados.testkit').fake);

const ExcelJS = require('exceljs');
const kit = require('./resumenJurados.testkit');
const { obtenerHistorialDesignaciones } = require('./historialDesignaciones');
const { construirLibroHistorial } = require('./historialDesignacionesExport');
const { clasificarFilasRegularizacion, resumenClasificacion } = require('./regularizacionEstadosPropuesta');

const ADMIN = { id: 'adm-1', nombre_completo: 'Ana Administradora' };
const P = 'P27';
const N = 25;
const ACEPTADO = i => i < 5;
const MODIF_MISMO = i => i >= 5 && i < 17;
const MODIF_REAL = i => i >= 17;
const ANULADAS = new Set([3, 20]);
const pad = i => String(i + 1).padStart(2, '0');
const rid = i => `R${pad(i)}`, did = i => `D${pad(i)}`, aid = i => `AS${pad(i)}`;
const jProp = i => `jP${pad(i)}`, jMod = i => `jM${pad(i)}`;
const efectivo = i => (MODIF_REAL(i) ? jMod(i) : jProp(i));

const T_CREADA = '2026-11-11T13:16:36Z';
const T_MODIF = '2026-11-11T13:40:00Z';
const T_APLIC = '2026-11-11T14:05:00Z';
const T_PUBLIC = '2026-11-11T14:30:00Z';
const T_ANUL = '2026-11-12T10:00:00Z';

function dataset() {
    const rodeos = [], detalles = [], asignaciones = [], bitacora = [], auditoria = [], jurados = [];
    for (let i = 0; i < N; i++) {
        jurados.push({ id: jProp(i), nombre_completo: `Jurado Propuesto ${pad(i)}`, categoria: i === 0 ? 'B' : 'C' });
        if (MODIF_REAL(i)) jurados.push({ id: jMod(i), nombre_completo: `Jurado Elegido ${pad(i)}`, categoria: 'B' });
        rodeos.push({ id: rid(i), club: `Club ${pad(i)}`, asociacion: i % 2 ? 'Talagante' : 'Cordillera', fecha: `2026-11-${String(14 + (i % 15)).padStart(2, '0')}`, duracion_dias: 1, tipo_rodeo_nombre: 'Provincial', temporada_id: 'T26', estado: 'activo', tipos_rodeo: { clasificaciones_designacion: { nombre: 'Provincial' } } });
        detalles.push({
            id: did(i), propuesta_id: P, rodeo_id: rid(i), jurado_id_propuesto: jProp(i),
            jurado_id_seleccionado: efectivo(i),
            estado_revision: ACEPTADO(i) ? 'ACEPTADO' : 'MODIFICADO',
            origen_seleccion: ACEPTADO(i) ? 'MOTOR' : (MODIF_MISMO(i) ? 'MANUAL_CON_ADVERTENCIA' : 'MANUAL'),
            explicacion_json: { jurado_propuesto: { jurado_id: jProp(i), categoria: 'C', optimizacion_global_relajaciones: MODIF_MISMO(i) ? ['FINDE_CONSECUTIVO'] : [] } },
            metricas_json: MODIF_MISMO(i) ? { advertencias_aceptadas: [{ tipo: 'FINDE_CONSECUTIVO' }] } : {}, // sin orden_presentacion (como en producción)
            created_at: T_CREADA, updated_at: T_CREADA,
        });
        if (MODIF_REAL(i)) {
            bitacora.push({ id: `BM${pad(i)}`, rodeo_id: rid(i), tipo_movimiento: 'modificacion_manual_borrador', propuesta_detalle_id: did(i), asignacion_id: null, usuario_pagado_id_anterior: jProp(i), nombre_anterior_snapshot: `Jurado Propuesto ${pad(i)}`, usuario_pagado_id_nuevo: jMod(i), nombre_nuevo_snapshot: `Jurado Elegido ${pad(i)}`, motivo_catalogo_id: 'm1', motivo_detalle: 'Cercanía', actor_id: ADMIN.id, fecha_efectiva: T_MODIF, created_at: T_MODIF, operacion_id: null, catalogo_motivos_designacion: { codigo: 'AJUSTE', etiqueta: 'Ajuste administrativo' } });
            auditoria.push({ id: `UM${pad(i)}`, tabla: 'propuestas_designacion_detalle', registro_id: did(i), accion: 'editar', datos_anteriores: { estado_revision: 'PENDIENTE' }, datos_nuevos: { jurado_id_seleccionado: jMod(i), estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL' }, actor_id: ADMIN.id, actor_tipo: 'administrador', descripcion: `Modificación manual en propuesta: Jurado Elegido ${pad(i)} → MODIFICADO (bitácora 00000000-0000-0000-0000-0000000000${pad(i)})`, created_at: T_MODIF });
        }
        const anulada = ANULADAS.has(i);
        asignaciones.push({ id: aid(i), rodeo_id: rid(i), usuario_pagado_id: efectivo(i), tipo_persona: 'jurado', estado: anulada ? 'anulado' : 'activo', estado_designacion: 'pendiente', publicado: true, publicado_en: T_PUBLIC, publicado_por: ADMIN.id, propuesta_detalle_id: did(i), nombre_importado: null, categoria_aplicada: MODIF_REAL(i) ? 'B' : 'C', created_at: T_APLIC, updated_at: anulada ? T_ANUL : T_PUBLIC, created_by: ADMIN.id, aceptado_en: null, observacion_designacion: null });
        bitacora.push({ id: `BA${pad(i)}`, rodeo_id: rid(i), tipo_movimiento: 'aplicacion_propuesta', propuesta_detalle_id: did(i), asignacion_id: aid(i), usuario_pagado_id_anterior: null, nombre_anterior_snapshot: null, usuario_pagado_id_nuevo: efectivo(i), nombre_nuevo_snapshot: null, motivo_catalogo_id: null, motivo_detalle: null, actor_id: ADMIN.id, fecha_efectiva: T_APLIC, created_at: T_APLIC, operacion_id: null, catalogo_motivos_designacion: null });
        // Auditoría de la aplicación (misma acción que la bitácora → no debe duplicar).
        // revisado_por_admin=true se derivó del estado_revision (falso para 17 filas): no es evidencia.
        auditoria.push({ id: `UC${pad(i)}`, tabla: 'asignaciones', registro_id: aid(i), accion: 'crear', datos_anteriores: null, datos_nuevos: { rodeo_id: rid(i), usuario_pagado_id: efectivo(i), origen: 'propuesta_designacion', propuesta_id: P, detalle_id: did(i), revisado_por_admin: true }, actor_id: ADMIN.id, actor_tipo: 'administrador', descripcion: 'Asignación creada desde propuesta de designación', created_at: T_APLIC });
        // Publicación con el formato antiguo (sin asignacion_ids).
        auditoria.push({ id: `UP${pad(i)}`, tabla: 'asignaciones', registro_id: rid(i), accion: 'publicar_designaciones', datos_anteriores: null, datos_nuevos: null, actor_id: ADMIN.id, actor_tipo: 'administrador', descripcion: `Designaciones publicadas para Club ${pad(i)}`, created_at: T_PUBLIC });
        if (anulada) auditoria.push({ id: `UX${pad(i)}`, tabla: 'asignaciones', registro_id: aid(i), accion: 'eliminar', datos_anteriores: { rodeo_id: rid(i), usuario_pagado_id: efectivo(i), tipo_persona: 'jurado' }, datos_nuevos: { estado: 'anulado' }, actor_id: ADMIN.id, actor_tipo: 'administrador', descripcion: 'Asignación anulada', created_at: T_ANUL });
    }
    return {
        administradores: [ADMIN], usuarios_pagados: jurados, rodeos,
        propuestas_designacion: [{ id: P, estado: 'BORRADOR', creado_por: ADMIN.id, created_at: T_CREADA, configuracion_version_id: 'cfg12', motor_usado: 'global', fecha_corte_tecnica: T_CREADA, resultado_cobertura_json: { total_cupos: 25, cobertura_obtenida: 25, estado_busqueda: 'COBERTURA_COMPLETA' }, configuracion_designacion_versiones: { numero_version: 12 } }],
        propuestas_designacion_detalle: detalles, asignaciones, bitacora_designaciones: bitacora, auditoria,
        configuracion_retencion: [], temporadas: [{ id: 'T26', nombre: '2026-2027' }],
    };
}

let db;
beforeEach(() => { db = dataset(); kit.cargarDataset(db); });

const porRodeo = (r, i) => r.rodeos.find(x => x.rodeo.id === rid(i));
const cuenta = (h, tipo) => h.eventos.filter(e => e.tipo === tipo).length;

describe('Propuesta aplicada (réplica 27c6bc5d…): el historial representa fielmente lo ocurrido', () => {
    test('fixture coherente con lo verificado en producción', () => {
        expect(db.bitacora_designaciones).toHaveLength(33);
        expect(db.asignaciones.filter(a => a.estado === 'activo' && a.publicado)).toHaveLength(23);
        expect(db.asignaciones.filter(a => a.estado === 'anulado')).toHaveLength(2);
    });

    test('las 8 modificaciones reales aparecen UNA vez, con su fuente (bitácora), autor y motivo', async () => {
        const r = await obtenerHistorialDesignaciones({ propuesta_id: P });
        expect(r.rodeos).toHaveLength(N);
        for (let i = 17; i < N; i++) {
            const h = porRodeo(r, i);
            const mods = h.eventos.filter(e => e.tipo === 'MODIFICACION_BORRADOR');
            expect(mods).toHaveLength(1); // la auditoría que remite a la bitácora no duplica
            expect(mods[0]).toMatchObject({
                origen: 'ADMINISTRADOR', responsable: 'Ana Administradora', motivo: 'Ajuste administrativo', justificacion: 'Cercanía',
                jurado_anterior: { id: jProp(i) }, jurado_nuevo: { id: jMod(i) }, referencia: { tabla: 'bitacora_designaciones', id: `BM${pad(i)}` },
            });
            expect(cuenta(h, 'CLASIFICACION_AUTOMATICA')).toBe(0);
            expect(h.resumen.jurado_confirmado_admin).toBe(`Jurado Elegido ${pad(i)} (modificado)`);
            expect(h.resumen.decision_borrador).toBe('Modificación administrativa registrada');
            expect(h.resumen.modificaciones_administrativas).toBe(1);
        }
    });

    test('las 17 filas sin evidencia NO se presentan como confirmación ni modificación del administrador', async () => {
        const r = await obtenerHistorialDesignaciones({ propuesta_id: P });
        for (let i = 0; i < 17; i++) {
            const h = porRodeo(r, i);
            expect(cuenta(h, 'CONFIRMACION_ADMIN')).toBe(0);
            expect(cuenta(h, 'MODIFICACION_BORRADOR')).toBe(0);
            const auto = h.eventos.filter(e => e.tipo === 'CLASIFICACION_AUTOMATICA');
            expect(auto).toHaveLength(1);
            expect(auto[0]).toMatchObject({ origen: 'SISTEMA', jurado_nuevo: { id: jProp(i) } });
            expect(auto[0].estado_resultante).toMatch(/no es una decisión administrativa comprobada/);
            expect(h.resumen.jurado_confirmado_admin).toBe('Sin confirmación individual registrada (aplicado en la aplicación colectiva de la propuesta)');
            expect(h.resumen.decision_borrador).toMatch(/^Clasificación automática al guardar/);
            expect(h.resumen.modificaciones_administrativas).toBe(0);
        }
    });

    test('aplicación colectiva, publicación y anulación: un evento por hecho, fuente real, sin duplicados', async () => {
        const r = await obtenerHistorialDesignaciones({ propuesta_id: P });
        const todos = r.rodeos.flatMap(x => x.eventos);
        expect(new Set(todos.map(e => e.id)).size).toBe(todos.length);
        for (let i = 0; i < N; i++) {
            const h = porRodeo(r, i);
            const ap = h.eventos.filter(e => e.tipo === 'APLICACION_PROPUESTA');
            expect(ap).toHaveLength(1);
            expect(ap[0].referencia).toEqual({ tabla: 'bitacora_designaciones', id: `BA${pad(i)}` });
            expect(ap[0].propuesta_aplicada).toBe(true);
            const pub = h.eventos.filter(e => e.tipo === 'PUBLICACION');
            expect(pub).toHaveLength(1);
            expect(pub[0].referencia).toEqual({ tabla: 'auditoria', id: `UP${pad(i)}` });
            expect(cuenta(h, 'ANULACION')).toBe(ANULADAS.has(i) ? 1 : 0);
        }
        const anul = porRodeo(r, 20).eventos.find(e => e.tipo === 'ANULACION');
        expect(anul).toMatchObject({ referencia: { tabla: 'auditoria', id: 'UX21' }, jurado_anterior: { id: jMod(20) }, responsable: 'Ana Administradora' });
        // Estado final siempre desde asignaciones reales.
        expect(porRodeo(r, 3).resumen.jurado_vigente).toBe('Sin jurado vigente');
        expect(porRodeo(r, 20).resumen.jurado_vigente).toBe('Sin jurado vigente');
        expect(porRodeo(r, 0).resumen.jurado_vigente).toBe('Jurado Propuesto 01');
        expect(r.rodeos.filter(x => x.resumen.jurado_vigente !== 'Sin jurado vigente')).toHaveLength(23);
        // Totales de la propuesta: 25 aplicaciones, 25 publicaciones, 2 anulaciones, 8 modificaciones, 0 confirmaciones individuales.
        const total = t => todos.filter(e => e.tipo === t).length;
        expect([total('APLICACION_PROPUESTA'), total('PUBLICACION'), total('ANULACION'), total('MODIFICACION_BORRADOR'), total('CONFIRMACION_ADMIN'), total('CLASIFICACION_AUTOMATICA')])
            .toEqual([25, 25, 2, 8, 0, 17]);
    });

    test('la aplicación colectiva es un evento distinto de la confirmación individual (check verde)', async () => {
        // Fila 0 recibe una confirmación individual real ANTES de aplicar.
        db.auditoria.push({ id: 'UOK01', tabla: 'propuestas_designacion_detalle', registro_id: did(0), accion: 'editar', datos_anteriores: { estado_revision: 'PENDIENTE' }, datos_nuevos: { jurado_id_seleccionado: jProp(0), estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR' }, actor_id: ADMIN.id, actor_tipo: 'administrador', descripcion: 'Jurado propuesto confirmado por el administrador: Jurado Propuesto 01', created_at: '2026-11-11T13:50:00Z' });
        kit.cargarDataset(db);
        const r = await obtenerHistorialDesignaciones({ propuesta_id: P });
        const h0 = porRodeo(r, 0), h1 = porRodeo(r, 1);
        expect(h0.eventos.map(e => e.tipo)).toEqual(expect.arrayContaining(['CONFIRMACION_ADMIN', 'APLICACION_PROPUESTA']));
        expect(cuenta(h0, 'CLASIFICACION_AUTOMATICA')).toBe(0);
        expect(h0.resumen.jurado_confirmado_admin).toBe('Jurado Propuesto 01');
        expect(h0.resumen.decision_borrador).toBe('Confirmación individual registrada');
        // Fila 1: solo aplicación colectiva → nunca se convierte en "confirmada".
        expect(cuenta(h1, 'CONFIRMACION_ADMIN')).toBe(0);
        expect(cuenta(h1, 'APLICACION_PROPUESTA')).toBe(1);
        const iConf = h0.eventos.findIndex(e => e.tipo === 'CONFIRMACION_ADMIN');
        const iAplic = h0.eventos.findIndex(e => e.tipo === 'APLICACION_PROPUESTA');
        expect(iConf).toBeLessThan(iAplic);
    });

    test('auditoría futura de aplicación (formato 2026-11-11): la aplicación colectiva informa la decisión real, nunca una confirmación ficticia', async () => {
        // Fila 1 sin bitácora de aplicación (p. ej. registro parcial): el evento sale de la auditoría 'crear'.
        db.bitacora_designaciones = db.bitacora_designaciones.filter(b => b.id !== 'BA02');
        const uc = db.auditoria.find(a => a.id === 'UC02');
        uc.datos_nuevos = { ...uc.datos_nuevos, evento: 'APLICACION_COLECTIVA', revisado_por_admin: false, decision_individual: 'CLASIFICACION_AUTOMATICA', estado_revision_borrador: 'ACEPTADO' };
        kit.cargarDataset(db);
        const r = await obtenerHistorialDesignaciones({ propuesta_id: P });
        const h = porRodeo(r, 1);
        const ap = h.eventos.filter(e => e.tipo === 'APLICACION_PROPUESTA');
        expect(ap).toHaveLength(1);
        expect(ap[0].referencia).toEqual({ tabla: 'auditoria', id: 'UC02' });
        expect(ap[0].justificacion).toBe('Aplicación colectiva — decisión individual previa: Clasificación automática al guardar — sin confirmación individual registrada');
        expect(cuenta(h, 'CONFIRMACION_ADMIN')).toBe(0);
    });

    test('categoría junto a cada jurado: prioriza el registro histórico y rotula la actual cuando no lo hay', async () => {
        // Fila 18 (modificada): sin categoria_aplicada en su designación → el
        // jurado elegido solo tiene la categoría ACTUAL (rotulada como tal).
        db.asignaciones.find(a => a.id === aid(17)).categoria_aplicada = null;
        kit.cargarDataset(db);
        const r = await obtenerHistorialDesignaciones({ propuesta_id: P });

        const h1 = porRodeo(r, 0); // propuesto jP01: motor C, hoy B
        const motor = h1.eventos.find(e => e.tipo === 'MOTOR_PROPUESTA');
        expect(motor.jurado_nuevo).toMatchObject({ id: jProp(0), categoria: 'C', categoria_fuente: 'MOTOR', categoria_actual: 'B' });
        const pub = h1.eventos.find(e => e.tipo === 'APLICACION_PROPUESTA');
        expect(pub.jurado_nuevo).toMatchObject({ categoria: 'C', categoria_fuente: 'DESIGNACION' });
        expect(h1.resumen.jurado_vigente_jurados).toEqual([{ id: jProp(0), nombre: 'Jurado Propuesto 01', categoria: 'C', categoria_fuente: 'DESIGNACION', categoria_actual: 'B' }]);

        const h20 = porRodeo(r, 20); // modificada y anulada
        const mod = h20.eventos.find(e => e.tipo === 'MODIFICACION_BORRADOR');
        expect(mod.jurado_anterior).toMatchObject({ id: jProp(20), categoria: 'C', categoria_fuente: 'MOTOR' });
        expect(mod.jurado_nuevo).toMatchObject({ id: jMod(20), categoria: 'B', categoria_fuente: 'DESIGNACION' });
        expect(h20.eventos.find(e => e.tipo === 'ANULACION').jurado_anterior).toMatchObject({ id: jMod(20), categoria: 'B', categoria_fuente: 'DESIGNACION' });

        const h17 = porRodeo(r, 17);
        expect(h17.eventos.find(e => e.tipo === 'MODIFICACION_BORRADOR').jurado_nuevo).toMatchObject({ id: jMod(17), categoria: 'B', categoria_fuente: 'ACTUAL' });

        // Excel: la actual nunca se presenta como histórica.
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await construirLibroHistorial(r).xlsx.writeBuffer());
        const h2 = wb.getWorksheet('Historial cronológico');
        const celdas = [];
        for (let i = 5; i <= h2.rowCount; i++) celdas.push(h2.getRow(i).getCell(8).value);
        expect(celdas).toContain('Jurado Elegido 18 [Cat. B, actual]');
        expect(celdas).toContain('Jurado Elegido 21 [Cat. B]');
        expect(celdas).toContain('Jurado Propuesto 01 [Cat. C, hoy B]');
        expect(celdas.some(c => /Sin categoría registrada/.test(String(c)))).toBe(false);
    });

    test('Excel (3 hojas) = pantalla: mismas decisiones, mismos eventos, sin confirmaciones falsas', async () => {
        const r = await obtenerHistorialDesignaciones({ propuesta_id: P });
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await construirLibroHistorial(r).xlsx.writeBuffer());
        const h1 = wb.getWorksheet('Resumen por rodeo');
        const filas = [];
        for (let i = 5; i <= h1.rowCount; i++) filas.push(h1.getRow(i));
        expect(filas).toHaveLength(N);
        // Confirmado: las 8 modificaciones reales llevan la categoría del
        // jurado elegido (aplicada en la designación); las 17 automáticas
        // conservan su texto "Sin confirmación individual registrada…".
        const conCat = (txt, cat) => txt.replace(/^(Jurado (?:Elegido|Propuesto) \d+)/, `$1 [Cat. ${cat}]`);
        expect(filas.map(f => f.getCell(10).value)).toEqual(r.rodeos.map(x => (x.resumen.jurado_confirmado_admin_jurado ? conCat(x.resumen.jurado_confirmado_admin, 'B') : x.resumen.jurado_confirmado_admin)));
        expect(filas.filter(f => /\[Cat\. B\] \(modificado\)$/.test(f.getCell(10).value))).toHaveLength(8);
        expect(filas.map(f => f.getCell(11).value)).toEqual(r.rodeos.map(x => x.resumen.decision_borrador));
        expect(filas.map(f => f.getCell(12).value)).toEqual(r.rodeos.map(x => (x.resumen.jurado_vigente_jurados.length ? conCat(x.resumen.jurado_vigente, /Elegido/.test(x.resumen.jurado_vigente) ? 'B' : (x.rodeo.id === rid(0) ? 'C, hoy B' : 'C')) : x.resumen.jurado_vigente)));
        // Propuesto originalmente: categoría del snapshot del motor; si hoy es otra, se aclara.
        const filaClub = club => filas.find(f => f.getCell(3).value === club);
        expect(filaClub('Club 01').getCell(9).value).toBe('Jurado Propuesto 01 [Cat. C, hoy B]');
        expect(filaClub('Club 02').getCell(9).value).toBe('Jurado Propuesto 02 [Cat. C]');
        expect(filas.map(f => f.getCell(14).value)).toEqual(r.rodeos.map(x => x.resumen.modificaciones_administrativas));

        const h2 = wb.getWorksheet('Historial cronológico');
        const etiquetas = [];
        for (let i = 5; i <= h2.rowCount; i++) etiquetas.push(h2.getRow(i).getCell(5).value);
        expect(etiquetas).toEqual(r.rodeos.flatMap(x => x.eventos.map(e => e.etiqueta)));
        expect(etiquetas.filter(e => String(e).startsWith('Confirmación administrativa'))).toHaveLength(0);

        const h3 = wb.getWorksheet('Propuesta original del motor');
        const decisiones = [];
        for (let i = 5; i <= h3.rowCount; i++) decisiones.push(h3.getRow(i).getCell(17).value);
        expect(decisiones.filter(d => /^Clasificación automática/.test(d))).toHaveLength(17);
        expect(decisiones.filter(d => d === 'Modificación administrativa registrada')).toHaveLength(8);
    });

    test('script 018: la propuesta queda BLOQUEADA para escritura; 0 filas a corregir; categorías separadas', () => {
        const filas = clasificarFilasRegularizacion({
            propuesta: db.propuestas_designacion[0], detalles: db.propuestas_designacion_detalle,
            bitacora: db.bitacora_designaciones, auditoria: db.auditoria, asignaciones: db.asignaciones,
        });
        const res = resumenClasificacion(filas, { propuesta: db.propuestas_designacion[0], asignaciones: db.asignaciones });
        expect(res.bloqueo.bloqueada).toBe(true);
        expect(res.bloqueo.motivos[0]).toMatch(/25 asignación\(es\) real\(es\).*23 activa\(s\), 2 anulada\(s\)/);
        expect(res.a_corregir).toBe(0);
        expect(res.por_categoria).toEqual({ CLASIFICACION_AUTOMATICA: 17, MODIFICACION_COMPROBADA: 8, MODIFICACION_SIN_REGISTRO: 0, CONFIRMACION_COMPROBADA: 0, SIN_DECISION: 0 });
        expect([res.clasificacion_automatica_aceptado, res.clasificacion_automatica_modificado]).toEqual([5, 12]);
        expect(res.asignaciones).toEqual({ total: 25, activas: 23, publicadas: 23, anuladas: 2 });
        expect(res.filas_aplicadas).toBe(25);
        // Las 8 modificaciones reales, identificadas con precisión.
        expect(filas.filter(f => f.categoria === 'MODIFICACION_COMPROBADA').map(f => f.detalle_id)).toEqual(Array.from({ length: 8 }, (_, k) => did(17 + k)));
        expect(filas.filter(f => f.categoria === 'MODIFICACION_COMPROBADA').every(f => f.fuentes_evidencia.includes('bitacora') && f.movimientos_modificacion === 1)).toBe(true);
        // Ninguna fila cambia; las 17 se tratan en la capa de visualización.
        expect(filas.every(f => !f.corregir && JSON.stringify(f.antes) === JSON.stringify(f.despues))).toBe(true);
        expect(filas.filter(f => f.categoria === 'CLASIFICACION_AUTOMATICA').every(f => /sin modificar datos/.test(f.tratamiento))).toBe(true);
    });
});
