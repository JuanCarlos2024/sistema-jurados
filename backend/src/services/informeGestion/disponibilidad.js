// ═════════════════════════════════════════════════════════════════════════
// Disponibilidad DECLARADA y utilización de jurados.
//
// disponibilidad_usuarios solo guarda días POSITIVOS (usuario, fecha): no
// existe "no disponible". Por eso:
//   · el indicador se llama DISPONIBILIDAD DECLARADA;
//   · un día sin registro NUNCA se interpreta como "no disponible": el
//     estado es SIN_DECLARACION_REGISTRADA;
//   · el usuario solo puede marcar el mes en curso y el siguiente, así que
//     en períodos antiguos la ausencia de registros no es informativa.
//
// Unidad de análisis = BLOQUE de rodeo (sábado/domingo/feriado consecutivos,
// mismo criterio de services/feriados.js → esDiaRodeo). No se duplican las
// reglas del motor de designación: solo se lee asignaciones ya existentes.
// ═════════════════════════════════════════════════════════════════════════
const feriados = require('../feriados');
const { addDays, diffDays } = require('./fechasEquivalentes');
const { redondear, porcentaje } = require('./agregados');

// Bloques de días de rodeo dentro de [desde, hasta]: [{ inicio, fin, dias[] }]
function bloquesRodeo(desde, hasta, esDiaRodeo = feriados.esDiaRodeo) {
    const bloques = [];
    let actual = null;
    const total = diffDays(hasta, desde);
    for (let i = 0; i <= total; i++) {
        const f = addDays(desde, i);
        if (esDiaRodeo(f)) {
            if (!actual) { actual = { inicio: f, fin: f, dias: [f] }; bloques.push(actual); }
            else { actual.fin = f; actual.dias.push(f); }
        } else {
            actual = null;
        }
    }
    return bloques;
}

function analizarDisponibilidad({ desde, hasta, jurados, disponibilidad, asignaciones, rodeos }, opciones = {}) {
    const esDiaRodeo = opciones.esDiaRodeo || feriados.esDiaRodeo;
    const rangoFechas = opciones.rangoFechas || feriados.rangoFechas;
    const bloques = bloquesRodeo(desde, hasta, esDiaRodeo);

    const rodeoPorId = {};
    (rodeos || []).forEach(r => { if (r.estado === 'activo') rodeoPorId[r.id] = r; });

    const diasDeclarados = new Map();
    for (const d of (disponibilidad || [])) {
        if (d.fecha < desde || d.fecha > hasta) continue;
        if (!diasDeclarados.has(d.usuario_pagado_id)) diasDeclarados.set(d.usuario_pagado_id, new Set());
        diasDeclarados.get(d.usuario_pagado_id).add(d.fecha);
    }

    const bloquesDesignados = new Map();
    const designacionesPorJurado = new Map();
    for (const a of (asignaciones || [])) {
        if (a.tipo_persona !== 'jurado' || a.estado !== 'activo' || a.estado_designacion === 'rechazado' || !a.usuario_pagado_id) continue;
        const r = rodeoPorId[a.rodeo_id];
        if (!r || r.fecha < desde || r.fecha > hasta) continue;
        designacionesPorJurado.set(a.usuario_pagado_id, (designacionesPorJurado.get(a.usuario_pagado_id) || 0) + 1);
        const dias = new Set(rangoFechas(r.fecha, r.duracion_dias || 1));
        bloques.forEach((b, idx) => {
            if (b.dias.some(d => dias.has(d))) {
                if (!bloquesDesignados.has(a.usuario_pagado_id)) bloquesDesignados.set(a.usuario_pagado_id, new Set());
                bloquesDesignados.get(a.usuario_pagado_id).add(idx);
            }
        });
    }

    const detalle = (jurados || []).map(j => {
        const declarados = diasDeclarados.get(j.id) || new Set();
        const idxDeclarados = new Set();
        bloques.forEach((b, idx) => { if (b.dias.some(d => declarados.has(d))) idxDeclarados.add(idx); });
        const designados = bloquesDesignados.get(j.id) || new Set();
        const designadosConDisp = [...designados].filter(i => idxDeclarados.has(i)).length;
        return {
            usuario_id: j.id,
            jurado: j.nombre_completo || null,
            categoria: j.categoria || null,
            estado: idxDeclarados.size === 0 ? 'SIN_DECLARACION_REGISTRADA' : 'CON_DECLARACION',
            bloques_posibles: bloques.length,
            bloques_con_disponibilidad_declarada: idxDeclarados.size,
            porcentaje_disponibilidad_declarada: porcentaje(idxDeclarados.size, bloques.length),
            designaciones: designacionesPorJurado.get(j.id) || 0,
            bloques_designados: designados.size,
            bloques_designados_con_disponibilidad_declarada: designadosConDisp,
            utilizacion_sobre_disponibilidad_declarada: idxDeclarados.size ? porcentaje(designadosConDisp, idxDeclarados.size) : null,
            bloques_designados_sin_declaracion: designados.size - designadosConDisp
        };
    });

    const conDecl = detalle.filter(d => d.estado === 'CON_DECLARACION');
    // Casos de lectura (NO son evaluación de las personas): disponibilidad declarada sin designación, y la más baja.
    const brecha = d => d.bloques_con_disponibilidad_declarada - d.bloques_designados_con_disponibilidad_declarada;
    const porNombre = (a, b) => (a.jurado || '').localeCompare(b.jurado || '', 'es');
    const destacados = {
        mayor_disponibilidad_sin_utilizar: conDecl.filter(d => brecha(d) > 0)
            .sort((a, b) => brecha(b) - brecha(a) || b.bloques_con_disponibilidad_declarada - a.bloques_con_disponibilidad_declarada || porNombre(a, b)).slice(0, 10),
        menor_disponibilidad_declarada: [...conDecl]
            .sort((a, b) => a.porcentaje_disponibilidad_declarada - b.porcentaje_disponibilidad_declarada || porNombre(a, b)).slice(0, 5),
        criterio: 'mayor_disponibilidad_sin_utilizar = bloques con disponibilidad declarada menos bloques designados con esa disponibilidad; no es una evaluación de la persona.'
    };
    const sumDisp = conDecl.reduce((s, d) => s + d.bloques_con_disponibilidad_declarada, 0);
    const sumUso = conDecl.reduce((s, d) => s + d.bloques_designados_con_disponibilidad_declarada, 0);
    return {
        rango: { desde, hasta },
        bloques_posibles: bloques.length,
        resumen: {
            jurados_analizados: detalle.length,
            con_declaracion: conDecl.length,
            sin_declaracion_registrada: detalle.length - conDecl.length,
            porcentaje_jurados_con_declaracion: porcentaje(conDecl.length, detalle.length),
            promedio_disponibilidad_declarada_pct: conDecl.length ? redondear(conDecl.reduce((s, d) => s + d.porcentaje_disponibilidad_declarada, 0) / conDecl.length, 1) : null,
            utilizacion_global_sobre_disponibilidad_declarada: sumDisp ? porcentaje(sumUso, sumDisp) : null
        },
        destacados,
        nota_metodologica: 'DISPONIBILIDAD DECLARADA: solo se registran días disponibles. La ausencia de registro se informa como SIN_DECLARACION_REGISTRADA, nunca como "no disponible". El usuario solo puede declarar el mes en curso y el siguiente.',
        detalle
    };
}

module.exports = { bloquesRodeo, analizarDisponibilidad };
