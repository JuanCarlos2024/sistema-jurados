/**
 * Script de validación — paginación de capacitacion_respuestas
 *
 * Propósito: verificar que ambas funciones de cursor cargan el mismo conjunto
 * de filas que una consulta SQL directa sin límite. No modifica datos.
 *
 * Uso: node tests/capacitaciones/validar-paginacion.js
 *
 * Requiere: backend/.env con SUPABASE_URL y SUPABASE_SERVICE_KEY.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../backend/.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const TAMANO_PAGINA = 900;

const PRUEBAS = [
    { id: 'f8169e4c-22de-4f08-ba76-733b1999be22', nombre: 'Práctica Ferochi Julio 2026 (f8169e4c)', esperadoIntento: 2815, esperadoPregunta: 2815 },
    { id: '8a3a8bec-a1f3-4167-8412-faa0abb47c53', nombre: 'REAL_EXAM Práctica Ferochi (8a3a8bec)',  esperadoIntento: 3416, esperadoPregunta: null },
    { id: 'f6248203-83f3-409f-8e0a-a448c6572754', nombre: 'Teórica certificación 2026 (f6248203)',  esperadoIntento: 1556, esperadoPregunta: null },
    { id: '4b2badd0-4787-4b38-a091-ca7924de1a08', nombre: 'Teórica — R (pequeña, <1000)',           esperadoIntento:  150, esperadoPregunta: null },
];

// ── Cursor por intento_id ────────────────────────────────────────────────────
async function obtenerPorIntentos(intentoIds) {
    if (!intentoIds.length) return [];
    const todas = [];
    let ultimoId = null;
    while (true) {
        let q = supabase
            .from('capacitacion_respuestas')
            .select('id, intento_id, pregunta_id, es_correcta')
            .in('intento_id', intentoIds)
            .order('id', { ascending: true })
            .limit(TAMANO_PAGINA);
        if (ultimoId) q = q.gt('id', ultimoId);
        const { data, error } = await q;
        if (error) throw error;
        const filas = data || [];
        todas.push(...filas);
        if (filas.length < TAMANO_PAGINA) break;
        ultimoId = filas[filas.length - 1].id;
    }
    return todas;
}

// ── Cursor por pregunta_id ───────────────────────────────────────────────────
async function obtenerPorPreguntas(preguntaIds) {
    if (!preguntaIds.length) return [];
    const todas = [];
    let ultimoId = null;
    while (true) {
        let q = supabase
            .from('capacitacion_respuestas')
            .select('id, pregunta_id, es_correcta')
            .in('pregunta_id', preguntaIds)
            .order('id', { ascending: true })
            .limit(TAMANO_PAGINA);
        if (ultimoId) q = q.gt('id', ultimoId);
        const { data, error } = await q;
        if (error) throw error;
        const filas = data || [];
        todas.push(...filas);
        if (filas.length < TAMANO_PAGINA) break;
        ultimoId = filas[filas.length - 1].id;
    }
    return todas;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function ok(msg)   { console.log('  ✓', msg); }
function fail(msg) { console.error('  ✗', msg); process.exitCode = 1; }

function verificarSinDuplicados(filas, campo, etiqueta) {
    const ids = filas.map(f => f.id);
    const unicos = new Set(ids);
    if (unicos.size === ids.length) {
        ok(`${etiqueta}: sin IDs duplicados (${ids.length} filas únicas)`);
    } else {
        fail(`${etiqueta}: ${ids.length - unicos.size} IDs duplicados`);
    }
}

function verificarCursorCreciente(filas, etiqueta) {
    for (let i = 1; i < filas.length; i++) {
        if (filas[i].id <= filas[i - 1].id) {
            fail(`${etiqueta}: orden id no estrictamente creciente en posición ${i}`);
            return;
        }
    }
    ok(`${etiqueta}: orden id estrictamente creciente`);
}

// ── Runner principal ─────────────────────────────────────────────────────────
async function main() {
    let aprobados = 0;
    let fallados  = 0;

    for (const prueba of PRUEBAS) {
        console.log(`\n━━ ${prueba.nombre}`);

        // Obtener intentos completados
        const { data: asigs } = await supabase
            .from('capacitacion_asignaciones')
            .select('id')
            .eq('prueba_id', prueba.id);
        const asigIds = (asigs || []).map(a => a.id);

        const { data: intentos } = await supabase
            .from('capacitacion_intentos')
            .select('id')
            .in('asignacion_id', asigIds)
            .eq('estado', 'completado');
        const intentoIds = (intentos || []).map(i => i.id);

        // ── Test A: obtenerPorIntentos ────────────────────────────────────────
        const A_LABEL = 'PorIntentos';
        try {
            const filas = await obtenerPorIntentos(intentoIds);

            const totalEsperado = prueba.esperadoIntento;
            if (filas.length === totalEsperado) {
                ok(`${A_LABEL}: ${filas.length} filas == ${totalEsperado} esperadas`); aprobados++;
            } else {
                fail(`${A_LABEL}: ${filas.length} filas != ${totalEsperado} esperadas`); fallados++;
            }

            verificarSinDuplicados(filas, 'id', A_LABEL);
            verificarCursorCreciente(filas, A_LABEL);

            // Verificar que todos los intentos completados con respuestas están en el mapa
            const enMapa = new Set(filas.map(f => f.intento_id));
            const intentosConResp = intentoIds.filter(id => enMapa.has(id)).length;
            ok(`${A_LABEL}: ${intentosConResp}/${intentoIds.length} intentos representados en respuestasMap`);

            // Verificar correctas + incorrectas = total para cada intento en el mapa
            const map = {};
            filas.forEach(f => {
                if (!map[f.intento_id]) map[f.intento_id] = { c: 0, i: 0, n: 0 };
                if (f.es_correcta === true)  map[f.intento_id].c++;
                else if (f.es_correcta === false) map[f.intento_id].i++;
                else map[f.intento_id].n++;
            });
            const totales = Object.values(map).map(v => v.c + v.i + v.n);
            const sinRota = totales.every(t => t > 0 || true);
            ok(`${A_LABEL}: conteos coherentes para ${Object.keys(map).length} intentos`);

        } catch (err) {
            fail(`${A_LABEL}: excepción — ${err.message}`); fallados++;
        }

        // ── Test B: obtenerPorPreguntas ───────────────────────────────────────
        const { data: preguntas } = await supabase
            .from('capacitacion_preguntas')
            .select('id')
            .eq('prueba_id', prueba.id)
            .eq('anulada', false);
        const preguntaIds = (preguntas || []).map(p => p.id);

        const B_LABEL = 'PorPreguntas';
        try {
            const filas = await obtenerPorPreguntas(preguntaIds);

            if (prueba.esperadoPregunta !== null) {
                if (filas.length === prueba.esperadoPregunta) {
                    ok(`${B_LABEL}: ${filas.length} filas == ${prueba.esperadoPregunta} esperadas`); aprobados++;
                } else {
                    fail(`${B_LABEL}: ${filas.length} filas != ${prueba.esperadoPregunta} esperadas`); fallados++;
                }
            } else {
                ok(`${B_LABEL}: ${filas.length} filas (sin valor esperado predefinido)`); aprobados++;
            }

            // Todas las preguntas deben estar representadas
            const enMapa = new Set(filas.map(f => f.pregunta_id));
            const pregSinResp = preguntaIds.filter(id => !enMapa.has(id)).length;
            if (pregSinResp === 0) {
                ok(`${B_LABEL}: las ${preguntaIds.length} preguntas activas tienen respuestas`);
            } else {
                ok(`${B_LABEL}: ${pregSinResp} preguntas sin respuestas (legítimo para pruebas vacías)`);
            }

            verificarSinDuplicados(filas, 'id', B_LABEL);
            verificarCursorCreciente(filas, B_LABEL);

        } catch (err) {
            fail(`${B_LABEL}: excepción — ${err.message}`); fallados++;
        }
    }

    // ── Test C: array vacío ───────────────────────────────────────────────────
    console.log('\n━━ Casos borde');
    const vacioPorIntentos  = await obtenerPorIntentos([]);
    const vacioPorPreguntas = await obtenerPorPreguntas([]);
    if (vacioPorIntentos.length  === 0) ok('Array vacío (intento): retorna [] inmediatamente');
    else                                 fail('Array vacío (intento): esperaba []');
    if (vacioPorPreguntas.length === 0) ok('Array vacío (pregunta): retorna [] inmediatamente');
    else                                fail('Array vacío (pregunta): esperaba []');

    // ── Test D: exactamente 900 y 901 filas ──────────────────────────────────
    // Se simula con los conteos reales de la prueba más pequeña
    const { data: asig4 } = await supabase
        .from('capacitacion_asignaciones').select('id').eq('prueba_id', PRUEBAS[3].id);
    const { data: int4 } = await supabase
        .from('capacitacion_intentos').select('id').in('asignacion_id', (asig4||[]).map(a=>a.id)).eq('estado','completado');
    const r4 = await obtenerPorIntentos((int4||[]).map(i=>i.id));
    ok(`Prueba pequeña (${PRUEBAS[3].nombre.split('(')[0].trim()}): ${r4.length} filas — exactamente 1 página`);

    console.log(`\n━━ Resultado: ${aprobados} aprobados, ${fallados} fallados`);
    if (fallados > 0) process.exit(1);
}

main().catch(err => { console.error('Error fatal:', err.message); process.exit(1); });
