-- ============================================================
-- MANTENIMIENTO 010: Reset de datos operativos de prueba
-- Sistema de Jurados — Federación de Rodeo Chileno
-- ============================================================
--
-- PROPÓSITO:
--   Limpiar datos de rodeos, asignaciones, importaciones y bonos
--   cargados durante la fase de pruebas, para iniciar operación real.
--
-- TABLAS LIMPIADAS (orden FK leaf-first):
--   1. bonos_solicitados      — bonos por distancia solicitados
--   2. rodeo_adjuntos         — archivos adjuntos por rodeo
--   3. rodeo_links            — links YouTube por rodeo
--   4. importaciones_pendientes — filas Excel pendientes de revisión
--   5. asignaciones           — personas asignadas a rodeos
--   6. rodeos                 — eventos/rodeos cargados
--   7. importaciones          — registros de carga de Excel
--   8. auditoria (parcial)    — logs de las entidades anteriores
--
-- TABLAS CONSERVADAS (no se tocan):
--   administradores, usuarios_pagados, configuracion_tarifas,
--   configuracion_retencion, bonos_config, tipos_rodeo,
--   categorias_rodeo, disponibilidad_usuarios
--
-- INSTRUCCIONES:
--   PASO A (dry-run)  → ejecutar solo el bloque "PASO 0" (SELECT)
--   PASO B (backup)   → ver instrucciones de backup más abajo
--   PASO C (ejecutar) → ejecutar el bloque BEGIN … COMMIT
--   PASO D (verificar)→ ejecutar el bloque "VERIFICACIÓN POST-RESET"
--
-- ¡NO EJECUTAR PASO C SIN HABER COMPLETADO PASOS A Y B!
-- ============================================================


-- ============================================================
-- PASO 0: DRY-RUN
-- Muestra exactamente cuántas filas se borrarán y cuántas se
-- conservan. NO modifica ningún dato.
-- Ejecutar esto primero y revisar los resultados.
-- ============================================================

SELECT
    'LIMPIAR' AS accion,
    'bonos_solicitados'          AS tabla,
    COUNT(*)                     AS filas_a_borrar
FROM bonos_solicitados

UNION ALL SELECT 'LIMPIAR', 'rodeo_adjuntos',           COUNT(*) FROM rodeo_adjuntos
UNION ALL SELECT 'LIMPIAR', 'rodeo_links',              COUNT(*) FROM rodeo_links
UNION ALL SELECT 'LIMPIAR', 'importaciones_pendientes', COUNT(*) FROM importaciones_pendientes
UNION ALL SELECT 'LIMPIAR', 'asignaciones',             COUNT(*) FROM asignaciones
UNION ALL SELECT 'LIMPIAR', 'rodeos',                   COUNT(*) FROM rodeos
UNION ALL SELECT 'LIMPIAR', 'importaciones',            COUNT(*) FROM importaciones
UNION ALL SELECT 'LIMPIAR', 'auditoria (operativa)',    COUNT(*) FROM auditoria
    WHERE tabla IN (
        'asignaciones','rodeos','importaciones',
        'bonos_solicitados','importaciones_pendientes',
        'rodeo_adjuntos','rodeo_links'
    )

UNION ALL SELECT '--------', '--- CONSERVADAS ---',    0

UNION ALL SELECT 'CONSERVAR', 'administradores',        COUNT(*) FROM administradores
UNION ALL SELECT 'CONSERVAR', 'usuarios_pagados',       COUNT(*) FROM usuarios_pagados
UNION ALL SELECT 'CONSERVAR', 'configuracion_tarifas',  COUNT(*) FROM configuracion_tarifas
UNION ALL SELECT 'CONSERVAR', 'configuracion_retencion',COUNT(*) FROM configuracion_retencion
UNION ALL SELECT 'CONSERVAR', 'bonos_config',           COUNT(*) FROM bonos_config
UNION ALL SELECT 'CONSERVAR', 'tipos_rodeo',            COUNT(*) FROM tipos_rodeo
UNION ALL SELECT 'CONSERVAR', 'categorias_rodeo',       COUNT(*) FROM categorias_rodeo
UNION ALL SELECT 'CONSERVAR', 'disponibilidad_usuarios',COUNT(*) FROM disponibilidad_usuarios

ORDER BY accion DESC, tabla;


-- ============================================================
-- PASO 1: BACKUP MANUAL (ANTES DE EJECUTAR EL RESET)
-- ============================================================
--
-- Opción A — Supabase Dashboard (recomendada para producción):
--   1. Ir a supabase.com → proyecto → Settings → Database
--   2. Descargar backup desde "Backups" (plan Pro) o
--      usar "Table Editor" → Export para cada tabla crítica.
--
-- Opción B — exportar con este script (guardar resultados):
--   Ejecutar cada SELECT y exportar como CSV desde el editor:

