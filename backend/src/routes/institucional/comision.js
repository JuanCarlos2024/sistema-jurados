// ─────────────────────────────────────────────────────────────────────────
// Portal de Comisión de Asociación (migración 079) — evaluación individual
// de jurados por rodeo, independiente del Delegado de Asociación. Reutiliza
// el mismo resolutor de asociación (rodeoDeMiAsociacion, de cartilla.js —
// nunca ILIKE) y el mismo validarRut ya existente en el proyecto.
//
// Gate de rol: soloRolInstitucional('comision_asociacion') — una cuenta de
// Delegado nunca puede usar estas rutas, aunque llame directo por HTTP.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloCuentaInstitucional, exigirCambioPasswordSiPrimerLogin, soloRolInstitucional } = require('../../middleware/auth');
const { resolverTemporada } = require('../../services/informeGestion/cargaDatos');
const { construirIndiceCatalogo, resolverAsociacion } = require('../../services/informeGestion/asociaciones');
const { validarRut, normalizarRut } = require('../../services/rut');
const { rodeoDeMiAsociacion } = require('./cartilla');

router.use(soloCuentaInstitucional);
router.use(exigirCambioPasswordSiPrimerLogin);
router.use(soloRolInstitucional('comision_asociacion'));

// Comisión de Asociación (080): notas con un decimal (coma o punto), 1.0-7.0.
// Rechaza (nunca redondea) más de un decimal — la columna NUMERIC(2,1) de la
// 080 sí redondearía silenciosamente un valor con más precisión, por eso esta
// validación vive acá, antes de llamar a la RPC (mismo criterio del proyecto:
// el backend nunca confía en que la base de datos corrija un dato mal
// formado). Devuelve null ante cualquier entrada inválida (vacía, con texto,
// con más de un decimal o fuera de 1.0-7.0) — nunca lanza.
function normalizarNotaComision(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const texto = valor.toString().trim().replace(',', '.');
    if (!/^\d+(\.\d)?$/.test(texto)) return null;
    const n = parseFloat(texto);
    if (n < 1.0 || n > 7.0) return null;
    return n;
}

