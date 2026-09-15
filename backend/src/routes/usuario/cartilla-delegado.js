const express  = require('express');
const router   = express.Router();
const supabase = require('../../config/supabase');
const {
    ASPECTOS_DESEMPENO_JURADO, validarAspectosDesempeno, calcularPromedioDesempeno,
    sincronizarNotaDelegado
} = require('../../services/cartillaDelegadoNotas');

// Middleware: solo delegados pueden usar este módulo
router.use((req, res, next) => {
    if (req.usuario?.tipo_persona !== 'delegado_rentado') {
        return res.status(403).json({ error: 'Solo los delegados pueden acceder a la cartilla del delegado.' });
    }
    next();
});

// ─── Campos permitidos en escritura ──────────────────────────────────────────
// Mejora "nuevo formato oficial 2026-2027": se revisó agregar columnas nuevas
// para Asociación/Club/correo del delegado y se descartó (gate de la segunda
// revisión) — ver nota en POST /rodeo/:rodeo_id más abajo sobre por qué
// Asociación/Club se muestran EN VIVO desde `rodeos` en vez de duplicarse
// acá, y por qué no existe `delegado_email` (el encabezado oficial nuevo NO
// pide correo del delegado — el correo de contacto es del veterinario/
// técnico, ya cubierto por respuestas_json.informe_veterinario.correo).
//
// 4ª revisión (simplificar/evitar duplicación): `temporada` y `tipo_rodeo`
// dejan de ser editables por el Delegado — son 100% automáticos, calculados
// UNA VEZ al crear la cartilla (ver POST /rodeo/:rodeo_id) a partir de
// `rodeo.temporadas.nombre`/`rodeo.tipo_rodeo_nombre`, y el frontend nuevo
// los muestra en vivo directo desde `rodeo` (nunca los envía en el body).
// Se retiran de CAMPOS_EDITABLES como defensa en profundidad: aunque algún
// cliente antiguo los enviara, el backend ya no los sobrescribiría.
// `club_asociacion_organizador` también se retira: quedó redundante con
// Asociación/Club en vivo (ver POST /rodeo/:rodeo_id) — se deja de
// escribir/aceptar, pero la columna y cualquier valor histórico existente
// se conservan intactos para cartillas ya creadas (ver vista Administrador
// y PDF, que siguen mostrando el valor histórico si existe).
//
// 5ª revisión: mismo tratamiento para `fecha_rodeo` — tenía exactamente el
// mismo problema que `temporada` (el frontend la leía desde `cartilla`, que
// no existe hasta el primer guardado). Se retira de CAMPOS_EDITABLES; el
// frontend la muestra en vivo desde `rodeo.fecha`, nunca desde esta columna.
const CAMPOS_EDITABLES = [
    'delegado_nombre', 'delegado_telefono',
    'secretario_jurado', 'secretario_numero_socio',
    'publico_serie_campeones',
    'serie_campeones_dos_vueltas', 'incluye_informe_disciplinario', 'incluye_informe_ganado_bajo_peso',
    'certificacion_medialuna_comuna', 'certificacion_mas_200_personas',
    'certificacion_mas_250_personas', 'certificacion_vinculacion_comunidad',
    'respuestas_json'
];

// `club_asociacion_organizador` se retira de los requeridos: ya no se
// escribe en cartillas nuevas (queda null), sería imposible enviar el
// informe si siguiera siendo obligatorio. `temporada`/`tipo_rodeo` se
// mantienen — siguen garantizados por el auto-cálculo del POST de creación.
const CAMPOS_REQUERIDOS_ENVIO = [
    'temporada', 'fecha_rodeo', 'delegado_nombre', 'tipo_rodeo'
];

