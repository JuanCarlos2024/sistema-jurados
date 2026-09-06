// ─────────────────────────────────────────────────────────────────────────
// Temporadas deportivas — Etapa 1 (infraestructura + administración manual).
//
// Permisos: solo Administrador pleno (rol_evaluacion = null) — mismo patrón
// allowlist que admin/propuesta-designacion.js. Cualquier sub-rol (monitor,
// analista, comisión técnica, director, capacitador) queda denegado.
//
// Esta etapa NO modifica el motor de Propuesta de Designación: la tabla
// `temporadas` sigue siendo consultada por el motor exactamente igual que
// hoy (activa=true + rango de fechas). Estas rutas solo administran las
// filas de `temporadas` y, en admin/rodeos.js, la asignación manual de
// rodeos.temporada_id.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const auditoria = require('../../services/auditoria');
const { soloRolEvaluacion } = require('../../middleware/auth');
const {
    validarRangoFechas, detectarSolapamiento, validarActivacion, validarDesactivacion,
    calcularConteosPorTemporada, evaluarAsignacionLote, construirAuditoriaExcepcionFechas
} = require('../../services/temporadas');

router.use(soloRolEvaluacion());

const SELECT_TEMPORADA = 'id, nombre, fecha_inicio, fecha_fin, chica_inicio, chica_fin, grande_inicio, grande_fin, activa, created_at';

// ─── Helper: temporadas + conteo de rodeos asociados (2 queries fijas,
// nunca una consulta por temporada ni por rodeo — ver sección "NO N+1"). ──
async function cargarTemporadasConConteos() {
    const { data: temporadas, error: errT } = await supabase
        .from('temporadas').select(SELECT_TEMPORADA).order('fecha_inicio');
    if (errT) throw new Error(errT.message);

    const { data: rodeosActivos, error: errR } = await supabase
        .from('rodeos').select('temporada_id').eq('estado', 'activo');
    if (errR) throw new Error(errR.message);

    const conteos = calcularConteosPorTemporada(rodeosActivos, temporadas);
    const countPorId = new Map(conteos.por_temporada.map(c => [c.temporada_id, c.count]));

    return {
        temporadas: (temporadas || []).map(t => ({ ...t, rodeos_count: countPorId.get(t.id) || 0 })),
        sin_temporada: conteos.sin_temporada,
        total_rodeos: conteos.total
    };
}