/*
SELECT * FROM asignaciones          ORDER BY created_at;
SELECT * FROM rodeos                ORDER BY created_at;
SELECT * FROM importaciones         ORDER BY created_at;
SELECT * FROM bonos_solicitados     ORDER BY created_at;
SELECT * FROM importaciones_pendientes ORDER BY created_at;
SELECT * FROM rodeo_adjuntos        ORDER BY created_at;
SELECT * FROM rodeo_links           ORDER BY created_at;
*/

--   Supabase SQL Editor → seleccionar resultados → "Export CSV"
--   Guardar cada archivo con nombre: backup_YYYY-MM-DD_<tabla>.csv
--
-- Opción C — node scripts/reset-operativo.js (genera JSON automático)
--   Ver scripts/reset-operativo.js para uso con --dry-run y --ejecutar


-- ============================================================
-- PASO 2: RESET EN TRANSACCIÓN
-- ¡Ejecutar COMPLETO (desde BEGIN hasta COMMIT) de una sola vez!
-- Si algo falla, PostgreSQL hace ROLLBACK automático.
-- ============================================================

BEGIN;

-- Registro del inicio (para auditoría del reset mismo)
INSERT INTO auditoria (tabla, accion, actor_id, actor_tipo, descripcion)
VALUES (
    'sistema',
    'reset_operativo',
    'sistema',
    'administrador',
    'Reset de datos operativos de prueba — inicio transacción: ' || NOW()::TEXT
);

-- ── 1. bonos_solicitados ─────────────────────────────────────
-- FK NOT NULL → asignaciones.id: debe ir antes que asignaciones.
DELETE FROM bonos_solicitados;

-- ── 2. rodeo_adjuntos ────────────────────────────────────────
-- FK CASCADE desde rodeos; FK SET NULL desde asignaciones.
-- Se borra antes de asignaciones y rodeos para orden explícito.
DELETE FROM rodeo_adjuntos;

-- ── 3. rodeo_links ───────────────────────────────────────────
-- Mismo patrón que rodeo_adjuntos.
DELETE FROM rodeo_links;

-- ── 4. importaciones_pendientes ──────────────────────────────
-- FK NOT NULL → importaciones.id: debe ir antes que importaciones.
-- FK nullable → asignaciones.id y rodeos.id (ya serán borradas).
DELETE FROM importaciones_pendientes;

-- ── 5. asignaciones ──────────────────────────────────────────
-- FK NOT NULL → rodeos.id: debe ir antes que rodeos.
DELETE FROM asignaciones;

-- ── 6. rodeos ────────────────────────────────────────────────
-- FK nullable → importaciones.id: debe ir antes que importaciones.
DELETE FROM rodeos;

-- ── 7. importaciones ─────────────────────────────────────────
-- Historial de cargas de Excel. Stand-alone en este punto.
DELETE FROM importaciones;

-- ── 8. auditoria (solo entradas de entidades borradas) ───────
-- Conserva logs de: login, cambio de password, gestión de usuarios,
-- configuración, y el propio registro del reset.
-- Solo elimina logs de operaciones sobre los datos borrados.
DELETE FROM auditoria
WHERE tabla IN (
    'asignaciones',
    'rodeos',
    'importaciones',
    'bonos_solicitados',
    'importaciones_pendientes',
    'rodeo_adjuntos',
    'rodeo_links'
);

-- Registro del cierre exitoso
INSERT INTO auditoria (tabla, accion, actor_id, actor_tipo, descripcion)
VALUES (
    'sistema',
    'reset_operativo',
    'sistema',
    'administrador',
    'Reset de datos operativos de prueba — completado exitosamente: ' || NOW()::TEXT
);

-- ── Verificación interna (dentro de la transacción) ──────────
-- Si alguna tabla tiene filas inesperadas, se verá aquí ANTES del COMMIT.
DO $$
DECLARE
    n_bonos    INTEGER;
    n_asigs    INTEGER;
    n_rodeos   INTEGER;
    n_imps     INTEGER;
    n_usuarios INTEGER;
    n_admins   INTEGER;