// ─── GET /rodeos — "Mis Rodeos", Comisión de Asociación ───────────────────
// Mismo criterio de pertenencia (resolverAsociacion, nunca ILIKE) que
// institucional/rodeos.js, pero la forma de la respuesta es propia de este
// módulo: jurados vigentes + estado de evaluación individual de cada uno +
// Nota Comisión general del rodeo.
router.get('/rodeos', async (req, res) => {
    try {
        const hoy = new Date().toISOString().slice(0, 10);
        const temporada = await resolverTemporada(supabase, hoy);
        if (!temporada) {
            return res.status(200).json({ rodeos: [], temporada: null, mensaje: 'No hay una temporada vigente configurada.' });
        }

        const { data: rodeosRango, error: errRodeos } = await supabase
            .from('rodeos')
            .select('id, fecha, club, asociacion, tipo_rodeo_nombre, estado')
            .gte('fecha', temporada.fecha_inicio)
            .lte('fecha', temporada.fecha_fin)
            .order('fecha', { ascending: false });
        if (errRodeos) return res.status(500).json({ error: errRodeos.message });

        const [{ data: catalogo }, { data: alias }] = await Promise.all([
            supabase.from('asociaciones').select('id, nombre, nombre_normalizado, activa'),
            supabase.from('asociacion_alias').select('asociacion_id, alias, alias_normalizado')
        ]);
        const indice = construirIndiceCatalogo(catalogo || [], alias || []);

        const propios = [];
        for (const r of (rodeosRango || [])) {
            const asoc = resolverAsociacion(r.asociacion, indice);
            if (asoc && asoc.id === req.usuario.asociacion_id) propios.push(r);
        }

        let juradosPorRodeo = new Map(); // rodeo_id -> [{asignacion_id, nombre}]
        let evaluacionesPorAsignacion = new Map(); // asignacion_id -> fila de comision_evaluaciones_jurado
        let notasPorRodeo = new Map(); // rodeo_id -> fila de rodeo_notas_secundarias
        let asignacionesAutorizadas = new Set(); // asignacion_id con autorización administrativa 'pendiente' (ronda 3, punto 4)
        if (propios.length > 0) {
            const idsPropios = propios.map(r => r.id);
            const [
                { data: jurados, error: errJur },
                { data: evaluaciones, error: errEval },
                { data: notas, error: errNotas },
                { data: autorizaciones, error: errAut }
            ] = await Promise.all([
                supabase.from('asignaciones').select('id, rodeo_id, usuario_pagado_id, nombre_importado, usuarios_pagados(nombre_completo)')
                    .in('rodeo_id', idsPropios)
                    .eq('tipo_persona', 'jurado')
                    .eq('estado', 'activo')
                    .eq('publicado', true)
                    // Hallazgo (corrección posterior): NULL-segura — una asignación con
                    // estado_designacion aún NULL (pendiente, nunca rechazada) es vigente
                    // igual que el resto del sistema nuevo de este módulo (ver fn_designacion_
                    // vigente de la migración 079). El `<>` desnudo excluía esas filas sin
                    // querer (NULL <> 'rechazado' nunca es TRUE en Postgres/PostgREST).
                    .or('estado_designacion.neq.rechazado,estado_designacion.is.null'),
                supabase.from('comision_evaluaciones_jurado')
                    .select('asignacion_id, nota_individual_calculada, estado, enviada_en, evaluadores_comision(nombre, apellidos)')
                    .in('rodeo_id', idsPropios),
                supabase.from('rodeo_notas_secundarias')
                    .select('rodeo_id, nota_comision, estado_nota_comision, requiere_revision_admin')
                    .in('rodeo_id', idsPropios),
                supabase.from('comision_autorizaciones_evaluacion')
                    .select('asignacion_id')
                    .in('rodeo_id', idsPropios)
                    .eq('estado', 'pendiente')
            ]);
            if (errJur) return res.status(500).json({ error: errJur.message });
            if (errEval) return res.status(500).json({ error: errEval.message });
            if (errNotas) return res.status(500).json({ error: errNotas.message });
            if (errAut) return res.status(500).json({ error: errAut.message });

            for (const j of (jurados || [])) {
                const nombre = j.usuarios_pagados?.nombre_completo || j.nombre_importado || null;
                if (!nombre) continue; // nunca se inventa un nombre si la relación no resuelve
                if (!juradosPorRodeo.has(j.rodeo_id)) juradosPorRodeo.set(j.rodeo_id, []);
                juradosPorRodeo.get(j.rodeo_id).push({ asignacion_id: j.id, nombre });
            }
            for (const e of (evaluaciones || [])) evaluacionesPorAsignacion.set(e.asignacion_id, e);
            for (const n of (notas || [])) notasPorRodeo.set(n.rodeo_id, n);
            for (const a of (autorizaciones || [])) asignacionesAutorizadas.add(a.asignacion_id);
        }

        const rodeos = propios.map(r => {
            const notas = notasPorRodeo.get(r.id) || null;
            const estadoNotaComision = notas?.estado_nota_comision || 'sin_evaluar';
            // Corrección posterior: antes solo excluía 'historica_sin_desglose' —
            // ofrecía "Evaluar" también sobre rodeos 'completa'/'corregida_admin' o
            // con requiere_revision_admin=true, acciones que la RPC real SIEMPRE
            // rechaza (NOTA_COMISION_CERRADA / REQUIERE_RESOLUCION_ADMINISTRATIVA_
            // PRIMERO) salvo que exista una autorización administrativa específica
            // para ESA asignación — esa excepción se aplica por jurado, no por rodeo.
            const cerradoParaNuevosEnvios = r.estado === 'anulado'
                || estadoNotaComision === 'historica_sin_desglose'
                || estadoNotaComision === 'completa'
                || estadoNotaComision === 'corregida_admin'
                || !!notas?.requiere_revision_admin;

            const jurados = (juradosPorRodeo.get(r.id) || []).map(j => {
                const ev = evaluacionesPorAsignacion.get(j.asignacion_id) || null;
                const evaluado = !!ev;
                return {
                    asignacion_id: j.asignacion_id,
                    nombre: j.nombre,
                    evaluado,
                    nota_individual: ev ? Number(ev.nota_individual_calculada) : null,
                    evaluador_nombre: ev?.evaluadores_comision ? `${ev.evaluadores_comision.nombre} ${ev.evaluadores_comision.apellidos}` : null,
                    enviada_en: ev?.enviada_en || null,
                    // Nunca true para un jurado ya evaluado (UNIQUE real igual lo
                    // rechazaría) ni para un rodeo histórico (sin excepción posible).
                    evaluacion_disponible: !evaluado && estadoNotaComision !== 'historica_sin_desglose'
                        && (!cerradoParaNuevosEnvios || asignacionesAutorizadas.has(j.asignacion_id))
                };
            });

            return {
                id: r.id,
                fecha: r.fecha,
                club: r.club,
                asociacion: r.asociacion,
                tipo_rodeo: r.tipo_rodeo_nombre,
                estado_rodeo: r.estado,
                jurados,
                estado_nota_comision: estadoNotaComision,
                nota_comision: notas?.nota_comision != null ? Number(notas.nota_comision) : null,
                requiere_revision_admin: !!notas?.requiere_revision_admin,
                // Se conserva a nivel de rodeo (compatibilidad: caso general, sin
                // contemplar autorizaciones puntuales por jurado) — el frontend usa
                // el campo por jurado de arriba para la decisión real del botón.
                evaluacion_disponible: !cerradoParaNuevosEnvios
            };
        });

        res.json({
            rodeos,
            temporada: { id: temporada.id, nombre: temporada.nombre, fecha_inicio: temporada.fecha_inicio, fecha_fin: temporada.fecha_fin }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── GET /evaluadores — catálogo de la asociación propia ─────────────────
router.get('/evaluadores', async (req, res) => {
    const { data, error } = await supabase
        .from('evaluadores_comision')
        .select('id, nombre, apellidos, rut, telefono, email, activo')
        .eq('asociacion_id', req.usuario.asociacion_id)
        .order('nombre');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ evaluadores: data || [] });
});

// ─── POST /evaluadores — "+ Nuevo evaluador" ───────────────────────────────
router.post('/evaluadores', async (req, res) => {
    const nombre = (req.body?.nombre || '').toString().trim();
    const apellidos = (req.body?.apellidos || '').toString().trim();
    const telefono = req.body?.telefono ? req.body.telefono.toString().trim() : null;
    const email = req.body?.email ? req.body.email.toString().trim().toLowerCase() : null;

    if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio.' });
    if (!apellidos) return res.status(400).json({ error: 'Los apellidos son obligatorios.' });

    // Validación de RUT chileno con dígito verificador — reutiliza
    // services/rut.js (YA EXISTENTE), nunca se duplica la lógica.
    const validacion = validarRut(req.body?.rut);
    if (!validacion.valido) return res.status(400).json({ error: validacion.error || 'RUT inválido.' });

    const { data, error } = await supabase.rpc('registrar_evaluador_comision_con_auditoria', {
        p_asociacion_id: req.usuario.asociacion_id,
        p_nombre: nombre,
        p_apellidos: apellidos,
        p_rut: validacion.rut,
        p_telefono: telefono,
        p_email: email,
        p_actor_id: req.usuario.id,
        p_actor_tipo: 'cuenta_institucional'
    });

    if (error) {
        if (error.message?.includes('EVALUADOR_YA_REGISTRADO')) {
            return res.status(409).json({ error: 'Ya existe un evaluador registrado con ese RUT para esta asociación.', code: 'EVALUADOR_YA_REGISTRADO' });
        }
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ evaluador: data });
});

// ─── POST /evaluaciones — envío definitivo, sin borradores ─────────────────
router.post('/evaluaciones', async (req, res) => {
    const {
        rodeo_id, asignacion_id, evaluador_id,
        nota_apinadero, nota_cancha, nota_atajadas, nota_cuarta_carrera,
        hubo_movimiento_rienda, nota_rienda, afecto_resultado_final, comentario
    } = req.body || {};

    if (!rodeo_id || !asignacion_id || !evaluador_id) {
        return res.status(400).json({ error: 'rodeo_id, asignacion_id y evaluador_id son requeridos.' });
    }
    // Comisión de Asociación (080): notas con un decimal (coma o punto), 1.0-7.0.
    const notaApinaderoNorm = normalizarNotaComision(nota_apinadero);
    const notaCanchaNorm    = normalizarNotaComision(nota_cancha);
    const notaAtajadasNorm  = normalizarNotaComision(nota_atajadas);
    const notaCuartaNorm    = normalizarNotaComision(nota_cuarta_carrera);
    if ([notaApinaderoNorm, notaCanchaNorm, notaAtajadasNorm, notaCuartaNorm].some(n => n === null)) {
        return res.status(400).json({ error: 'Las cuatro notas de criterio son obligatorias y deben ser números entre 1.0 y 7.0 con un máximo de un decimal (ej. 6, 6,5 o 6.5).' });
    }
    if (typeof hubo_movimiento_rienda !== 'boolean') {
        return res.status(400).json({ error: '¿Hubo Movimiento a la Rienda? es obligatorio.' });
    }
    let notaRiendaNorm = null;
    if (hubo_movimiento_rienda) {
        notaRiendaNorm = normalizarNotaComision(nota_rienda);
        if (notaRiendaNorm === null) {
            return res.status(400).json({ error: 'La nota de Movimiento a la Rienda es obligatoria y debe ser un número entre 1.0 y 7.0 con un máximo de un decimal (ej. 6, 6,5 o 6.5).' });
        }
    }
    if (typeof afecto_resultado_final !== 'boolean') {
        return res.status(400).json({ error: 'La pregunta sobre si el desempeño afectó el resultado final es obligatoria.' });
    }
    if (comentario && comentario.length > 5000) {
        return res.status(400).json({ error: 'El comentario no puede superar los 5000 caracteres.' });
    }

    // La asociación del rodeo se verifica SIEMPRE server-side (nunca se
    // confía en lo que mande el cliente) — mismo resolutor de cartilla.js.
    const rodeo = await rodeoDeMiAsociacion(rodeo_id, req.usuario.asociacion_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });

    const { data, error } = await supabase.rpc('enviar_evaluacion_comision_jurado_con_auditoria', {
        p_rodeo_id: rodeo_id,
        p_asignacion_id: asignacion_id,
        p_asociacion_id: req.usuario.asociacion_id,
        p_evaluador_id: evaluador_id,
        p_cuenta_institucional_id: req.usuario.id,
        p_nota_apinadero: notaApinaderoNorm,
        p_nota_cancha: notaCanchaNorm,
        p_nota_atajadas: notaAtajadasNorm,
        p_nota_cuarta_carrera: notaCuartaNorm,
        p_hubo_movimiento_rienda: hubo_movimiento_rienda,
        p_nota_rienda: hubo_movimiento_rienda ? notaRiendaNorm : null,
        p_afecto_resultado_final: afecto_resultado_final,
        p_comentario: comentario || null
    });

    if (error) {
        if (error.message?.includes('EVALUACION_YA_ENVIADA')) {
            return res.status(409).json({ error: 'Este jurado ya tiene una evaluación definitiva enviada para este rodeo.', code: 'EVALUACION_YA_ENVIADA' });
        }
        if (error.message?.includes('NOTA_COMISION_HISTORICA_PROTEGIDA')) {
            return res.status(409).json({ error: 'Este rodeo tiene una Nota Comisión histórica protegida. No se pueden registrar evaluaciones nuevas.', code: 'NOTA_COMISION_HISTORICA_PROTEGIDA' });
        }
        if (error.message?.includes('NOTA_COMISION_CERRADA')) {
            return res.status(409).json({ error: 'La Nota Comisión general de este rodeo ya fue publicada o corregida. No se pueden registrar evaluaciones nuevas por este medio.', code: 'NOTA_COMISION_CERRADA' });
        }
        if (error.message?.includes('REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO')) {
            return res.status(409).json({ error: 'Este rodeo tiene una revisión administrativa pendiente. Debe resolverla el administrador antes de registrar nuevas evaluaciones.', code: 'REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO' });
        }
        if (error.message?.includes('DESIGNACION_NO_VIGENTE') || error.message?.includes('ASIGNACION_NO_ENCONTRADA') || error.message?.includes('ASIGNACION_NO_ES_JURADO')) {
            return res.status(409).json({ error: 'La designación de este jurado para este rodeo ya no está vigente.', code: 'DESIGNACION_NO_VIGENTE' });
        }
        if (error.message?.includes('EVALUADOR_NO_ENCONTRADO') || error.message?.includes('EVALUADOR_SUSPENDIDO') || error.message?.includes('EVALUADOR_DE_OTRA_ASOCIACION')) {
            return res.status(400).json({ error: 'El evaluador seleccionado no es válido para esta asociación.', code: 'EVALUADOR_INVALIDO' });
        }
        if (error.message?.includes('NOTA_RIENDA_REQUERIDA')) {
            return res.status(400).json({ error: 'Debe ingresar la nota del Movimiento a la Rienda.', code: 'NOTA_RIENDA_REQUERIDA' });
        }
        if (error.message?.includes('NOTA_RIENDA_NO_CORRESPONDE')) {
            return res.status(400).json({ error: 'No corresponde ingresar nota de Rienda si no hubo Movimiento a la Rienda.', code: 'NOTA_RIENDA_NO_CORRESPONDE' });
        }
        return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ evaluacion: data });
});

module.exports = router;
