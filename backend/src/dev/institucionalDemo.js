// ─────────────────────────────────────────────────────────────────────────
// MODO DEMOSTRACIÓN — namespace institucional completo con datos ficticios
// (Fase 2.5). Permite revisar visualmente el Portal de Delegados de
// Asociación SIN que existan las tablas reales (migraciones 061-064 aún no
// aplicadas en producción) y SIN tocar Supabase en absoluto.
//
// Este router REEMPLAZA por completo a routes/institucional/index.js cuando
// está activo — nunca coexisten montados al mismo tiempo (ver app.js). No
// importa `config/supabase`, no importa ningún servicio real: es 100%
// autocontenido con los datos de institucionalDemoDatos.js.
//
// Doble guardia de producción (la primera, más fuerte, está en app.js: este
// archivo ni siquiera se `require()` si NODE_ENV==='production'): acá se
// repite la verificación por si este módulo se importara desde otro lugar
// en el futuro — nunca debe exportar un router funcional en producción.
// ─────────────────────────────────────────────────────────────────────────
const express = require('express');
const jwt = require('jsonwebtoken');

if (process.env.NODE_ENV === 'production') {
    throw new Error('institucionalDemo.js no debe cargarse nunca con NODE_ENV=production');
}

const { DEMO_PASSWORD, CUENTAS, DELEGADOS_POR_ASOCIACION, TEMPORADA_DEMO, RODEOS_POR_ASOCIACION, JURADOS_DEMO_POR_RODEO } = require('./institucionalDemoDatos');
// Fase 3.4 — "Descargar PDF": mismo generador real que usa el administrador
// (no es Supabase, es una función pura sobre objetos planos) — funciona
// igual en modo demostración, sin ningún mock ni diseño paralelo.
const { generarCartillaDelegadoPDF } = require('../services/cartilla-delegado-pdf');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';
const router = express.Router();

function generarTokenDemo(cuenta) {
    return jwt.sign({
        id: cuenta.id,
        tipo: 'cuenta_institucional',
        rol_institucional: cuenta.rol_institucional,
        asociacion_id: cuenta.asociacion_id,
        asociacion_nombre: cuenta.asociacion_nombre,
        primer_login: cuenta.primer_login,
        demo: true // marca explícita: cualquiera que inspeccione el token ve que es ficticio
    }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

function cuentaPorId(id) {
    return Object.values(CUENTAS).find(c => c.id === id) || null;
}

// Mismo middleware "ligero" que el real en forma (verifica JWT + tipo), pero
// SIN tocar Supabase — la "revalidación" es contra el objeto en memoria.
function soloCuentaInstitucionalDemo(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
    if (payload.tipo !== 'cuenta_institucional') {
        return res.status(403).json({ error: 'Acceso restringido a cuentas institucionales' });
    }
    const cuenta = cuentaPorId(payload.id);
    if (!cuenta || !cuenta.activo) {
        return res.status(401).json({ error: 'Sesión inválida: la cuenta institucional ya no está activa' });
    }
    req.usuario = payload;
    req.cuentaDemo = cuenta;
    next();
}

// ── Auth ───────────────────────────────────────────────────────────────
router.post('/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son requeridos' });

    const cuenta = CUENTAS[email.trim().toLowerCase()];
    if (!cuenta || password !== DEMO_PASSWORD) {
        return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = generarTokenDemo(cuenta);
    res.json({
        token,
        usuario: {
            id: cuenta.id,
            tipo: 'cuenta_institucional',
            rol_institucional: cuenta.rol_institucional,
            asociacion_id: cuenta.asociacion_id,
            asociacion_nombre: cuenta.asociacion_nombre,
            email,
            primer_login: cuenta.primer_login
        }
    });
});

router.post('/auth/cambiar-password', soloCuentaInstitucionalDemo, (req, res) => {
    const { password_nueva } = req.body;
    if (!password_nueva || password_nueva.length < 8) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    }
    // No persiste nada real (en memoria, se pierde al reiniciar) — suficiente
    // para probar visualmente el flujo de "primer ingreso".
    req.cuentaDemo.primer_login = false;
    res.json({ mensaje: 'Contraseña actualizada correctamente (DEMOSTRACIÓN — no se guardó en ninguna base de datos)' });
});

// ── Delegados ──────────────────────────────────────────────────────────
router.get('/delegados', soloCuentaInstitucionalDemo, (req, res) => {
    const delegados = DELEGADOS_POR_ASOCIACION[req.usuario.asociacion_id] || [];
    res.json({ delegados, asociacion_id: req.usuario.asociacion_id });
});

router.post('/delegados/seleccionar', soloCuentaInstitucionalDemo, (req, res) => {
    const { delegado_id } = req.body;
    if (!delegado_id) return res.status(400).json({ error: 'delegado_id es requerido' });
    const delegado = (DELEGADOS_POR_ASOCIACION[req.usuario.asociacion_id] || []).find(d => d.id === delegado_id);
    if (!delegado) return res.status(403).json({ error: 'Delegado no válido para esta asociación' });
    res.json({ delegado });
});

