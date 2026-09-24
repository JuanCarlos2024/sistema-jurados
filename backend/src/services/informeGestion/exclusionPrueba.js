// Exclusión estructural de datos de prueba del Informe de Gestión (migración 058).
// Son dos conceptos independientes:
//   - usuarios_pagados.es_prueba: la PERSONA sale de todo análisis personal (rankings, promedios, muestra,
//     seguimiento, disponibilidad, utilización). Sus rodeos siguen contando si el rodeo no es de prueba.
//   - rodeos.es_prueba: el RODEO (y todo lo que cuelga de él) sale de las estadísticas ejecutivas,
//     aunque hayan participado usuarios reales.
// Función pura: no escribe nada ni toca la base; solo filtra el dataset en memoria.

function excluirDatosPrueba(ds) {
    const rodeosPrueba = new Set(ds.rodeos.filter(r => r.es_prueba === true).map(r => r.id));

    const idsUsuariosPrueba = new Set([
        ...ds.usuarios.filter(u => u.es_prueba === true).map(u => u.id),
        ...(ds.idsUsuariosPrueba || [])
    ]);

    if (!rodeosPrueba.size && !idsUsuariosPrueba.size) {
        return { ...ds, datos_excluidos: { usuarios_prueba: 0, rodeos_prueba: 0 } };
    }

    const rodeos = ds.rodeos.filter(r => !rodeosPrueba.has(r.id));
    const evaluaciones = ds.evaluaciones.filter(e => !rodeosPrueba.has(e.rodeo_id));
    const evalIds = new Set(evaluaciones.map(e => e.id));

    // Asignaciones: fuera las de rodeos de prueba y las de personas de prueba (los rodeos reales se mantienen).
    const asignaciones = ds.asignaciones.filter(a => !rodeosPrueba.has(a.rodeo_id) && !idsUsuariosPrueba.has(a.usuario_pagado_id));
    const asigIds = new Set(asignaciones.map(a => a.id));

    return {
        ...ds,
        rodeos,
        evaluaciones,
        casos: ds.casos.filter(c => evalIds.has(c.evaluacion_id)),
        cartillas: ds.cartillas.filter(c => !rodeosPrueba.has(c.rodeo_id)),
        notasSecundarias: ds.notasSecundarias.filter(n => !rodeosPrueba.has(n.rodeo_id)),
        asignaciones,
        notasJurado: ds.notasJurado.filter(n => asigIds.has(n.asignacion_id)),
        usuarios: ds.usuarios.filter(u => !idsUsuariosPrueba.has(u.id)),
        disponibilidad: ds.disponibilidad.filter(d => !idsUsuariosPrueba.has(d.usuario_pagado_id)),
        // Solo conteos: nunca nombres ni ids.
        datos_excluidos: { usuarios_prueba: idsUsuariosPrueba.size, rodeos_prueba: rodeosPrueba.size }
    };
}

module.exports = { excluirDatosPrueba };
