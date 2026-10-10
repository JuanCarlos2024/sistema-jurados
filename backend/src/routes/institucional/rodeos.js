// ─────────────────────────────────────────────────────────────────────────
// GET /api/institucional/rodeos — rodeos de la asociación autenticada, en la
// temporada vigente, con el estado de cartilla (solo lectura — Fase 2).
//
// La asociación viene SIEMPRE de req.usuario.asociacion_id (resuelto en el
// login), nunca de un query param — así es imposible que Osorno pida los
// rodeos de Valdivia manipulando la URL (Caso A de seguridad).
//
// rodeos.asociacion es texto libre sin FK (ver auditoría Fase 1). Para
// filtrar SIN ILIKE y SIN adivinar, se reutiliza exactamente el mismo
// resolutor que ya usa el sistema (construirIndiceCatalogo/resolverAsociacion
// de informeGestion/asociaciones.js, services/delegadosAsociacion.js) sobre
// los valores de asociación realmente presentes en los rodeos consultados —
// nunca se asume ni se fuerza una correspondencia ambigua (Caso H).
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloCuentaInstitucional } = require('../../middleware/auth');
const { resolverTemporada } = require('../../services/informeGestion/cargaDatos');
const { construirIndiceCatalogo, resolverAsociacion } = require('../../services/informeGestion/asociaciones');
const auditoria = require('../../services/auditoria');
// Fase 3.3: reutiliza la MISMA verificación de pertenencia de rodeo y de
// delegado válido que ya usa institucional/cartilla.js — nunca se duplica.
const { rodeoDeMiAsociacion, delegadoValido } = require('./cartilla');

router.use(soloCuentaInstitucional);

// Estado de cartilla para un rodeo, dadas TODAS sus filas en cartillas_delegado.
// Nunca elige una "oficial" arbitrariamente cuando hay más de una (ver Fase 1:
// UNIQUE(rodeo_id, delegado_id) permite varias si son de delegados distintos) —
// deja un estado controlado explícito para que el administrador lo resuelva
// (diseño real de esto queda para la Fase 3, tal como se pidió).
function estadoCartillaDeFilas(filas) {
    if (!filas || filas.length === 0) return 'sin_cartilla';
    if (filas.length === 1) return filas[0].estado;
    return 'multiples_cartillas_sin_resolver';
}

