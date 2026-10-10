// ─────────────────────────────────────────────────────────────────────────
// DATOS DE DEMOSTRACIÓN — Fase 2.5. Exclusivamente ficticios, exclusivamente
// en memoria (nunca tocan Supabase). Este archivo NO se carga nunca si
// NODE_ENV === 'production' (el guard real está en app.js, antes de
// siquiera requerir este módulo) ni sin la variable DEMO_INSTITUCIONAL=1.
//
// 3 escenarios, cada uno con su propia cuenta demo (misma contraseña fija
// DEMO1234 para las 3, porque son credenciales ficticias, no reales):
//
//   A) demo-osorno@ferochi.com        — flujo normal completo: delegados
//      certificados, rodeos activos/anulado, varios estados de cartilla.
//   B) demo-sinregistros@ferochi.com  — asociación SIN delegados
//      certificados (catálogo vacío) — para probar ese mensaje.
//   C) demo-estados@ferochi.com       — todos los estados de cartilla
//      posibles, incluyendo el conflicto "multiples_cartillas_sin_resolver".
// ─────────────────────────────────────────────────────────────────────────
const DEMO_PASSWORD = 'DEMO1234';

const CUENTAS = {
    'demo-osorno@ferochi.com': {
        id: 'demo-cuenta-osorno',
        asociacion_id: 'demo-asoc-osorno',
        asociacion_nombre: 'OSORNO (DEMOSTRACIÓN)',
        rol_institucional: 'delegado_asociacion',
        activo: true,
        primer_login: false
    },
    'demo-sinregistros@ferochi.com': {
        id: 'demo-cuenta-sinregistros',
        asociacion_id: 'demo-asoc-sinregistros',
        asociacion_nombre: 'ASOCIACIÓN DEMO SIN DELEGADOS',
        rol_institucional: 'delegado_asociacion',
        activo: true,
        primer_login: false
    },
    'demo-estados@ferochi.com': {
        id: 'demo-cuenta-estados',
        asociacion_id: 'demo-asoc-estados',
        asociacion_nombre: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA',
        rol_institucional: 'delegado_asociacion',
        activo: true,
        primer_login: true // para poder probar también el flujo de cambio obligatorio
    }
};

const DELEGADOS_POR_ASOCIACION = {
    'demo-asoc-osorno': [
        { id: 'demo-del-1', nombre: 'Ana Soto Pérez (DEMO)' },
        { id: 'demo-del-2', nombre: 'Bruno Hernández Díaz (DEMO)' },
        { id: 'demo-del-3', nombre: 'Carla Muñoz Rojas (DEMO)' }
    ],
    'demo-asoc-sinregistros': [],
    'demo-asoc-estados': [
        { id: 'demo-del-4', nombre: 'Diego Fernández (DEMO)' },
        { id: 'demo-del-5', nombre: 'Elena Castro (DEMO)' }
    ]
};

const TEMPORADA_DEMO = { id: 'demo-temp-1', nombre: '2026-2027 (DEMOSTRACIÓN)', fecha_inicio: '2026-07-01', fecha_fin: '2027-06-30' };

