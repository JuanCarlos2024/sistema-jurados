// ─────────────────────────────────────────────────────────────────────────
// Configuración de Propuesta de Designación — Etapa 4: administración de
// VERSIONES (listar, ver detalle, crear, activar). El motor/preview/
// borradores (Etapa 3) siguen viviendo en propuesta-designacion.js — este
// archivo es exclusivamente el CRUD (sin la "D") administrativo de
// configuracion_designacion_versiones/_orden_criterios/_matriz.
//
// Toda escritura pasa EXCLUSIVAMENTE por las RPC transaccionales de las
// migraciones 050/051 (activar_configuracion_designacion /
// crear_configuracion_designacion_version) — este archivo nunca hace un
// INSERT/UPDATE directo sobre esas 3 tablas (ver configuracionDesignacion
// Repositorio.js). Nunca se crea una versión ya activa, y activar sigue
// siendo un paso EXPLÍCITO y separado de crear (sección 4/5 del pedido).
//
// Sin PATCH funcional ni DELETE — las versiones son históricas e inmutables
// por diseño (igual que documenta la migración 050). Solo lectura + crear +
// activar.
//
// Permisos: mismo patrón que propuesta-designacion.js — SOLO administrador
// pleno (rol_evaluacion = null) hoy, vía soloRolEvaluacion() sin argumentos.
// No se amplía a otros perfiles sin necesidad (sección 36/37 del pedido).
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const auditoria = require('../../services/auditoria');
const { soloRolEvaluacion } = require('../../middleware/auth');
const { construirConfiguracionDefaultV1 } = require('../../services/configuracionDesignacion');
const {
    cargarConfiguracionDesignacionActiva,
    listarVersionesDesignacion,
    obtenerVersionDesignacionDetalle,
    crearVersionDesignacion,
    activarVersionDesignacion
} = require('../../services/configuracionDesignacionRepositorio');

// Allowlist: solo administrador pleno (rol_evaluacion === null) hoy — mismo
// criterio que propuesta-designacion.js.
router.use(soloRolEvaluacion());

// ─── Respuesta uniforme para un { error, detalle } de la capa de servicio ──
function responderError(res, resultado, status = 400) {
    return res.status(status).json({ error: resultado.error, detalle: resultado.detalle });
}

