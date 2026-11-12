// Historial Unificado de Designaciones — servicio (pantalla y Excel usan
// obtenerHistorialDesignaciones). Supabase falso en memoria que aplica
// filtros reales y el límite de 1000 filas de PostgREST (ver testkit).
jest.mock('../config/supabase', () => require('./resumenJurados.testkit').fake);

const kit = require('./resumenJurados.testkit');
const { obtenerHistorialDesignaciones, SIN_INFO } = require('./historialDesignaciones');

const ADMIN = { id: 'adm-1', nombre_completo: 'Ana Administradora' };
const JUR = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(l => [l, { id: `j${l}`, nombre_completo: `Jurado ${l}` }]));
const MOTIVO_ENF = { codigo: 'ENFERMEDAD', etiqueta: 'Enfermedad del jurado' };
const MOTIVO_AJ = { codigo: 'AJUSTE', etiqueta: 'Ajuste administrativo' };

function rodeo(id, fecha, extra = {}) {
    return { id, club: `Club ${id}`, asociacion: `Asoc ${id}`, fecha, duracion_dias: 1, tipo_rodeo_nombre: 'Provincial', temporada_id: 'T26', estado: 'activo', tipos_rodeo: { clasificaciones_designacion: { nombre: 'Provincial' } }, ...extra };
}
function propuesta(id, created_at, extra = {}) {
    return { id, estado: 'BORRADOR', creado_por: ADMIN.id, created_at, configuracion_version_id: 'cfg12', motor_usado: 'global', fecha_corte_tecnica: created_at, resultado_cobertura_json: { total_cupos: 5, cobertura_obtenida: 5, estado_busqueda: 'COBERTURA_COMPLETA' }, configuracion_designacion_versiones: { numero_version: 12 }, ...extra };
}
function detalle(id, propuesta_id, rodeo_id, propuesto, extra = {}) {
    return { id, propuesta_id, rodeo_id, jurado_id_propuesto: propuesto, jurado_id_seleccionado: null, estado_revision: 'PENDIENTE', origen_seleccion: null, explicacion_json: { jurado_propuesto: { jurado_id: propuesto, categoria: 'A', comuna_canonica: 'Rancagua', distancia_km: 120, checks: { disponible: true } } }, metricas_json: {}, created_at: '2026-11-01T12:00:00Z', updated_at: '2026-11-01T12:00:00Z', ...extra };
}
function asig(id, rodeo_id, usuario, extra = {}) {
    return { id, rodeo_id, usuario_pagado_id: usuario, tipo_persona: 'jurado', estado: 'activo', estado_designacion: 'pendiente', publicado: false, publicado_en: null, publicado_por: null, propuesta_detalle_id: null, nombre_importado: null, created_at: '2026-11-05T12:00:00Z', updated_at: '2026-11-05T12:00:00Z', created_by: ADMIN.id, aceptado_en: null, observacion_designacion: null, ...extra };
}
function bit(id, rodeo_id, tipo, ant, nue, extra = {}) {
    return { id, rodeo_id, tipo_movimiento: tipo, propuesta_detalle_id: null, asignacion_id: null, usuario_pagado_id_anterior: ant, nombre_anterior_snapshot: ant ? `Jurado ${ant.slice(1)}` : null, usuario_pagado_id_nuevo: nue, nombre_nuevo_snapshot: nue ? `Jurado ${nue.slice(1)}` : null, motivo_catalogo_id: null, motivo_detalle: null, actor_id: ADMIN.id, fecha_efectiva: extra.created_at, operacion_id: null, catalogo_motivos_designacion: null, ...extra };
}
function aud(id, tabla, registro_id, accion, created_at, extra = {}) {
    return { id, tabla, registro_id, accion, datos_anteriores: null, datos_nuevos: null, actor_id: ADMIN.id, actor_tipo: 'administrador', descripcion: null, created_at, ...extra };
}

