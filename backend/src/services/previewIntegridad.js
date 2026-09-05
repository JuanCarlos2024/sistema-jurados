// ═════════════════════════════════════════════════════════════════════════
// Propuesta de Designación — Etapa 4: integridad del PREVIEW (edición antes
// de guardar el borrador).
//
// Esto NO es autenticación — el acceso a cualquier endpoint sigue exigiendo
// un JWT de administrador válido (soloRolEvaluacion() en el router, sin
// cambios). Esto es solo una firma de integridad sobre el snapshot INMUTABLE
// que produjo el motor en el dry-run (temporada, rodeos, jurado_id_propuesto
// original por rodeo, estado original) — para que, mientras el administrador
// edita en memoria del navegador sin nada guardado en BD, el backend pueda
// detectar si ese snapshot original fue alterado antes de llegar de vuelta
// (al pedir candidatos, al seleccionar, o al guardar), sin tener que
// persistir nada en la base de datos durante el preview.
//
// ─── QUÉ DEMUESTRA EL TOKEN Y QUÉ NO ────────────────────────────────────
// El token demuestra "el motor originalmente propuso X para este rodeo,
// en esta corrida" — un hecho histórico, congelado en el momento del
// dry-run. NO demuestra ni exige que X siga siendo válido o que el motor
// lo seguiría eligiendo si se corriera de nuevo — eso es responsabilidad
// de la revalidación EN VIVO (ver POST /propuestas), que evalúa si la
// selección ACTUAL sigue cumpliendo las reglas duras, no si coincide con
// el ranking original. Separar estos dos conceptos es intencional: el
// snapshot es para integridad/auditoría del histórico, la revalidación es
// para permisos de la decisión actual.
//
// ─── FIRMADO, NO CIFRADO ──────────────────────────────────────────────
// El payload va en base64url plano — cualquiera con el token (el propio
// administrador autenticado que lo recibió) puede decodificarlo y leerlo.
// La firma HMAC solo garantiza que NO fue alterado, no lo oculta. Por eso
// el snapshot contiene exclusivamente identificadores y enums ya visibles
// en la propia pantalla de dry-run — nunca nada sensible:
//   v (versión del formato), temporada_id, y por rodeo: rodeo_id, estado
//   ('PROPUESTO'|'SIN_PROPUESTA'|'NO_EVALUABLE'), jurado_id_propuesto.
// Ningún password, secreto, JWT, service key, email, ni ningún dato que no
// esté ya expuesto en la respuesta del propio dry-run.
//
// ─── FIRMA HMAC con separación de dominio ─────────────────────────────
// Reutiliza JWT_SECRET (ya existente, ya usado exclusivamente en backend)
// como clave — evita introducir un segundo secreto que gestionar sin
// necesidad real. Para que esta firma nunca pueda confundirse ni
// reutilizarse con la de otro propósito futuro que también use JWT_SECRET
// como clave, el payload se firma con un prefijo de dominio explícito
// (HMAC(clave, "propuesta-designacion-preview-v1:" + payload)) — un token
// firmado para este propósito nunca es válido para otro contexto y
// viceversa, aunque compartan la misma clave.
// ═════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const SECRETO = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';
const DOMINIO = 'propuesta-designacion-preview-v1:';
const VERSION_SNAPSHOT = 1;

function calcularFirma(payloadB64) {
    return crypto.createHmac('sha256', SECRETO).update(DOMINIO + payloadB64).digest('hex');
}

// ─── Firma un snapshot inmutable del resultado original del motor ────────
// @param snapshot { temporada_id, rodeos: [{ rodeo_id, estado, jurado_id_propuesto }] }
// @returns preview_token (string opaco, firmado — no cifrado)
function firmarPreview(snapshot) {
    const payload = {
        v: VERSION_SNAPSHOT,
        temporada_id: snapshot.temporada_id ?? null,
        rodeos: (snapshot.rodeos || []).map(r => ({
            rodeo_id: r.rodeo_id,
            estado: r.estado,
            jurado_id_propuesto: r.jurado_id_propuesto ?? null
        }))
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${payloadB64}.${calcularFirma(payloadB64)}`;
}

// ─── Verifica un preview_token y devuelve el snapshot original ────────────
// Nunca lanza — cualquier entrada malformada (token ausente, sin separador,
// firma de largo distinto, base64 inválido, JSON inválido, versión
// desconocida) devuelve null de forma controlada, nunca una excepción sin
// capturar. La comparación de firma es en tiempo constante
// (crypto.timingSafeEqual), y SIEMPRE se verifica el largo de ambos buffers
// antes de llamarla (timingSafeEqual lanza si los largos difieren).
// @returns snapshot { temporada_id, rodeos: [...] } | null si es inválido/alterado
function verificarPreviewToken(token) {
    if (!token || typeof token !== 'string') return null;
    const idx = token.lastIndexOf('.');
    if (idx <= 0 || idx === token.length - 1) return null;

    const payloadB64 = token.slice(0, idx);
    const firmaRecibida = token.slice(idx + 1);
    const firmaEsperada = calcularFirma(payloadB64);

    const bufRecibida = Buffer.from(firmaRecibida, 'utf8');
    const bufEsperada = Buffer.from(firmaEsperada, 'utf8');
    if (bufRecibida.length !== bufEsperada.length) return null; // evita que timingSafeEqual lance por largos distintos
    if (!crypto.timingSafeEqual(bufRecibida, bufEsperada)) return null;

    try {
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        if (payload.v !== VERSION_SNAPSHOT || !Array.isArray(payload.rodeos)) return null;
        return payload;
    } catch {
        return null;
    }
}

// ─── Mapa rodeo_id → { estado, jurado_id_propuesto } del snapshot ─────────
// Utilidad para los endpoints — evita repetir el .find()/.reduce() en cada uno.
function mapaPorRodeo(snapshot) {
    const mapa = new Map();
    for (const r of (snapshot?.rodeos || [])) mapa.set(r.rodeo_id, r);
    return mapa;
}

module.exports = { firmarPreview, verificarPreviewToken, mapaPorRodeo };