const RODEOS_POR_ASOCIACION = {
    'demo-asoc-osorno': [
        { id: 'demo-rodeo-1', fecha: '2026-09-18', club: 'Club San Carlos (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-2', fecha: '2026-09-25', club: 'Club Río Negro (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-3', fecha: '2026-10-02', club: 'Club Pilauco (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'anulado' },
        // Fase 3.1 — Caso A: rodeo con Delegado Rentado designado (ficticio).
        // La asociación lo VE en su listado pero no puede completar su cartilla
        // institucional — demuestra visualmente el mensaje y el badge del Caso A.
        { id: 'demo-rodeo-13', fecha: '2026-10-09', club: 'Club El Convento (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo', delegado_rentado_designado: true, nombre_rentado: 'Pedro González Muñoz (DEMO)' },
        // Fase 3.1 (cierre) — Caso D: la cartilla institucional YA fue iniciada
        // (ver cartillasDemoPorRodeo en institucionalDemo.js) y DESPUÉS apareció
        // una designación vigente de Delegado Rentado — demuestra visualmente el
        // bloqueo de guardado/envío sin ocultar ni borrar el contenido existente.
        { id: 'demo-rodeo-14', fecha: '2026-10-16', club: 'Club Las Quemas (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo', delegado_rentado_designado: true, nombre_rentado: 'Luis Soto Fuentes (DEMO)' },
        // Fase 3.3: rodeos EXCLUSIVOS para probar la selección de delegado por
        // rodeo de forma aislada — nunca reutilizar demo-rodeo-1/2 acá (ya
        // acumulan cartillas creadas por pruebas de la Fase 3 en este mismo
        // archivo; el store en memoria es compartido entre todos los tests).
        { id: 'demo-rodeo-15', fecha: '2026-10-23', club: 'Club Rahue (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-16', fecha: '2026-10-30', club: 'Club Francke (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-17', fecha: '2026-11-06', club: 'Club Damas (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-18', fecha: '2026-11-13', club: 'Club Trafún (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        // Fase 3.5 — rodeos EXCLUSIVOS para los 4 escenarios de "responsable
        // único y trazabilidad" (nunca reutilizar los de Fase 3.3/3.4 — mismo
        // motivo: el store en memoria es compartido entre todas las pruebas).
        //   Escenario A: sin responsable confirmado todavía.
        { id: 'demo-rodeo-19', fecha: '2026-11-20', club: 'Club Pichilemu (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        //   Escenario B: Ana Soto ya confirmada + cartilla en borrador ya
        //   guardada -> la asociación NO puede sustituirla directamente.
        { id: 'demo-rodeo-20', fecha: '2026-11-27', club: 'Club Pampa Alegre (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        //   Escenario C: Ana Soto fue el responsable inicial; Bruno Hernández
        //   es el reemplazo YA autorizado (simulado) -> historial con ambos.
        { id: 'demo-rodeo-21', fecha: '2026-12-04', club: 'Club Puyehue (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        //   Escenario auxiliar: libre para probar confirmaciones aisladas sin
        //   interferir con A/B/C.
        { id: 'demo-rodeo-22', fecha: '2026-12-11', club: 'Club Entre Lagos (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        // Reservados exclusivamente para los tests automatizados del bloqueo
        // de reselección (independencia entre rodeos, creación con confirmación
        // previa, envío, etc.) — nunca reutilizar los de arriba (A/B/C) ni los
        // de Fase 3.3/3.4, mismo motivo de siempre: el store en memoria es
        // compartido entre TODOS los tests de este archivo.
        { id: 'demo-rodeo-23', fecha: '2026-12-18', club: 'Club Coihueco (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-24', fecha: '2026-12-25', club: 'Club Purranque (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-25', fecha: '2027-01-01', club: 'Club Río Bueno (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-26', fecha: '2027-01-08', club: 'Club Maicolpué (DEMO)', asociacion: 'OSORNO (DEMOSTRACIÓN)', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' }
    ],
    'demo-asoc-sinregistros': [
        { id: 'demo-rodeo-4', fecha: '2026-09-20', club: 'Club Demo X', asociacion: 'ASOCIACIÓN DEMO SIN DELEGADOS', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' }
    ],
    'demo-asoc-estados': [
        { id: 'demo-rodeo-5', fecha: '2026-08-10', club: 'Club Demo Borrador', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-6', fecha: '2026-08-17', club: 'Club Demo Enviada', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-7', fecha: '2026-08-24', club: 'Club Demo Observada', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-8', fecha: '2026-08-31', club: 'Club Demo Reenviada', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-9', fecha: '2026-09-07', club: 'Club Demo Aprobada', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-10', fecha: '2026-09-14', club: 'Club Demo Cerrada', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' },
        { id: 'demo-rodeo-11', fecha: '2026-09-21', club: 'Club Demo Anulado', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'anulado' },
        { id: 'demo-rodeo-12', fecha: '2026-09-28', club: 'Club Demo Conflicto', asociacion: 'ASOCIACIÓN DEMO ESTADOS DE CARTILLA', tipo_rodeo: 'Provincial', estado_rodeo: 'activo' }
    ]
};

// Fase 3.4 — "Jurado designado": nombres ficticios de jurados ya publicados
// por rodeo. demo-rodeo-1 queda SIN entrada a propósito (demuestra "Pendiente
// de designación"); demo-rodeo-2 trae DOS jurados (demuestra la lista con
// más de uno); el resto trae uno solo.
const JURADOS_DEMO_POR_RODEO = {
    'demo-rodeo-2': ['Juan Pérez Soto (DEMO)', 'Pedro Ramírez Lagos (DEMO)'],
    'demo-rodeo-13': ['Manuel Torres (DEMO)'],
    'demo-rodeo-14': ['Manuel Torres (DEMO)'],
    'demo-rodeo-15': ['Jorge Muñoz (DEMO)'],
    'demo-rodeo-6': ['Jorge Muñoz (DEMO)'],
    'demo-rodeo-9': ['Jorge Muñoz (DEMO)', 'Manuel Torres (DEMO)']
};

module.exports = { DEMO_PASSWORD, CUENTAS, DELEGADOS_POR_ASOCIACION, TEMPORADA_DEMO, RODEOS_POR_ASOCIACION, JURADOS_DEMO_POR_RODEO };