BEGIN
    SELECT COUNT(*) INTO n_bonos   FROM bonos_solicitados;
    SELECT COUNT(*) INTO n_asigs   FROM asignaciones;
    SELECT COUNT(*) INTO n_rodeos  FROM rodeos;
    SELECT COUNT(*) INTO n_imps    FROM importaciones;
    SELECT COUNT(*) INTO n_usuarios FROM usuarios_pagados;
    SELECT COUNT(*) INTO n_admins  FROM administradores;

    -- Verificar que tablas operativas están vacías
    IF n_bonos > 0 OR n_asigs > 0 OR n_rodeos > 0 OR n_imps > 0 THEN
        RAISE EXCEPTION 'ERROR: Alguna tabla operativa no quedó vacía — ROLLBACK. bonos=% asigs=% rodeos=% imps=%',
            n_bonos, n_asigs, n_rodeos, n_imps;
    END IF;

    -- Verificar que tablas críticas conservan datos
    IF n_usuarios = 0 THEN
        RAISE EXCEPTION 'ERROR CRÍTICO: usuarios_pagados quedó vacía — ROLLBACK';
    END IF;
    IF n_admins = 0 THEN
        RAISE EXCEPTION 'ERROR CRÍTICO: administradores quedó vacía — ROLLBACK';
    END IF;

    RAISE NOTICE '✓ Verificación OK: bonos=0 asigs=0 rodeos=0 imps=0 | usuarios=% admins=%',
        n_usuarios, n_admins;
END $$;

COMMIT;
-- Si llegaste aquí sin error: el reset fue exitoso y atómico.
-- Si hubo error antes: PostgreSQL hizo ROLLBACK automático; no se borró nada.


-- ============================================================
-- PASO 3: VERIFICACIÓN POST-RESET (ejecutar después del COMMIT)
-- ============================================================

SELECT
    'LIMPIADA' AS estado,
    tabla,
    filas_restantes
FROM (
    SELECT 'bonos_solicitados'          AS tabla, COUNT(*) AS filas_restantes FROM bonos_solicitados
    UNION ALL SELECT 'rodeo_adjuntos',           COUNT(*) FROM rodeo_adjuntos
    UNION ALL SELECT 'rodeo_links',              COUNT(*) FROM rodeo_links
    UNION ALL SELECT 'importaciones_pendientes', COUNT(*) FROM importaciones_pendientes
    UNION ALL SELECT 'asignaciones',             COUNT(*) FROM asignaciones
    UNION ALL SELECT 'rodeos',                   COUNT(*) FROM rodeos
    UNION ALL SELECT 'importaciones',            COUNT(*) FROM importaciones
) t
WHERE filas_restantes > 0  -- si aparece alguna aquí, algo falló

UNION ALL

SELECT
    'CONSERVADA' AS estado,
    tabla,
    filas
FROM (
    SELECT 'administradores'        AS tabla, COUNT(*) AS filas FROM administradores
    UNION ALL SELECT 'usuarios_pagados',      COUNT(*) FROM usuarios_pagados
    UNION ALL SELECT 'configuracion_tarifas', COUNT(*) FROM configuracion_tarifas
    UNION ALL SELECT 'bonos_config',          COUNT(*) FROM bonos_config
    UNION ALL SELECT 'tipos_rodeo',           COUNT(*) FROM tipos_rodeo
    UNION ALL SELECT 'categorias_rodeo',      COUNT(*) FROM categorias_rodeo
    UNION ALL SELECT 'disponibilidad_usuarios', COUNT(*) FROM disponibilidad_usuarios
) t

ORDER BY estado DESC, tabla;

-- Resultado esperado:
--   CONSERVADA | administradores        | ≥ 1
--   CONSERVADA | bonos_config           | ≥ 1
--   CONSERVADA | categorias_rodeo       | ≥ 1
--   CONSERVADA | configuracion_tarifas  | 3
--   CONSERVADA | disponibilidad_usuarios| cualquier número
--   CONSERVADA | tipos_rodeo            | ≥ 1
--   CONSERVADA | usuarios_pagados       | ≥ 1
--   (no debe aparecer ninguna fila con estado LIMPIADA)


-- ============================================================
-- ROLLBACK: Cómo restaurar si algo salió mal
-- ============================================================
--
-- 1. El propio BEGIN...COMMIT es atómico: si hubo error DENTRO
--    de la transacción, PostgreSQL hizo ROLLBACK automático.
--    No se perdió nada.
--
-- 2. Si ya se hizo COMMIT pero necesitas restaurar:
--    a. Supabase Pro: usar Point-in-Time Recovery desde Dashboard.
--    b. Backup manual: re-importar los CSV exportados en Paso 1B con:
--
--       COPY asignaciones FROM '/ruta/backup_asignaciones.csv' CSV HEADER;
--       -- (repetir para cada tabla en orden inverso al borrado)
--
--    c. Backup via script Node: ejecutar el JSON generado en
--       scripts/reset-operativo.js, sección de restauración (pendiente).
--
-- 3. Orden de restauración (inverso al borrado):
--    importaciones → rodeos → asignaciones → importaciones_pendientes
--    → rodeo_adjuntos → rodeo_links → bonos_solicitados
-- ============================================================
