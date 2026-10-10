// ─────────────────────────────────────────────────────────────────────────
// Cartilla de Delegado desde el Portal de Delegado de Asociación (Fase 3).
// Reutiliza EXACTAMENTE la misma tabla, el mismo formulario (frontend) y la
// misma lógica de notas/validación que el flujo de Delegado Rentado — NUNCA
// crea un formulario paralelo simplificado. Lo único que es genuinamente
// distinto es la AUTORIZACIÓN (asociación+delegado certificado en vez de
// asignación individual) y la CREACIÓN/ADJUNTO (vía RPC transaccional, para
// garantizar "una sola cartilla oficial por rodeo" de forma atómica).
//
// Reutiliza de usuario/cartilla-delegado.js (vía propiedades del router,
// ver ese archivo): CAMPOS_EDITABLES, CAMPOS_REQUERIDOS_ENVIO,
// cargarJuradosRodeo — nunca duplicados aquí.
// Reutiliza de services/cartillaDelegadoNotas.js: validarAspectosDesempeno,
// calcularPromedioDesempeno, sincronizarNotaDelegado — sin cambios.
// Reutiliza de services/informeGestion/asociaciones.js: el mismo resolutor
// de asociación (nunca ILIKE) que ya usa institucional/rodeos.js.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const supabase = require('../../config/supabase');
const { soloCuentaInstitucional } = require('../../middleware/auth');
const { construirIndiceCatalogo, resolverAsociacion } = require('../../services/informeGestion/asociaciones');
const {
    validarAspectosDesempeno, calcularPromedioDesempeno, sincronizarNotaDelegado
} = require('../../services/cartillaDelegadoNotas');
// Fase 3.4 — "Descargar PDF": se reutiliza el MISMO generador que ya usa el
// administrador (backend/src/services/cartilla-delegado-pdf.js), sin crear
// un diseño paralelo. Ese generador no tiene ninguna restricción de estado
// (se confirmó leyendo admin/cartillas-delegado.js GET /:id/pdf: genera el
// PDF para cualquier `cartilla.estado`) — por eso acá tampoco se restringe
// por estado, solo por autorización (ver GET /:id/pdf más abajo).
const { generarCartillaDelegadoPDF } = require('../../services/cartilla-delegado-pdf');
// Fase 3.5 — "Historial de Responsables": servicio ÚNICO de lectura, basado
// en `auditoria` real (nunca se fabrica un evento), compartido con el
// detalle administrativo y el PDF.
const { obtenerHistorialResponsables } = require('../../services/historialResponsableInstitucional');

const usuarioCartillaDelegado = require('../usuario/cartilla-delegado');
const { CAMPOS_EDITABLES, CAMPOS_REQUERIDOS_ENVIO, cargarJuradosRodeo } = usuarioCartillaDelegado;

const ESTADOS_BLOQUEADOS = ['enviada', 'reenviada', 'aprobada', 'cerrada'];

// Fase 3.1 (cierre, Caso D): mensaje y código ÚNICOS para el bloqueo de
// escritura cuando, DESPUÉS de iniciada la cartilla institucional, aparece
// una designación vigente de Delegado Rentado para el mismo rodeo. Nunca se
// elimina ni se transfiere la cartilla — solo se bloquean nuevos guardados,
// el envío y el cambio de delegado responsable, hasta resolución administrativa.
const MENSAJE_BLOQUEADA_POR_DESIGNACION_POSTERIOR = 'Este rodeo presenta un cambio de designación de Delegado. La cartilla se encuentra temporalmente bloqueada hasta que el Administrador resuelva la situación.';
const CODIGO_BLOQUEADA_POR_DESIGNACION_POSTERIOR = 'BLOQUEADA_POR_DESIGNACION_POSTERIOR';

router.use(soloCuentaInstitucional);

