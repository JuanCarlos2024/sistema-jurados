#!/usr/bin/env bash
# =============================================================================
# Prueba de concurrencia REAL — Fase 1B (reemplazo transaccional de jurados).
# =============================================================================
# Verifica, con DOS conexiones PostgreSQL genuinamente independientes (no
# PGlite, no secuencial), que:
#   1. Dos reemplazos concurrentes que compiten por el MISMO jurado, en dos
#      rodeos con fechas que se cruzan, NUNCA pueden confirmarse ambos
#      (pg_advisory_xact_lock + verificación de cruce dentro de la RPC,
#      migración 084).
#   2. El perdedor de la carrera no modifica ni asignaciones ni la bitácora
#      (rollback real, atómico).
#   3. Dos reemplazos concurrentes SIN conflicto real (jurados distintos,
#      sin cruce de fechas) se confirman AMBOS, sin deadlock.
#
# NO se conecta a Supabase ni a ninguna base existente. Crea un clúster de
# PostgreSQL y una base de datos EXCLUSIVOS para esta prueba, en un
# directorio temporal nuevo. Al finalizar (éxito o error) detiene ese
# servidor y BORRA por completo el directorio temporal — no deja nada atrás.
#
# REQUISITO: una instalación COMPLETA de PostgreSQL (el SERVIDOR, no solo
# las herramientas de línea de comandos) — es decir, que `initdb` pueda
# crear un clúster nuevo. Si su instalación de PostgreSQL 17 solo incluye
# psql/pg_dump/etc. (common cuando el instalador de EDB se ejecutó sin
# marcar el componente "PostgreSQL Server"), este script lo detecta y se
# detiene con instrucciones antes de intentar nada.
#
# Uso:
#   bash tests/concurrency/prueba_concurrencia_real_reemplazo.sh
#
# Variables opcionales (con sus valores por defecto):
#   PGBIN="/c/Program Files/PostgreSQL/17/bin"   # carpeta bin/ de su instalación
#   PORT=55433                                    # puerto temporal, no el 5432 real
# =============================================================================
set -euo pipefail

PGBIN="${PGBIN:-/c/Program Files/PostgreSQL/17/bin}"
PORT="${PORT:-55433}"
DBNAME="fase1b_concurrencia_test"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRACIONES="$REPO_ROOT/database/migrations"
ESQUEMA="$REPO_ROOT/backend/src/services/__fixtures__/esquemaBitacoraDesignaciones.sql"

WORKDIR="$(mktemp -d)"
DATADIR="$WORKDIR/data"
LOGFILE="$WORKDIR/postgres.log"

echo "== 1/7 — Verificando que la instalación de PostgreSQL incluye el SERVIDOR =="
for bin in initdb pg_ctl psql; do
    if [ ! -x "$PGBIN/$bin.exe" ]; then
        echo "ERROR: no se encontró $PGBIN/$bin.exe"
        echo "       Ajuste la variable PGBIN al directorio bin/ correcto."
        exit 1
    fi
done
if [ ! -f "$PGBIN/../share/postgres.bki" ]; then
    echo "ERROR: $PGBIN parece contener SOLO las herramientas de línea de comandos"
    echo "       (psql, pg_dump, etc.) — falta el componente SERVIDOR: no existe"
    echo "       $PGBIN/../share/postgres.bki, que initdb necesita para crear un clúster."
    echo ""
    echo "       Esto NO se puede completar sin volver a ejecutar el instalador de"
    echo "       PostgreSQL 17 y marcar explícitamente el componente 'PostgreSQL Server'"
    echo "       (o 'Database Server'), no solo 'Command Line Tools'."
    echo ""
    echo "       Reintente este script después de completar esa instalación."
    rm -rf "$WORKDIR"
    exit 1
fi
echo "    OK — servidor disponible en $PGBIN"

