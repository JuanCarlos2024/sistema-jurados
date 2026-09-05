// ─────────────────────────────────────────────────────────────────────────
// Propuesta de Designación de Jurados — Etapa 2 (infraestructura de datos)
// + Etapa 3 (motor en modo DRY-RUN, POST /dry-run más abajo).
//
// Este router expone catálogos, diagnóstico, y el motor de propuesta en modo
// SIMULACIÓN (dry-run). El dry-run NO escribe nada en la base de datos: no
// inserta, no actualiza, no elimina asignaciones — es de solo lectura sobre
// rodeos/asignaciones/usuarios_pagados/disponibilidad. NO crea todavía el
// flujo real de "confirmar propuesta". Eso corresponde a una etapa posterior.
//
// Permisos: HOY, SOLO Administrador pleno (rol_evaluacion = null). Cualquier
// otro perfil —incluyendo monitor, analista, comisión técnica, director/Jefe
// Área Deportiva o cualquier sub-rol futuro— queda DENEGADO por defecto.
//
// Esto es una ALLOWLIST, no un blocklist: se usa `soloRolEvaluacion(...)` (ya
// existente en middleware/auth.js) SIN argumentos, lo que permite únicamente
// rol_evaluacion === null (admin pleno) y deniega cualquier otro valor. Para
// habilitar un perfil adicional en el futuro (ej. Jefe Área Deportiva, que en
// este sistema corresponde a rol_evaluacion 'director'), basta con agregar su
// código a la llamada: soloRolEvaluacion('director'). No requiere tocar la
// lógica de las rutas ni el middleware en sí.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { resolverComuna, cargarCatalogoResolucionComunas } = require('../../services/geografia');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { generarSimulacion, filtrarRodeosSinJuradoEfectivo } = require('../../services/motorPropuestaDesignacion');
const { claveClubAsociacion, sugerirComunaParaClub, normalizarClub, normalizarAsociacionClub } = require('../../services/clubUbicaciones');

// Allowlist: solo administrador pleno (rol_evaluacion === null) hoy.
router.use(soloRolEvaluacion());

const CODIGOS_CLASIFICACION = [
    'interclubes', 'provincial', 'interasociaciones', 'zonal', 'clasificatorio', 'nacional'
];