// ─── Jurado(s) oficialmente asignado(s) al rodeo — SOLO LECTURA, nunca
// almacenado en cartillas_delegado (pedido explícito: "Evita crear una
// segunda fuente independiente"). Misma fuente/condición que ya usa el resto
// del sistema para listar jurados de un rodeo: asignaciones activas con
// tipo_persona='jurado' → usuarios_pagados.nombre_completo (con fallback a
// nombre_importado para designaciones aún no vinculadas a un usuario).
async function cargarJuradosRodeo(rodeoId) {
    const { data } = await supabase
        .from('asignaciones')
        .select('usuario_pagado_id, nombre_importado, usuarios_pagados(nombre_completo)')
        .eq('rodeo_id', rodeoId)
        .eq('tipo_persona', 'jurado')
        .eq('estado', 'activo');
    return (data || [])
        .map(a => a.usuarios_pagados?.nombre_completo || a.nombre_importado || null)
        .filter(Boolean);
}

// ─── GET /api/usuario/cartilla-delegado/rodeo/:rodeo_id ──────────────────────
// Carga datos del rodeo, perfil del delegado y cartilla existente (o null).
router.get('/rodeo/:rodeo_id', async (req, res) => {
    const uid     = req.usuario.id;
    const rodeoId = req.params.rodeo_id;

    // Verificar que el delegado tiene asignación activa en este rodeo
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, estado_designacion')
        .eq('rodeo_id', rodeoId)
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .eq('publicado', true)
        .neq('estado_designacion', 'rechazado')
        .maybeSingle();

    if (!asig) {
        return res.status(404).json({ error: 'No tienes asignación activa para este rodeo.' });
    }

    const [{ data: rodeo }, { data: perfil }, { data: cartilla }, jurados] = await Promise.all([
        supabase.from('rodeos')
            .select('id, club, asociacion, fecha, tipo_rodeo_nombre, categoria_rodeo_nombre, temporada_id, temporadas(nombre)')
            .eq('id', rodeoId).single(),
        supabase.from('usuarios_pagados')
            .select('nombre_completo, telefono')
            .eq('id', uid).single(),
        supabase.from('cartillas_delegado')
            .select('*')
            .eq('rodeo_id', rodeoId)
            .eq('delegado_id', uid)
            .maybeSingle(),
        cargarJuradosRodeo(rodeoId)
    ]);

    res.json({ rodeo, perfil, cartilla: cartilla || null, asignacion_id: asig.id, jurados });
});

// ─── POST /api/usuario/cartilla-delegado/rodeo/:rodeo_id ─────────────────────
// Crea la cartilla si no existe; si ya existe la retorna (sin duplicar).
router.post('/rodeo/:rodeo_id', async (req, res) => {
    const uid     = req.usuario.id;
    const rodeoId = req.params.rodeo_id;

    // Verificar asignación activa
    const { data: asig } = await supabase
        .from('asignaciones')
        .select('id, estado_designacion')
        .eq('rodeo_id', rodeoId)
        .eq('usuario_pagado_id', uid)
        .eq('estado', 'activo')
        .eq('publicado', true)
        .neq('estado_designacion', 'rechazado')
        .maybeSingle();

    if (!asig) {
        return res.status(403).json({ error: 'Sin asignación activa para este rodeo.' });
    }

    // Si ya existe, retornar la existente (no duplicar)
    const { data: existente } = await supabase
        .from('cartillas_delegado')
        .select('id, estado')
        .eq('rodeo_id', rodeoId)
        .eq('delegado_id', uid)
        .maybeSingle();

    if (existente) {
        return res.json({ cartilla: existente, creada: false });
    }

    // Precargar datos del rodeo y perfil
    const [{ data: rodeo }, { data: perfil }] = await Promise.all([
        supabase.from('rodeos')
            .select('club, asociacion, fecha, tipo_rodeo_nombre, temporada_id, temporadas(nombre)')
            .eq('id', rodeoId).single(),
        supabase.from('usuarios_pagados')
            .select('nombre_completo, telefono')
            .eq('id', uid).single()
    ]);

    // Temporada — fuente oficial: temporadas.nombre vía rodeos.temporada_id
    // (ej. "2026-2027"), NUNCA hardcodeada. Solo si el rodeo no tiene
    // temporada asignada en el sistema se usa el año de la fecha como
    // respaldo mínimo (mismo comportamiento previo, ahora como fallback).
    // 4ª revisión: se guarda como registro histórico de creación, pero deja
    // de ser editable (ver CAMPOS_EDITABLES) — el frontend la muestra EN
    // VIVO desde `rodeo`, nunca desde esta columna.
    const temporadaNombre = rodeo?.temporadas?.nombre || (rodeo?.fecha ? rodeo.fecha.slice(0, 4) : null);

    // 4ª revisión (simplificar/evitar duplicación): `club_asociacion_organizador`
    // YA NO se auto-completa en cartillas nuevas — quedó redundante con
    // Asociación/Club, que se muestran EN VIVO desde `rodeo.asociacion`/
    // `rodeo.club` (ya viajan en la respuesta de este mismo POST y de GET
    // /rodeo/:rodeo_id). La columna se conserva para cartillas ya creadas
    // antes de este cambio (no se migra ni se borra su valor histórico).
    const { data: nueva, error } = await supabase
        .from('cartillas_delegado')
        .insert({
            rodeo_id:                   rodeoId,
            delegado_id:                uid,
            asignacion_id:              asig.id,
            temporada:                  temporadaNombre,
            fecha_rodeo:                rodeo?.fecha || null,
            delegado_nombre:            perfil?.nombre_completo || null,
            delegado_telefono:          perfil?.telefono        || null,
            tipo_rodeo:                 rodeo?.tipo_rodeo_nombre || null,
            creado_por:                 uid
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ cartilla: nueva, creada: true });
});