// Confirma que el rodeo pertenece a la asociación del token — SIEMPRE server-side,
// resolviendo por catálogo+alias real (nunca ILIKE), igual que institucional/rodeos.js.
// Devuelve el rodeo si pertenece; null si no existe o no pertenece a esta asociación.
async function rodeoDeMiAsociacion(rodeoId, asociacionId) {
    const { data: rodeo } = await supabase
        .from('rodeos')
        .select('id, club, asociacion, fecha, estado, tipo_rodeo_nombre, temporada_id, temporadas(nombre)')
        .eq('id', rodeoId)
        .maybeSingle();
    if (!rodeo) return null;

    const [{ data: catalogo }, { data: alias }] = await Promise.all([
        supabase.from('asociaciones').select('id, nombre, nombre_normalizado, activa'),
        supabase.from('asociacion_alias').select('asociacion_id, alias, alias_normalizado')
    ]);
    const indice = construirIndiceCatalogo(catalogo || [], alias || []);
    const asoc = resolverAsociacion(rodeo.asociacion, indice);
    if (!asoc || asoc.id !== asociacionId) return null;
    return rodeo;
}

// Fase 3.1 — regla oficial: "cada rodeo tiene un solo delegado responsable".
// Designación EFECTIVA de Delegado Rentado para un rodeo: criterio
// TEXTUALMENTE igual al que usuario/cartilla-delegado.js usa para el
// autochequeo del propio Rentado (estado='activo' + publicado=true +
// estado_designacion != 'rechazado'), aquí sin filtrar por
// usuario_pagado_id — importa si ALGÚN Rentado tiene designación vigente, no
// cuál. Una fila histórica anulada, no publicada o rechazada nunca cuenta.
async function tieneDelegadoRentadoDesignado(rodeoId) {
    const { data } = await supabase
        .from('asignaciones')
        .select('id, estado_designacion')
        .eq('rodeo_id', rodeoId)
        .eq('tipo_persona', 'delegado_rentado')
        .eq('estado', 'activo')
        .eq('publicado', true)
        .neq('estado_designacion', 'rechazado')
        .maybeSingle();
    return !!data;
}

// Valida que un delegado sea activo+certificado+de la MISMA asociación — mismo
// criterio exacto que POST /institucional/delegados/seleccionar (Fase 2).
async function delegadoValido(delegadoId, asociacionId) {
    const { data } = await supabase
        .from('delegados_asociacion')
        .select('id, nombre, asociacion_id, activo, certificado')
        .eq('id', delegadoId)
        .maybeSingle();
    if (!data || !data.activo || !data.certificado || data.asociacion_id !== asociacionId) return null;
    return data;
}

// ─── GET /rodeo/:rodeo_id ───────────────────────────────────────────────
router.get('/rodeo/:rodeo_id', async (req, res) => {
    const rodeo = await rodeoDeMiAsociacion(req.params.rodeo_id, req.usuario.asociacion_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });

    const [{ data: filas }, rentadoDesignado, jurados, { data: designacion }] = await Promise.all([
        supabase.from('cartillas_delegado').select('*').eq('rodeo_id', rodeo.id),
        tieneDelegadoRentadoDesignado(rodeo.id),
        cargarJuradosRodeo(rodeo.id),
        // Fase 3.5: la fila de rodeos_delegado_institucional (si existe) es la
        // FUENTE del responsable confirmado — se necesita su id para leer el
        // historial de auditoría asociado a ella.
        supabase.from('rodeos_delegado_institucional').select('id').eq('rodeo_id', rodeo.id).maybeSingle()
    ]);

    const institucional = (filas || []).find(f => f.delegado_asociacion_id != null) || null;
    const rentadoCartillaExiste = (filas || []).some(f => f.delegado_id != null);

    // Fase 3.1: la cartilla institucional solo está disponible cuando NO hay
    // designación vigente de Delegado Rentado y NO existe ya una cartilla
    // Rentado con contenido real — en cualquiera de esos dos casos, la
    // responsabilidad es (o fue) del Rentado y requiere resolución
    // administrativa antes de permitir la vía institucional (nunca se
    // esconde solo el botón: el backend repite exactamente esta misma
    // verificación en POST).
    const conflictoRentado = !institucional && (rentadoDesignado || rentadoCartillaExiste);

    // Fase 3.1 (cierre, Caso D): si la cartilla institucional YA existe pero
    // DESPUÉS apareció una designación vigente de Delegado Rentado para el
    // mismo rodeo, nunca se oculta ni se elimina la cartilla — se sigue
    // devolviendo para consulta/lectura, pero marcada como bloqueada para
    // nuevas escrituras (ver PATCH y POST /:id/enviar, que repiten esta
    // misma verificación en el backend antes de cualquier UPDATE).
    const bloqueadaPorDesignacionPosterior = !!institucional && rentadoDesignado;

    // Fase 3.5 — "Historial de Responsables": solo lectura, construido 100%
    // desde auditoria real (nunca se fabrica un evento). Si no hay
    // designación ni cartilla todavía, el historial viene vacío.
    const historialResponsables = await obtenerHistorialResponsables(supabase, {
        designacionId: designacion?.id || null,
        cartillaId: institucional?.id || null
    });

    res.json({
        rodeo,
        cartilla: institucional,
        conflicto_rentado: conflictoRentado,
        delegado_rentado_designado: rentadoDesignado,
        bloqueada_por_designacion_posterior: bloqueadaPorDesignacionPosterior,
        jurados,
        historial_responsables: historialResponsables
    });
});