// ─── GET /comunas?q= — catálogo comunas_chile para selector con búsqueda ───
// Sin q: devuelve el catálogo completo (345 comunas, tamaño manejable para un
// <datalist>). Con q (2+ caracteres): filtra por nombre, útil para búsqueda.
router.get('/comunas', async (req, res) => {
    const { q = '' } = req.query;
    let query = supabase
        .from('comunas_chile')
        .select('id, nombre, region, latitud, longitud')
        .eq('activo', true)
        .order('nombre', { ascending: true })
        .limit(400);

    if (q.trim().length >= 2) {
        query = query.ilike('nombre', `%${q.trim()}%`).limit(50);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── GET /clasificaciones — las 6 clasificaciones + su matriz A/B/C ────────
router.get('/clasificaciones', async (req, res) => {
    const { data: clasificaciones, error } = await supabase
        .from('clasificaciones_designacion')
        .select('id, codigo, nombre, orden')
        .order('orden', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const { data: matriz, error: errMatriz } = await supabase
        .from('clasificacion_categoria_matriz')
        .select('clasificacion_id, categoria, elegible, prioridad');

    if (errMatriz) return res.status(500).json({ error: errMatriz.message });

    const matrizPorClasificacion = {};
    for (const fila of (matriz || [])) {
        if (!matrizPorClasificacion[fila.clasificacion_id]) matrizPorClasificacion[fila.clasificacion_id] = [];
        matrizPorClasificacion[fila.clasificacion_id].push({
            categoria: fila.categoria, elegible: fila.elegible, prioridad: fila.prioridad
        });
    }

    res.json((clasificaciones || []).map(c => ({
        ...c,
        matriz: (matrizPorClasificacion[c.id] || []).sort((a, b) => a.prioridad - b.prioridad)
    })));
});

// ─── GET /tipos-rodeo-clasificacion — tipos_rodeo con su clasificación actual ───
router.get('/tipos-rodeo-clasificacion', async (req, res) => {
    const { activo } = req.query;
    let query = supabase
        .from('tipos_rodeo')
        .select('id, nombre, duracion_dias, activo, clasificacion_designacion_id, clasificaciones_designacion(codigo, nombre)')
        .order('nombre', { ascending: true });

    if (activo !== undefined) query = query.eq('activo', activo === 'true');

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json((data || []).map(t => ({
        id: t.id,
        nombre: t.nombre,
        duracion_dias: t.duracion_dias,
        activo: t.activo,
        clasificacion_codigo: t.clasificaciones_designacion?.codigo || null,
        clasificacion_nombre: t.clasificaciones_designacion?.nombre || null
    })));
});

// ─── PATCH /tipos-rodeo/:id/clasificacion — editar clasificación de un tipo ───
// Body: { clasificacion_codigo: 'interclubes'|'provincial'|...|null }
// NO toca nombre/duracion_dias/categoria_rodeo_id del tipo — solo este campo.
router.patch('/tipos-rodeo/:id/clasificacion', async (req, res) => {
    const { clasificacion_codigo } = req.body;

    if (clasificacion_codigo !== null && clasificacion_codigo !== undefined && !CODIGOS_CLASIFICACION.includes(clasificacion_codigo)) {
        return res.status(400).json({
            error: `clasificacion_codigo inválido. Valores permitidos: ${CODIGOS_CLASIFICACION.join(', ')}, o null (sin clasificar)`
        });
    }

    const { data: tipoAnterior } = await supabase
        .from('tipos_rodeo')
        .select('id, nombre, clasificacion_designacion_id')
        .eq('id', req.params.id)
        .single();

    if (!tipoAnterior) return res.status(404).json({ error: 'Tipo de rodeo no encontrado' });

    let clasificacion_designacion_id = null;
    let clasificacionNombre = 'Sin clasificar';
    if (clasificacion_codigo) {
        const { data: clas } = await supabase
            .from('clasificaciones_designacion')
            .select('id, nombre')
            .eq('codigo', clasificacion_codigo)
            .single();
        if (!clas) return res.status(400).json({ error: 'Clasificación no encontrada' });
        clasificacion_designacion_id = clas.id;
        clasificacionNombre = clas.nombre;
    }

    const { data, error } = await supabase
        .from('tipos_rodeo')
        .update({ clasificacion_designacion_id, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select('id, nombre, clasificacion_designacion_id')
        .single();

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'tipos_rodeo',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: { clasificacion_designacion_id: tipoAnterior.clasificacion_designacion_id },
        datos_nuevos: { clasificacion_designacion_id },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Clasificación de designación de "${tipoAnterior.nombre}" → ${clasificacionNombre}`,
        ip_address: req.ip
    });

    res.json(data);
});

// ─── GET /diagnostico — contadores de datos incompletos (solo lectura) ────
// No muta nada. Pensado para saber, antes de construir el motor, qué datos
// faltan: comuna/clasificación en rodeos, categoría/comuna/asociación en
// jurados, y resolución de la comuna en texto libre del jurado contra el
// catálogo comunas_chile (comparación conservadora, sin fuzzy matching).
router.get('/diagnostico', async (req, res) => {
    // ── Rodeos activos: con/sin comuna, con/sin clasificación (heredada del tipo) ──
    const PAGINA = 900;
    let rodeos = [];
    {
        let offset = 0;
        while (true) {
            const { data: pagina, error } = await supabase
                .from('rodeos')
                .select('id, comuna_id, tipo_rodeo_id, tipos_rodeo(clasificacion_designacion_id)')
                .eq('estado', 'activo')
                .range(offset, offset + PAGINA - 1);
            if (error) return res.status(500).json({ error: error.message });
            const filas = pagina || [];
            rodeos = rodeos.concat(filas);
            if (filas.length < PAGINA) break;
            offset += PAGINA;
        }
    }

    const diagnosticoRodeos = {
        total: rodeos.length,
        con_comuna: rodeos.filter(r => !!r.comuna_id).length,
        sin_comuna: rodeos.filter(r => !r.comuna_id).length,
        con_clasificacion: rodeos.filter(r => !!r.tipos_rodeo?.clasificacion_designacion_id).length,
        sin_clasificacion: rodeos.filter(r => !r.tipos_rodeo?.clasificacion_designacion_id).length
    };

    // ── Tipos de rodeo: clasificados vs sin clasificar ──
    const { data: tipos, error: errTipos } = await supabase
        .from('tipos_rodeo')
        .select('id, clasificacion_designacion_id')
        .eq('activo', true);
    if (errTipos) return res.status(500).json({ error: errTipos.message });

    const diagnosticoTipos = {
        total: (tipos || []).length,
        clasificados: (tipos || []).filter(t => !!t.clasificacion_designacion_id).length,
        sin_clasificar: (tipos || []).filter(t => !t.clasificacion_designacion_id).length
    };

    // ── Jurados activos: categoría, comuna, asociación, resolución de comuna ──
    const { data: jurados, error: errJ } = await supabase
        .from('usuarios_pagados')
        .select('id, categoria, comuna, asociacion')
        .eq('activo', true)
        .eq('tipo_persona', 'jurado');
    if (errJ) return res.status(500).json({ error: errJ.message });

    // Catálogo de resolución de comuna (comunas_chile + comunas_chile_alias),
    // cargado una sola vez — mismo mecanismo central que usará el futuro motor.
    let catalogoComunas;
    try {
        catalogoComunas = await cargarCatalogoResolucionComunas();
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    let conCategoria = 0, sinCategoria = 0;
    let conComuna = 0, sinComuna = 0, comunaResuelta = 0, comunaNoReconocida = 0;
    let asociacionVacia = 0;

    for (const j of (jurados || [])) {
        if (j.categoria && ['A', 'B', 'C'].includes(j.categoria)) conCategoria++; else sinCategoria++;

        const comunaTexto = (j.comuna || '').trim();
        if (comunaTexto) {
            conComuna++;
            const resultado = resolverComuna(comunaTexto, catalogoComunas);
            if (resultado.resuelto) comunaResuelta++; else comunaNoReconocida++;
        } else {
            sinComuna++;
        }

        if (!j.asociacion || !j.asociacion.trim()) asociacionVacia++;
    }

    const diagnosticoJurados = {
        total: (jurados || []).length,
        con_categoria: conCategoria,
        sin_categoria: sinCategoria,
        con_comuna_texto: conComuna,
        sin_comuna_texto: sinComuna,
        comuna_resuelta_contra_catalogo: comunaResuelta,
        comuna_no_reconocida_contra_catalogo: comunaNoReconocida,
        asociacion_vacia_o_nula: asociacionVacia
    };

    res.json({
        rodeos: diagnosticoRodeos,
        tipos_rodeo: diagnosticoTipos,
        jurados: diagnosticoJurados,
        generado_en: new Date().toISOString()
    });
});

// Detecta "la tabla todavía no existe" tanto en el código de error crudo de
// Postgres (42P01) como en el de PostgREST/Supabase (que valida contra su
// caché de esquema antes de tocar la BD y devuelve PGRST205/PGRST202 con un
// mensaje tipo "Could not find the table ... in the schema cache").
function esErrorTablaInexistente(error) {
    if (!error) return false;
    if (error.code === '42P01' || error.code === 'PGRST205' || error.code === 'PGRST202') return true;
    return /could not find the table|does not exist/i.test(error.message || '');
}

// Carga el mapa de ubicaciones habituales (club_ubicaciones) activas, para
// las claves club+asociación pedidas. Si la tabla todavía no existe (la
// migración 046 aún no fue aplicada), degrada a "sin sugerencias de este
// tipo" en vez de romper el buscador — así el endpoint sigue funcionando
// exactamente igual que hoy hasta que la migración se autorice y aplique.
async function cargarMapaUbicacionesHabituales(pares) {
    const mapa = new Map();
    if (pares.length === 0) return mapa;

    const { data, error } = await supabase
        .from('club_ubicaciones')
        .select('club_nombre_normalizado, asociacion_normalizada, comuna_id, comunas_chile(nombre)')
        .eq('activo', true);

    if (error) {
        if (esErrorTablaInexistente(error)) return mapa; // tabla no existe todavía — degradar, no romper
        throw new Error(error.message);
    }

    for (const row of (data || [])) {
        const clave = `${row.club_nombre_normalizado}||${row.asociacion_normalizada}`;
        mapa.set(clave, { comuna_id: row.comuna_id, comuna_nombre: row.comunas_chile?.nombre || null });
    }
    return mapa;
}

// ─── GET /rodeos-disponibles — buscador de rodeos SIN jurado efectivo ─────
// Alimenta el buscador del laboratorio de simulación (Etapa 3.1). Devuelve
// exclusivamente rodeos activos que NO tengan ya una asignación de jurado
// efectiva — mismo criterio único que usa el motor (esAsignacionEfectiva):
// una asignación rechazada o anulada NO cuenta como "ya tiene jurado".
// No oculta rodeos por falta de comuna/clasificación — eso lo reporta el
// dry-run como NO_EVALUABLE; aquí solo se informa para que el admin lo vea.
// Incluye, para los rodeos sin comuna, una sugerencia SEGURA (nunca aplicada
// automáticamente): ver services/clubUbicaciones.js.
//
// Anti N+1: consultas fijas (rodeos + asignaciones + catálogo de comunas +
// ubicaciones habituales), sin importar cuántos rodeos falten comuna.
router.get('/rodeos-disponibles', async (req, res) => {
    const { fecha_desde, fecha_hasta, asociacion, tipo_rodeo_id, q, estado_datos } = req.query;

    let query = supabase
        .from('rodeos')
        .select(`
            id, club, asociacion, fecha, tipo_rodeo_id, tipo_rodeo_nombre, comuna_id,
            tipos_rodeo(clasificaciones_designacion(codigo, nombre)),
            comunas_chile(nombre)
        `)
        .eq('estado', 'activo')
        .order('fecha', { ascending: true })
        .limit(200);

    if (fecha_desde)    query = query.gte('fecha', fecha_desde);
    if (fecha_hasta)    query = query.lte('fecha', fecha_hasta);
    if (asociacion)     query = query.ilike('asociacion', `%${asociacion}%`);
    if (tipo_rodeo_id)  query = query.eq('tipo_rodeo_id', tipo_rodeo_id);
    if (q)              query = query.or(`club.ilike.%${q}%,asociacion.ilike.%${q}%`);

    const { data: rodeos, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    if (!rodeos || rodeos.length === 0) return res.json({ rodeos: [] });

    const rodeoIds = rodeos.map(r => r.id);
    const { data: asigs, error: errA } = await supabase
        .from('asignaciones')
        .select('rodeo_id, estado, estado_designacion')
        .in('rodeo_id', rodeoIds)
        .eq('tipo_persona', 'jurado');
    if (errA) return res.status(500).json({ error: errA.message });

    // Único criterio de "ya tiene jurado" — el mismo que usa el motor
    // (filtrarRodeosSinJuradoEfectivo reutiliza esAsignacionEfectiva).
    const sinJurado = filtrarRodeosSinJuradoEfectivo(rodeos, asigs);

    // Catálogo de comunas + ubicaciones habituales, solo si hace falta
    // (algún rodeo visible carece de comuna) — evita trabajo innecesario.
    const necesitaSugerencia = sinJurado.some(r => !r.comuna_id);
    let catalogoComunas = null, mapaHabitual = new Map();
    if (necesitaSugerencia) {
        try {
            catalogoComunas = await cargarCatalogoResolucionComunas();
            mapaHabitual = await cargarMapaUbicacionesHabituales(sinJurado);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    let disponibles = sinJurado.map(r => {
        const clasificacion_codigo = r.tipos_rodeo?.clasificaciones_designacion?.codigo || null;
        const comuna_nombre = r.comunas_chile?.nombre || null;

        let sugerencia_comuna = null;
        if (!r.comuna_id && catalogoComunas) {
            sugerencia_comuna = sugerirComunaParaClub(r.club, r.asociacion, mapaHabitual, catalogoComunas);
        }

        return {
            id: r.id,
            club: r.club,
            asociacion: r.asociacion,
            fecha: r.fecha,
            tipo_rodeo_nombre: r.tipo_rodeo_nombre,
            clasificacion_codigo,
            clasificacion_nombre: r.tipos_rodeo?.clasificaciones_designacion?.nombre || null,
            comuna_id: r.comuna_id,
            comuna_nombre,
            sugerencia_comuna
        };
    });

    // Filtro "Estado de datos" (derivado, se aplica sobre lo ya calculado)
    if (estado_datos === 'sin_comuna')        disponibles = disponibles.filter(r => !r.comuna_nombre);
    else if (estado_datos === 'sin_clasificacion') disponibles = disponibles.filter(r => !r.clasificacion_codigo);
    else if (estado_datos === 'completo')     disponibles = disponibles.filter(r => r.comuna_nombre && r.clasificacion_codigo);

    res.json({ rodeos: disponibles });
});

// ─── POST /club-ubicacion — guardar/actualizar comuna habitual de un club ──
// Body: { club, asociacion, comuna_id }. Upsert por club+asociación
// normalizados (activo=true). Es solo una SUGERENCIA a futuro — no toca
// ningún rodeo. Solo Administrador (allowlist del router).
router.post('/club-ubicacion', async (req, res) => {
    const { club, asociacion, comuna_id } = req.body;
    if (!club || !asociacion || !comuna_id) {
        return res.status(400).json({ error: 'club, asociacion y comuna_id son requeridos' });
    }

    const { data: comuna } = await supabase.from('comunas_chile').select('id, nombre').eq('id', comuna_id).single();
    if (!comuna) return res.status(400).json({ error: 'Comuna no encontrada' });

    const payload = {
        club_nombre: club.trim(),
        club_nombre_normalizado: normalizarClub(club),
        asociacion: asociacion.trim(),
        asociacion_normalizada: normalizarAsociacionClub(asociacion),
        comuna_id,
        confirmado_por: req.usuario.id,
        confirmado_en: new Date().toISOString(),
        activo: true,
        updated_at: new Date().toISOString()
    };

    const { data, error } = await supabase
        .from('club_ubicaciones')
        .upsert(payload, { onConflict: 'club_nombre_normalizado,asociacion_normalizada' })
        .select()
        .single();

    if (error) {
        if (esErrorTablaInexistente(error)) {
            return res.status(409).json({ error: 'La tabla club_ubicaciones todavía no existe (migración 046 pendiente de aplicar)' });
        }
        return res.status(500).json({ error: error.message });
    }

    await auditoria.registrar({
        tabla: 'club_ubicaciones',
        registro_id: data.id,
        accion: 'crear',
        datos_nuevos: { club: payload.club_nombre, asociacion: payload.asociacion, comuna_id, comuna_nombre: comuna.nombre },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Comuna habitual guardada: ${payload.club_nombre} (${payload.asociacion}) → ${comuna.nombre}`,
        ip_address: req.ip
    });

    res.json(data);
});

// ─── GET /rodeos-mismo-club — otros rodeos del mismo club+asociación sin comuna ──
// Usado para el prompt "Existen X rodeos sin comuna de este mismo club" —
// SOLO informa, no aplica nada. Comparación EXACTA normalizada (no ILIKE,
// no fuzzy) para no agrupar clubes distintos por coincidencia parcial.
router.get('/rodeos-mismo-club', async (req, res) => {
    const { club, asociacion, excluir } = req.query;
    if (!club || !asociacion) return res.status(400).json({ error: 'club y asociacion son requeridos' });

    const clubNorm = normalizarClub(club);
    const asocNorm = normalizarAsociacionClub(asociacion);

    const { data, error } = await supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha')
        .eq('estado', 'activo')
        .is('comuna_id', null);
    if (error) return res.status(500).json({ error: error.message });

    const coincidencias = (data || []).filter(r =>
        r.id !== excluir &&
        normalizarClub(r.club) === clubNorm &&
        normalizarAsociacionClub(r.asociacion) === asocNorm
    );

    res.json({ rodeos: coincidencias });
});

// ─── POST /aplicar-comuna-lote — aplicar una comuna a rodeos EXPLÍCITAMENTE elegidos ──
// Body: { comuna_id, rodeo_ids: [...] }. Requiere que el admin haya
// confirmado la lista exacta (ver GET /rodeos-mismo-club) — nunca aplica
// "todos los que coincidan" automáticamente. Solo actualiza rodeos activos
// cuya comuna_id sea NULL (no sobrescribe una comuna ya cargada por lote).
router.post('/aplicar-comuna-lote', async (req, res) => {
    const { comuna_id, rodeo_ids } = req.body;
    if (!comuna_id || !Array.isArray(rodeo_ids) || rodeo_ids.length === 0) {
        return res.status(400).json({ error: 'comuna_id y rodeo_ids (array no vacío) son requeridos' });
    }

    const { data: comuna } = await supabase.from('comunas_chile').select('id, nombre').eq('id', comuna_id).single();
    if (!comuna) return res.status(400).json({ error: 'Comuna no encontrada' });

    const { data: actualizados, error } = await supabase
        .from('rodeos')
        .update({ comuna_id, updated_at: new Date().toISOString() })
        .in('id', rodeo_ids)
        .eq('estado', 'activo')
        .is('comuna_id', null)
        .select('id, club, fecha');

    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'rodeos',
        registro_id: null,
        accion: 'editar',
        datos_nuevos: { comuna_id, comuna_nombre: comuna.nombre, rodeos_afectados: (actualizados || []).map(r => r.id) },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Comuna "${comuna.nombre}" aplicada en lote a ${(actualizados || []).length} rodeo(s) (confirmado manualmente)`,
        ip_address: req.ip
    });

    res.json({ mensaje: `${(actualizados || []).length} rodeo(s) actualizado(s)`, actualizados: actualizados || [] });
});

// ─── POST /dry-run — motor de propuesta en modo SIMULACIÓN ────────────────
// Body: { rodeo_ids: [uuid, ...] }
// Respuesta: { modo:'DRY_RUN', temporada, resumen, resultados, ... }
//
// SOLO LECTURA: no llama a POST /admin/asignaciones, no hace INSERT/UPDATE/
// DELETE sobre asignaciones/rodeos/usuarios_pagados/disponibilidad. No
// guarda ningún log ni resultado — cada llamada recalcula todo desde cero.
router.post('/dry-run', async (req, res) => {
    const { rodeo_ids } = req.body;

    if (!Array.isArray(rodeo_ids) || rodeo_ids.length === 0) {
        return res.status(400).json({ error: 'rodeo_ids debe ser un array con al menos un id' });
    }
    if (rodeo_ids.length > 200) {
        return res.status(400).json({ error: 'Máximo 200 rodeos por corrida de simulación' });
    }

    try {
        const resultado = await generarSimulacion(rodeo_ids);
        res.json(resultado);
    } catch (err) {
        console.error('[DRY-RUN] Error generando simulación:', err.message);
        res.status(500).json({ error: 'No se pudo generar la simulación: ' + err.message });
    }
});

module.exports = router;