// ── Fase 3.3/3.5 — selección (y, desde 3.5, CONFIRMACIÓN) institucional por
// rodeo (en memoria). Mismo rol que la tabla real rodeos_delegado_institucional
// (migraciones 068/069): como máximo UNA fila por rodeo, y desde que existe,
// es INMUTABLE por esta vía (solo el reemplazo autorizado, simulado más abajo,
// puede cambiarla) — independiente de cartillasDemoPorRodeo (declarada más
// abajo). rodeo_id -> { delegado_asociacion_id, nombre }.
const seleccionDelegadoPorRodeoDemo = {};

// ── Fase 3.5 — Historial de Responsables (en memoria) ───────────────────
// Mismo rol que la consulta real a `auditoria` (ver
// services/historialResponsableInstitucional.js): nunca se fabrica un evento
// que no fue "registrado" por una acción real de este router — cada entrada
// se agrega SOLO cuando la acción correspondiente efectivamente ocurre.
// rodeo_id -> [{ accion, descripcion, created_at }], siempre en orden
// cronológico de inserción (coincide con orden ascendente por created_at).
const historialDemoPorRodeo = {};
function registrarEventoHistorialDemo(rodeoId, accion, descripcion) {
    if (!historialDemoPorRodeo[rodeoId]) historialDemoPorRodeo[rodeoId] = [];
    historialDemoPorRodeo[rodeoId].push({ accion, descripcion, created_at: new Date().toISOString() });
}
// Fuente única de "¿hay ya un responsable confirmado para este rodeo?" — una
// selección explícita (vía seleccionar-delegado) o, si no la hay pero YA
// existe una cartilla (dato pre-sembrado), la autoría de esa cartilla cuenta
// como la confirmación implícita que debió existir para poder crearla.
function responsableConfirmadoDemo(rodeoId) {
    if (seleccionDelegadoPorRodeoDemo[rodeoId]) return seleccionDelegadoPorRodeoDemo[rodeoId];
    const cartilla = cartillasDemoPorRodeo[rodeoId];
    if (cartilla?.delegado_asociacion_id) {
        return { delegado_asociacion_id: cartilla.delegado_asociacion_id, nombre: cartilla.delegado_nombre };
    }
    return null;
}

// ── Rodeos ─────────────────────────────────────────────────────────────
// Fase 3.1/3.3: tipo_delegado/nombre_delegado/cartilla_institucional_disponible
// espejean exactamente los mismos criterios de institucional/rodeos.js contra
// datos reales — así "Mis Rodeos" en modo demostración distingue visualmente
// el Caso A, el Caso B y la selección por rodeo sin tocar Supabase.
router.get('/rodeos', soloCuentaInstitucionalDemo, (req, res) => {
    const rodeos = (RODEOS_POR_ASOCIACION[req.usuario.asociacion_id] || []).map(r => {
        const rentadoDesignado = !!r.delegado_rentado_designado;
        const cartillaExistente = cartillasDemoPorRodeo[r.id] || null;
        const cartillaInstitucionalDisponible = r.estado_rodeo !== 'anulado' && !rentadoDesignado;
        const seleccion = seleccionDelegadoPorRodeoDemo[r.id] || null;

        let tipoDelegado, nombreDelegado, delegadoAsociacionIdSeleccionado = null;
        if (rentadoDesignado) {
            tipoDelegado = 'delegado_rentado';
            nombreDelegado = r.nombre_rentado || null; // nunca se inventa si no está en los datos
        } else {
            tipoDelegado = 'delegado_asociacion';
            nombreDelegado = cartillaExistente?.delegado_nombre || seleccion?.nombre || null;
            delegadoAsociacionIdSeleccionado = cartillaExistente?.delegado_asociacion_id || seleccion?.delegado_asociacion_id || null;
        }

        return {
            ...r,
            // Fase 3.4 — corrección "Responsable vacío en cartilla enviada":
            // estado_cartilla se computa SIEMPRE desde el objeto real en
            // cartillasDemoPorRodeo (igual que calcula el backend real desde
            // cartillas_delegado), NUNCA desde una etiqueta estática en los
            // datos del rodeo — esa etiqueta quedaba desincronizada de a quién
            // pertenecía realmente la cartilla (causa raíz del bug reportado:
            // "Enviada" se mostraba sin ningún registro de cartilla detrás, por
            // lo tanto sin ningún nombre que mostrar). ESTADOS_CARTILLA_ESPECIALES_DEMO
            // cubre el único caso que esta estructura (un objeto por rodeo) no
            // puede representar: "multiples_cartillas_sin_resolver" requiere DOS
            // cartillas conflictivas para el mismo rodeo.
            estado_cartilla: ESTADOS_CARTILLA_ESPECIALES_DEMO[r.id] || cartillaExistente?.estado || 'sin_cartilla',
            delegado_rentado_designado: rentadoDesignado,
            cartilla_institucional_disponible: cartillaInstitucionalDisponible,
            tipo_delegado: tipoDelegado,
            nombre_delegado: nombreDelegado,
            delegado_asociacion_id_seleccionado: delegadoAsociacionIdSeleccionado,
            cartilla_iniciada: !!cartillaExistente,
            cartilla_id: cartillaExistente?.id || null,
            // Fase 3.4 — "Jurado designado": mismo campo y semántica que el
            // backend real (arreglo vacío = "Pendiente de designación").
            jurados_designados: JURADOS_DEMO_POR_RODEO[r.id] || []
        };
    });
    res.json({ rodeos, temporada: TEMPORADA_DEMO });
});