// ─── POST /rodeo/:rodeo_id — crear o adjuntar la cartilla ──────────────
// Fase 3.5 — regla oficial: "un único responsable confirmado por rodeo".
// Esta ruta YA NO acepta un delegado_asociacion_id del body para decidir
// quién es el responsable — SIEMPRE usa el responsable YA CONFIRMADO en
// rodeos_delegado_institucional (POST /institucional/rodeos/:id/seleccionar-
// delegado, ver ese archivo). Si el body envía un delegado_asociacion_id que
// NO coincide con el confirmado, se rechaza — nunca se permite elegir ni
// cambiar el responsable "de paso" al completar la cartilla; esa ya no es
// la vía (el reemplazo, si corresponde, es exclusivamente administrativo).
router.post('/rodeo/:rodeo_id', async (req, res) => {
    const rodeo = await rodeoDeMiAsociacion(req.params.rodeo_id, req.usuario.asociacion_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });
    if (rodeo.estado === 'anulado') {
        return res.status(422).json({ error: 'No puede crearse una cartilla para un rodeo anulado.', code: 'RODEO_ANULADO' });
    }

    const { data: confirmado } = await supabase
        .from('rodeos_delegado_institucional')
        .select('delegado_asociacion_id')
        .eq('rodeo_id', rodeo.id)
        .maybeSingle();

    if (!confirmado) {
        return res.status(422).json({
            error: 'Debe seleccionar y confirmar un delegado para este rodeo antes de completar la cartilla.',
            code: 'DELEGADO_NO_SELECCIONADO'
        });
    }
    if (req.body?.delegado_asociacion_id && req.body.delegado_asociacion_id !== confirmado.delegado_asociacion_id) {
        return res.status(403).json({
            error: 'El responsable de este rodeo ya fue confirmado y no puede elegirse otro desde acá. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO'
        });
    }

    const delegado = await delegadoValido(confirmado.delegado_asociacion_id, req.usuario.asociacion_id);
    if (!delegado) return res.status(403).json({ error: 'Delegado no válido para esta asociación.' });

    // Mismo auto-cálculo que usuario/cartilla-delegado.js POST /rodeo/:rodeo_id
    // (temporada vía temporadas.nombre con fallback al año de la fecha).
    const temporadaNombre = rodeo?.temporadas?.nombre || (rodeo?.fecha ? rodeo.fecha.slice(0, 4) : null);

    const { data, error } = await supabase.rpc('crear_o_adjuntar_cartilla_institucional', {
        p_rodeo_id: rodeo.id,
        p_delegado_asociacion_id: delegado.id,
        p_delegado_nombre: delegado.nombre,
        p_cuenta_institucional_id: req.usuario.id,
        p_temporada: temporadaNombre,
        p_fecha_rodeo: rodeo.fecha || null,
        p_tipo_rodeo: rodeo.tipo_rodeo_nombre || null
    });

    if (error) {
        if (error.message?.includes('DELEGADO_RENTADO_DESIGNADO')) {
            return res.status(409).json({
                error: 'Este rodeo tiene un Delegado Rentado designado. La cartilla corresponde a dicho delegado.',
                code: 'DELEGADO_RENTADO_DESIGNADO'
            });
        }
        if (error.message?.includes('CARTILLA_RENTADO_EXISTENTE')) {
            return res.status(409).json({
                error: 'Ya existe una cartilla de Delegado Rentado para este rodeo. Requiere decisión administrativa antes de continuar desde el portal institucional.',
                code: 'CARTILLA_RENTADO_EXISTENTE'
            });
        }
        if (error.message?.includes('CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO')) {
            return res.status(409).json({
                error: 'La cartilla ya fue enviada/aprobada y no admite cambiar el delegado responsable.',
                code: 'CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO'
            });
        }
        return res.status(500).json({ error: error.message });
    }

    const cartilla = Array.isArray(data) ? data[0] : data;

    // Fase 3.5.1: la auditoría de este evento ('crear'/'guardar') ya NO se
    // registra desde acá con una llamada JS separada (auditoria.registrar(),
    // que traga sus propios errores por diseño) — crear_o_adjuntar_cartilla_
    // institucional (migración 070) la inserta DENTRO de su propia
    // transacción, junto con el INSERT/UPDATE de la cartilla: si esa
    // auditoría fallara, la cartilla tampoco quedaría creada/adjuntada, y
    // esta llamada habría recibido `error` más arriba en vez de llegar aquí.
    res.status(cartilla.version === 1 ? 201 : 200).json({ cartilla, creada: cartilla.version === 1 });
});