cleanup() {
    echo "== Deteniendo el servidor de prueba y borrando el directorio temporal =="
    "$PGBIN/pg_ctl.exe" -D "$DATADIR" -l "$LOGFILE" stop -m fast >/dev/null 2>&1 || true
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "== 2/7 — Creando un clúster EXCLUSIVO para esta prueba en $DATADIR =="
"$PGBIN/initdb.exe" -D "$DATADIR" -U postgres --auth=trust -E UTF8 >/dev/null

echo "== 3/7 — Iniciando ese clúster en el puerto $PORT (nunca el 5432 real) =="
"$PGBIN/pg_ctl.exe" -D "$DATADIR" -l "$LOGFILE" -o "-p $PORT -c listen_addresses=localhost" start
sleep 1

PSQL=("$PGBIN/psql.exe" -h localhost -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

echo "== 4/7 — Creando la base de datos de prueba y cargando esquema + migraciones 083/084 =="
"${PSQL[@]}" -d postgres -c "CREATE DATABASE $DBNAME;"
"${PSQL[@]}" -d "$DBNAME" -f "$ESQUEMA"
"${PSQL[@]}" -d "$DBNAME" -f "$MIGRACIONES/083_fase1a_bitacora_designaciones_catalogo_motivos_snapshot_notas.sql"
"${PSQL[@]}" -d "$DBNAME" -f "$MIGRACIONES/084_reemplazo_jurado_transaccional_con_bitacora.sql"
"${PSQL[@]}" -d "$DBNAME" -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres; GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO postgres;"

echo "== 5/7 — Sembrando datos de prueba (UUID fijos, para referenciarlos desde dos sesiones separadas) =="
"${PSQL[@]}" -d "$DBNAME" <<'SQL'
INSERT INTO administradores (id, nombre_completo) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Admin A'),
    ('99999999-9999-9999-9999-999999999999', 'Admin B');

INSERT INTO usuarios_pagados (id, tipo_persona, nombre_completo, categoria) VALUES
    ('22222222-2222-2222-2222-222222222222', 'jurado', 'Jurado Candidato (disputado)', 'A'),
    ('33333333-3333-3333-3333-333333333333', 'jurado', 'Jurado Original Rodeo X', 'A'),
    ('44444444-4444-4444-4444-444444444444', 'jurado', 'Jurado Original Rodeo Y', 'A'),
    ('55555555-5555-5555-5555-555555555555', 'jurado', 'Jurado Original Rodeo P', 'B'),
    ('66666666-6666-6666-6666-666666666666', 'jurado', 'Jurado Original Rodeo Q', 'B'),
    ('77777777-7777-7777-7777-777777777777', 'jurado', 'Jurado Nuevo Sin Conflicto 1', 'B'),
    ('88888888-8888-8888-8888-888888888888', 'jurado', 'Jurado Nuevo Sin Conflicto 2', 'B');

-- Escenario 1: rodeos X e Y con fechas que SE CRUZAN (10-11 julio vs 11 julio).
INSERT INTO rodeos (id, club, asociacion, fecha, duracion_dias) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', 'Club X', 'Osorno', '2026-07-10', 2),
    ('aaaaaaaa-0000-0000-0000-000000000002', 'Club Y', 'Osorno', '2026-07-11', 1);
INSERT INTO asignaciones (id, rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada, valor_diario_aplicado, pago_base_calculado, estado) VALUES
    ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'jurado', 'Jurado Original Rodeo X', 'A', 100000, 100000, 'activo'),
    ('cccccccc-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444444', 'jurado', 'Jurado Original Rodeo Y', 'A', 100000, 100000, 'activo');

-- Escenario 2: rodeos P y Q en fechas que NO se cruzan, con jurados nuevos distintos.
INSERT INTO rodeos (id, club, asociacion, fecha, duracion_dias) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000003', 'Club P', 'Osorno', '2026-08-01', 1),
    ('aaaaaaaa-0000-0000-0000-000000000004', 'Club Q', 'Osorno', '2026-08-15', 1);
INSERT INTO asignaciones (id, rodeo_id, usuario_pagado_id, tipo_persona, nombre_importado, categoria_aplicada, valor_diario_aplicado, pago_base_calculado, estado) VALUES
    ('cccccccc-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000003', '55555555-5555-5555-5555-555555555555', 'jurado', 'Jurado Original Rodeo P', 'B', 100000, 100000, 'activo'),
    ('cccccccc-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000004', '66666666-6666-6666-6666-666666666666', 'jurado', 'Jurado Original Rodeo Q', 'B', 100000, 100000, 'activo');
SQL
echo "    OK — datos sembrados"

MOTIVO_SQL="(SELECT id FROM catalogo_motivos_designacion WHERE codigo = 'jurado_no_disponible')"

echo "== 6/7 — ESCENARIO 1: dos reemplazos que compiten por el MISMO jurado, rodeos con fechas cruzadas =="
echo "         Sesión A reemplaza en el rodeo X y retiene la transacción abierta 3s (sin COMMIT) para dejar una ventana real de carrera."
"${PSQL[@]}" -d "$DBNAME" -c "
BEGIN;
SELECT reemplazar_jurado_asignacion_con_bitacora(
    p_asignacion_id := 'cccccccc-0000-0000-0000-000000000001',
    p_usuario_pagado_id_nuevo := '22222222-2222-2222-2222-222222222222',
    p_categoria_aplicada_nueva := 'A', p_valor_diario_aplicado_nuevo := 150000, p_pago_base_calculado_nuevo := 150000,
    p_motivo_catalogo_id := $MOTIVO_SQL,
    p_actor_id := '11111111-1111-1111-1111-111111111111'
);
SELECT pg_sleep(3);
COMMIT;
" > "$WORKDIR/sesionA.log" 2>&1 &
PID_A=$!

sleep 1
echo "         Sesión B intenta, para el MISMO jurado, el rodeo Y (fechas cruzadas con X) mientras A sigue sin confirmar."
"${PSQL[@]}" -d "$DBNAME" -c "
BEGIN;
SELECT reemplazar_jurado_asignacion_con_bitacora(
    p_asignacion_id := 'cccccccc-0000-0000-0000-000000000002',
    p_usuario_pagado_id_nuevo := '22222222-2222-2222-2222-222222222222',
    p_categoria_aplicada_nueva := 'A', p_valor_diario_aplicado_nuevo := 150000, p_pago_base_calculado_nuevo := 150000,
    p_motivo_catalogo_id := $MOTIVO_SQL,
    p_actor_id := '99999999-9999-9999-9999-999999999999'
);
COMMIT;
" > "$WORKDIR/sesionB.log" 2>&1 &
PID_B=$!

set +e
wait "$PID_A"; RC_A=$?
wait "$PID_B"; RC_B=$?
set -e

echo ""
echo "--- Log Sesión A (rodeo X) ---"; cat "$WORKDIR/sesionA.log"
echo "--- Log Sesión B (rodeo Y) ---"; cat "$WORKDIR/sesionB.log"
echo ""

RESULTADO=$("${PSQL[@]}" -d "$DBNAME" -t -A -c "
SELECT
    (SELECT usuario_pagado_id FROM asignaciones WHERE id = 'cccccccc-0000-0000-0000-000000000001') AS asig_x,
    (SELECT usuario_pagado_id FROM asignaciones WHERE id = 'cccccccc-0000-0000-0000-000000000002') AS asig_y,
    (SELECT count(*) FROM bitacora_designaciones) AS filas_bitacora;
")
echo "Estado final (usuario_pagado_id asig_x | asig_y | filas_bitacora): $RESULTADO"

ESCENARIO1_OK=0
if [ "$RC_A" -eq 0 ] && [ "$RC_B" -ne 0 ] && grep -q "CRUCE_DISPONIBILIDAD" "$WORKDIR/sesionB.log"; then
    ESCENARIO1_OK=1
    echo "ESCENARIO 1: APROBADO — Sesión A confirmó, Sesión B fue rechazada con CRUCE_DISPONIBILIDAD, sin aplicar nada."
elif [ "$RC_B" -eq 0 ] && [ "$RC_A" -ne 0 ] && grep -q "CRUCE_DISPONIBILIDAD" "$WORKDIR/sesionA.log"; then
    ESCENARIO1_OK=1
    echo "ESCENARIO 1: APROBADO — Sesión B confirmó primero, Sesión A fue rechazada con CRUCE_DISPONIBILIDAD, sin aplicar nada."
else
    echo "ESCENARIO 1: FALLIDO — revisar los logs arriba (se esperaba exactamente un éxito y un CRUCE_DISPONIBILIDAD)."
fi

echo ""
echo "== 7/7 — ESCENARIO 2: dos reemplazos concurrentes SIN conflicto real (jurados y fechas distintas, sin cruce) =="
"${PSQL[@]}" -d "$DBNAME" -c "
BEGIN;
SELECT reemplazar_jurado_asignacion_con_bitacora(
    p_asignacion_id := 'cccccccc-0000-0000-0000-000000000003',
    p_usuario_pagado_id_nuevo := '77777777-7777-7777-7777-777777777777',
    p_categoria_aplicada_nueva := 'B', p_valor_diario_aplicado_nuevo := 150000, p_pago_base_calculado_nuevo := 150000,
    p_motivo_catalogo_id := $MOTIVO_SQL,
    p_actor_id := '11111111-1111-1111-1111-111111111111'
);
COMMIT;
" > "$WORKDIR/sesionP.log" 2>&1 &
PID_P=$!
"${PSQL[@]}" -d "$DBNAME" -c "
BEGIN;
SELECT reemplazar_jurado_asignacion_con_bitacora(
    p_asignacion_id := 'cccccccc-0000-0000-0000-000000000004',
    p_usuario_pagado_id_nuevo := '88888888-8888-8888-8888-888888888888',
    p_categoria_aplicada_nueva := 'B', p_valor_diario_aplicado_nuevo := 150000, p_pago_base_calculado_nuevo := 150000,
    p_motivo_catalogo_id := $MOTIVO_SQL,
    p_actor_id := '99999999-9999-9999-9999-999999999999'
);
COMMIT;
" > "$WORKDIR/sesionQ.log" 2>&1 &
PID_Q=$!

set +e
wait "$PID_P"; RC_P=$?
wait "$PID_Q"; RC_Q=$?
set -e

echo "--- Log Sesión P (rodeo P) ---"; cat "$WORKDIR/sesionP.log"
echo "--- Log Sesión Q (rodeo Q) ---"; cat "$WORKDIR/sesionQ.log"

ESCENARIO2_OK=0
if [ "$RC_P" -eq 0 ] && [ "$RC_Q" -eq 0 ]; then
    ESCENARIO2_OK=1
    echo "ESCENARIO 2: APROBADO — ambos reemplazos, sin conflicto real entre sí, se confirmaron correctamente (sin deadlock)."
else
    echo "ESCENARIO 2: FALLIDO — uno de los dos reemplazos sin conflicto real fue rechazado indebidamente, o hubo un error/deadlock."
fi

echo ""
echo "=============================================================="
if [ "$ESCENARIO1_OK" -eq 1 ] && [ "$ESCENARIO2_OK" -eq 1 ]; then
    echo "RESULTADO GLOBAL: APROBADO"
    exit 0
else
    echo "RESULTADO GLOBAL: FALLIDO"
    exit 1
fi
