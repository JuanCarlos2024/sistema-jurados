/**
 * /api/admin/analisis-preguntas
 *
 * Análisis estadístico de preguntas de capacitación.
 * Solo lectura. Montado en index.js bajo soloAdmin (heredado del padre).
 *
 * Requisito: ENABLE_ANALISIS_PREGUNTAS=true
 * Sin la variable: todos los endpoints responden 404.
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const supabase = require('../../config/supabase');

// ─── Feature flag ──────────────────────────────────────────────────────────────

function habilitado() {
    return process.env.ENABLE_ANALISIS_PREGUNTAS === 'true';
}

router.use((req, res, next) => {
    if (!habilitado()) {
        return res.status(404).json({ error: 'Módulo deshabilitado', lab_disabled: true });
    }
    next();
});

// ─── Constantes ────────────────────────────────────────────────────────────────

const PAGINA    = 900;   // Filas por página (offset y cursor)
const BLOQUE_IN = 200;   // UUIDs máximos por filtro .in() individual

// ─── Validación de UUID ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Normalización de texto ────────────────────────────────────────────────────

function norm(s) {
    if (s == null) return '';
    return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Fingerprint canónico SHA-256 ──────────────────────────────────────────────
//
// Se calcula desde el contenido actual de la pregunta y sus alternativas.
// El snapshot del intento se usa en la UI para mostrar el enunciado histórico,
// pero el fingerprint de agrupación debe ser estable y comparable entre pruebas.
//
// Limitación: si una pregunta fue editada después de algunos intentos, la huella
// actual puede no coincidir con la huella que habría tenido antes de la edición.

function calcularFingerprint(pregunta, altsOrdenadas) {
    const obj = {
        enunciado:       norm(pregunta.enunciado),
        tipo:            norm(pregunta.tipo),
        imagen_url:      norm(pregunta.imagen_url),
        video_url:       norm(pregunta.video_url),
        video_sin_audio: Boolean(pregunta.video_sin_audio),
        n_alternativas:  altsOrdenadas.length,
        alternativas:    altsOrdenadas
            .map(a => ({ texto: norm(a.texto), correcta: Boolean(a.es_correcta) }))
            .sort((a, b) => a.texto < b.texto ? -1 : a.texto > b.texto ? 1
                         : Number(b.correcta) - Number(a.correcta))
    };
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// ─── Paginación por offset+rango con fragmentación de .in() ───────────────────
//
// Para colecciones que pueden superar 1000 filas (alternativas, asignaciones,
// intentos). Cada bloque de IDs se pagina internamente con range/offset hasta
// agotar las filas. Nunca supone que una sola página es suficiente.

async function cargarEnBloques(tabla, selectStr, campo, ids, applyExtra) {
    if (!ids || ids.length === 0) return [];
    const fn = applyExtra || (q => q);
    const todas = [];

    for (let i = 0; i < ids.length; i += BLOQUE_IN) {
        const bloque = ids.slice(i, i + BLOQUE_IN);
        let offset   = 0;

        while (true) {
            const q = fn(
                supabase
                    .from(tabla)
                    .select(selectStr)
                    .in(campo, bloque)
                    .range(offset, offset + PAGINA - 1)
            );
            const { data, error } = await q;
            if (error) throw error;
            const filas = data || [];
            todas.push(...filas);
            if (filas.length < PAGINA) break;
            offset += PAGINA;
        }
    }
    return todas;
}

// Cargar todas las pruebas sin filtro de ID (para el listado /pruebas)
async function cargarTodas(tabla, selectStr, ordenarPor, asc) {
    const todas = [];
    let offset  = 0;
    while (true) {
        const { data, error } = await supabase
            .from(tabla)
            .select(selectStr)
            .order(ordenarPor, { ascending: asc })
            .range(offset, offset + PAGINA - 1);
        if (error) throw error;
        const filas = data || [];
        todas.push(...filas);
        if (filas.length < PAGINA) break;
        offset += PAGINA;
    }
    return todas;
}

// ─── Cursor keyset para capacitacion_respuestas ────────────────────────────────
//
// Selecciona alternativa_id (necesaria para calcular la alternativa incorrecta
// más elegida). Se fragmenta la lista de intentoIds en bloques de BLOQUE_IN
// para no generar URLs excesivamente largas en PostgREST.

async function cargarRespuestas(intentoIds) {
    if (!intentoIds || intentoIds.length === 0) return [];
    const todas = [];

    for (let i = 0; i < intentoIds.length; i += BLOQUE_IN) {
        const bloque  = intentoIds.slice(i, i + BLOQUE_IN);
        let ultimoId  = null;

        while (true) {
            let q = supabase
                .from('capacitacion_respuestas')
                .select('id, intento_id, pregunta_id, alternativa_id, es_correcta')
                .in('intento_id', bloque)
                .order('id', { ascending: true })
                .limit(PAGINA);

            if (ultimoId) q = q.gt('id', ultimoId);

            const { data, error } = await q;
            if (error) {
                console.error('[analisis-preguntas/cursor] error tras id=' + ultimoId, error.message);
                throw error;
            }
            const filas = data || [];
            todas.push(...filas);
            if (filas.length < PAGINA) break;
            ultimoId = filas[filas.length - 1].id;
        }
    }
    return todas;
}

// ─── Protección contra CSV/Excel formula injection ────────────────────────────

function csvCell(v) {
    const s = String(v ?? '');
    const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
    return '"' + safe.replace(/"/g, '""') + '"';
}

// ─── GET /pruebas ──────────────────────────────────────────────────────────────

router.get('/pruebas', async (req, res) => {
    try {
        const pruebas = await cargarTodas(
            'capacitacion_pruebas',
            'id, titulo, estado, fecha_inicio, fecha_fin, created_at',
            'created_at',
            false
        );

        if (pruebas.length === 0) return res.json([]);

        const pruebaIds = pruebas.map(p => p.id);

        const [preguntas, asigs] = await Promise.all([
            cargarEnBloques('capacitacion_preguntas', 'id, prueba_id, anulada', 'prueba_id', pruebaIds),
            cargarEnBloques('capacitacion_asignaciones', 'id, prueba_id', 'prueba_id', pruebaIds)
        ]);

        const asigIds = asigs.map(a => a.id);
        const intentos = await cargarEnBloques(
            'capacitacion_intentos',
            'id, asignacion_id, estado',
            'asignacion_id',
            asigIds,
            q => q.eq('estado', 'completado')
        );

        const cnts = {};
        const asigPrueba = {};
        asigs.forEach(a => { asigPrueba[a.id] = a.prueba_id; });

        preguntas.forEach(p => {
            if (!cnts[p.prueba_id]) cnts[p.prueba_id] = { preguntas: 0, anuladas: 0, intentosComp: 0 };
            cnts[p.prueba_id].preguntas++;
            if (p.anulada) cnts[p.prueba_id].anuladas++;
        });

        intentos.forEach(i => {
            const pid = asigPrueba[i.asignacion_id];
            if (!pid) return;
            if (!cnts[pid]) cnts[pid] = { preguntas: 0, anuladas: 0, intentosComp: 0 };
            cnts[pid].intentosComp++;
        });

        res.json(pruebas.map(p => ({
            id:                    p.id,
            titulo:                p.titulo,
            estado:                p.estado,
            fecha_inicio:          p.fecha_inicio,
            fecha_fin:             p.fecha_fin,
            created_at:            p.created_at,
            total_preguntas:       cnts[p.id]?.preguntas    || 0,
            preguntas_anuladas:    cnts[p.id]?.anuladas     || 0,
            intentos_completados:  cnts[p.id]?.intentosComp || 0
        })));
    } catch (err) {
        console.error('[analisis-preguntas/pruebas]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── GET /analizar ─────────────────────────────────────────────────────────────
//
// Parámetros de query:
//   pruebas     — UUIDs separados por coma (obligatorio, 1–10)
//   politica    — primero | ultimo | todos  (default: primero)
//   min_muestra — entero positivo (default: 5)
//
// Devuelve { resumen, tabla } donde cada fila de la tabla incluye
// el detalle por prueba y la distribución de alternativas incorrectas
// para que el frontend abra el modal sin hacer otra petición.

router.get('/analizar', async (req, res) => {
    try {
        // ── Validar parámetros ─────────────────────────────────────────────
        const rawPruebas = (req.query.pruebas || '').trim();
        if (!rawPruebas) {
            return res.status(400).json({ error: 'Parámetro "pruebas" obligatorio' });
        }

        const pruebaIds = rawPruebas.split(',').map(s => s.trim()).filter(Boolean);
        if (pruebaIds.length === 0 || pruebaIds.length > 10) {
            return res.status(400).json({ error: 'Indique entre 1 y 10 pruebas' });
        }
        for (const id of pruebaIds) {
            if (!UUID_RE.test(id)) {
                return res.status(400).json({ error: 'UUID inválido: ' + id });
            }
        }

        const POLITICAS = ['primero', 'ultimo', 'todos'];
        const politica  = req.query.politica || 'primero';
        if (!POLITICAS.includes(politica)) {
            return res.status(400).json({ error: 'politica debe ser: primero, ultimo o todos' });
        }

        const minMuestra = Math.max(1, parseInt(req.query.min_muestra || '5', 10) || 5);

        // ── 1. Pruebas ────────────────────────────────────────────────────
        const pruebas = await cargarEnBloques(
            'capacitacion_pruebas',
            'id, titulo, estado, fecha_inicio, fecha_fin',
            'id',
            pruebaIds
        );

        const pruebaMap = {};
        pruebas.forEach(p => { pruebaMap[p.id] = p; });

        const noEncontradas = pruebaIds.filter(id => !pruebaMap[id]);
        if (noEncontradas.length > 0) {
            return res.status(404).json({ error: 'Pruebas no encontradas: ' + noEncontradas.join(', ') });
        }

        // ── 2. Preguntas ──────────────────────────────────────────────────
        const preguntas = await cargarEnBloques(
            'capacitacion_preguntas',
            'id, prueba_id, enunciado, tipo, imagen_url, video_url, video_sin_audio, anulada, banco_pregunta_id, orden',
            'prueba_id',
            pruebaIds
        );

        const pregIds = preguntas.map(p => p.id);
        const pregMap = {};
        preguntas.forEach(p => { pregMap[p.id] = p; });

        // ── 3. Alternativas ───────────────────────────────────────────────
        const alternativas = await cargarEnBloques(
            'capacitacion_alternativas',
            'id, pregunta_id, texto, es_correcta, orden',
            'pregunta_id',
            pregIds
        );

        const altsMap = {};
        alternativas.forEach(a => {
            if (!altsMap[a.pregunta_id]) altsMap[a.pregunta_id] = [];
            altsMap[a.pregunta_id].push(a);
        });
        Object.values(altsMap).forEach(arr => arr.sort((a, b) => a.orden - b.orden));

        const altById = {};
        alternativas.forEach(a => { altById[a.id] = a; });

        // ── 4. Fingerprints para TODAS las preguntas ──────────────────────
        const fpPorPregId = {};
        preguntas.forEach(p => {
            fpPorPregId[p.id] = calcularFingerprint(p, altsMap[p.id] || []);
        });

        // ── 5. Detección de banco_pregunta_id con versiones divergentes ───
        const fpsPorBanco = {};
        preguntas.forEach(p => {
            if (!p.banco_pregunta_id) return;
            if (!fpsPorBanco[p.banco_pregunta_id]) fpsPorBanco[p.banco_pregunta_id] = new Set();
            fpsPorBanco[p.banco_pregunta_id].add(fpPorPregId[p.id]);
        });
        const bancoDivergente = new Set(
            Object.entries(fpsPorBanco)
                .filter(([, fps]) => fps.size > 1)
                .map(([bid]) => bid)
        );

        // ── 6. Clave de grupo para cada pregunta ──────────────────────────
        //
        // (a) banco + mismo fp → BANCO_<bid>
        // (b) banco + fp distinto → BANCOD_<bid>_<fp>  (divergente, sin fusión)
        // (c) sin banco + mismo fp → FP_<fp>

        function claveGrupo(p) {
            const fp  = fpPorPregId[p.id];
            const bid = p.banco_pregunta_id;
            if (bid && !bancoDivergente.has(bid)) return 'BANCO_' + bid;
            if (bid &&  bancoDivergente.has(bid)) return 'BANCOD_' + bid + '_' + fp;
            return 'FP_' + fp;
        }

        const grupos = {};
        preguntas.forEach(p => {
            const clave = claveGrupo(p);
            if (!grupos[clave]) {
                grupos[clave] = {
                    clave,
                    fingerprint:       fpPorPregId[p.id],
                    banco_pregunta_id: p.banco_pregunta_id || null,
                    tipo_agrupacion:   clave.startsWith('BANCOD') ? 'banco_divergente'
                                     : clave.startsWith('BANCO_') ? 'banco_exacto'
                                     : 'contenido',
                    anuladas_count:   0,
                    total_instancias: 0,
                    preguntas:        []
                };
            }
            grupos[clave].preguntas.push(p);
            grupos[clave].total_instancias++;
            if (p.anulada) grupos[clave].anuladas_count++;
        });

        Object.values(grupos).forEach(g => {
            g.es_anulada = g.anuladas_count === g.total_instancias;
        });

        // ── 7. Asignaciones ───────────────────────────────────────────────
        const asigs = await cargarEnBloques(
            'capacitacion_asignaciones',
            'id, prueba_id, usuario_pagado_id',
            'prueba_id',
            pruebaIds
        );

        const asigMap          = {};
        const asigIdsPorPrueba = {};
        asigs.forEach(a => {
            asigMap[a.id] = a;
            if (!asigIdsPorPrueba[a.prueba_id]) asigIdsPorPrueba[a.prueba_id] = [];
            asigIdsPorPrueba[a.prueba_id].push(a.id);
        });
        const todosAsigIds = asigs.map(a => a.id);

        // ── 8. Intentos completados ───────────────────────────────────────
        const todosIntentos = await cargarEnBloques(
            'capacitacion_intentos',
            'id, asignacion_id, estado, numero_intento, orden_preguntas_json, snapshot_contenido_json',
            'asignacion_id',
            todosAsigIds,
            q => q.eq('estado', 'completado').order('numero_intento', { ascending: true })
        );

        const intentosPorAsig = {};
        todosIntentos.forEach(i => {
            if (!intentosPorAsig[i.asignacion_id]) intentosPorAsig[i.asignacion_id] = [];
            intentosPorAsig[i.asignacion_id].push(i);
        });

        // ── 9. Selección de intentos según política ───────────────────────
        //
        // Política primero/ultimo: un intento por (usuario, prueba).
        // Política todos: todos los intentos completados.
        // Un usuario en múltiples pruebas seleccionadas NO se elimina de ninguna.

        const intentosSeleccionados = [];
        const marcados = new Set();

        for (const prueba_id of pruebaIds) {
            for (const asig_id of (asigIdsPorPrueba[prueba_id] || [])) {
                const uid   = asigMap[asig_id]?.usuario_pagado_id;
                const lista = intentosPorAsig[asig_id] || [];
                if (lista.length === 0) continue;

                if (politica === 'todos') {
                    lista.forEach(i => intentosSeleccionados.push({ ...i, prueba_id, usuario_id: uid }));
                } else {
                    const clave = uid + '|' + prueba_id;
                    if (marcados.has(clave)) continue;
                    marcados.add(clave);
                    const elegido = politica === 'ultimo' ? lista[lista.length - 1] : lista[0];
                    intentosSeleccionados.push({ ...elegido, prueba_id, usuario_id: uid });
                }
            }
        }

        const intentoIds = intentosSeleccionados.map(i => i.id);

        // ── 10. Respuestas — cursor keyset fragmentado ────────────────────
        const respuestas = await cargarRespuestas(intentoIds);

        const respMap = {};
        respuestas.forEach(r => {
            if (!respMap[r.intento_id]) respMap[r.intento_id] = {};
            respMap[r.intento_id][r.pregunta_id] = r;
        });

        // ── 11. Estadísticas por grupo ────────────────────────────────────
        //
        // Prioridad para preguntas esperadas:
        //   P1: orden_preguntas_json
        //   P2: claves de snapshot_contenido_json.preguntas
        //   P3: solo omisiones explícitas (incrementa indetTotal)

        const statsGrupo  = {};
        const altIncGrupo = {};
        let   indetTotal  = 0;

        for (const intento of intentosSeleccionados) {
            const resps = respMap[intento.id] || {};
            const snap  = intento.snapshot_contenido_json;
            const orden = intento.orden_preguntas_json;

            let pregIdsEsperadas = null;
            let indeterminable   = false;

            if (Array.isArray(orden) && orden.length > 0) {
                pregIdsEsperadas = orden.filter(id => pregMap[id]);
            } else if (snap?.preguntas && Object.keys(snap.preguntas).length > 0) {
                pregIdsEsperadas = Object.keys(snap.preguntas).filter(id => pregMap[id]);
            } else {
                indeterminable   = true;
                indetTotal++;
                pregIdsEsperadas = Object.keys(resps).filter(id => pregMap[id]);
            }

            const gruposEnIntento = new Set();
            for (const pregId of pregIdsEsperadas) {
                const p = pregMap[pregId];
                if (!p || p.anulada) continue;
                gruposEnIntento.add(claveGrupo(p));
            }

            for (const gClave of gruposEnIntento) {
                if (!statsGrupo[gClave]) {
                    statsGrupo[gClave] = {
                        participantes:        0,
                        correctas:            0,
                        incorrectas:          0,
                        omitidas:             0,
                        omisiones_implicitas: 0,
                        porPrueba:            {}
                    };
                    altIncGrupo[gClave] = {};
                }
                const eg  = statsGrupo[gClave];
                const pid = intento.prueba_id;
                if (!eg.porPrueba[pid]) {
                    eg.porPrueba[pid] = { participantes: 0, correctas: 0, incorrectas: 0, omitidas: 0 };
                }

                eg.participantes++;
                eg.porPrueba[pid].participantes++;

                const pregDelGrupo = pregIdsEsperadas.filter(pid2 => {
                    const p = pregMap[pid2];
                    return p && !p.anulada && claveGrupo(p) === gClave;
                });

                for (const pregId of pregDelGrupo) {
                    const resp = resps[pregId];

                    if (!resp) {
                        if (!indeterminable) {
                            eg.omitidas++;
                            eg.porPrueba[pid].omitidas++;
                            eg.omisiones_implicitas++;
                        }
                    } else if (resp.alternativa_id === null || resp.es_correcta === null) {
                        eg.omitidas++;
                        eg.porPrueba[pid].omitidas++;
                    } else if (resp.es_correcta === true) {
                        eg.correctas++;
                        eg.porPrueba[pid].correctas++;
                    } else {
                        eg.incorrectas++;
                        eg.porPrueba[pid].incorrectas++;
                        const altTextoNorm = resp.alternativa_id
                            ? norm(altById[resp.alternativa_id]?.texto || '')
                            : '(desconocida)';
                        altIncGrupo[gClave][altTextoNorm] =
                            (altIncGrupo[gClave][altTextoNorm] || 0) + 1;
                    }
                }
            }
        }

        // ── 12. Tabla de resultados ───────────────────────────────────────
        const tabla = [];
        let pregAnuladasTotal = 0;

        for (const [clave, grupo] of Object.entries(grupos)) {
            if (grupo.es_anulada) {
                pregAnuladasTotal += grupo.total_instancias;
                continue;
            }

            const eg = statsGrupo[clave] || {
                participantes: 0, correctas: 0, incorrectas: 0, omitidas: 0,
                omisiones_implicitas: 0, porPrueba: {}
            };

            const total      = eg.correctas + eg.incorrectas + eg.omitidas;
            const pctAcierto = total > 0 ? Math.round(eg.correctas   / total * 1000) / 10 : null;
            const pctError   = total > 0 ? Math.round(eg.incorrectas / total * 1000) / 10 : null;
            const pctOmision = total > 0 ? Math.round(eg.omitidas    / total * 1000) / 10 : null;

            const altIncEntries = Object.entries(altIncGrupo[clave] || {})
                .sort((a, b) => b[1] - a[1]);

            const pregRep = grupo.preguntas.find(p => !p.anulada) || grupo.preguntas[0];
            const altsRep = (altsMap[pregRep.id] || []).map(a => ({
                id:          a.id,
                texto:       a.texto,
                es_correcta: a.es_correcta,
                orden:       a.orden
            }));

            const pruebasConGrupo = [...new Set(grupo.preguntas.map(p => p.prueba_id))];

            const detallePorPrueba = Object.entries(eg.porPrueba).map(([prueba_id, s]) => {
                const t = s.correctas + s.incorrectas + s.omitidas;
                return {
                    prueba_id,
                    titulo:        pruebaMap[prueba_id]?.titulo || prueba_id,
                    participantes: s.participantes,
                    correctas:     s.correctas,
                    incorrectas:   s.incorrectas,
                    omitidas:      s.omitidas,
                    pct_acierto:   t > 0 ? Math.round(s.correctas   / t * 1000) / 10 : null,
                    pct_error:     t > 0 ? Math.round(s.incorrectas / t * 1000) / 10 : null,
                    pct_omision:   t > 0 ? Math.round(s.omitidas    / t * 1000) / 10 : null
                };
            });

            tabla.push({
                grupo_clave:             clave,
                fingerprint:             grupo.fingerprint,
                banco_pregunta_id:       grupo.banco_pregunta_id,
                tipo_agrupacion:         grupo.tipo_agrupacion,
                enunciado:               pregRep.enunciado,
                tipo:                    pregRep.tipo,
                imagen_url:              pregRep.imagen_url || null,
                video_url:               pregRep.video_url  || null,
                alternativas:            altsRep,
                pruebas_ids:             pruebasConGrupo,
                pruebas_titulos:         pruebasConGrupo.map(id => pruebaMap[id]?.titulo || id),
                participantes:           eg.participantes,
                correctas:               eg.correctas,
                incorrectas:             eg.incorrectas,
                omitidas:                eg.omitidas,
                omisiones_implicitas:    eg.omisiones_implicitas || 0,
                items_considerados:      eg.correctas + eg.incorrectas + eg.omitidas,
                respuestas_registradas:  (eg.correctas + eg.incorrectas + eg.omitidas) - (eg.omisiones_implicitas || 0),
                pct_acierto:             pctAcierto,
                pct_error:               pctError,
                pct_omision:             pctOmision,
                muestra_baja:            eg.participantes < minMuestra,
                alt_incorrecta_top:      altIncEntries[0]?.[0] || null,
                alt_incorrecta_top_n:    altIncEntries[0]?.[1] || 0,
                distribucion_incorrectas: altIncEntries.map(([texto, count]) => ({ texto, count })),
                detalle_por_prueba:      detallePorPrueba
            });
        }

        // ── 13. Resumen ejecutivo ────────────────────────────────────────
        const participantesUnicos = new Set(intentosSeleccionados.map(i => i.usuario_id)).size;

        const resumen = {
            pruebas_seleccionadas:           pruebaIds.length,
            pruebas:                         pruebas.map(p => ({ id: p.id, titulo: p.titulo, estado: p.estado })),
            politica_intentos:               politica,
            min_muestra:                     minMuestra,
            participantes_unicos:            participantesUnicos,
            intentos_considerados:           intentosSeleccionados.length,
            grupos_preguntas:                tabla.length,
            preguntas_activas_total:         preguntas.filter(p => !p.anulada).length,
            preguntas_anuladas_excluidas:    pregAnuladasTotal,
            grupos_banco_divergente:         tabla.filter(r => r.tipo_agrupacion === 'banco_divergente').length,
            respuestas_registradas:          respuestas.length,
            correctas_total:                 tabla.reduce((a, r) => a + r.correctas, 0),
            incorrectas_total:               tabla.reduce((a, r) => a + r.incorrectas, 0),
            omitidas_total:                  tabla.reduce((a, r) => a + r.omitidas, 0),
            omisiones_implicitas_total:      tabla.reduce((a, r) => a + r.omisiones_implicitas, 0),
            items_considerados_total:        tabla.reduce((a, r) => a + r.items_considerados, 0),
            intentos_sin_orden_determinable: indetTotal,
            generado_en:                     new Date().toISOString(),
            aviso_es_correcta: 'Contenido reconstruido desde el intento histórico. ' +
                'La clasificación correcta/incorrecta corresponde a la corrección vigente ' +
                'en el sistema, no necesariamente a la del momento en que se rindió la prueba.'
        };

        res.json({ resumen, tabla });

    } catch (err) {
        console.error('[analisis-preguntas/analizar]', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
        res.status(500).json({ error: err.message });
    }
});

module.exports         = router;
module.exports.csvCell = csvCell;