// ─── GET /versiones — historial completo (cabecera de cada versión) ───────
router.get('/versiones', async (req, res) => {
    try {
        const versiones = await listarVersionesDesignacion();
        res.json({ versiones });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /versiones/:id — detalle completo de UNA versión, SOLO LECTURA ───
// (reglas + criterios + matriz + metadata) — usado para "Ver" una versión
// del historial (activa o no) y para el indicador "Ver reglas" desde
// Propuesta de Designación.
router.get('/versiones/:id', async (req, res) => {
    try {
        const detalle = await obtenerVersionDesignacionDetalle(req.params.id);
        if (detalle.error) return responderError(res, detalle, 404);
        res.json(detalle);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /activa — atajo: detalle completo de la configuración ACTIVA ─────
router.get('/activa', async (req, res) => {
    try {
        const activa = await cargarConfiguracionDesignacionActiva();
        if (activa.error) return responderError(res, activa, 500);
        const detalle = await obtenerVersionDesignacionDetalle(activa.meta.id);
        if (detalle.error) return responderError(res, detalle, 500);
        res.json(detalle);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /defaults — Versión 1 predeterminada (pura, sin BD) ──────────────
// Usada por "Restaurar configuración predeterminada" (sección 33) para
// mostrar el diff ANTES de crear la nueva versión — nunca modifica nada.
router.get('/defaults', (req, res) => {
    res.json({ configuracion: construirConfiguracionDefaultV1() });
});

// ─── POST /versiones — crear una versión NUEVA, siempre INACTIVA ──────────
// Body: { configuracion, descripcion, es_restaurar_defaults }. `configuracion`
// debe traer la forma completa (misma que construirConfiguracionDefaultV1()).
// `es_restaurar_defaults` es SOLO para etiquetar la auditoría (sección 33/38:
// "Restaurar predeterminada" reutiliza este mismo endpoint con el payload de
// construirConfiguracionDefaultV1(), nunca activa nada por su cuenta) — no
// cambia ninguna validación ni el resultado persistido.
router.post('/versiones', async (req, res) => {
    const { configuracion, descripcion, es_restaurar_defaults } = req.body;

    // Defensa temprana con mensaje claro — crearVersionDesignacion() vuelve
    // a correr exactamente esta misma validación (fuente única,
    // validarConfiguracion), esto solo evita tocar la RPC con un payload
    // obviamente vacío.
    if (!configuracion || typeof configuracion !== 'object') {
        return res.status(400).json({ error: 'CONFIGURACION_DESIGNACION_INVALIDA', detalle: 'configuracion requerida' });
    }

    let resultado;
    try {
        resultado = await crearVersionDesignacion({
            configuracion, descripcion: descripcion || null, creadoPor: req.usuario.id
        });
    } catch (err) {
        return res.status(500).json({ error: 'No se pudo crear la nueva versión de configuración de designación: ' + err.message });
    }
    if (resultado.error) return responderError(res, resultado, 400);

    const accion = es_restaurar_defaults === true ? 'RESTAURAR_DEFAULT_CONFIG_DESIGNACION' : 'CREAR_VERSION_CONFIG_DESIGNACION';
    await auditoria.registrar({
        tabla: 'configuracion_designacion_versiones',
        registro_id: resultado.id,
        accion,
        datos_nuevos: { numero_version: resultado.numero_version, descripcion: descripcion || null },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `${es_restaurar_defaults === true ? 'Restauró la configuración predeterminada como' : 'Creó'} la versión v${resultado.numero_version} de configuración de designación de propuestas, INACTIVA.`,
        ip_address: req.ip
    });

    res.status(201).json({ id: resultado.id, numero_version: resultado.numero_version, activa: false });
});

// ─── POST /versiones/:id/activar — activar EXPLÍCITAMENTE una versión ─────
// Usa exclusivamente la RPC activar_configuracion_designacion — nunca varios
// UPDATE desde JS (sección 5). Previews/borradores existentes NO se tocan
// (quedan atados a su propia versión, Etapa 3) — este endpoint no hace
// absolutamente ningún cambio sobre propuestas_designacion.
router.post('/versiones/:id/activar', async (req, res) => {
    let versionAntes;
    try {
        const activaAntes = await cargarConfiguracionDesignacionActiva();
        versionAntes = activaAntes.error ? null : activaAntes.meta.numero_version;
    } catch {
        versionAntes = null; // no bloquea la activación por no poder leer el "antes" para la auditoría
    }

    const resultado = await activarVersionDesignacion(req.params.id);
    if (resultado.error) return responderError(res, resultado, 400);

    // numero_version para la respuesta/auditoría — detalle liviano, ya
    // validado por la propia RPC que acaba de activarla.
    const detalle = await obtenerVersionDesignacionDetalle(req.params.id);
    const numeroActivado = detalle.error ? null : detalle.meta.numero_version;

    await auditoria.registrar({
        tabla: 'configuracion_designacion_versiones',
        registro_id: req.params.id,
        accion: 'ACTIVAR_VERSION_CONFIG_DESIGNACION',
        datos_anteriores: { numero_version_activa: versionAntes },
        datos_nuevos: { numero_version_activa: numeroActivado },
        actor_id: req.usuario.id,
        actor_tipo: 'administrador',
        descripcion: `Activó la versión v${numeroActivado ?? req.params.id} de configuración de designación de propuestas (reemplaza a v${versionAntes ?? '—'}). Los previews y borradores existentes conservan la versión con la que fueron creados.`,
        ip_address: req.ip
    });

    res.json({ id: req.params.id, numero_version: numeroActivado, activa: true });
});

module.exports = router;