// ─── PATCH /:id — guardar avance (control de concurrencia optimista) ──
router.patch('/:id', async (req, res) => {
    const { data: cartilla } = await supabase
        .from('cartillas_delegado')
        .select('id, rodeo_id, estado, version, delegado_asociacion_id, delegado_nombre')
        .eq('id', req.params.id)
        .maybeSingle();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    // Nunca permite tocar una cartilla de origen Delegado Rentado desde este namespace.
    if (!cartilla.delegado_asociacion_id) return res.status(403).json({ error: 'Sin permiso.' });

    const rodeo = await rodeoDeMiAsociacion(cartilla.rodeo_id, req.usuario.asociacion_id);
    if (!rodeo) return res.status(403).json({ error: 'Sin permiso.' }); // defensa en profundidad: el rodeo ya no es de esta asociación

    if (ESTADOS_BLOQUEADOS.includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada y no puede modificarse.', code: 'ESTADO_BLOQUEADO' });
    }

    // Fase 3.1 (cierre, Caso D): re-verificar en CADA guardado — no solo al
    // crear — si entretanto apareció una designación vigente de Delegado
    // Rentado para este rodeo. Nunca se oculta ni se borra la cartilla (el
    // GET sigue devolviéndola), pero no se admite ningún guardado nuevo.
    if (await tieneDelegadoRentadoDesignado(cartilla.rodeo_id)) {
        return res.status(409).json({ error: MENSAJE_BLOQUEADA_POR_DESIGNACION_POSTERIOR, code: CODIGO_BLOQUEADA_POR_DESIGNACION_POSTERIOR });
    }

    if (req.body.version === undefined) return res.status(400).json({ error: 'version es requerida.' });

    if (req.body.respuestas_json?.desempeno_jurado !== undefined) {
        const chk = validarAspectosDesempeno(req.body.respuestas_json.desempeno_jurado);
        if (!chk.valido) return res.status(422).json({ error: chk.error, campos: chk.camposInvalidos });
    }

    // Fase 3.5 — regla oficial: el responsable confirmado es inmutable por
    // esta vía. Un guardado normal YA NO puede cambiar delegado_asociacion_id
    // (ni delegado_nombre, su snapshot) — el único camino es el reemplazo
    // administrativo autorizado (ver admin/rodeos.js). Se rechaza
    // explícitamente en vez de ignorarlo en silencio, para que un intento
    // (accidental o no) de enviarlo quede señalado con un error claro.
    if (req.body.delegado_asociacion_id !== undefined && req.body.delegado_asociacion_id !== cartilla.delegado_asociacion_id) {
        return res.status(403).json({
            error: 'El responsable de esta cartilla ya fue confirmado y no puede cambiarse desde un guardado normal. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO'
        });
    }
    // Mismo bloqueo para delegado_nombre: es el nombre DECLARADO del
    // responsable confirmado, no un campo de texto libre editable para
    // cartillas institucionales (a diferencia del flujo de Delegado Rentado,
    // que sí puede corregir su propio nombre en su propia cartilla).
    if (req.body.delegado_nombre !== undefined && req.body.delegado_nombre !== cartilla.delegado_nombre) {
        return res.status(403).json({
            error: 'El nombre del responsable confirmado no puede editarse desde acá. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO'
        });
    }

    const updates = { updated_at: new Date().toISOString(), actualizado_por_cuenta_institucional_id: req.usuario.id, version: cartilla.version + 1 };
    CAMPOS_EDITABLES.forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    if (updates.respuestas_json?.desempeno_jurado) {
        updates.respuestas_json.desempeno_jurado.nota_promedio = calcularPromedioDesempeno(updates.respuestas_json.desempeno_jurado);
    }

    // Fase 3.5.1 — control de concurrencia optimista Y auditoría obligatoria
    // en una sola transacción (migración 070): si el INSERT en `auditoria`
    // fallara, el UPDATE de la cartilla también se revierte — nunca se
    // reporta "guardado correctamente" sin que quede su evento de auditoría.
    // Reemplaza el UPDATE suelto + auditoria.registrar() posterior (ese
    // helper traga sus propios errores por diseño, correcto para el resto
    // del sistema pero insuficiente para esta garantía específica).
    const { data, error } = await supabase.rpc('actualizar_cartilla_institucional_con_auditoria', {
        p_cartilla_id: req.params.id,
        p_version: req.body.version,
        p_cambios: updates,
        p_cuenta_institucional_id: req.usuario.id,
        p_accion: 'guardar',
        p_descripcion: 'Guardado de borrador institucional'
    });

    if (error) {
        if (error.message?.includes('CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA')) {
            return res.status(409).json({
                error: 'La cartilla fue modificada por otra sesión mientras tanto. Recargue los datos más recientes antes de guardar de nuevo.',
                code: 'VERSION_DESACTUALIZADA'
            });
        }
        return res.status(500).json({ error: error.message });
    }

    const cartillaGuardada = Array.isArray(data) ? data[0] : data;
    res.json({ mensaje: 'Borrador guardado correctamente', cartilla: cartillaGuardada });
});