function dataset() {
    return {
        administradores: [ADMIN],
        usuarios_pagados: Object.values(JUR),
        rodeos: [
            rodeo('R1', '2026-11-14'),                               // cadena completa con reemplazo
            rodeo('R2', '2026-11-15'),                               // solo propuesta del motor
            rodeo('R3', '2026-11-15'),                               // cambio manual en borrador
            rodeo('R4', '2026-11-21'),                               // anulación + nueva designación manual
            rodeo('R5', '2026-11-22'),                               // dos propuestas, una aplicada
            rodeo('R6', '2026-11-13', { duracion_dias: 2 }),         // 2 días: 13-14
            rodeo('R7', '2026-10-01'),                               // fuera del período
            rodeo('R8', '2026-11-28'),                               // asignación antigua sin auditoría
        ],
        propuestas_designacion: [propuesta('P1', '2026-11-01T13:16:36Z'), propuesta('P2', '2026-11-02T10:00:00Z')],
        propuestas_designacion_detalle: [
            detalle('D1', 'P1', 'R1', 'jA', { estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR', jurado_id_seleccionado: 'jA', explicacion_json: { jurado_propuesto: { jurado_id: 'jA', optimizacion_global_relajaciones: ['FINDE_CONSECUTIVO'] } } }),
            detalle('D2', 'P1', 'R2', 'jC'),
            detalle('D3', 'P1', 'R3', 'jC', { estado_revision: 'MODIFICADO', origen_seleccion: 'MANUAL', jurado_id_seleccionado: 'jD' }),
            detalle('D5', 'P1', 'R5', 'jG', { estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR', jurado_id_seleccionado: 'jG' }),
            detalle('D5b', 'P2', 'R5', 'jH'), // alternativa nunca aplicada
        ],
        asignaciones: [
            // R1: aplicada desde D1 a jA; luego reemplazada por jB (misma fila reescrita)
            asig('AS1', 'R1', 'jB', { propuesta_detalle_id: 'D1', created_at: '2026-11-03T10:00:00Z', publicado: true, publicado_en: '2026-11-03T11:00:00Z' }),
            asig('AS4a', 'R4', 'jE', { estado: 'anulado', created_at: '2026-11-04T09:00:00Z' }),
            asig('AS4b', 'R4', 'jF', { created_at: '2026-11-06T09:00:00Z' }),
            asig('AS5', 'R5', 'jG', { propuesta_detalle_id: 'D5', created_at: '2026-11-03T10:00:00Z' }),
            asig('AS8', 'R8', 'jH', { created_at: '2026-09-01T09:00:00Z', created_by: null, estado_designacion: 'aceptado', aceptado_en: '2026-09-02T09:00:00Z' }),
        ],
        bitacora_designaciones: [
            bit('B1', 'R1', 'aplicacion_propuesta', null, 'jA', { propuesta_detalle_id: 'D1', asignacion_id: 'AS1', created_at: '2026-11-03T10:00:00Z' }),
            bit('B2', 'R1', 'reemplazo', 'jA', 'jB', { asignacion_id: 'AS1', created_at: '2026-11-13T09:00:00Z', motivo_catalogo_id: 'm1', motivo_detalle: 'Licencia médica', catalogo_motivos_designacion: MOTIVO_ENF }),
            bit('B3', 'R3', 'modificacion_manual_borrador', 'jC', 'jD', { propuesta_detalle_id: 'D3', created_at: '2026-11-01T14:00:00Z', motivo_catalogo_id: 'm2', catalogo_motivos_designacion: MOTIVO_AJ }),
            bit('B5', 'R5', 'aplicacion_propuesta', null, 'jG', { propuesta_detalle_id: 'D5', asignacion_id: 'AS5', created_at: '2026-11-03T10:00:00Z' }),
        ],
        auditoria: [
            aud('U1', 'propuestas_designacion_detalle', 'D1', 'editar', '2026-11-01T13:30:00Z', { datos_nuevos: { jurado_id_seleccionado: 'jA', estado_revision: 'ACEPTADO', origen_seleccion: 'MOTOR', advertencias_confirmadas: ['FINDE_CONSECUTIVO'] }, descripcion: 'Jurado propuesto confirmado por el administrador: Jurado A' }),
            // duplica B3 (la auditoría remite a la bitácora) → no debe generar un 2º evento
            aud('U3', 'propuestas_designacion_detalle', 'D3', 'editar', '2026-11-01T14:00:00Z', { datos_nuevos: { jurado_id_seleccionado: 'jD', estado_revision: 'MODIFICADO' }, descripcion: 'Modificación manual en propuesta: Jurado D → MODIFICADO (bitácora 00000000-0000-0000-0000-0000000000b3)' }),
            aud('U4', 'asignaciones', 'AS1', 'crear', '2026-11-03T10:00:00Z', { datos_nuevos: { rodeo_id: 'R1', usuario_pagado_id: 'jA', origen: 'propuesta_designacion' } }),
            aud('U5', 'asignaciones', 'R1', 'publicar_designaciones', '2026-11-03T11:00:00Z', { datos_nuevos: { rodeo_id: 'R1', asignacion_ids: ['AS1'] }, descripcion: 'Designaciones publicadas para Club R1' }),
            aud('U6', 'asignaciones', 'AS1', 'editar', '2026-11-04T08:00:00Z', { actor_id: 'jA', actor_tipo: 'usuario_pagado', datos_nuevos: { estado_designacion: 'aceptado' }, descripcion: 'Designación aceptada: Club R1' }),
            aud('U7', 'asignaciones', 'AS4a', 'crear', '2026-11-04T09:00:00Z', { datos_nuevos: { rodeo_id: 'R4', usuario_pagado_id: 'jE' } }),
            aud('U8', 'asignaciones', 'AS4a', 'eliminar', '2026-11-05T09:00:00Z', { datos_anteriores: { usuario_pagado_id: 'jE' }, datos_nuevos: { estado: 'anulado', motivo: 'Indisponibilidad informada' } }),
            aud('U9', 'asignaciones', 'AS4b', 'crear', '2026-11-06T09:00:00Z', { datos_nuevos: { rodeo_id: 'R4', usuario_pagado_id: 'jF' } }),
        ],
        configuracion_retencion: [], temporadas: [{ id: 'T26', nombre: '2026-2027' }],
    };
}

const historialDe = (r, id) => r.rodeos.find(x => x.rodeo.id === id);
const tipos = h => h.eventos.map(e => e.tipo);

beforeEach(() => kit.cargarDataset(dataset()));

describe('Línea de tiempo por rodeo', () => {
    test('cadena completa: MOTOR → confirmación → aplicación → publicación → aceptación → reemplazo → vigente', async () => {
        const r = await obtenerHistorialDesignaciones({ rodeo_ids: ['R1'] });
        const h = historialDe(r, 'R1');
        expect(tipos(h)).toEqual([
            'MOTOR_PROPUESTA', 'RELAJACION_MOTOR', 'BORRADOR_GUARDADO', 'CONFIRMACION_ADMIN',
            'APLICACION_PROPUESTA', 'PUBLICACION', 'ACEPTACION', 'REEMPLAZO', 'ESTADO_FINAL',
        ]);
        const ev = Object.fromEntries(h.eventos.map(e => [e.tipo, e]));
        expect(ev.MOTOR_PROPUESTA).toMatchObject({ origen: 'MOTOR', jurado_nuevo: { id: 'jA', nombre: 'Jurado A' }, configuracion_version: 12, propuesta_aplicada: true });
        expect(ev.RELAJACION_MOTOR.estado_resultante).toMatch(/no es una decisión administrativa/);
        expect(ev.CONFIRMACION_ADMIN).toMatchObject({ origen: 'ADMINISTRADOR', responsable: 'Ana Administradora', jurado_nuevo: { id: 'jA' } });
        expect(ev.ACEPTACION).toMatchObject({ origen: 'JURADO', jurado_nuevo: { id: 'jA' } }); // jurado en ESE momento (antes del reemplazo)
        expect(ev.PUBLICACION.jurado_nuevo.id).toBe('jA');
        expect(ev.REEMPLAZO).toMatchObject({ jurado_anterior: { id: 'jA' }, jurado_nuevo: { id: 'jB' }, motivo: 'Enfermedad del jurado', justificacion: 'Licencia médica', responsable: 'Ana Administradora' });
        expect(ev.ESTADO_FINAL).toMatchObject({ origen: 'SISTEMA', jurado_nuevo: { id: 'jB', nombre: 'Jurado B' } });
        expect(h.resumen).toMatchObject({
            propuesta_aplicada_id: 'P1', configuracion_version: 12, jurado_propuesto_original: 'Jurado A',
            jurado_confirmado_admin: 'Jurado A', jurado_vigente: 'Jurado B', reemplazos_posteriores: 1,
            motivo_ultimo_reemplazo: 'Enfermedad del jurado', modificaciones_administrativas: 0,
        });
    });

    test('motor sin cambios administrativos: PENDIENTE, sin confirmación ni modificaciones', async () => {
        const h = historialDe(await obtenerHistorialDesignaciones({ rodeo_ids: ['R2'] }), 'R2');
        expect(tipos(h)).toEqual(['MOTOR_PROPUESTA', 'BORRADOR_GUARDADO', 'ESTADO_FINAL']);
        expect(h.eventos[1].estado_resultante).toMatch(/no implica aprobación/);
        expect(h.resumen).toMatchObject({ jurado_confirmado_admin: 'Sin confirmación administrativa', jurado_vigente: 'Sin jurado vigente', modificaciones_administrativas: 0, propuesta_aplicada_id: null });
    });

    test('cambio dentro de la propuesta: un solo evento (bitácora), sin duplicar la auditoría que lo describe', async () => {
        const h = historialDe(await obtenerHistorialDesignaciones({ rodeo_ids: ['R3'] }), 'R3');
        const mods = h.eventos.filter(e => e.tipo === 'MODIFICACION_BORRADOR');
        expect(mods).toHaveLength(1);
        expect(mods[0]).toMatchObject({ jurado_anterior: { id: 'jC' }, jurado_nuevo: { id: 'jD' }, motivo: 'Ajuste administrativo', responsable: 'Ana Administradora' });
        expect(h.resumen.modificaciones_administrativas).toBe(1);
        expect(h.resumen.jurado_confirmado_admin).toBe('Jurado D (modificado)');
    });

    test('anulación y nueva designación manual desde Rodeos', async () => {
        const h = historialDe(await obtenerHistorialDesignaciones({ rodeo_ids: ['R4'] }), 'R4');
        expect(tipos(h)).toEqual(['DESIGNACION_MANUAL', 'ANULACION', 'DESIGNACION_MANUAL', 'ESTADO_FINAL']);
        expect(h.eventos[1]).toMatchObject({ jurado_anterior: { id: 'jE' }, motivo: 'Indisponibilidad informada', estado_resultante: 'Anulada' });
        expect(h.eventos[2].jurado_nuevo.id).toBe('jF');
        expect(h.resumen.jurado_vigente).toBe('Jurado F'); // por asignaciones reales
        expect(h.resumen.jurado_propuesto_original).toBe('Sin propuesta del motor');
    });

    test('varias propuestas: distingue la aplicada de la alternativa nunca aplicada', async () => {
        const h = historialDe(await obtenerHistorialDesignaciones({ rodeo_ids: ['R5'] }), 'R5');
        const motor = h.eventos.filter(e => e.tipo === 'MOTOR_PROPUESTA');
        expect(motor.map(e => [e.propuesta_id, e.propuesta_aplicada])).toEqual([['P1', true], ['P2', false]]);
        expect(h.resumen).toMatchObject({ propuesta_aplicada_id: 'P1', propuestas_no_aplicadas: 1, jurado_propuesto_original: 'Jurado G', jurado_vigente: 'Jurado G' });
    });

    test('registro antiguo sin auditoría: eventos derivados rotulados, sin autor inventado', async () => {
        const h = historialDe(await obtenerHistorialDesignaciones({ rodeo_ids: ['R8'] }), 'R8');
        expect(tipos(h)).toEqual(['DESIGNACION_MANUAL', 'ACEPTACION', 'ESTADO_FINAL']);
        expect(h.eventos[0]).toMatchObject({ responsable: SIN_INFO, justificacion: expect.stringMatching(/reconstruido/) });
        expect(h.eventos[1]).toMatchObject({ origen: 'SISTEMA', responsable: SIN_INFO });
    });

    test('el jurado vigente sale de asignaciones reales, no del texto de la propuesta', async () => {
        const h = historialDe(await obtenerHistorialDesignaciones({ rodeo_ids: ['R1'] }), 'R1');
        // La propuesta dice A (ACEPTADO); la asignación real hoy es B.
        expect(h.resumen.jurado_confirmado_admin).toBe('Jurado A');
        expect(h.resumen.jurado_vigente).toBe('Jurado B');
    });

    test('sin eventos duplicados en ningún rodeo', async () => {
        const r = await obtenerHistorialDesignaciones({});
        r.rodeos.forEach(h => {
            const ids = h.eventos.map(e => e.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });
});

describe('Filtros del reporte', () => {
    test('el período selecciona rodeos (incluye uno de 2 días que empieza antes) y trae TODO su historial', async () => {
        // Fin de semana 14-15 nov: R1, R2, R3 y R6 (13-14). R7 queda fuera.
        const r = await obtenerHistorialDesignaciones({ fecha_desde: '2026-11-14', fecha_hasta: '2026-11-15' });
        expect(r.rodeos.map(x => x.rodeo.id).sort()).toEqual(['R1', 'R2', 'R3', 'R6']);
        // movimientos anteriores al período (propuesta del 01/11) siguen presentes
        expect(historialDe(r, 'R1').eventos.some(e => e.tipo === 'MOTOR_PROPUESTA' && e.fecha < '2026-11-14')).toBe(true);
    });

    test('jurado: incluye rodeos donde participó en cualquier rol', async () => {
        const r = await obtenerHistorialDesignaciones({ jurado_id: 'jA' });
        expect(r.rodeos.map(x => x.rodeo.id)).toEqual(['R1']);
        const rC = await obtenerHistorialDesignaciones({ jurado_id: 'jC' });
        expect(rC.rodeos.map(x => x.rodeo.id).sort()).toEqual(['R2', 'R3']);
    });

    test('propuesta, tipo de movimiento y origen', async () => {
        const p2 = await obtenerHistorialDesignaciones({ propuesta_id: 'P2' });
        expect(p2.rodeos.map(x => x.rodeo.id)).toEqual(['R5']);
        expect(p2.propuesta_original.map(f => f.propuesta_id)).toEqual(['P2']);

        const reemplazos = await obtenerHistorialDesignaciones({ tipo_movimiento: 'REEMPLAZO' });
        expect(reemplazos.rodeos.map(x => x.rodeo.id)).toEqual(['R1']);
        expect(reemplazos.rodeos[0].eventos.every(e => e.tipo === 'REEMPLAZO')).toBe(true);

        const jurado = await obtenerHistorialDesignaciones({ origen: 'JURADO' });
        expect(jurado.rodeos.map(x => x.rodeo.id)).toEqual(['R1']);
    });

    test('asociación y club', async () => {
        expect((await obtenerHistorialDesignaciones({ asociacion: 'asoc r4' })).rodeos.map(x => x.rodeo.id)).toEqual(['R4']);
        expect((await obtenerHistorialDesignaciones({ club: 'Club R5' })).rodeos.map(x => x.rodeo.id)).toEqual(['R5']);
    });
});

describe('Robustez', () => {
    test('paginación: más de 1000 movimientos de un rodeo no se omiten', async () => {
        const db = dataset();
        for (let i = 0; i < 1100; i++) {
            db.bitacora_designaciones.push(bit(`BX${String(i).padStart(5, '0')}`, 'R2', 'rectificacion_administrativa', 'jC', 'jC', { asignacion_id: null, propuesta_detalle_id: 'D2', created_at: `2026-11-0${1 + (i % 9)}T00:00:00Z` }));
        }
        kit.cargarDataset(db);
        const h = historialDe(await obtenerHistorialDesignaciones({ rodeo_ids: ['R2'] }), 'R2');
        expect(h.eventos.filter(e => e.tipo === 'REEMPLAZO')).toHaveLength(1100);
    });

    test('no altera ningún registro histórico (solo lectura)', async () => {
        const antes = JSON.stringify(kit.fake.db);
        await obtenerHistorialDesignaciones({});
        await obtenerHistorialDesignaciones({ fecha_desde: '2026-11-01', fecha_hasta: '2026-11-30', jurado_id: 'jB' });
        expect(JSON.stringify(kit.fake.db)).toBe(antes);
    });

    test('hoja "propuesta original": usa el snapshot guardado (categoría, comuna, distancia, cobertura)', async () => {
        const r = await obtenerHistorialDesignaciones({ rodeo_ids: ['R2'] });
        expect(r.propuesta_original[0]).toMatchObject({ propuesta_id: 'P1', jurado_propuesto: 'Jurado C', categoria: 'A', comuna: 'Rancagua', distancia_km: 120, configuracion_version: 12, motor: 'global', propuesta_aplicada: false, cobertura: '5/5 (COBERTURA_COMPLETA)' });
        expect(r.propuesta_original[0].nota_tecnica).toBeNull(); // no se inventa
    });
});