// GET /api/admin/temporadas — listado para Configuración → Temporadas
router.get('/', async (req, res) => {
    try {
        const data = await cargarTemporadasConConteos();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/temporadas/conteos — misma fuente, para el panel/contador
// de Rodeos ("RODEOS SIN TEMPORADA: X"). Un solo endpoint reutilizado por
// ambas pantallas — no se duplica el cálculo.
router.get('/conteos', async (req, res) => {
    try {
        const { temporadas, sin_temporada, total_rodeos } = await cargarTemporadasConConteos();
        res.json({
            sin_temporada,
            total_rodeos,
            por_temporada: temporadas.map(t => ({ temporada_id: t.id, nombre: t.nombre, count: t.rodeos_count }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/temporadas/:id/rodeos — acción "Ver rodeos"
router.get('/:id/rodeos', async (req, res) => {
    const { data, error } = await supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha, tipo_rodeo_nombre')
        .eq('temporada_id', req.params.id)
        .eq('estado', 'activo')
        .order('fecha');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ data: data || [] });
});

// POST /api/admin/temporadas — crear
router.post('/', async (req, res) => {
    const { nombre, fecha_inicio, fecha_fin, activa } = req.body;
    if (!nombre || !nombre.trim()) return res.status(400).json({ error: 'nombre es requerido' });

    const rango = validarRangoFechas(fecha_inicio, fecha_fin);
    if (!rango.valido) return res.status(400).json({ error: rango.error });

    const { data: existentes, error: errE } = await supabase
        .from('temporadas').select('id, nombre, fecha_inicio, fecha_fin, activa');
    if (errE) return res.status(500).json({ error: errE.message });

    const solapa = detectarSolapamiento({ fecha_inicio, fecha_fin }, existentes);
    if (solapa) {
        return res.status(409).json({
            error: `El rango se solapa con la temporada "${solapa.nombre}" (${solapa.fecha_inicio} a ${solapa.fecha_fin}).`
        });
    }

    const activaExistente = (existentes || []).find(t => t.activa) || null;
    const act = validarActivacion(!!activa, activaExistente, null);
    if (!act.permitido) return res.status(409).json({ error: act.error });

    const { data, error } = await supabase
        .from('temporadas')
        .insert({ nombre: nombre.trim(), fecha_inicio, fecha_fin, activa: !!activa })
        .select(SELECT_TEMPORADA)
        .single();
    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'temporadas',
        registro_id: data.id,
        accion: 'crear',
        datos_nuevos: { nombre: data.nombre, fecha_inicio, fecha_fin, activa: !!activa },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Temporada creada: ${data.nombre}`,
        ip_address: req.ip
    });

    res.status(201).json(data);
});

// PATCH /api/admin/temporadas/:id — editar (nombre / fechas / activa)
router.patch('/:id', async (req, res) => {
    const { nombre, fecha_inicio, fecha_fin, activa, confirmar_rodeos_fuera_rango } = req.body;

    const { data: anterior, error: errA } = await supabase
        .from('temporadas').select(SELECT_TEMPORADA).eq('id', req.params.id).single();
    if (errA || !anterior) return res.status(404).json({ error: 'Temporada no encontrada' });

    const nuevaFechaInicio = fecha_inicio !== undefined ? fecha_inicio : anterior.fecha_inicio;
    const nuevaFechaFin = fecha_fin !== undefined ? fecha_fin : anterior.fecha_fin;
    const rango = validarRangoFechas(nuevaFechaInicio, nuevaFechaFin);
    if (!rango.valido) return res.status(400).json({ error: rango.error });

    const { data: existentes, error: errE } = await supabase
        .from('temporadas').select('id, nombre, fecha_inicio, fecha_fin, activa');
    if (errE) return res.status(500).json({ error: errE.message });

    const solapa = detectarSolapamiento({ fecha_inicio: nuevaFechaInicio, fecha_fin: nuevaFechaFin }, existentes, req.params.id);
    if (solapa) {
        return res.status(409).json({
            error: `El rango se solapa con la temporada "${solapa.nombre}" (${solapa.fecha_inicio} a ${solapa.fecha_fin}).`
        });
    }

    if (activa !== undefined) {
        const nuevaActiva = !!activa;
        // 1) Nunca dejar el sistema con cero temporadas activas mientras el
        //    motor dependa de activa=true (sección 1 del pedido).
        const desact = validarDesactivacion(anterior.activa, nuevaActiva);
        if (!desact.permitido) return res.status(409).json({ error: desact.error });
        // 2) Nunca activar una segunda temporada mientras otra ya lo está
        //    (sin desactivación automática — sección 2 del pedido).
        const activaExistente = (existentes || []).find(t => t.activa && t.id !== req.params.id) || null;
        const act = validarActivacion(nuevaActiva, activaExistente, req.params.id);
        if (!act.permitido) return res.status(409).json({ error: act.error });
    }

    // Si cambian las fechas, verificar en batch (1 query) si algún rodeo YA
    // asociado a esta temporada quedaría fuera del nuevo rango. Nunca se
    // toca rodeos.temporada_id acá — solo se advierte/confirma la excepción
    // (secciones 6-10 del pedido).
    const cambianFechas = (fecha_inicio !== undefined && fecha_inicio !== anterior.fecha_inicio) ||
                          (fecha_fin !== undefined && fecha_fin !== anterior.fecha_fin);
    let rodeosFueraDelNuevoRango = [];
    if (cambianFechas) {
        const { data: rodeosAsociados, error: errRod } = await supabase
            .from('rodeos')
            .select('id, club, fecha')
            .eq('temporada_id', req.params.id)
            .eq('estado', 'activo');
        if (errRod) return res.status(500).json({ error: errRod.message });

        const evalu = evaluarAsignacionLote(rodeosAsociados || [], { fecha_inicio: nuevaFechaInicio, fecha_fin: nuevaFechaFin }, !!confirmar_rodeos_fuera_rango);
        if (evalu.requiereConfirmacion) {
            return res.status(409).json({
                requiereConfirmacion: true,
                motivo: 'RODEOS_FUERA_NUEVO_RANGO',
                mensaje: `⚠ Al cambiar las fechas de esta temporada, ${evalu.fuera.length} rodeo(s) ya asociado(s) quedarán fuera del nuevo rango.`,
                cantidad: evalu.fuera.length,
                rodeos: evalu.fuera.map(r => ({ id: r.id, club: r.club, fecha: r.fecha }))
            });
        }
        rodeosFueraDelNuevoRango = evalu.fuera;
    }

    const cambios = {};
    if (nombre !== undefined) cambios.nombre = nombre.trim();
    if (fecha_inicio !== undefined) cambios.fecha_inicio = fecha_inicio;
    if (fecha_fin !== undefined) cambios.fecha_fin = fecha_fin;
    if (activa !== undefined) cambios.activa = !!activa;

    if (Object.keys(cambios).length === 0) return res.json(anterior);

    const { data, error } = await supabase
        .from('temporadas').update(cambios).eq('id', req.params.id).select(SELECT_TEMPORADA).single();
    if (error) return res.status(500).json({ error: error.message });

    await auditoria.registrar({
        tabla: 'temporadas',
        registro_id: req.params.id,
        accion: 'editar',
        datos_anteriores: anterior,
        datos_nuevos: cambios,
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Temporada editada: ${anterior.nombre}`,
        ip_address: req.ip
    });

    // Auditoría dedicada de la EXCEPCIÓN — solo si efectivamente quedaron
    // rodeos fuera del nuevo rango y el administrador confirmó igual.
    // rodeos.temporada_id NUNCA se toca en este flujo (sección 9).
    if (rodeosFueraDelNuevoRango.length > 0) {
        await auditoria.registrar({
            ...construirAuditoriaExcepcionFechas(
                anterior,
                { fecha_inicio: anterior.fecha_inicio, fecha_fin: anterior.fecha_fin },
                { fecha_inicio: nuevaFechaInicio, fecha_fin: nuevaFechaFin },
                rodeosFueraDelNuevoRango,
                req.usuario.id
            ),
            ip_address: req.ip
        });
    }

    res.json(data);
});

module.exports = router;