// ─── POST /:id/enviar ───────────────────────────────────────────────────
router.post('/:id/enviar', async (req, res) => {
    const { data: cartilla } = await supabase
        .from('cartillas_delegado')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (!cartilla.delegado_asociacion_id) return res.status(403).json({ error: 'Sin permiso.' });

    const rodeo = await rodeoDeMiAsociacion(cartilla.rodeo_id, req.usuario.asociacion_id);
    if (!rodeo) return res.status(403).json({ error: 'Sin permiso.' });

    if (ESTADOS_BLOQUEADOS.includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada.', code: 'ESTADO_BLOQUEADO' });
    }

    // Fase 3.1 (cierre, Caso D): mismo bloqueo que PATCH — nunca se envía una
    // cartilla institucional mientras exista un conflicto de designación sin
    // resolver.
    if (await tieneDelegadoRentadoDesignado(cartilla.rodeo_id)) {
        return res.status(409).json({ error: MENSAJE_BLOQUEADA_POR_DESIGNACION_POSTERIOR, code: CODIGO_BLOQUEADA_POR_DESIGNACION_POSTERIOR });
    }

    if (req.body?.version === undefined) return res.status(400).json({ error: 'version es requerida.' });
    if (Number(req.body.version) !== cartilla.version) {
        return res.status(409).json({
            error: 'La cartilla fue modificada por otra sesión mientras tanto. Recargue los datos más recientes antes de enviar.',
            code: 'VERSION_DESACTUALIZADA'
        });
    }

    const body = req.body || {};
    const merged = { ...cartilla, ...body };
    const faltantes = CAMPOS_REQUERIDOS_ENVIO.filter(k => !merged[k] || String(merged[k]).trim() === '');
    if (faltantes.length > 0) {
        return res.status(422).json({ error: `Faltan campos requeridos antes de enviar: ${faltantes.join(', ')}.`, faltantes });
    }

    const djMerged = merged.respuestas_json?.desempeno_jurado;
    if (djMerged !== undefined) {
        const chk = validarAspectosDesempeno(djMerged);
        if (!chk.valido) return res.status(422).json({ error: chk.error, campos: chk.camposInvalidos });
    }

    // Fase 3.5: mismo bloqueo que PATCH — el nombre del responsable
    // confirmado no es un campo libre editable para cartillas institucionales.
    if (body.delegado_nombre !== undefined && body.delegado_nombre !== cartilla.delegado_nombre) {
        return res.status(403).json({
            error: 'El nombre del responsable confirmado no puede editarse desde acá. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO'
        });
    }

    const ahora = new Date().toISOString();
    const esReenvio = cartilla.estado === 'observada';
    const nuevoEstado = esReenvio ? 'reenviada' : 'enviada';
    const historial = Array.isArray(cartilla.historial_observaciones) ? [...cartilla.historial_observaciones] : [];
    if (esReenvio) historial.push({ tipo: 'reenvio', fecha: ahora, por: 'delegado_asociacion' });

    const updates = {
        estado: nuevoEstado,
        enviada_en: cartilla.enviada_en || ahora,
        updated_at: ahora,
        actualizado_por_cuenta_institucional_id: req.usuario.id,
        historial_observaciones: historial,
        version: cartilla.version + 1,
        ...(esReenvio ? { reenviada_en: ahora } : {})
    };
    CAMPOS_EDITABLES.forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });

    let notaPromedio = null;
    if (updates.respuestas_json?.desempeno_jurado) {
        notaPromedio = calcularPromedioDesempeno(updates.respuestas_json.desempeno_jurado);
        updates.respuestas_json.desempeno_jurado.nota_promedio = notaPromedio;
    }

    // Fase 3.5.1 — misma garantía que PATCH: el UPDATE y su auditoría
    // obligatoria ('enviar'/'reenviar') quedan en una sola transacción
    // (migración 070) — si la auditoría fallara, el envío tampoco queda
    // aplicado (nunca "cartilla enviada" sin su evento de auditoría).
    const { data, error } = await supabase.rpc('actualizar_cartilla_institucional_con_auditoria', {
        p_cartilla_id: req.params.id,
        p_version: cartilla.version,
        p_cambios: updates,
        p_cuenta_institucional_id: req.usuario.id,
        p_accion: 'enviar',
        p_descripcion: `${esReenvio ? 'Reenvío' : 'Envío'} de cartilla institucional`
    });

    if (error) {
        if (error.message?.includes('CARTILLA_NO_ENCONTRADA_O_VERSION_DESACTUALIZADA')) {
            return res.status(409).json({ error: 'La cartilla fue modificada por otra sesión mientras tanto.', code: 'VERSION_DESACTUALIZADA' });
        }
        return res.status(500).json({ error: error.message });
    }

    const data_enviada = Array.isArray(data) ? data[0] : data;

    let notaDelegadoSincronizada = false;
    if (notaPromedio !== null) {
        try {
            await sincronizarNotaDelegado(cartilla.rodeo_id, notaPromedio, req.usuario.id);
            notaDelegadoSincronizada = true;
        } catch (errSync) {
            console.error('[CARTILLA-INSTITUCIONAL enviar] Error sincronizando Nota Delegado:', errSync.message);
        }
    }

    const msg = esReenvio ? 'Cartilla reenviada correctamente.' : 'Cartilla enviada correctamente.';
    res.json({ mensaje: msg, cartilla: data_enviada, nota_delegado_sincronizada: notaDelegadoSincronizada });
});