router.get('/', async (req, res) => {
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
        const sinEquivalencia = new Set();
        for (const r of (rodeosRango || [])) {
            const asoc = resolverAsociacion(r.asociacion, indice);
            if (!asoc) { sinEquivalencia.add(r.asociacion); continue; } // Caso H: nunca se expone a nadie
            if (asoc.id === req.usuario.asociacion_id) propios.push(r);
        }
        // Caso H: se registra para revisión administrativa (log), nunca se expone
        // al usuario institucional ni se le asigna a ninguna asociación por defecto.
        if (sinEquivalencia.size > 0) {
            console.warn(`[INSTITUCIONAL] rodeos con asociación sin equivalencia en el catálogo (pendiente de revisión admin): ${[...sinEquivalencia].join(', ')}`);
        }

        let cartillasPorRodeo = {};
        let rentadoDesignadoPorRodeo = new Map(); // rodeo_id -> nombre real del Rentado (o null si no se pudo resolver)
        let seleccionPorRodeo = new Map(); // rodeo_id -> { delegado_asociacion_id, nombre }
        let juradosPorRodeo = new Map(); // rodeo_id -> string[] (nombres), SOLO designaciones publicadas y no rechazadas
        if (propios.length > 0) {
            const idsPropios = propios.map(r => r.id);
            const [
                { data: cartillas, error: errCart },
                { data: designaciones, error: errAsig },
                { data: selecciones, error: errSel },
                { data: jurados, error: errJur }
            ] = await Promise.all([
                supabase.from('cartillas_delegado').select('id, rodeo_id, estado, delegado_id, delegado_asociacion_id').in('rodeo_id', idsPropios),
                // Fase 3.1 — regla oficial: "cada rodeo tiene un solo delegado responsable".
                // Mismo criterio TEXTUAL de "designación efectiva" que usuario/cartilla-delegado.js
                // usa para el autochequeo del propio Rentado y que institucional/cartilla.js usa
                // para bloquear la creación: estado='activo' + publicado=true + estado_designacion
                // != 'rechazado'. Una fila anulada, no publicada o rechazada nunca cuenta. Se trae
                // también el nombre real (Fase 3.3): usuarios_pagados(nombre_completo) con el mismo
                // fallback a nombre_importado que ya usa admin/rodeos.js al publicar designaciones —
                // nunca se inventa un nombre si la relación no resuelve.
                supabase.from('asignaciones').select('rodeo_id, nombre_importado, usuarios_pagados(nombre_completo)')
                    .in('rodeo_id', idsPropios)
                    .eq('tipo_persona', 'delegado_rentado')
                    .eq('estado', 'activo')
                    .eq('publicado', true)
                    .neq('estado_designacion', 'rechazado'),
                // Fase 3.3: selección institucional declarada por rodeo (tabla nueva,
                // aditiva, independiente de cartillas_delegado — ver migración 068).
                supabase.from('rodeos_delegado_institucional').select('rodeo_id, delegado_asociacion_id, delegados_asociacion(nombre)')
                    .in('rodeo_id', idsPropios),
                // Fase 3.4 — "Jurado designado": UNA sola consulta batched para
                // TODOS los rodeos propios (nunca una consulta por fila). Mismo
                // criterio de "designación efectiva" (activo+publicado+no rechazada)
                // que ya se usa para el Rentado arriba — la asociación solo debe
                // conocer designaciones ya oficialmente publicadas por el admin,
                // nunca borradores internos (estado_designacion='pendiente' SÍ
                // cuenta, igual que en el resto del sistema: aún no fue rechazada).
                supabase.from('asignaciones').select('rodeo_id, nombre_importado, usuarios_pagados(nombre_completo)')
                    .in('rodeo_id', idsPropios)
                    .eq('tipo_persona', 'jurado')
                    .eq('estado', 'activo')
                    .eq('publicado', true)
                    .neq('estado_designacion', 'rechazado')
            ]);
            if (errCart) return res.status(500).json({ error: errCart.message });
            if (errAsig) return res.status(500).json({ error: errAsig.message });
            if (errSel) return res.status(500).json({ error: errSel.message });
            if (errJur) return res.status(500).json({ error: errJur.message });
            for (const c of (cartillas || [])) {
                if (!cartillasPorRodeo[c.rodeo_id]) cartillasPorRodeo[c.rodeo_id] = [];
                cartillasPorRodeo[c.rodeo_id].push(c);
            }
            for (const d of (designaciones || [])) {
                rentadoDesignadoPorRodeo.set(d.rodeo_id, d.usuarios_pagados?.nombre_completo || d.nombre_importado || null);
            }
            for (const s of (selecciones || [])) {
                seleccionPorRodeo.set(s.rodeo_id, { delegado_asociacion_id: s.delegado_asociacion_id, nombre: s.delegados_asociacion?.nombre || null });
            }
            for (const j of (jurados || [])) {
                const nombre = j.usuarios_pagados?.nombre_completo || j.nombre_importado || null;
                if (!nombre) continue; // nunca se inventa un nombre si la relación no resuelve
                if (!juradosPorRodeo.has(j.rodeo_id)) juradosPorRodeo.set(j.rodeo_id, []);
                juradosPorRodeo.get(j.rodeo_id).push(nombre);
            }
        }

        const rodeos = propios.map(r => {
            const filas = cartillasPorRodeo[r.id];
            const rentadoDesignado = rentadoDesignadoPorRodeo.has(r.id);
            const rentadoCartillaExiste = (filas || []).some(f => f.delegado_id != null);
            const estadoCartilla = estadoCartillaDeFilas(filas);
            // Misma regla de dos pasos que institucional/cartilla.js: la vía
            // institucional no está disponible si hay designación vigente de
            // Rentado O si ya existe contenido real de una cartilla Rentado
            // (aunque la designación que la originó haya sido anulada después).
            const cartillaInstitucionalDisponible = r.estado !== 'anulado' && !rentadoDesignado && !rentadoCartillaExiste;

            // Fase 3.3 — "Tipo de Delegado" / "Nombre del Delegado": nunca se
            // inventa una modalidad si los datos no la determinan con claridad.
            const institucional = (filas || []).find(f => f.delegado_asociacion_id != null) || null;
            const seleccion = seleccionPorRodeo.get(r.id) || null;
            let tipoDelegado, nombreDelegado, delegadoAsociacionIdSeleccionado = null;
            if (rentadoDesignado) {
                tipoDelegado = 'delegado_rentado';
                nombreDelegado = rentadoDesignadoPorRodeo.get(r.id); // null si no se pudo resolver el nombre real
            } else if (rentadoCartillaExiste || estadoCartilla === 'multiples_cartillas_sin_resolver') {
                tipoDelegado = 'conflicto';
                nombreDelegado = institucional?.delegado_nombre || null;
            } else {
                tipoDelegado = 'delegado_asociacion';
                // La cartilla ya iniciada manda sobre la selección previa (pueden
                // haber divergido si se cambió desde el propio formulario) — ver
                // sincronización en institucional/cartilla.js.
                nombreDelegado = institucional?.delegado_nombre || seleccion?.nombre || null;
                delegadoAsociacionIdSeleccionado = institucional?.delegado_asociacion_id || seleccion?.delegado_asociacion_id || null;
            }

            return {
                id: r.id,
                fecha: r.fecha,
                club: r.club,
                asociacion: r.asociacion,
                tipo_rodeo: r.tipo_rodeo_nombre,
                estado_rodeo: r.estado,
                estado_cartilla: estadoCartilla,
                delegado_rentado_designado: rentadoDesignado,
                cartilla_institucional_disponible: cartillaInstitucionalDisponible,
                tipo_delegado: tipoDelegado,
                nombre_delegado: nombreDelegado,
                delegado_asociacion_id_seleccionado: delegadoAsociacionIdSeleccionado,
                cartilla_iniciada: !!institucional,
                // Fase 3.4 — "Ver cartilla"/"Descargar PDF": id real de la cartilla
                // institucional (nunca la de Delegado Rentado) para armar el enlace
                // de descarga; null si todavía no existe ninguna.
                cartilla_id: institucional?.id || null,
                // Fase 3.4 — "Jurado designado": arreglo de nombres (vacío si
                // todavía no hay ninguna designación publicada y no rechazada
                // para este rodeo; el frontend muestra "Pendiente de designación").
                jurados_designados: juradosPorRodeo.get(r.id) || []
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

// ─── POST /:rodeo_id/seleccionar-delegado (Fase 3.3, bloqueado en 3.5) ────
// Fase 3.5 — regla oficial: "cada rodeo tiene un único Delegado de
// Asociación responsable, confirmado UNA sola vez." Esta ruta YA NO permite
// cambiar un responsable ya confirmado (ni para el mismo delegado que llegó
// a confirmarlo, ni para otro) — es una CONFIRMACIÓN, no una edición. El
// único camino para cambiarlo después es el reemplazo administrativo
// autorizado (ver admin/rodeos.js POST /:id/reemplazar-delegado-institucional).
//
// El bloqueo es 100% de BASE DE DATOS, no de este código: la RPC
// confirmar_delegado_institucional_rodeo (migración 069) hace un INSERT...
// ON CONFLICT (rodeo_id) DO NOTHING sobre el mismo índice único de 068 —
// dos confirmaciones concurrentes para el mismo rodeo SIEMPRE dejan una
// sola fila ganadora, sin importar qué tan rápido lleguen ni en qué orden
// las procese Node. Esta ruta solo decide qué código HTTP devolver según
// si la fila devuelta coincide o no con lo que esta llamada pidió.
router.post('/:rodeo_id/seleccionar-delegado', async (req, res) => {
    const { delegado_asociacion_id } = req.body;
    if (!delegado_asociacion_id) return res.status(400).json({ error: 'delegado_asociacion_id es requerido.' });

    // 1. La cuenta pertenece a la asociación organizadora de este rodeo —
    // misma verificación (nunca ILIKE) que usa institucional/cartilla.js.
    const rodeo = await rodeoDeMiAsociacion(req.params.rodeo_id, req.usuario.asociacion_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });

    // 2. El delegado está certificado, activo y es de la MISMA asociación.
    const delegado = await delegadoValido(delegado_asociacion_id, req.usuario.asociacion_id);
    if (!delegado) return res.status(403).json({ error: 'Delegado no válido para esta asociación.' });

    // Fase 3.1 — regla oficial: si el rodeo ya es responsabilidad de un
    // Delegado Rentado vigente, ni siquiera se permite declarar una
    // preferencia institucional (evita confusión: la asociación no puede
    // "elegir" un delegado para un rodeo que no le corresponde).
    const { data: designacionVigente } = await supabase
        .from('asignaciones')
        .select('id')
        .eq('rodeo_id', rodeo.id)
        .eq('tipo_persona', 'delegado_rentado')
        .eq('estado', 'activo')
        .eq('publicado', true)
        .neq('estado_designacion', 'rechazado')
        .maybeSingle();
    if (designacionVigente) {
        return res.status(409).json({
            error: 'Este rodeo tiene un Delegado Rentado designado. La cartilla corresponde a dicho delegado.',
            code: 'DELEGADO_RENTADO_DESIGNADO'
        });
    }

    const { data, error } = await supabase.rpc('confirmar_delegado_institucional_rodeo', {
        p_rodeo_id: rodeo.id,
        p_delegado_asociacion_id: delegado.id,
        p_delegado_nombre: delegado.nombre,
        p_cuenta_institucional_id: req.usuario.id
    });
    if (error) return res.status(500).json({ error: error.message });

    const vigente = Array.isArray(data) ? data[0] : data;

    // La fila devuelta puede ser la que ACABA de crear esta llamada, o una
    // YA confirmada por otra llamada anterior (o por una concurrente que
    // ganó la carrera) — en cualquier caso donde coincide con lo solicitado,
    // es un éxito (incluye el caso "re-confirmar el mismo delegado" como
    // no-op idempotente). Si coincide con OTRO delegado, queda bloqueado.
    if (vigente.delegado_asociacion_id !== delegado.id) {
        return res.status(409).json({
            error: 'Este rodeo ya tiene un Delegado de Asociación confirmado como responsable. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO',
            responsable_actual: { delegado_asociacion_id: vigente.delegado_asociacion_id }
        });
    }

    res.json({
        seleccion: { rodeo_id: rodeo.id, delegado_asociacion_id: delegado.id, nombre: delegado.nombre, designacion_id: vigente.id }
    });
});

module.exports = router;