// ─── PATCH /api/usuario/cartilla-delegado/:id ────────────────────────────────
// Guarda borrador. Solo disponible si estado !== 'enviada'.
router.patch('/:id', async (req, res) => {
    const uid = req.usuario.id;

    const { data: cartilla } = await supabase
        .from('cartillas_delegado')
        .select('id, estado, delegado_id')
        .eq('id', req.params.id)
        .maybeSingle();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (cartilla.delegado_id !== uid) return res.status(403).json({ error: 'Sin permiso.' });
    if (['enviada', 'reenviada', 'aprobada'].includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada y no puede modificarse.' });
    }

    // Validación de rango 1.0–7.0 para las notas del desempeño del jurado
    // (Sección III, nuevo formato) — SIEMPRE, aunque el borrador esté
    // incompleto (aspectos ausentes son válidos; aspectos presentes fuera de
    // rango NO lo son). Misma validación exacta que en /enviar.
    if (req.body.respuestas_json?.desempeno_jurado !== undefined) {
        const chk = validarAspectosDesempeno(req.body.respuestas_json.desempeno_jurado);
        if (!chk.valido) return res.status(422).json({ error: chk.error, campos: chk.camposInvalidos });
    }

    const updates = { updated_at: new Date().toISOString(), actualizado_por: uid };
    CAMPOS_EDITABLES.forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
    });

    // Nota Promedio — calculada SIEMPRE que las 4 notas estén completas y
    // válidas (queda guardada dentro de respuestas_json.desempeno_jurado
    // para que la pantalla la recupere igual que cualquier otro campo). La
    // sincronización hacia rodeo_notas_secundarias.nota_delegado ocurre
    // SOLO al enviar (ver POST /:id/enviar) — nunca en cada guardado de
    // borrador, para no pisar el valor oficial mientras se sigue editando.
    if (updates.respuestas_json?.desempeno_jurado) {
        updates.respuestas_json.desempeno_jurado.nota_promedio =
            calcularPromedioDesempeno(updates.respuestas_json.desempeno_jurado);
    }

    const { data, error } = await supabase
        .from('cartillas_delegado')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ mensaje: 'Borrador guardado correctamente', cartilla: data });
});