// Fase 3.4 — nombre de archivo claro y seguro: fecha SIN conversión de huso
// horario (mismo criterio que fmtFechaRodeo() del frontend — rodeos.fecha es
// una fecha deportiva pura, nunca se crea un objeto Date con ella) y club sin
// caracteres inválidos para nombre de archivo.
function nombreArchivoCartillaPDF(club, fechaRodeo) {
    const clubLimpio = (club || 'rodeo').normalize('NFD').replace(/[̀-ͯ]/g, '') // sin tildes
        .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'rodeo';
    let fechaLimpia = 'sin-fecha';
    if (fechaRodeo) {
        const [y, m, d] = String(fechaRodeo).split('T')[0].split('-');
        if (y && m && d) fechaLimpia = `${d}-${m}-${y}`;
    }
    return `Cartilla_Delegado_${clubLimpio}_${fechaLimpia}.pdf`;
}

// ─── GET /:id/pdf — descargar el PDF oficial (Fase 3.4) ────────────────────
// Reutiliza íntegramente el generador existente (generarCartillaDelegadoPDF),
// nunca un diseño paralelo. Autorización: la cartilla debe ser de ORIGEN
// institucional (delegado_asociacion_id IS NOT NULL — nunca se expone una
// cartilla de Delegado Rentado por este namespace, mismo criterio que PATCH/
// enviar) Y su rodeo debe pertenecer a la asociación autenticada (misma
// verificación que el resto de este router — nunca por ID a secas). Nunca
// escribe nada: es una consulta de solo lectura, sin importar el estado.
router.get('/:id/pdf', async (req, res) => {
    const { data: cartilla, error } = await supabase
        .from('cartillas_delegado')
        .select(`
            *,
            rodeo:rodeos!cartillas_delegado_rodeo_id_fkey(
                id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre,
                temporada_id, temporadas(nombre)
            )
        `)
        .eq('id', req.params.id)
        .maybeSingle();

    if (error || !cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (!cartilla.delegado_asociacion_id) return res.status(403).json({ error: 'Sin permiso.' });

    // Defensa en profundidad: re-verifica que el rodeo siga perteneciendo a
    // la asociación del token (nunca confía solo en que la cartilla "ya es
    // institucional" — la asociación pudo cambiar, o el rodeo nunca fue
    // revisado todavía por esta ruta específica).
    const rodeoAutorizado = await rodeoDeMiAsociacion(cartilla.rodeo_id, req.usuario.asociacion_id);
    if (!rodeoAutorizado) return res.status(403).json({ error: 'Sin permiso.' });

    try {
        // Fase 3.5: mismo servicio de historial que GET /rodeo/:rodeo_id —
        // el PDF solo agrega el bloque final si realmente hay eventos
        // auditados (nunca fabrica ninguno).
        const { data: designacion } = await supabase
            .from('rodeos_delegado_institucional')
            .select('id')
            .eq('rodeo_id', cartilla.rodeo_id)
            .maybeSingle();
        const historialResponsables = await obtenerHistorialResponsables(supabase, {
            designacionId: designacion?.id || null,
            cartillaId: cartilla.id
        });
        const buffer = await generarCartillaDelegadoPDF(cartilla, cartilla.rodeo || {}, { historialResponsables });
        const nombre = nombreArchivoCartillaPDF(cartilla.rodeo?.club, cartilla.fecha_rodeo);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
        res.setHeader('Content-Length', buffer.length);
        res.end(buffer);
    } catch (err) {
        console.error('[CARTILLA-INSTITUCIONAL pdf]', err.message);
        res.status(500).json({ error: 'Error al generar PDF: ' + err.message });
    }
});

// Fase 3.3: expone estos dos helpers (mismo patrón que usuario/cartilla-delegado.js
// con CAMPOS_EDITABLES) para que institucional/rodeos.js reutilice la MISMA
// verificación de pertenencia de rodeo y de delegado válido, sin duplicarla.
router.rodeoDeMiAsociacion = rodeoDeMiAsociacion;
router.delegadoValido = delegadoValido;

module.exports = router;