// POST /rodeos/:rodeo_id/seleccionar-delegado (Fase 3.5 — CONFIRMACIÓN, ya no
// edición libre): mismo contrato que el real (institucional/rodeos.js) — la
// PRIMERA confirmación para un rodeo queda fija; cualquier intento posterior
// con OTRO delegado se rechaza con 409 RESPONSABLE_YA_CONFIRMADO (reintentar
// con el MISMO delegado ya confirmado es un no-op idempotente, 200). El
// único camino para cambiarlo después es el reemplazo autorizado simulado
// (ver POST /rodeos/:rodeo_id/reemplazar-delegado-institucional-demo).
router.post('/rodeos/:rodeo_id/seleccionar-delegado', soloCuentaInstitucionalDemo, (req, res) => {
    const { delegado_asociacion_id } = req.body;
    if (!delegado_asociacion_id) return res.status(400).json({ error: 'delegado_asociacion_id es requerido.' });

    const rodeo = rodeoDemo(req.usuario.asociacion_id, req.params.rodeo_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });
    if (rodeo.delegado_rentado_designado) {
        return res.status(409).json({
            error: 'Este rodeo tiene un Delegado Rentado designado. La cartilla corresponde a dicho delegado.',
            code: 'DELEGADO_RENTADO_DESIGNADO'
        });
    }
    const delegado = delegadoDemo(req.usuario.asociacion_id, delegado_asociacion_id);
    if (!delegado) return res.status(403).json({ error: 'Delegado no válido para esta asociación.' });

    const yaConfirmado = responsableConfirmadoDemo(rodeo.id);
    if (yaConfirmado) {
        if (yaConfirmado.delegado_asociacion_id !== delegado.id) {
            return res.status(409).json({
                error: 'Este rodeo ya tiene un Delegado de Asociación confirmado como responsable. Un reemplazo solo puede autorizarlo el Administrador.',
                code: 'RESPONSABLE_YA_CONFIRMADO',
                responsable_actual: { delegado_asociacion_id: yaConfirmado.delegado_asociacion_id }
            });
        }
        // Re-confirmar el MISMO delegado ya confirmado: no-op idempotente.
        return res.json({ seleccion: { rodeo_id: rodeo.id, delegado_asociacion_id: delegado.id, nombre: delegado.nombre } });
    }

    seleccionDelegadoPorRodeoDemo[rodeo.id] = { delegado_asociacion_id: delegado.id, nombre: delegado.nombre };
    registrarEventoHistorialDemo(rodeo.id, 'confirmar_responsable_institucional',
        `Delegado de Asociación confirmado como responsable: ${delegado.nombre}`);

    res.json({
        seleccion: { rodeo_id: rodeo.id, delegado_asociacion_id: delegado.id, nombre: delegado.nombre }
    });
});

