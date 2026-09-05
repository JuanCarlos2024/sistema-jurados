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
const { generarSimulacion, cargarDatosMotor, ejecutarSimulacion, filtrarRodeosSinJuradoEfectivo, evaluarCandidatoDirecto, TOP_N_TODOS_LOS_CANDIDATOS } = require('../../services/motorPropuestaDesignacion');
const { claveClubAsociacion, sugerirComunaParaClub, normalizarClub, normalizarAsociacionClub } = require('../../services/clubUbicaciones');
const { clasificarJurado } = require('../../services/diagnosticoJurados');
const { calcularBloqueRodeo } = require('../../services/feriados');
const {
    construirDetalleDesdeResultado, detectarConflictoInterno, decidirEstadoSeleccion, resumenPropuesta,
    resolverFilaALiberar, obtenerJuradoEfectivo, ESTADOS_REVISION,
    evaluarCambiosParaGuardar
} = require('../../services/propuestaDesignacion');
const { firmarPreview, verificarPreviewToken, mapaPorRodeo } = require('../../services/previewIntegridad');

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

// ─── GET /asociaciones-existentes — valores DISTINCT ya usados en el sistema ──
// Alimenta el datalist de sugerencias al completar la asociación de un
// jurado (panel "Datos pendientes"). Devuelve exactamente los valores tal
// como están guardados hoy en rodeos.asociacion y usuarios_pagados.asociacion
// — SIN normalizar, SIN fusionar, SIN fuzzy matching. "BÍO-BÍO" y
// "RÍO BÍO-BÍO" (o cualquier otro par distinto) aparecen como dos entradas
// separadas, tal cual están en la base. Sigue siendo posible escribir un
// valor nuevo que no esté en la lista — esto es solo una sugerencia.
router.get('/asociaciones-existentes', async (req, res) => {
    const [{ data: rodeosAsoc, error: e1 }, { data: usuariosAsoc, error: e2 }] = await Promise.all([
        supabase.from('rodeos').select('asociacion').eq('estado', 'activo'),
        supabase.from('usuarios_pagados').select('asociacion').eq('activo', true)
    ]);
    if (e1) return res.status(500).json({ error: e1.message });
    if (e2) return res.status(500).json({ error: e2.message });

    const valores = new Set();
    for (const r of (rodeosAsoc || [])) if (r.asociacion && r.asociacion.trim()) valores.add(r.asociacion.trim());
    for (const u of (usuariosAsoc || [])) if (u.asociacion && u.asociacion.trim()) valores.add(u.asociacion.trim());

    res.json({ asociaciones: [...valores].sort((a, b) => a.localeCompare(b, 'es')) });
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

    // Misma función que usa GET /jurados-pendientes — un solo criterio, para
    // que el contador de aquí y la lista de allá nunca puedan divergir.
    let conCategoria = 0, sinCategoria = 0;
    let conComuna = 0, sinComuna = 0, comunaResuelta = 0, comunaNoReconocida = 0;
    let asociacionVacia = 0;

    for (const j of (jurados || [])) {
        const c = clasificarJurado(j, catalogoComunas);
        if (c.sinCategoria) sinCategoria++; else conCategoria++;
        if (c.sinComuna) sinComuna++; else conComuna++;
        if (c.comunaNoReconocida) comunaNoReconocida++; else if (!c.sinComuna) comunaResuelta++;
        if (c.sinAsociacion) asociacionVacia++;
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

// ─── GET /jurados-pendientes?tipo= — lista exacta de jurados afectados ────
// Complemento de /diagnostico: éste da contadores, este otro da las filas
// reales para poder corregirlas sin buscar manualmente. Usa exactamente el
// mismo criterio (clasificarJurado) que /diagnostico, así el número del
// indicador y la cantidad de filas devueltas siempre coinciden. Solo
// lectura — no modifica nada.
router.get('/jurados-pendientes', async (req, res) => {
    const { tipo } = req.query;
    const tiposValidos = ['sin_categoria', 'sin_comuna', 'sin_asociacion', 'comuna_no_reconocida'];
    if (!tiposValidos.includes(tipo)) {
        return res.status(400).json({ error: `tipo inválido. Valores permitidos: ${tiposValidos.join(', ')}` });
    }

    const { data: jurados, error } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, codigo_interno, categoria, comuna, asociacion')
        .eq('activo', true)
        .eq('tipo_persona', 'jurado')
        .order('nombre_completo');
    if (error) return res.status(500).json({ error: error.message });

    let catalogoComunas;
    try {
        catalogoComunas = await cargarCatalogoResolucionComunas();
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    const CAMPO = { sin_categoria: 'sinCategoria', sin_comuna: 'sinComuna', sin_asociacion: 'sinAsociacion', comuna_no_reconocida: 'comunaNoReconocida' };
    const campo = CAMPO[tipo];

    const afectados = (jurados || [])
        .filter(j => clasificarJurado(j, catalogoComunas)[campo])
        .map(j => ({
            id: j.id, nombre_completo: j.nombre_completo, codigo_interno: j.codigo_interno,
            categoria: j.categoria, comuna: j.comuna, asociacion: j.asociacion
        }));

    res.json({ jurados: afectados });
});

// ─── GET /tipos-rodeo-afectando-rodeos — qué tipos causan "rodeos sin ────
// clasificación" (la clasificación se define en el TIPO, no en el rodeo).
// Devuelve solo tipos sin clasificar que además tienen al menos un rodeo
// activo — para que la acción "Corregir Tipo de Rodeo" apunte exactamente
// a los tipos que están causando el problema hoy, no a cualquier tipo sin
// clasificar aunque no lo use nadie. Solo lectura.
router.get('/tipos-rodeo-afectando-rodeos', async (req, res) => {
    const { data: rodeos, error } = await supabase
        .from('rodeos')
        .select('tipo_rodeo_id, tipo_rodeo_nombre, tipos_rodeo(clasificacion_designacion_id)')
        .eq('estado', 'activo');
    if (error) return res.status(500).json({ error: error.message });

    const conteo = new Map(); // tipo_rodeo_id -> { nombre, cantidad }
    for (const r of (rodeos || [])) {
        if (r.tipos_rodeo?.clasificacion_designacion_id) continue; // ya clasificado, no es el problema
        if (!r.tipo_rodeo_id) continue;
        if (!conteo.has(r.tipo_rodeo_id)) conteo.set(r.tipo_rodeo_id, { tipo_rodeo_id: r.tipo_rodeo_id, nombre: r.tipo_rodeo_nombre, cantidad_rodeos: 0 });
        conteo.get(r.tipo_rodeo_id).cantidad_rodeos++;
    }

    res.json({ tipos: [...conteo.values()].sort((a, b) => b.cantidad_rodeos - a.cantidad_rodeos) });
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
// Respuesta: { modo:'DRY_RUN', temporada, resumen, resultados, preview_token, ... }
//
// SOLO LECTURA: no llama a POST /admin/asignaciones, no hace INSERT/UPDATE/
// DELETE sobre asignaciones/rodeos/usuarios_pagados/disponibilidad. No
// guarda ningún log ni resultado — cada llamada recalcula todo desde cero.
//
// preview_token: firma de integridad (HMAC, ver services/previewIntegridad.js)
// sobre el snapshot INMUTABLE de este resultado (temporada + por rodeo:
// estado + jurado_id_propuesto original). Mientras el administrador edita la
// propuesta en memoria del navegador ANTES de guardar (sin nada persistido
// todavía), este token viaja de ida y vuelta en cada llamada a /preview/* y
// a /propuestas — el backend lo verifica siempre antes de confiar en nada
// del "jurado originalmente propuesto por el motor" que declare el cliente.
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

        // Enriquecer cada resultado con tipo de rodeo/clasificación/comuna —
        // mismo join que ya usa GET /propuestas/:id — para que la tarjeta de
        // PREVIEW (editable antes de guardar) tenga exactamente los mismos
        // datos que la tarjeta de un borrador ya guardado (sección 2/16).
        const { data: rodeosDetalle } = await supabase
            .from('rodeos')
            .select('id, tipo_rodeo_nombre, tipos_rodeo(clasificaciones_designacion(codigo, nombre)), comunas_chile(nombre)')
            .in('id', rodeo_ids);
        const detallePorId = new Map((rodeosDetalle || []).map(r => [r.id, r]));
        resultado.resultados.forEach(res2 => {
            if (!res2.rodeo) return;
            const d = detallePorId.get(res2.rodeo_id);
            res2.rodeo.tipo_rodeo_nombre = d?.tipo_rodeo_nombre || null;
            res2.rodeo.clasificacion_nombre = d?.tipos_rodeo?.clasificaciones_designacion?.nombre || null;
            res2.rodeo.comuna_nombre = d?.comunas_chile?.nombre || null;
        });

        const { data: temporadaActiva } = await supabase.from('temporadas').select('id').eq('activa', true).maybeSingle();
        const preview_token = firmarPreview({
            temporada_id: temporadaActiva?.id || null,
            rodeos: resultado.resultados.map(r => ({
                rodeo_id: r.rodeo_id,
                estado: r.estado,
                jurado_id_propuesto: r.estado === 'PROPUESTO' ? r.jurado_propuesto.jurado_id : null
            }))
        });
        res.json({ ...resultado, preview_token });
    } catch (err) {
        console.error('[DRY-RUN] Error generando simulación:', err.message);
        res.status(500).json({ error: 'No se pudo generar la simulación: ' + err.message });
    }
});

// ═════════════════════════════════════════════════════════════════════════
// Etapa 4 — PROPUESTA BORRADOR persistente. NO crea asignaciones reales, NO
// publica, NO es visible para ningún jurado. Reutiliza generarSimulacion()/
// ejecutarSimulacion() para todo lo que es "reglas del motor" — este bloque
// solo agrega la capa de persistencia + selección/aceptación administrativa.
// ═════════════════════════════════════════════════════════════════════════

// ─── POST /propuestas — persiste el estado temporal editado como BORRADOR ──
// Body: { preview_token, estado_temporal }. YA NO vuelve a correr el motor y
// pisar lo que el administrador editó durante el preview — revalida cada
// fila contra datos frescos y, si nada cambió desde el dry-run, persiste
// EXACTAMENTE lo editado. Si algo cambió (nueva asignación, disponibilidad,
// conflicto nuevo), NO reemplaza en silencio: no guarda nada y devuelve qué
// filas requieren revisión (todo o nada — el administrador decide, sección
// 11-12 del pedido). El cliente expresa elecciones; el servidor construye
// el registro definitivo (`construirDetalleDesdeResultado` sobre datos
// frescos, nunca lo que mandó el navegador).
router.post('/propuestas', async (req, res) => {
    const { preview_token, estado_temporal } = req.body;

    const validacion = validarEstadoTemporal(preview_token, estado_temporal);
    if (validacion.error) return res.status(400).json({ error: validacion.error });
    const { snapshot, tokenPorRodeo } = validacion;
    const idsUnicos = [...tokenPorRodeo.keys()];

    // Advertencia (no bloqueante) de rodeos ya presentes en otra propuesta BORRADOR
    let rodeosYaEnOtraPropuesta = [];
    {
        const { data: yaEnOtra, error: errYa } = await supabase
            .from('propuestas_designacion_detalle')
            .select('rodeo_id, propuestas_designacion!inner(estado)')
            .in('rodeo_id', idsUnicos)
            .eq('propuestas_designacion.estado', 'BORRADOR');
        if (errYa) return res.status(500).json({ error: errYa.message });
        rodeosYaEnOtraPropuesta = [...new Set((yaEnOtra || []).map(r => r.rodeo_id))];
    }

    // Revalidación EN VIVO — UNA carga batched del motor (cargarDatosMotor,
    // sin N+1) + UNA consulta de datos reales de rodeos. `resultadoFresco`
    // (topN por defecto) es solo para mostrar estado/explicación/"por qué
    // ganó" — la validez de un jurado puntual se decide con
    // evaluarCandidatoDirecto() más abajo, nunca buscándolo en esta lista
    // (sección 7/9 de la revisión final: la integridad del guardado no
    // depende de ningún límite artificial).
    let contexto, resultadoFresco, rodeosPorId;
    try {
        contexto = await cargarDatosMotor(idsUnicos);
        resultadoFresco = ejecutarSimulacion(contexto);
        rodeosPorId = await cargarRodeosRealesPorId(idsUnicos);
    } catch (err) {
        return res.status(500).json({ error: 'No se pudo revalidar la propuesta: ' + err.message });
    }
    const frescoPorRodeo = new Map(resultadoFresco.resultados.map(r => [r.rodeo_id, r]));
    const estadoTemporalPorRodeo = new Map(estado_temporal.map(f => [f.rodeo_id, f]));

    // Filas enriquecidas de TODO el conjunto, para detectarConflictoInterno —
    // construidas UNA sola vez y reutilizadas por cada fila con selección.
    const todasFilasEnriquecidas = enriquecerFilasParaConflicto(
        idsUnicos.map(id => {
            const f = estadoTemporalPorRodeo.get(id);
            return {
                detalle_id: id, estado_revision: f.estado_revision, jurado_id_seleccionado: f.jurado_id_seleccionado,
                jurado_id_propuesto: tokenPorRodeo.get(id)?.jurado_id_propuesto ?? null, rodeo_id: id
            };
        }),
        rodeosPorId
    );

    const cambiosDetectados = [];
    const filasParaPersistir = [];

    for (const rodeoId of idsUnicos) {
        const fresco = frescoPorRodeo.get(rodeoId);
        const original = tokenPorRodeo.get(rodeoId);
        const temporal = estadoTemporalPorRodeo.get(rodeoId);

        if (!fresco) {
            cambiosDetectados.push({ rodeo_id: rodeoId, motivo: 'El rodeo ya no se pudo revalidar (puede haber sido eliminado o desactivado).' });
            continue;
        }

        // Un rodeo que AHORA es NO_EVALUABLE (cambió un dato estructural —
        // comuna/clasificación) es un cambio real que sí requiere revisión,
        // sin importar si había o no una selección administrativa.
        if (fresco.estado === 'NO_EVALUABLE' && original.estado !== 'NO_EVALUABLE') {
            cambiosDetectados.push({ rodeo_id: rodeoId, motivo: 'El rodeo ya no es evaluable — cambió un dato estructural (comuna/clasificación) desde que se generó la propuesta.' });
            continue;
        }

        if (temporal.estado_revision === 'SIN_JURADO_ACTUAL') {
            // El jurado fue movido a otra fila durante el preview — se
            // conserva tal cual (histórico intacto, sin jurado vigente aquí).
            // jurado_id_propuesto SIEMPRE sale del snapshot firmado
            // (`original`), NUNCA de `fresco` — el histórico no cambia por revalidar.
            filasParaPersistir.push({
                rodeo_id: rodeoId, jurado_id_propuesto: original.jurado_id_propuesto, jurado_id_seleccionado: null,
                estado_revision: 'SIN_JURADO_ACTUAL', origen_seleccion: null, explicacion_json: {}, metricas_json: {}
            });
            continue;
        }

        // Jurado EFECTIVO que se persistiría en esta fila según lo editado
        // en el preview — misma fuente única de verdad que el resto del
        // sistema (obtenerJuradoEfectivo), alimentada con el jurado_id_
        // propuesto INMUTABLE del snapshot (nunca el de `fresco`).
        const juradoEfectivo = obtenerJuradoEfectivo({
            estado_revision: temporal.estado_revision, jurado_id_seleccionado: temporal.jurado_id_seleccionado,
            jurado_id_propuesto: original.jurado_id_propuesto
        });

        if (!juradoEfectivo) {
            // SIN_PROPUESTA / NO_EVALUABLE — nunca hubo una decisión
            // administrativa que proteger; se persiste tal cual el motor lo
            // ve AHORA (no hay riesgo de pisar ninguna elección).
            filasParaPersistir.push(construirDetalleDesdeResultado(fresco));
            continue;
        }

        // Hay un jurado efectivo (aceptado explícitamente, modificado, o
        // simplemente la propuesta del motor sin tocar todavía) — la
        // pregunta de la revalidación es "¿este jurado específico SIGUE
        // SIENDO VÁLIDO para este rodeo?", NUNCA "¿el motor lo elegiría de
        // nuevo como ganador?" — un cambio de ranking/equidad por sí solo
        // NO invalida una selección que sigue cumpliendo todas las reglas
        // duras (sección 1 de la revisión).
        // Evaluación DIRECTA de ESTE jurado puntual — nunca "¿aparece entre
        // los primeros N?" (sección 7/8 de la revisión final). Si no se
        // encuentra (inactivo/eliminado) o el rodeo/tipo ya no es evaluable,
        // evaluarCandidatoDirecto() lo indica explícitamente.
        const resultadoEval = evaluarCandidatoDirecto(contexto, rodeoId, juradoEfectivo);
        if (resultadoEval.error) {
            cambiosDetectados.push({ rodeo_id: rodeoId, club: fresco.rodeo?.club, fecha: fresco.rodeo?.fecha, motivo: 'El jurado ya no se pudo evaluar para este rodeo (puede haber dejado de existir o estar activo).' });
            continue;
        }
        const evaluacion = resultadoEval.evaluacion;

        const rodeoInfo = rodeosPorId.get(rodeoId);
        const conflictosFrescos = rodeoInfo ? detectarConflictoInterno(
            { id: rodeoId, club: rodeoInfo.club, fecha: rodeoInfo.fecha, asociacion: rodeoInfo.asociacion, bloque: calcularBloqueRodeo(rodeoInfo.fecha, rodeoInfo.duracion_dias || 1) },
            juradoEfectivo,
            todasFilasEnriquecidas.filter(f => f.rodeo.id !== rodeoId)
        ) : [];
        const advertenciasFrescas = [
            ...evaluacion.causas.map(c => ({ tipo: c, origen: 'REGLA_MOTOR', distancia_km: evaluacion.distanciaKm, categoria: evaluacion.jurado.categoria, asociacion: evaluacion.jurado.asociacion })),
            ...conflictosFrescos.map(c => ({ ...c, origen: 'CONFLICTO_INTERNO_PROPUESTA' }))
        ];

        // Solo una advertencia NUEVA bloquea el guardado — ver
        // evaluarCambiosParaGuardar() (sección 4 de la revisión).
        const cambios = evaluarCambiosParaGuardar(advertenciasFrescas, temporal.metricas_json?.advertencias_aceptadas);
        if (cambios.requiereRevision) {
            cambiosDetectados.push({
                rodeo_id: rodeoId, club: fresco.rodeo?.club, fecha: fresco.rodeo?.fecha, jurado_id: juradoEfectivo,
                motivo: `Surgió una advertencia nueva que no estaba presente cuando se revisó esta selección: ${cambios.advertenciasNuevas.map(a => a.tipo).join(', ')}.`
            });
            continue;
        }

        // Sin cambios que revisar — el backend RECONSTRUYE la clasificación
        // (nunca confía en estado_revision/origen_seleccion que mande el
        // frontend, sección 9) usando la misma función pura que todo el
        // resto del sistema, a partir del jurado efectivo ya validado y las
        // advertencias frescas (vacías, o solo las ya aceptadas).
        const { estado_revision, origen_seleccion } = decidirEstadoSeleccion(juradoEfectivo, original.jurado_id_propuesto, advertenciasFrescas);
        filasParaPersistir.push({
            rodeo_id: rodeoId,
            jurado_id_propuesto: original.jurado_id_propuesto, // SIEMPRE el histórico firmado, nunca el ganador fresco
            jurado_id_seleccionado: juradoEfectivo,
            estado_revision, origen_seleccion,
            explicacion_json: construirExplicacionHistorica(fresco, original.jurado_id_propuesto),
            metricas_json: {
                candidatos_evaluados: fresco.candidatos_evaluados, candidatos_potenciales_bd: fresco.candidatos_potenciales_bd, descartes: fresco.descartes,
                ...(advertenciasFrescas.length > 0 ? { advertencias_aceptadas: advertenciasFrescas } : {})
            }
        });
    }

    if (cambiosDetectados.length > 0) {
        return res.status(409).json({
            requiereRevision: true,
            cambios: cambiosDetectados,
            mensaje: 'Algunas selecciones cambiaron desde que se generó esta propuesta y requieren revisión antes de guardar. No se guardó nada.'
        });
    }

    const { data: propuesta, error: errProp } = await supabase
        .from('propuestas_designacion')
        .insert({ temporada_id: snapshot.temporada_id, estado: 'BORRADOR', creado_por: req.usuario.id })
        .select()
        .single();
    if (errProp) return res.status(500).json({ error: errProp.message });

    const filas = filasParaPersistir.map(f => ({ propuesta_id: propuesta.id, ...f }));
    const { data: detalles, error: errDet } = await supabase
        .from('propuestas_designacion_detalle')
        .insert(filas)
        .select();
    if (errDet) return res.status(500).json({ error: errDet.message });

    await auditoria.registrar({
        tabla: 'propuestas_designacion',
        registro_id: propuesta.id,
        accion: 'crear',
        datos_nuevos: { rodeos: idsUnicos.length, resumen: resumenPropuesta(detalles) },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Propuesta borrador creada con ${idsUnicos.length} rodeo(s), conservando las ediciones hechas durante el preview`,
        ip_address: req.ip
    });

    res.status(201).json({
        propuesta: { id: propuesta.id, estado: propuesta.estado, created_at: propuesta.created_at, resumen: resumenPropuesta(detalles) },
        rodeos_ya_en_otra_propuesta: rodeosYaEnOtraPropuesta
    });
});

// ─── GET /propuestas — listado de propuestas guardadas ────────────────────
router.get('/propuestas', async (req, res) => {
    const { data: propuestas, error } = await supabase
        .from('propuestas_designacion')
        .select('id, temporada_id, estado, creado_por, created_at, updated_at, temporadas(nombre)')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    if (!propuestas || propuestas.length === 0) return res.json({ propuestas: [] });

    const ids = propuestas.map(p => p.id);
    const { data: detalles, error: errD } = await supabase
        .from('propuestas_designacion_detalle')
        .select('propuesta_id, estado_revision')
        .in('propuesta_id', ids);
    if (errD) return res.status(500).json({ error: errD.message });

    const porPropuesta = {};
    for (const d of (detalles || [])) {
        if (!porPropuesta[d.propuesta_id]) porPropuesta[d.propuesta_id] = [];
        porPropuesta[d.propuesta_id].push(d);
    }

    res.json({
        propuestas: propuestas.map(p => ({
            id: p.id,
            temporada: p.temporadas?.nombre || null,
            estado: p.estado,
            created_at: p.created_at,
            updated_at: p.updated_at,
            resumen: resumenPropuesta(porPropuesta[p.id] || [])
        }))
    });
});

// ─── GET /propuestas/:id — detalle completo de una propuesta ──────────────
router.get('/propuestas/:id', async (req, res) => {
    const { data: propuesta, error } = await supabase
        .from('propuestas_designacion')
        .select('id, temporada_id, estado, creado_por, created_at, updated_at, confirmado_en, temporadas(nombre)')
        .eq('id', req.params.id)
        .single();
    if (error || !propuesta) return res.status(404).json({ error: 'Propuesta no encontrada' });

    const { data: detalles, error: errD } = await supabase
        .from('propuestas_designacion_detalle')
        .select(`
            id, rodeo_id, jurado_id_propuesto, jurado_id_seleccionado, estado_revision, origen_seleccion,
            explicacion_json, metricas_json, created_at, updated_at,
            rodeos(
                club, fecha, asociacion, tipo_rodeo_nombre,
                tipos_rodeo(clasificacion_designacion_id, clasificaciones_designacion(codigo, nombre)),
                comunas_chile(nombre)
            )
        `)
        .eq('propuesta_id', req.params.id)
        .order('created_at');
    if (errD) return res.status(500).json({ error: errD.message });

    // Nombres + datos básicos de jurados en una sola consulta adicional (evita
    // el problema de relaciones ambiguas de PostgREST al tener dos FKs
    // distintas hacia la misma tabla usuarios_pagados desde la misma fila).
    const juradoIds = [...new Set((detalles || []).flatMap(d => [d.jurado_id_propuesto, d.jurado_id_seleccionado]).filter(Boolean))];
    const juradoPorId = {};
    if (juradoIds.length > 0) {
        const { data: jurados } = await supabase.from('usuarios_pagados').select('id, nombre_completo, categoria, asociacion, comuna').in('id', juradoIds);
        (jurados || []).forEach(j => { juradoPorId[j.id] = j; });
    }

    const detalleFinal = (detalles || []).map(d => {
        const rodeoRaw = d.rodeos || null;
        const rodeo = rodeoRaw ? {
            club: rodeoRaw.club, fecha: rodeoRaw.fecha, asociacion: rodeoRaw.asociacion,
            tipo_rodeo_nombre: rodeoRaw.tipo_rodeo_nombre,
            clasificacion_nombre: rodeoRaw.tipos_rodeo?.clasificaciones_designacion?.nombre || null,
            clasificacion_codigo: rodeoRaw.tipos_rodeo?.clasificaciones_designacion?.codigo || null,
            comuna_nombre: rodeoRaw.comunas_chile?.nombre || null
        } : null;

        // Jurado EFECTIVO de la fila — SIEMPRE vía obtenerJuradoEfectivo(),
        // fuente única de verdad (nunca un fallback ad-hoc repetido acá): una
        // fila SIN_JURADO_ACTUAL da null aunque jurado_id_propuesto (histórico)
        // siga apuntando a alguien.
        const juradoEfectivoId = obtenerJuradoEfectivo(d);
        const infoJurado = juradoEfectivoId ? juradoPorId[juradoEfectivoId] : null;
        // Métricas del motor (distancia/preferente/designaciones) solo son
        // válidas para mostrar cuando el jurado efectivo sigue siendo
        // exactamente el que el motor propuso originalmente — si el
        // administrador modificó por otro candidato, esas métricas no le
        // pertenecen y se omiten (no se inventan ni se recalculan aquí).
        const esElPropuestoPorElMotor = juradoEfectivoId && juradoEfectivoId === d.jurado_id_propuesto &&
            (!d.jurado_id_seleccionado || d.jurado_id_seleccionado === d.jurado_id_propuesto);
        const metricasMotor = esElPropuestoPorElMotor ? (d.explicacion_json?.jurado_propuesto || null) : null;

        return {
            id: d.id, rodeo_id: d.rodeo_id,
            rodeo,
            jurado_id_propuesto: d.jurado_id_propuesto,
            nombre_propuesto: d.jurado_id_propuesto ? (juradoPorId[d.jurado_id_propuesto]?.nombre_completo || null) : null,
            jurado_id_seleccionado: d.jurado_id_seleccionado,
            nombre_seleccionado: d.jurado_id_seleccionado ? (juradoPorId[d.jurado_id_seleccionado]?.nombre_completo || null) : null,
            jurado_efectivo: juradoEfectivoId ? {
                id: juradoEfectivoId,
                nombre: infoJurado?.nombre_completo || null,
                categoria: infoJurado?.categoria || null,
                asociacion: infoJurado?.asociacion || null,
                comuna: infoJurado?.comuna || null,
                distancia_km: metricasMotor?.distancia_km ?? null,
                categoria_preferente: metricasMotor?.categoria_preferente ?? null,
                designaciones_temporada_antes: metricasMotor?.designaciones_temporada_antes ?? null
            } : null,
            estado_revision: d.estado_revision,
            origen_seleccion: d.origen_seleccion,
            explicacion_json: d.explicacion_json,
            metricas_json: d.metricas_json,
            created_at: d.created_at, updated_at: d.updated_at
        };
    });

    res.json({
        propuesta: {
            id: propuesta.id, temporada: propuesta.temporadas?.nombre || null, estado: propuesta.estado,
            created_at: propuesta.created_at, updated_at: propuesta.updated_at, confirmado_en: propuesta.confirmado_en
        },
        resumen: resumenPropuesta(detalles || []),
        detalle: detalleFinal
    });
});

// ─── Enriquece filas crudas con bloque de fechas real (helper compartido) ─
// Misma forma para el camino PERSISTIDO (filas de propuestas_designacion_
// detalle) y para el camino PREVIEW (filas construidas a partir del
// estado_temporal del cliente + un preview_token verificado) — así
// detectarConflictoInterno()/resolverFilaALiberar() nunca se reimplementan
// ni se bifurcan por modo.
// @param filasRaw [{ detalle_id, estado_revision, jurado_id_seleccionado, jurado_id_propuesto, rodeo_id }]
// @param rodeosPorId Map(rodeo_id -> { club, fecha, asociacion, tipo_rodeo_nombre, duracion_dias })
function enriquecerFilasParaConflicto(filasRaw, rodeosPorId) {
    return (filasRaw || [])
        .map(f => {
            const r = rodeosPorId.get(f.rodeo_id);
            if (!r || !r.fecha) return null;
            return {
                detalle_id: f.detalle_id, estado_revision: f.estado_revision,
                jurado_id_seleccionado: f.jurado_id_seleccionado, jurado_id_propuesto: f.jurado_id_propuesto,
                rodeo: {
                    id: f.rodeo_id, club: r.club, fecha: r.fecha, asociacion: r.asociacion,
                    tipo_rodeo_nombre: r.tipo_rodeo_nombre, bloque: calcularBloqueRodeo(r.fecha, r.duracion_dias || 1)
                }
            };
        })
        .filter(f => f && obtenerJuradoEfectivo(f)); // fuente única de verdad, sin lógica ad-hoc aquí
}

// ─── Datos reales de un conjunto de rodeos, indexados por id (helper) ─────
// Usado por el camino PREVIEW para construir `rodeosPorId` — SIEMPRE se
// vuelve a consultar la BD real; el cliente nunca puede declarar club/
// fecha/asociación de un rodeo, solo qué jurado le asignó.
async function cargarRodeosRealesPorId(rodeoIds) {
    const idsUnicos = [...new Set(rodeoIds)];
    if (idsUnicos.length === 0) return new Map();
    const { data, error } = await supabase
        .from('rodeos')
        .select('id, club, fecha, asociacion, tipo_rodeo_nombre, duracion_dias')
        .in('id', idsUnicos);
    if (error) throw new Error(error.message);
    const mapa = new Map();
    (data || []).forEach(r => mapa.set(r.id, r));
    return mapa;
}

// ─── Valida integridad + coherencia del estado_temporal recibido (PREVIEW) ─
// 1) el preview_token debe tener firma válida (ver services/previewIntegridad);
// 2) estado_temporal debe traer EXACTAMENTE el mismo conjunto de rodeo_ids
//    que el snapshot original — sin duplicados, sin faltantes, sin rodeos
//    ajenos inventados (sección 5 del pedido: "no confiar en otras_filas
//    parcial");
// 3) cada fila debe tener una forma mínima válida.
// El cliente NUNCA puede declarar jurado_id_propuesto — siempre sale del
// snapshot firmado (sección 7).
// @returns { error } | { snapshot, tokenPorRodeo }
function validarEstadoTemporal(previewToken, estadoTemporal) {
    const snapshot = verificarPreviewToken(previewToken);
    if (!snapshot) return { error: 'preview_token inválido, alterado o ausente. Vuelva a ejecutar la simulación.' };
    if (!Array.isArray(estadoTemporal) || estadoTemporal.length === 0) {
        return { error: 'estado_temporal debe ser un array con al menos una fila' };
    }

    const tokenPorRodeo = mapaPorRodeo(snapshot);
    const idsToken = new Set(tokenPorRodeo.keys());
    const idsRecibidos = estadoTemporal.map(f => f?.rodeo_id);
    const idsRecibidosSet = new Set(idsRecibidos);

    if (idsRecibidos.length !== idsRecibidosSet.size) {
        return { error: 'estado_temporal contiene rodeos duplicados' };
    }
    if (idsRecibidosSet.size !== idsToken.size || [...idsRecibidosSet].some(id => !idsToken.has(id))) {
        return { error: 'estado_temporal no coincide con los rodeos de esta simulación (incompleto o con rodeos ajenos)' };
    }
    for (const fila of estadoTemporal) {
        if (!ESTADOS_REVISION.includes(fila.estado_revision)) {
            return { error: `estado_revision inválido en rodeo ${fila.rodeo_id}` };
        }
        if (fila.jurado_id_seleccionado != null && typeof fila.jurado_id_seleccionado !== 'string') {
            return { error: `jurado_id_seleccionado inválido en rodeo ${fila.rodeo_id}` };
        }
    }
    return { snapshot, tokenPorRodeo };
}

// ─── Reconstruye explicacion_json para un jurado HISTÓRICO al revalidar ───
// Al guardar, jurado_id_propuesto siempre es el del snapshot firmado
// (`juradoIdOriginal`), pero `fresco.jurado_propuesto` (el ganador de ESTA
// corrida) puede ser otra persona si el ranking/equidad cambió — eso NO
// invalida al jurado original (sección 1 de la revisión), pero significa
// que no podemos usar `fresco.jurado_propuesto` tal cual para describirlo
// sin mezclar datos de dos personas distintas.
//   - Si el ganador actual sigue siendo el mismo: se usa tal cual (incluye
//     `checks` detallados, que el motor solo calcula para el ganador).
//   - Si cambió: se reconstruye desde `top_candidatos` (fresco, específico
//     de ese jurado) — sin `checks` detallados, pero estar en
//     top_candidatos ya implica que pasó todas las reglas duras al evaluarlo.
function construirExplicacionHistorica(fresco, juradoIdOriginal) {
    if (!juradoIdOriginal) return {};
    if (fresco.estado === 'PROPUESTO' && fresco.jurado_propuesto?.jurado_id === juradoIdOriginal) {
        return { jurado_propuesto: fresco.jurado_propuesto, top_candidatos: fresco.top_candidatos || [] };
    }
    const c = (fresco.top_candidatos || []).find(x => x.jurado_id === juradoIdOriginal);
    if (!c) return {};
    return {
        jurado_propuesto: {
            jurado_id: c.jurado_id, nombre: c.nombre, categoria: c.categoria, categoria_preferente: c.categoria_preferente,
            comuna_canonica: c.comuna_nombre, distancia_km: c.distancia_km,
            designaciones_temporada_antes: c.designaciones_antes, designaciones_temporada_despues: c.designaciones_antes + 1
        },
        top_candidatos: fresco.top_candidatos || []
    };
}

// ─── Otras filas "efectivas" de una propuesta YA GUARDADA (persistida) ────
// Trae las demás filas de la MISMA propuesta que tienen un jurado efectivo
// (seleccionado o, si no, propuesto por el motor — sección 7), ya
// enriquecidas. Para el camino PREVIEW (sin propuesta_id todavía) ver los
// endpoints /preview/* más abajo, que arman el mismo tipo de fila a partir
// del estado_temporal + preview_token en vez de una consulta a esta tabla.
async function cargarOtrasFilasEfectivas(propuestaId, detalleIdExcluir) {
    const { data: otras, error } = await supabase
        .from('propuestas_designacion_detalle')
        .select('id, estado_revision, jurado_id_seleccionado, jurado_id_propuesto, rodeo_id, rodeos(id, club, fecha, asociacion, duracion_dias, tipo_rodeo_nombre)')
        .eq('propuesta_id', propuestaId)
        .in('estado_revision', ['ACEPTADO', 'MODIFICADO', 'PENDIENTE'])
        .neq('id', detalleIdExcluir);
    if (error) throw new Error(error.message);
    const rodeosPorId = new Map();
    (otras || []).forEach(f => { if (f.rodeos) rodeosPorId.set(f.rodeo_id, f.rodeos); });
    const filasRaw = (otras || []).map(f => ({
        detalle_id: f.id, estado_revision: f.estado_revision,
        jurado_id_seleccionado: f.jurado_id_seleccionado, jurado_id_propuesto: f.jurado_id_propuesto, rodeo_id: f.rodeo_id
    }));
    return enriquecerFilasParaConflicto(filasRaw, rodeosPorId);
}

// ─── GET /propuestas/:propuestaId/detalle/:detalleId/candidatos ───────────
// Candidatos para "Designar jurado"/"Modificar" (mismo panel — sección 13 de
// la mejora) — reutiliza cargarDatosMotor() + ejecutarSimulacion() (con topN
// alto para no limitarse a 5) sobre EL MISMO rodeo. NO reimplementa ninguna
// regla. candidatos_validos = cumplen todas las reglas del motor (ordenados
// igual que el dry-run); descartados = todos los demás jurados evaluados,
// con sus causas — para la excepción manual (sección 12) sin necesitar una
// lista aparte de "los 61". Cada candidato trae además `uso_en_otra_fila`
// (sección 6): si ese jurado ya está efectivo en otro rodeo de esta MISMA
// propuesta, reutilizando detectarConflictoInterno() — sin reimplementar
// nada de reglas de fecha/asociación en el frontend.
router.get('/propuestas/:propuestaId/detalle/:detalleId/candidatos', async (req, res) => {
    const { data: detalle, error } = await supabase
        .from('propuestas_designacion_detalle')
        .select('id, rodeo_id, estado_revision')
        .eq('id', req.params.detalleId)
        .eq('propuesta_id', req.params.propuestaId)
        .single();
    if (error || !detalle) return res.status(404).json({ error: 'Detalle no encontrado' });
    if (detalle.estado_revision === 'NO_EVALUABLE') {
        return res.status(400).json({ error: 'Este rodeo no es evaluable (faltan datos estructurales de comuna/clasificación)' });
    }

    let resultado, rodeoEnriquecido;
    try {
        const contexto = await cargarDatosMotor([detalle.rodeo_id]);
        const simulacion = ejecutarSimulacion(contexto, TOP_N_TODOS_LOS_CANDIDATOS);
        resultado = simulacion.resultados[0];
        rodeoEnriquecido = contexto.rodeosPorId.get(detalle.rodeo_id) || null;
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    if (!resultado) return res.status(404).json({ error: 'No se pudo evaluar el rodeo' });

    let otrasFilas = [];
    try {
        otrasFilas = await cargarOtrasFilasEfectivas(req.params.propuestaId, req.params.detalleId);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    const rodeoDestino = rodeoEnriquecido ? { id: detalle.rodeo_id, club: rodeoEnriquecido.club, fecha: rodeoEnriquecido.fecha, asociacion: rodeoEnriquecido.asociacion, bloque: rodeoEnriquecido.bloque } : null;
    const conUso = (c) => ({ ...c, uso_en_otra_fila: rodeoDestino ? detectarConflictoInterno(rodeoDestino, c.jurado_id, otrasFilas) : [] });

    res.json({
        estado: resultado.estado,
        candidatos_validos: (resultado.top_candidatos || []).map(conUso),
        descartados: (resultado.descartados || []).map(conUso),
        candidatos_evaluados: resultado.candidatos_evaluados || 0
    });
});

// ═════════════════════════════════════════════════════════════════════════
// PREVIEW — edición ANTES de guardar el borrador (mejora post-Etapa 4).
// Ambos endpoints son STATELESS: no dependen de propuesta_id/detalle_id
// persistidos, reciben en cada llamada el preview_token (firmado en
// /dry-run) + el estado_temporal COMPLETO que el administrador está
// revisando en memoria del navegador. CERO escrituras en BD — reutilizan
// exactamente las mismas funciones que el camino persistido.
// ═════════════════════════════════════════════════════════════════════════

// ─── POST /preview/candidatos — candidatos ANTES de guardar el borrador ──
// Misma forma que GET .../candidatos pero stateless. Body:
// { rodeo_id, preview_token, estado_temporal }.
router.post('/preview/candidatos', async (req, res) => {
    const { rodeo_id, preview_token, estado_temporal } = req.body;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });

    const validacion = validarEstadoTemporal(preview_token, estado_temporal);
    if (validacion.error) return res.status(400).json({ error: validacion.error });
    const { tokenPorRodeo } = validacion;
    if (!tokenPorRodeo.has(rodeo_id)) return res.status(400).json({ error: 'rodeo_id no pertenece a este preview' });
    if (tokenPorRodeo.get(rodeo_id).estado === 'NO_EVALUABLE') {
        return res.status(400).json({ error: 'Este rodeo no es evaluable (faltan datos estructurales de comuna/clasificación)' });
    }

    let resultado, rodeoEnriquecido;
    try {
        const contexto = await cargarDatosMotor([rodeo_id]);
        const simulacion = ejecutarSimulacion(contexto, TOP_N_TODOS_LOS_CANDIDATOS);
        resultado = simulacion.resultados[0];
        rodeoEnriquecido = contexto.rodeosPorId.get(rodeo_id) || null;
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
    if (!resultado) return res.status(404).json({ error: 'No se pudo evaluar el rodeo' });

    let otrasFilas = [];
    try {
        const otras = estado_temporal.filter(f => f.rodeo_id !== rodeo_id);
        const rodeosPorId = await cargarRodeosRealesPorId(otras.map(f => f.rodeo_id));
        const filasRaw = otras.map(f => ({
            detalle_id: f.rodeo_id, estado_revision: f.estado_revision, jurado_id_seleccionado: f.jurado_id_seleccionado,
            jurado_id_propuesto: tokenPorRodeo.get(f.rodeo_id)?.jurado_id_propuesto ?? null, rodeo_id: f.rodeo_id
        }));
        otrasFilas = enriquecerFilasParaConflicto(filasRaw, rodeosPorId);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    const rodeoDestino = rodeoEnriquecido ? { id: rodeo_id, club: rodeoEnriquecido.club, fecha: rodeoEnriquecido.fecha, asociacion: rodeoEnriquecido.asociacion, bloque: rodeoEnriquecido.bloque } : null;
    const conUso = (c) => ({ ...c, uso_en_otra_fila: rodeoDestino ? detectarConflictoInterno(rodeoDestino, c.jurado_id, otrasFilas) : [] });

    res.json({
        estado: resultado.estado,
        candidatos_validos: (resultado.top_candidatos || []).map(conUso),
        descartados: (resultado.descartados || []).map(conUso),
        candidatos_evaluados: resultado.candidatos_evaluados || 0
    });
});

// ─── Evalúa (sin persistir) qué pasaría si se selecciona `juradoId` para ──
// `rodeoId` — evaluación DIRECTA del jurado específico (evaluarCandidatoDirecto,
// nunca busca en una lista/topN — sección 7/8 de la revisión final) +
// conflictos/uso con `otrasFilasEnriquecidas` (ya construidas por quien
// llama, sea desde BD persistida o desde estado_temporal de un preview). Es
// la ÚNICA lógica de evaluación — compartida por procesarSeleccion
// (persistido), POST /preview/seleccionar (stateless) y la revalidación de
// POST /propuestas al guardar. Nunca se duplica en ningún otro lugar.
// @returns { error } | { jurado, advertencias, rodeoEnriquecido }
async function evaluarSeleccion(rodeoId, juradoId, otrasFilasEnriquecidas) {
    if (!juradoId) return { error: 'jurado_id requerido' };

    let evaluacion, rodeoEnriquecido;
    try {
        const contexto = await cargarDatosMotor([rodeoId]);
        rodeoEnriquecido = contexto.rodeosPorId.get(rodeoId) || null;
        const resultado = evaluarCandidatoDirecto(contexto, rodeoId, juradoId);
        if (resultado.error === 'JURADO_INACTIVO_O_INEXISTENTE') return { error: 'Jurado inválido o inactivo' };
        if (resultado.error) return { error: 'No se pudo evaluar el rodeo para este jurado (' + resultado.error + ')' };
        evaluacion = resultado.evaluacion;
    } catch (err) {
        return { error: err.message };
    }

    let conflictos = [];
    if (rodeoEnriquecido) {
        conflictos = detectarConflictoInterno(
            { id: rodeoId, club: rodeoEnriquecido.club, fecha: rodeoEnriquecido.fecha, asociacion: rodeoEnriquecido.asociacion, bloque: rodeoEnriquecido.bloque },
            juradoId, otrasFilasEnriquecidas
        );
    }

    // Los campos extra (distancia_km/categoria/asociacion) alimentan
    // fingerprintAdvertencia() al guardar — ver propuestaDesignacion.js.
    const advertencias = [
        ...evaluacion.causas.map(c => ({ tipo: c, origen: 'REGLA_MOTOR', distancia_km: evaluacion.distanciaKm, categoria: evaluacion.jurado.categoria, asociacion: evaluacion.jurado.asociacion })),
        ...conflictos.map(c => ({ ...c, origen: 'CONFLICTO_INTERNO_PROPUESTA' }))
    ];
    const jurado = { id: evaluacion.jurado.id, nombre_completo: evaluacion.jurado.nombre_completo };
    return { jurado, advertencias, rodeoEnriquecido };
}

// ─── Lógica compartida por ACEPTAR, SELECCIONAR y DESIGNAR JURADO ─────────
// (mismo endpoint/función para las tres — sección 13 de la mejora: "Designar
// jurado" y "Modificar" son el mismo mecanismo, solo cambia la etiqueta
// visual según si la fila ya tenía jurado o no).
// Reevalúa al candidato con datos EN VIVO (evaluarSeleccion) y detecta
// conflictos/uso con otras filas de la MISMA propuesta (incluye PENDIENTE,
// sección 7). Si hay advertencias y no vienen confirmadas, no guarda nada y
// responde 409 para que el frontend pida confirmación explícita — nunca se
// aplica una excepción en silencio. Si el jurado ya estaba SELECCIONADO en
// otra fila, al confirmar se lo "mueve": esa fila anterior se libera primero
// (ver resolverFilaALiberar) y solo entonces se escribe la fila nueva.
async function procesarSeleccion(req, res, juradoId, confirmarAdvertencias) {
    const { propuestaId, detalleId } = req.params;

    const { data: propuesta } = await supabase.from('propuestas_designacion').select('id, estado').eq('id', propuestaId).single();
    if (!propuesta) return res.status(404).json({ error: 'Propuesta no encontrada' });
    if (propuesta.estado !== 'BORRADOR') return res.status(400).json({ error: 'Solo se puede modificar una propuesta en estado BORRADOR' });

    const { data: detalle } = await supabase.from('propuestas_designacion_detalle').select('*').eq('id', detalleId).eq('propuesta_id', propuestaId).single();
    if (!detalle) return res.status(404).json({ error: 'Detalle no encontrado' });
    if (detalle.estado_revision === 'NO_EVALUABLE') {
        return res.status(400).json({ error: 'Este rodeo no es evaluable — no se puede seleccionar un jurado' });
    }

    let otrasFilasEnriquecidas = [];
    try {
        otrasFilasEnriquecidas = await cargarOtrasFilasEfectivas(propuestaId, detalleId);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    const evaluacion = await evaluarSeleccion(detalle.rodeo_id, juradoId, otrasFilasEnriquecidas);
    if (evaluacion.error) return res.status(400).json({ error: evaluacion.error });
    const { jurado, advertencias, rodeoEnriquecido } = evaluacion;

    if (advertencias.length > 0 && !confirmarAdvertencias) {
        return res.status(409).json({
            requiereConfirmacion: true,
            advertencias,
            jurado: { id: jurado.id, nombre: jurado.nombre_completo }
        });
    }

    // "Mover jurado" (secciones 8-10 de la mejora): si este jurado ya estaba
    // efectivamente SELECCIONADO (aceptado o modificado, no solo propuesto
    // por el motor) en otra fila de esta misma propuesta, se libera esa fila
    // PRIMERO y recién después se escribe la fila nueva — así, ante una falla
    // a mitad de camino, el peor caso es "nadie seleccionado" y nunca "el
    // mismo jurado seleccionado en dos rodeos a la vez" (sección 10). NUNCA
    // se toca jurado_id_propuesto de la fila anterior (sección 15 — registro
    // histórico de lo que el motor propuso, se conserva siempre).
    const filaALiberar = resolverFilaALiberar(otrasFilasEnriquecidas, juradoId);
    if (filaALiberar) {
        const { data: detalleAnterior } = await supabase
            .from('propuestas_designacion_detalle')
            .select('jurado_id_seleccionado, estado_revision, metricas_json')
            .eq('id', filaALiberar.detalle_id)
            .single();
        const metricasAnteriorLimpias = { ...(detalleAnterior?.metricas_json || {}) };
        delete metricasAnteriorLimpias.advertencias_aceptadas;

        const { error: errLiberar } = await supabase
            .from('propuestas_designacion_detalle')
            .update({
                jurado_id_seleccionado: null, estado_revision: filaALiberar.nuevo_estado,
                origen_seleccion: null, metricas_json: metricasAnteriorLimpias, updated_at: new Date().toISOString()
            })
            .eq('id', filaALiberar.detalle_id);
        if (errLiberar) return res.status(500).json({ error: 'No se pudo liberar la fila anterior del jurado: ' + errLiberar.message });

        await auditoria.registrar({
            tabla: 'propuestas_designacion_detalle',
            registro_id: filaALiberar.detalle_id,
            accion: 'editar',
            datos_anteriores: { jurado_id_seleccionado: detalleAnterior?.jurado_id_seleccionado, estado_revision: detalleAnterior?.estado_revision },
            datos_nuevos: { jurado_id_seleccionado: null, estado_revision: filaALiberar.nuevo_estado },
            actor_id: req.usuario.id,
            actor_tipo: 'administrador',
            descripcion: `${jurado.nombre_completo} fue retirado/movido por el Administrador — pasó a ${rodeoEnriquecido?.club || 'otro rodeo'} (${rodeoEnriquecido?.fecha || ''}) de esta misma propuesta. Estado resultante: ${filaALiberar.nuevo_estado}.`,
            ip_address: req.ip
        });
    }

    const { estado_revision, origen_seleccion } = decidirEstadoSeleccion(juradoId, detalle.jurado_id_propuesto, advertencias);

    const metricas_json = { ...(detalle.metricas_json || {}) };
    if (advertencias.length > 0) metricas_json.advertencias_aceptadas = advertencias;
    else delete metricas_json.advertencias_aceptadas;

    const { data: actualizado, error: errUpd } = await supabase
        .from('propuestas_designacion_detalle')
        .update({ jurado_id_seleccionado: juradoId, estado_revision, origen_seleccion, metricas_json, updated_at: new Date().toISOString() })
        .eq('id', detalleId)
        .select()
        .single();
    if (errUpd) return res.status(500).json({ error: errUpd.message });

    await auditoria.registrar({
        tabla: 'propuestas_designacion_detalle',
        registro_id: detalleId,
        accion: 'editar',
        datos_anteriores: { jurado_id_seleccionado: detalle.jurado_id_seleccionado, estado_revision: detalle.estado_revision },
        datos_nuevos: { jurado_id_seleccionado: juradoId, estado_revision, origen_seleccion },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Selección en propuesta: ${jurado.nombre_completo} → ${estado_revision}${advertencias.length ? ' (con advertencias confirmadas)' : ''}`,
        ip_address: req.ip
    });

    res.json({ detalle: actualizado, advertencias, jurado_movido_desde: filaALiberar ? filaALiberar.detalle_id : null });
}

// ─── POST /preview/seleccionar — elegir/mover jurado ANTES de guardar ─────
// Stateless — mismo mecanismo que procesarSeleccion pero SIN persistir.
// Body: { rodeo_id, jurado_id, preview_token, estado_temporal, confirmar_advertencias }.
// Devuelve el CAMBIO AUTORIZADO por el backend (destino +, si corresponde,
// la fila de origen que debe liberarse) para que el frontend lo aplique tal
// cual a su array temporal — nunca decide el estado por su cuenta.
router.post('/preview/seleccionar', async (req, res) => {
    const { rodeo_id, jurado_id, preview_token, estado_temporal, confirmar_advertencias } = req.body;
    if (!rodeo_id) return res.status(400).json({ error: 'rodeo_id requerido' });

    const validacion = validarEstadoTemporal(preview_token, estado_temporal);
    if (validacion.error) return res.status(400).json({ error: validacion.error });
    const { tokenPorRodeo } = validacion;
    if (!tokenPorRodeo.has(rodeo_id)) return res.status(400).json({ error: 'rodeo_id no pertenece a este preview' });
    const infoRodeoToken = tokenPorRodeo.get(rodeo_id);
    if (infoRodeoToken.estado === 'NO_EVALUABLE') {
        return res.status(400).json({ error: 'Este rodeo no es evaluable — no se puede seleccionar un jurado' });
    }

    let otrasFilasEnriquecidas = [];
    try {
        const otras = estado_temporal.filter(f => f.rodeo_id !== rodeo_id);
        const rodeosPorId = await cargarRodeosRealesPorId(otras.map(f => f.rodeo_id));
        const filasRaw = otras.map(f => ({
            detalle_id: f.rodeo_id, estado_revision: f.estado_revision, jurado_id_seleccionado: f.jurado_id_seleccionado,
            jurado_id_propuesto: tokenPorRodeo.get(f.rodeo_id)?.jurado_id_propuesto ?? null, rodeo_id: f.rodeo_id
        }));
        otrasFilasEnriquecidas = enriquecerFilasParaConflicto(filasRaw, rodeosPorId);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }

    const evaluacion = await evaluarSeleccion(rodeo_id, jurado_id, otrasFilasEnriquecidas);
    if (evaluacion.error) return res.status(400).json({ error: evaluacion.error });
    const { jurado, advertencias } = evaluacion;

    if (advertencias.length > 0 && confirmar_advertencias !== true) {
        return res.status(409).json({
            requiereConfirmacion: true, advertencias, jurado: { id: jurado.id, nombre: jurado.nombre_completo }
        });
    }

    // "Mover" en memoria (secciones 8-10): si el jurado ya era efectivo en
    // otra fila del estado_temporal, el backend indica cómo debe quedar esa
    // fila de origen — el frontend la aplica tal cual, nunca la inventa.
    const filaALiberar = resolverFilaALiberar(otrasFilasEnriquecidas, jurado_id);
    const { estado_revision, origen_seleccion } = decidirEstadoSeleccion(jurado_id, infoRodeoToken.jurado_id_propuesto, advertencias);

    res.json({
        destino: {
            rodeo_id, jurado_id_seleccionado: jurado_id, estado_revision, origen_seleccion,
            advertencias_aceptadas: advertencias.length > 0 ? advertencias : null
        },
        origen_liberado: filaALiberar ? { rodeo_id: filaALiberar.detalle_id, estado_revision: filaALiberar.nuevo_estado } : null,
        advertencias
    });
});

// ─── POST /propuestas/:propuestaId/detalle/:detalleId/aceptar ─────────────
// "El Administrador está conforme con la sugerencia del motor." NO crea
// asignación — solo copia jurado_id_propuesto → jurado_id_seleccionado.
router.post('/propuestas/:propuestaId/detalle/:detalleId/aceptar', async (req, res) => {
    const { data: detalle } = await supabase
        .from('propuestas_designacion_detalle')
        .select('jurado_id_propuesto')
        .eq('id', req.params.detalleId)
        .eq('propuesta_id', req.params.propuestaId)
        .single();
    if (!detalle) return res.status(404).json({ error: 'Detalle no encontrado' });
    if (!detalle.jurado_id_propuesto) {
        return res.status(400).json({ error: 'Este rodeo no tiene un jurado propuesto por el motor para aceptar. Use "Modificar" para seleccionar uno manualmente.' });
    }
    await procesarSeleccion(req, res, detalle.jurado_id_propuesto, req.body?.confirmar_advertencias === true);
});

// ─── POST /propuestas/:propuestaId/detalle/:detalleId/seleccionar ─────────
// "Modificar": el administrador elige un candidato (válido o, con doble
// confirmación explícita, con advertencias). Body: { jurado_id,
// confirmar_advertencias }.
router.post('/propuestas/:propuestaId/detalle/:detalleId/seleccionar', async (req, res) => {
    const { jurado_id, confirmar_advertencias } = req.body;
    await procesarSeleccion(req, res, jurado_id, confirmar_advertencias === true);
});

// ─── POST /propuestas/:propuestaId/detalle/:detalleId/revertir ────────────
// Deshace una aceptación o modificación mientras la propuesta siga BORRADOR
// — vuelve a PENDIENTE (si el motor había propuesto a alguien) o a
// SIN_PROPUESTA (si la fila nunca tuvo propuesta del motor).
router.post('/propuestas/:propuestaId/detalle/:detalleId/revertir', async (req, res) => {
    const { data: propuesta } = await supabase.from('propuestas_designacion').select('estado').eq('id', req.params.propuestaId).single();
    if (!propuesta) return res.status(404).json({ error: 'Propuesta no encontrada' });
    if (propuesta.estado !== 'BORRADOR') return res.status(400).json({ error: 'Solo se puede modificar una propuesta en estado BORRADOR' });

    const { data: detalle } = await supabase
        .from('propuestas_designacion_detalle')
        .select('*')
        .eq('id', req.params.detalleId)
        .eq('propuesta_id', req.params.propuestaId)
        .single();
    if (!detalle) return res.status(404).json({ error: 'Detalle no encontrado' });
    if (!['ACEPTADO', 'MODIFICADO'].includes(detalle.estado_revision)) {
        return res.status(400).json({ error: 'Solo se puede revertir una fila ACEPTADA o MODIFICADA' });
    }

    const nuevoEstado = detalle.jurado_id_propuesto ? 'PENDIENTE' : 'SIN_PROPUESTA';
    const metricas_json = { ...(detalle.metricas_json || {}) };
    delete metricas_json.advertencias_aceptadas;

    const { data: actualizado, error } = await supabase
        .from('propuestas_designacion_detalle')
        .update({ jurado_id_seleccionado: null, estado_revision: nuevoEstado, origen_seleccion: null, metricas_json, updated_at: new Date().toISOString() })
        .eq('id', req.params.detalleId)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'propuestas_designacion_detalle',
        registro_id: req.params.detalleId,
        accion: 'editar',
        datos_anteriores: { jurado_id_seleccionado: detalle.jurado_id_seleccionado, estado_revision: detalle.estado_revision },
        datos_nuevos: { jurado_id_seleccionado: null, estado_revision: nuevoEstado },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Selección revertida en propuesta (vuelve a ${nuevoEstado})`,
        ip_address: req.ip
    });

    res.json({ detalle: actualizado });
});

module.exports = router;
