// ═════════════════════════════════════════════════════════════════════════
// Colleras completas ACTUALES con respaldo en el último snapshot válido.
//
// NO hay un segundo scraping: se reutiliza obtenerCollerasCompletas()
// (services/colleras-completas.js). La fuente externa NO puede bloquear el
// informe: se aplica un timeout propio; si falla se usa el último snapshot
// con estado_fuente 'OK'; si tampoco hay, se informa 'no_disponible'.
//
// Este módulo NO inserta snapshots por sí solo: guardarSnapshot() existe para
// una fase posterior y no está conectado a ninguna ruta.
// ═════════════════════════════════════════════════════════════════════════
const supabase = require('../../config/supabase');
const { obtenerCollerasCompletas } = require('../colleras-completas');
const CONFIG = require('./config');
const { hoyChile } = require('./fechasEquivalentes');

function conTimeout(promesa, ms) {
    let t;
    const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`Tiempo de espera agotado (${ms} ms) consultando la fuente de colleras completas`)), ms); });
    return Promise.race([promesa, limite]).finally(() => clearTimeout(t));
}

async function ultimoSnapshotValido(db) {
    const { data, error } = await db.from('colleras_completas_snapshots')
        .select('fecha_snapshot, total_colleras, temporada, fuente')
        .eq('estado_fuente', 'OK')
        .order('fecha_snapshot', { ascending: false })
        .limit(1);
    if (error) throw new Error(error.message);
    return (data && data[0]) || null;
}

async function obtenerCollerasActuales({ obtenerFn = obtenerCollerasCompletas, db = supabase, ahora = () => new Date(), timeoutMs = CONFIG.COLLERAS_SNAPSHOT_TIMEOUT_MS } = {}) {
    let detalleError;
    try {
        const r = await conTimeout(obtenerFn(), timeoutMs);
        const total = r && r.resumen ? r.resumen.totalCompletas : null;
        if (typeof total !== 'number' || !Number.isFinite(total)) throw new Error('La fuente respondió sin totalCompletas numérico');
        return {
            total,
            fechaDato: ahora().toISOString(),
            fuente: 'en_vivo',
            estado: 'actual',
            resumen: r.resumen,
            detalle_error: null
        };
    } catch (e) {
        detalleError = e.message;
    }
    try {
        const snap = await ultimoSnapshotValido(db);
        if (snap) {
            return {
                total: snap.total_colleras,
                fechaDato: snap.fecha_snapshot,
                fuente: 'snapshot',
                estado: 'fallback',
                resumen: null,
                detalle_error: detalleError
            };
        }
        return { total: null, fechaDato: null, fuente: 'ninguna', estado: 'no_disponible', resumen: null, detalle_error: `${detalleError} · Sin snapshot válido de respaldo` };
    } catch (e) {
        return { total: null, fechaDato: null, fuente: 'ninguna', estado: 'no_disponible', resumen: null, detalle_error: `${detalleError} · Snapshot no disponible: ${e.message}` };
    }
}

// Fila lista para insertar en colleras_completas_snapshots (función pura).
function construirSnapshot(datos, temporada, ahora = new Date()) {
    const ok = datos && datos.estado === 'actual' && typeof datos.total === 'number';
    return {
        fecha_snapshot: (ok ? datos.fechaDato : ahora.toISOString()),
        temporada,
        total_colleras: ok ? datos.total : null,
        fuente: 'gestionderodeos.cl',
        estado_fuente: ok ? 'OK' : 'ERROR',
        detalle_error: ok ? null : (datos && datos.detalle_error) || 'Sin dato de la fuente'
    };
}

// Solo insertar snapshots reales de la fuente en vivo (nunca reinsertar un fallback).
async function guardarSnapshot(datos, temporada, { db = supabase, ahora = new Date() } = {}) {
    const fila = construirSnapshot(datos, temporada, ahora);
    const { data, error } = await db.from('colleras_completas_snapshots').insert(fila).select().single();
    if (error) throw new Error('No se pudo guardar el snapshot: ' + error.message);
    return data;
}

// Operación EXPLÍCITA (POST /colleras/snapshot, solo administrador): consulta la fuente REAL y guarda un
// snapshot. Reglas:
//   1. fuente OK  → guarda, salvo que ya exista un snapshot válido del MISMO día (Chile) → no duplica;
//   2. fuente falla → NO guarda nada (un fallback nunca se guarda como dato nuevo) y devuelve el último conocido;
//   3. nunca se llama desde la carga del informe: no bloquea ni se dispara al refrescar la pantalla.
async function temporadaDelDia(db, hoy) {
    try {
        const { data } = await db.from('temporadas').select('nombre').lte('fecha_inicio', hoy).gte('fecha_fin', hoy).limit(1);
        return data && data[0] ? data[0].nombre : null;
    } catch { return null; }
}

async function registrarSnapshot({ obtenerFn = obtenerCollerasCompletas, db = supabase, ahora = () => new Date(), timeoutMs = CONFIG.COLLERAS_SNAPSHOT_TIMEOUT_MS } = {}) {
    const hoy = hoyChile(ahora());
    let total = null, detalleFuente = null;
    try {
        const r = await conTimeout(obtenerFn(), timeoutMs);
        total = r && r.resumen ? r.resumen.totalCompletas : null;
        if (typeof total !== 'number' || !Number.isFinite(total)) { total = null; throw new Error('La fuente respondió sin totalCompletas numérico'); }
    } catch (e) { detalleFuente = e.message; }

    let ultimo = null, detalleUltimo = null;
    try { ultimo = await ultimoSnapshotValido(db); } catch (e) { detalleUltimo = e.message; }

    if (total === null) {
        return { guardado: false, motivo: 'FUENTE_NO_DISPONIBLE', detalle_error: detalleFuente, ultimo_snapshot: ultimo, detalle_ultimo_snapshot: detalleUltimo };
    }
    if (ultimo && hoyChile(new Date(ultimo.fecha_snapshot)) === hoy) {
        return { guardado: false, motivo: 'YA_EXISTE_SNAPSHOT_VALIDO_DEL_DIA', total_fuente: total, snapshot: ultimo, ultimo_snapshot: ultimo };
    }
    const temporada = await temporadaDelDia(db, hoy);
    const guardado = await guardarSnapshot({ estado: 'actual', total, fechaDato: ahora().toISOString() }, temporada, { db, ahora: ahora() });
    return { guardado: true, motivo: 'SNAPSHOT_GUARDADO', total_fuente: total, snapshot: guardado, ultimo_snapshot: guardado };
}

// Fecha (YYYY-MM-DD, Chile) del dato para comparar con el histórico.
function fechaDatoISO(datos) {
    if (!datos || !datos.fechaDato) return null;
    return hoyChile(new Date(datos.fechaDato));
}

module.exports = { conTimeout, obtenerCollerasActuales, construirSnapshot, guardarSnapshot, registrarSnapshot, fechaDatoISO };