// POST /rodeos/:rodeo_id/reemplazar-delegado-institucional-demo — Fase 3.5.
// IMPORTANTE: esto es una CONVENIENCIA EXCLUSIVA del modo demostración, para
// poder mostrar visualmente el Escenario C (reemplazo + historial) sin tener
// que simular además un login de administrador completo. El namespace y la
// autorización REALES viven en admin/rodeos.js (POST /:id/reemplazar-
// delegado-institucional), protegidos por soloAdmin + soloNoMonitor/etc. y
// respaldados por la RPC de la migración 069 — ya cubiertos por sus propios
// tests dedicados (responsableUnicoInstitucional.rpc.test.js,
// rodeos.reemplazarDelegadoInstitucional.test.js). Esta ruta NUNCA existe en
// producción (todo este archivo está detrás del mismo doble guardia).
router.post('/rodeos/:rodeo_id/reemplazar-delegado-institucional-demo', soloCuentaInstitucionalDemo, (req, res) => {
    const { nuevo_delegado_asociacion_id, motivo } = req.body || {};
    if (!nuevo_delegado_asociacion_id) return res.status(400).json({ error: 'nuevo_delegado_asociacion_id es requerido.' });
    if (!motivo || String(motivo).trim() === '') {
        return res.status(422).json({ error: 'El motivo del reemplazo es obligatorio.', code: 'MOTIVO_REQUERIDO' });
    }
    const rodeo = rodeoDemo(req.usuario.asociacion_id, req.params.rodeo_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });

    const actual = responsableConfirmadoDemo(rodeo.id);
    if (!actual) {
        return res.status(409).json({
            error: 'Este rodeo todavía no tiene un Delegado de Asociación confirmado — no hay nada que reemplazar.',
            code: 'SIN_DESIGNACION_PREVIA'
        });
    }
    const cartilla = cartillasDemoPorRodeo[rodeo.id];
    if (cartilla && ESTADOS_BLOQUEADOS_DEMO.includes(cartilla.estado)) {
        return res.status(409).json({
            error: 'La cartilla de este rodeo ya fue enviada/aprobada/cerrada. El reemplazo de responsable sobre una cartilla en ese estado requiere un procedimiento específico, todavía no definido ni autorizado.',
            code: 'REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL'
        });
    }
    const nuevoDelegado = delegadoDemo(req.usuario.asociacion_id, nuevo_delegado_asociacion_id);
    if (!nuevoDelegado) return res.status(403).json({ error: 'El delegado indicado no es válido para esta asociación.' });

    seleccionDelegadoPorRodeoDemo[rodeo.id] = { delegado_asociacion_id: nuevoDelegado.id, nombre: nuevoDelegado.nombre };
    if (cartilla) {
        cartilla.delegado_asociacion_id = nuevoDelegado.id;
        cartilla.delegado_nombre = nuevoDelegado.nombre;
        cartilla.version += 1;
    }
    registrarEventoHistorialDemo(rodeo.id, 'reemplazar_responsable_institucional',
        `Reemplazo de responsable autorizado (DEMOSTRACIÓN) — motivo: ${String(motivo).trim()}`);

    res.json({
        mensaje: `Delegado de Asociación reemplazado correctamente (DEMOSTRACIÓN) para ${rodeo.club}.`,
        designacion: { rodeo_id: rodeo.id, delegado_asociacion_id: nuevoDelegado.id, nombre: nuevoDelegado.nombre }
    });
});

// ── Cartilla de Delegado (Fase 3) — simulación visual en memoria ───────
// Permite probar abrir/completar/guardar/recuperar/reenviar la MISMA
// pantalla compartida (frontend/usuario/cartilla-delegado.html) sin que
// existan las tablas reales todavía. Se reinicia al reiniciar el servidor
// de desarrollo — esto NO acredita que las escrituras/transacciones/
// restricciones reales funcionen en Supabase (eso se prueba en
// services/cartillaInstitucional.rpc.test.js contra un Postgres real de
// prueba, con el esquema real). Nunca toca Supabase, nunca persiste fuera
// de este proceso.
// Fase 3.4: una sola fábrica para pre-sembrar cartillas demo ya completadas,
// consistente con lo que crearía realmente POST /cartilla/rodeo/:id — así
// "Ver cartilla"/"Descargar PDF" siempre tienen contenido real que mostrar,
// y estado_cartilla (ver GET /rodeos) nunca queda desincronizado de a quién
// pertenece la cartilla (causa raíz del bug "Responsable vacío" corregido acá).
function cartillaDemoPreSembrada({ rodeoId, estado, delegadoAsociacionId, delegadoNombre, fechaRodeo, extra = {} }) {
    return {
        id: `demo-cart-${rodeoId}`, rodeo_id: rodeoId, estado, version: 1,
        delegado_asociacion_id: delegadoAsociacionId, delegado_nombre: delegadoNombre,
        delegado_telefono: '+56 9 1234 5678',
        temporada: TEMPORADA_DEMO.nombre, fecha_rodeo: fechaRodeo, tipo_rodeo: 'Provincial',
        secretario_jurado: 'Marta Ríos (DEMO)', secretario_numero_socio: '4821',
        serie_campeones_dos_vueltas: true, incluye_informe_disciplinario: false, incluye_informe_ganado_bajo_peso: false,
        certificacion_medialuna_comuna: true, certificacion_mas_200_personas: false,
        certificacion_mas_250_personas: false, certificacion_vinculacion_comunidad: true,
        respuestas_json: {
            secretario: { nombre: 'Marta Ríos (DEMO)', rut: '12.345.678-9', n_socio: '4821' },
            comentarios_generales: { texto: 'Rodeo desarrollado sin incidentes relevantes (datos de demostración).' },
            desempeno_jurado: { nota_promedio: 6.5 }
        },
        historial_observaciones: [],
        enviada_en: ['enviada', 'reenviada', 'aprobada', 'cerrada'].includes(estado) ? new Date().toISOString() : null,
        aprobada_en: ['aprobada', 'cerrada'].includes(estado) ? new Date().toISOString() : null,
        ...extra
    };
}