// ─── POST /api/usuario/cartilla-delegado/:id/enviar ──────────────────────────
// Valida campos obligatorios y marca la cartilla como enviada.
router.post('/:id/enviar', async (req, res) => {
    const uid = req.usuario.id;

    const { data: cartilla } = await supabase
        .from('cartillas_delegado')
        .select('*')
        .eq('id', req.params.id)
        .maybeSingle();

    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (cartilla.delegado_id !== uid) return res.status(403).json({ error: 'Sin permiso.' });
    if (['enviada', 'reenviada', 'aprobada'].includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada.' });
    }

    // Combinar datos actuales con posibles datos del body
    const body   = req.body || {};
    const merged = { ...cartilla, ...body };

    // Validar campos mínimos requeridos
    const faltantes = CAMPOS_REQUERIDOS_ENVIO.filter(k => !merged[k] || String(merged[k]).trim() === '');
    if (faltantes.length > 0) {
        return res.status(422).json({
            error: `Faltan campos requeridos antes de enviar: ${faltantes.join(', ')}.`,
            faltantes
        });
    }

    // Rango 1.0–7.0 de las notas del desempeño del jurado — misma
    // validación que PATCH, defensa en profundidad final antes de enviar.
    const djMerged = merged.respuestas_json?.desempeno_jurado;
    if (djMerged !== undefined) {
        const chk = validarAspectosDesempeno(djMerged);
        if (!chk.valido) return res.status(422).json({ error: chk.error, campos: chk.camposInvalidos });
    }

    const ahora = new Date().toISOString();
    // Si estaba observada, pasar a reenviada; si no, pasar a enviada
    const esReenvio   = cartilla.estado === 'observada';
    const nuevoEstado = esReenvio ? 'reenviada' : 'enviada';

    // Registrar en historial
    const historial = Array.isArray(cartilla.historial_observaciones) ? [...cartilla.historial_observaciones] : [];
    if (esReenvio) {
        historial.push({ tipo: 'reenvio', fecha: ahora, por: 'delegado' });
    }

    const updates = {
        estado:                  nuevoEstado,
        enviada_en:              cartilla.enviada_en || ahora,
        updated_at:              ahora,
        actualizado_por:         uid,
        historial_observaciones: historial,
        ...(esReenvio ? { reenviada_en: ahora } : {})
    };
    // Guardar también cualquier campo del body enviado simultáneamente
    CAMPOS_EDITABLES.forEach(k => {
        if (body[k] !== undefined) updates[k] = body[k];
    });

    // Nota Promedio — se recalcula sobre los datos finales que se están
    // enviando (nunca sobre datos parciales de un guardado anterior).
    let notaPromedio = null;
    if (updates.respuestas_json?.desempeno_jurado) {
        notaPromedio = calcularPromedioDesempeno(updates.respuestas_json.desempeno_jurado);
        updates.respuestas_json.desempeno_jurado.nota_promedio = notaPromedio;
    }

    const { data, error } = await supabase
        .from('cartillas_delegado')
        .update(updates)
        .eq('id', req.params.id)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    // Sincronizar con rodeo_notas_secundarias.nota_delegado — MISMA fuente
    // que ya usan los reportes/exportaciones del sistema (ver services/
    // cartillaDelegadoNotas.js). Solo si las 4 notas quedaron completas y
    // válidas; si no, no se toca nada (la Nota Delegado existente, si la
    // hubiera, se preserva — nunca se sobrescribe con datos incompletos).
    let notaDelegadoSincronizada = false;
    if (notaPromedio !== null) {
        try {
            await sincronizarNotaDelegado(cartilla.rodeo_id, notaPromedio, uid);
            notaDelegadoSincronizada = true;
        } catch (errSync) {
            console.error('[CARTILLA-DELEGADO enviar] Error sincronizando Nota Delegado:', errSync.message);
            // No se revierte el envío de la cartilla por esto — el informe ya
            // quedó guardado; se informa igual en la respuesta para que el
            // delegado sepa que la Nota Delegado no llegó a sincronizarse.
        }
    }

    const msg = esReenvio ? 'Cartilla reenviada correctamente.' : 'Cartilla enviada correctamente.';
    res.json({ mensaje: msg, cartilla: data, nota_delegado_sincronizada: notaDelegadoSincronizada });
});

module.exports = router;