// Fase 3.4: estados que esta estructura (un objeto por rodeo) no puede
// representar fielmente — "multiples_cartillas_sin_resolver" requiere DOS
// cartillas conflictivas para el MISMO rodeo. Se documenta como excepción
// explícita en vez de una etiqueta estática desconectada (la causa del bug).
const ESTADOS_CARTILLA_ESPECIALES_DEMO = {
    'demo-rodeo-12': 'multiples_cartillas_sin_resolver'
};

const cartillasDemoPorRodeo = {
    // Fase 3.1 (cierre) — Caso D: cartilla institucional YA iniciada para
    // demo-rodeo-14 (ver institucionalDemoDatos.js, delegado_rentado_designado:
    // true en ese mismo rodeo) — simula visualmente "se guardó contenido y
    // DESPUÉS apareció una designación vigente de Rentado": el contenido se
    // sigue viendo tal cual, pero queda bloqueado para nuevos guardados/envío.
    'demo-rodeo-14': {
        id: 'demo-cart-demo-rodeo-14', rodeo_id: 'demo-rodeo-14', estado: 'borrador', version: 1,
        delegado_asociacion_id: 'demo-del-1', delegado_nombre: 'Ana Soto Pérez (DEMO)',
        temporada: TEMPORADA_DEMO.nombre, fecha_rodeo: '2026-10-16', tipo_rodeo: 'Provincial',
        respuestas_json: {}, historial_observaciones: []
    },
    // Fase 3.4 — corrección "Responsable vacío en cartilla enviada" (Club Río
    // Negro): antes esta cartilla NO existía como objeto real, solo como
    // etiqueta estática "enviada" en los datos del rodeo — por eso no tenía
    // responsable que mostrar. Ahora es una cartilla real, igual que cualquier
    // otra, con autoría consistente con su estado.
    'demo-rodeo-2': cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-2', estado: 'enviada', delegadoAsociacionId: 'demo-del-2', delegadoNombre: 'Bruno Hernández Díaz (DEMO)', fechaRodeo: '2026-09-25' }),
    // Escenario C (demo-estados@ferochi.com) — mismo criterio: cada estado
    // mostrado en "Mis Rodeos" corresponde a una cartilla real pre-sembrada.
    'demo-rodeo-5':  cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-5',  estado: 'borrador',  delegadoAsociacionId: 'demo-del-4', delegadoNombre: 'Diego Fernández (DEMO)', fechaRodeo: '2026-08-10' }),
    'demo-rodeo-6':  cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-6',  estado: 'enviada',   delegadoAsociacionId: 'demo-del-4', delegadoNombre: 'Diego Fernández (DEMO)', fechaRodeo: '2026-08-17' }),
    'demo-rodeo-7':  cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-7',  estado: 'observada', delegadoAsociacionId: 'demo-del-5', delegadoNombre: 'Elena Castro (DEMO)',    fechaRodeo: '2026-08-24',
        extra: { observacion_admin: 'Falta completar el informe de disciplina (datos de demostración).', observada_en: new Date().toISOString() } }),
    'demo-rodeo-8':  cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-8',  estado: 'reenviada', delegadoAsociacionId: 'demo-del-4', delegadoNombre: 'Diego Fernández (DEMO)', fechaRodeo: '2026-08-31' }),
    'demo-rodeo-9':  cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-9',  estado: 'aprobada',  delegadoAsociacionId: 'demo-del-5', delegadoNombre: 'Elena Castro (DEMO)',    fechaRodeo: '2026-09-07' }),
    'demo-rodeo-10': cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-10', estado: 'cerrada',   delegadoAsociacionId: 'demo-del-4', delegadoNombre: 'Diego Fernández (DEMO)', fechaRodeo: '2026-09-14' }),
    // Fase 3.5 — Escenario B: Ana Soto ya confirmada + cartilla YA guardada
    // en borrador -> demuestra que la asociación NO puede sustituirla
    // directamente (POST seleccionar-delegado con otro delegado -> 409).
    'demo-rodeo-20': cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-20', estado: 'borrador', delegadoAsociacionId: 'demo-del-1', delegadoNombre: 'Ana Soto Pérez (DEMO)', fechaRodeo: '2026-11-27' }),
    // Fase 3.5 — Escenario C: Bruno Hernández es el responsable VIGENTE tras
    // un reemplazo YA autorizado (simulado); Ana Soto queda como responsable
    // ANTERIOR, visible solo en el historial (ver historialDemoPorRodeo abajo).
    'demo-rodeo-21': cartillaDemoPreSembrada({ rodeoId: 'demo-rodeo-21', estado: 'borrador', delegadoAsociacionId: 'demo-del-2', delegadoNombre: 'Bruno Hernández Díaz (DEMO)', fechaRodeo: '2026-12-04' })
};
const CAMPOS_EDITABLES_DEMO = [
    'delegado_nombre', 'delegado_telefono', 'secretario_jurado', 'secretario_numero_socio',
    'serie_campeones_dos_vueltas', 'incluye_informe_disciplinario', 'incluye_informe_ganado_bajo_peso',
    'certificacion_medialuna_comuna', 'certificacion_mas_200_personas',
    'certificacion_mas_250_personas', 'certificacion_vinculacion_comunidad', 'respuestas_json'
];
const ESTADOS_BLOQUEADOS_DEMO = ['enviada', 'reenviada', 'aprobada', 'cerrada'];

// Fase 3.5 — pre-siembra del historial para los Escenarios B y C: estos dos
// rodeos ya nacen con una cartilla pre-sembrada (arriba), así que su
// "confirmación inicial" nunca pasó realmente por POST /seleccionar-delegado
// en este proceso — se registra acá el mismo evento que esa ruta habría
// generado, para que el Escenario se vea completo desde el primer GET (nunca
// se inventa un evento que no corresponda a lo que el dato pre-sembrado
// representa: Ana Soto SÍ fue quien quedó confirmada/creó la cartilla en
// ambos casos).
registrarEventoHistorialDemo('demo-rodeo-20', 'confirmar_responsable_institucional', 'Delegado de Asociación confirmado como responsable: Ana Soto Pérez (DEMO)');
registrarEventoHistorialDemo('demo-rodeo-20', 'crear', 'Creación de cartilla institucional — delegado: Ana Soto Pérez (DEMO)');

registrarEventoHistorialDemo('demo-rodeo-21', 'confirmar_responsable_institucional', 'Delegado de Asociación confirmado como responsable: Ana Soto Pérez (DEMO)');
registrarEventoHistorialDemo('demo-rodeo-21', 'crear', 'Creación de cartilla institucional — delegado: Ana Soto Pérez (DEMO)');
registrarEventoHistorialDemo('demo-rodeo-21', 'reemplazar_responsable_institucional', 'Reemplazo de responsable autorizado (DEMOSTRACIÓN) — motivo: Ana Soto no pudo continuar, asociación solicitó reemplazo por Bruno Hernández Díaz (DEMO)');

function rodeoDemo(asociacionId, rodeoId) {
    return (RODEOS_POR_ASOCIACION[asociacionId] || []).find(r => r.id === rodeoId) || null;
}
function delegadoDemo(asociacionId, delegadoId) {
    return (DELEGADOS_POR_ASOCIACION[asociacionId] || []).find(d => d.id === delegadoId) || null;
}

router.get('/cartilla/rodeo/:rodeo_id', soloCuentaInstitucionalDemo, (req, res) => {
    const rodeo = rodeoDemo(req.usuario.asociacion_id, req.params.rodeo_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });
    const rentadoDesignado = !!rodeo.delegado_rentado_designado;
    const cartillaExistente = cartillasDemoPorRodeo[req.params.rodeo_id] || null;
    res.json({
        rodeo: { id: rodeo.id, club: rodeo.club, asociacion: rodeo.asociacion, fecha: rodeo.fecha, estado: rodeo.estado_rodeo, tipo_rodeo_nombre: rodeo.tipo_rodeo, temporadas: { nombre: TEMPORADA_DEMO.nombre } },
        cartilla: cartillaExistente,
        conflicto_rentado: rentadoDesignado && !cartillaExistente,
        delegado_rentado_designado: rentadoDesignado,
        // Fase 3.1 (cierre) — Caso D simulado: la cartilla YA existe y el
        // rodeo tiene designación vigente de Rentado -> se sigue devolviendo
        // el contenido (nunca se oculta), pero queda bloqueada para escritura.
        bloqueada_por_designacion_posterior: !!cartillaExistente && rentadoDesignado,
        jurados: ['Jurado Demo Uno', 'Jurado Demo Dos'],
        // Fase 3.5 — mismo campo que el backend real: nunca fabrica un evento,
        // viene vacío si registrarEventoHistorialDemo nunca se llamó para este rodeo.
        historial_responsables: historialDemoPorRodeo[req.params.rodeo_id] || []
    });
});

router.post('/cartilla/rodeo/:rodeo_id', soloCuentaInstitucionalDemo, (req, res) => {
    const rodeo = rodeoDemo(req.usuario.asociacion_id, req.params.rodeo_id);
    if (!rodeo) return res.status(404).json({ error: 'Rodeo no encontrado para su asociación.' });
    if (rodeo.estado_rodeo === 'anulado') {
        return res.status(422).json({ error: 'No puede crearse una cartilla para un rodeo anulado.', code: 'RODEO_ANULADO' });
    }
    // Fase 3.1 — Caso A simulado: mismo bloqueo que la RPC real (migración 066).
    if (rodeo.delegado_rentado_designado) {
        return res.status(409).json({
            error: 'Este rodeo tiene un Delegado Rentado designado. La cartilla corresponde a dicho delegado.',
            code: 'DELEGADO_RENTADO_DESIGNADO'
        });
    }

    // Fase 3.5 — regla oficial: "un único responsable confirmado por rodeo".
    // Ya NO se acepta un delegado_asociacion_id del body para decidir quién es
    // el responsable — SIEMPRE se usa el responsable YA CONFIRMADO (vía
    // seleccionar-delegado). Si el body envía uno que no coincide, se rechaza.
    const confirmado = responsableConfirmadoDemo(rodeo.id);
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

    const delegado = delegadoDemo(req.usuario.asociacion_id, confirmado.delegado_asociacion_id);
    if (!delegado) return res.status(403).json({ error: 'Delegado no válido para esta asociación.' });

    let cartilla = cartillasDemoPorRodeo[req.params.rodeo_id];
    if (!cartilla) {
        cartilla = {
            id: `demo-cart-${req.params.rodeo_id}`, rodeo_id: req.params.rodeo_id, estado: 'borrador', version: 1,
            delegado_asociacion_id: delegado.id, delegado_nombre: delegado.nombre,
            temporada: TEMPORADA_DEMO.nombre, fecha_rodeo: rodeo.fecha, tipo_rodeo: rodeo.tipo_rodeo,
            respuestas_json: {}, historial_observaciones: []
        };
        cartillasDemoPorRodeo[req.params.rodeo_id] = cartilla;
        registrarEventoHistorialDemo(rodeo.id, 'crear', `Creación de cartilla institucional — delegado: ${delegado.nombre}`);
        return res.status(201).json({ cartilla, creada: true });
    }
    if (ESTADOS_BLOQUEADOS_DEMO.includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada/aprobada y no admite cambiar el delegado responsable (simulado).', code: 'CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO' });
    }
    // Fase 3.5: ya nunca cambia de delegado por esta vía (se validó arriba que
    // coincide con el confirmado) — un reintento legítimo (p.ej. tras un error
    // de red) con el MISMO delegado solo sube la versión, nunca crea un
    // segundo borrador ni cambia la autoría.
    cartilla.version += 1;
    registrarEventoHistorialDemo(rodeo.id, 'guardar', `Adjunto de cartilla institucional — delegado: ${delegado.nombre}`);
    res.json({ cartilla, creada: false });
});

router.patch('/cartilla/:id', soloCuentaInstitucionalDemo, (req, res) => {
    const cartilla = Object.values(cartillasDemoPorRodeo).find(c => c.id === req.params.id);
    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (ESTADOS_BLOQUEADOS_DEMO.includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada y no puede modificarse.', code: 'ESTADO_BLOQUEADO' });
    }
    // Fase 3.1 (cierre) — Caso D simulado: mismo bloqueo que institucional/cartilla.js.
    const rodeoDeLaCartilla = rodeoDemo(req.usuario.asociacion_id, cartilla.rodeo_id);
    if (rodeoDeLaCartilla?.delegado_rentado_designado) {
        return res.status(409).json({
            error: 'Este rodeo presenta un cambio de designación de Delegado. La cartilla se encuentra temporalmente bloqueada hasta que el Administrador resuelva la situación.',
            code: 'BLOQUEADA_POR_DESIGNACION_POSTERIOR'
        });
    }
    if (req.body.version === undefined) return res.status(400).json({ error: 'version es requerida.' });
    if (Number(req.body.version) !== cartilla.version) {
        return res.status(409).json({ error: 'La cartilla fue modificada por otra sesión mientras tanto (simulado). Recargue los datos más recientes.', code: 'VERSION_DESACTUALIZADA' });
    }
    // Fase 3.5: el responsable confirmado es inmutable por un guardado normal.
    if (req.body.delegado_asociacion_id !== undefined && req.body.delegado_asociacion_id !== cartilla.delegado_asociacion_id) {
        return res.status(403).json({
            error: 'El responsable de esta cartilla ya fue confirmado y no puede cambiarse desde un guardado normal. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO'
        });
    }
    if (req.body.delegado_nombre !== undefined && req.body.delegado_nombre !== cartilla.delegado_nombre) {
        return res.status(403).json({
            error: 'El nombre del responsable confirmado no puede editarse desde acá. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO'
        });
    }
    CAMPOS_EDITABLES_DEMO.forEach(k => { if (req.body[k] !== undefined) cartilla[k] = req.body[k]; });
    cartilla.version += 1;
    registrarEventoHistorialDemo(cartilla.rodeo_id, 'guardar', 'Guardado de borrador institucional (DEMOSTRACIÓN)');
    res.json({ mensaje: 'Borrador guardado correctamente (DEMOSTRACIÓN — no se persiste en ninguna base real)', cartilla });
});

router.post('/cartilla/:id/enviar', soloCuentaInstitucionalDemo, (req, res) => {
    const cartilla = Object.values(cartillasDemoPorRodeo).find(c => c.id === req.params.id);
    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    if (ESTADOS_BLOQUEADOS_DEMO.includes(cartilla.estado)) {
        return res.status(409).json({ error: 'La cartilla ya fue enviada.', code: 'ESTADO_BLOQUEADO' });
    }
    const rodeoDeLaCartillaEnviar = rodeoDemo(req.usuario.asociacion_id, cartilla.rodeo_id);
    if (rodeoDeLaCartillaEnviar?.delegado_rentado_designado) {
        return res.status(409).json({
            error: 'Este rodeo presenta un cambio de designación de Delegado. La cartilla se encuentra temporalmente bloqueada hasta que el Administrador resuelva la situación.',
            code: 'BLOQUEADA_POR_DESIGNACION_POSTERIOR'
        });
    }
    if (req.body.version === undefined || Number(req.body.version) !== cartilla.version) {
        return res.status(409).json({ error: 'La cartilla fue modificada por otra sesión mientras tanto (simulado).', code: 'VERSION_DESACTUALIZADA' });
    }
    // Fase 3.5: mismo bloqueo que PATCH.
    if (req.body.delegado_nombre !== undefined && req.body.delegado_nombre !== cartilla.delegado_nombre) {
        return res.status(403).json({
            error: 'El nombre del responsable confirmado no puede editarse desde acá. Un reemplazo solo puede autorizarlo el Administrador.',
            code: 'RESPONSABLE_YA_CONFIRMADO'
        });
    }
    CAMPOS_EDITABLES_DEMO.forEach(k => { if (req.body[k] !== undefined) cartilla[k] = req.body[k]; });
    const esReenvio = cartilla.estado === 'observada';
    cartilla.estado = esReenvio ? 'reenviada' : 'enviada';
    cartilla.version += 1;
    registrarEventoHistorialDemo(cartilla.rodeo_id, 'enviar', `${esReenvio ? 'Reenvío' : 'Envío'} de cartilla institucional (DEMOSTRACIÓN)`);
    res.json({ mensaje: 'Cartilla enviada correctamente (DEMOSTRACIÓN — nunca se persistió en una base real)', cartilla, nota_delegado_sincronizada: false });
});

// Fase 3.4 — "Descargar PDF" en modo demostración: usa el MISMO generador
// real (nunca un PDF simplificado) — funciona porque generarCartillaDelegadoPDF
// es una función pura sobre objetos planos (cartilla, rodeo), sin tocar
// Supabase. Misma autorización en forma que la ruta real: la cartilla debe
// ser de origen institucional y pertenecer a un rodeo de esta asociación.
function nombreArchivoCartillaPDFDemo(club, fechaRodeo) {
    const clubLimpio = (club || 'rodeo').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'rodeo';
    let fechaLimpia = 'sin-fecha';
    if (fechaRodeo) {
        const [y, m, d] = String(fechaRodeo).split('T')[0].split('-');
        if (y && m && d) fechaLimpia = `${d}-${m}-${y}`;
    }
    return `Cartilla_Delegado_${clubLimpio}_${fechaLimpia}.pdf`;
}

router.get('/cartilla/:id/pdf', soloCuentaInstitucionalDemo, async (req, res) => {
    const cartilla = Object.values(cartillasDemoPorRodeo).find(c => c.id === req.params.id);
    if (!cartilla) return res.status(404).json({ error: 'Cartilla no encontrada.' });
    const rodeo = rodeoDemo(req.usuario.asociacion_id, cartilla.rodeo_id);
    if (!rodeo) return res.status(403).json({ error: 'Sin permiso.' });

    try {
        const buffer = await generarCartillaDelegadoPDF(cartilla, {
            id: rodeo.id, club: rodeo.club, asociacion: rodeo.asociacion, fecha: rodeo.fecha,
            tipo_rodeo_nombre: rodeo.tipo_rodeo, temporadas: { nombre: TEMPORADA_DEMO.nombre }
        });
        const nombre = nombreArchivoCartillaPDFDemo(rodeo.club, cartilla.fecha_rodeo);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
        res.setHeader('Content-Length', buffer.length);
        res.end(buffer);
    } catch (err) {
        console.error('[DEMO cartilla pdf]', err.message);
        res.status(500).json({ error: 'Error al generar PDF (demostración): ' + err.message });
    }
});

// ── Perfil ─────────────────────────────────────────────────────────────
router.get('/perfil', soloCuentaInstitucionalDemo, (req, res) => {
    res.json({
        email: Object.keys(CUENTAS).find(e => CUENTAS[e].id === req.cuentaDemo.id),
        activo: req.cuentaDemo.activo,
        rol_institucional: req.cuentaDemo.rol_institucional,
        asociacion_id: req.cuentaDemo.asociacion_id,
        asociacion_nombre: req.cuentaDemo.asociacion_nombre
    });
});

module.exports = router;
