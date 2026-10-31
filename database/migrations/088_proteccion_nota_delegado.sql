-- ═══════════════════════════════════════════════════════════════════════════════
-- Migración 088 — Protección y trazabilidad de Nota Delegado
-- (revisión final previa a publicación — 3 ajustes sobre el diseño inicial,
-- ver notas "AJUSTE 1/2/3" más abajo en cada sección afectada)
--
-- Objetivo: la Nota Delegado (rodeo_notas_secundarias.nota_delegado) puede
-- llegar de dos fuentes — la cartilla digital (Delegado Rentado o Delegado de
-- Asociación, servicio cartillaDelegadoNotas.js) o una corrección manual del
-- administrador (PUT /admin/rodeos/:id/notas-secundarias). Hasta ahora, la
-- cartilla digital podía sobrescribir SIEMPRE el valor vigente, incluida una
-- corrección manual que el administrador ya hubiera registrado.
--
-- REGLA PRINCIPAL (obligatoria): el administrador SIEMPRE puede modificar la
-- Nota Delegado — nunca hay un bloqueo permanente para él. La condición es un
-- comentario obligatorio de respaldo, pero SOLO cuando la modificación es
-- efectiva (AJUSTE 1 — ver sección C): reenviar el mismo valor nunca exige
-- comentario ni genera una corrección nueva. Lo que se protege es la
-- sincronización AUTOMÁTICA (cartilla digital): una vez que el administrador
-- corrige la nota, un reenvío de cartilla ya NO puede sobrescribirla — la
-- cartilla se sigue aceptando igual (nunca se bloquea el envío del informe),
-- pero su promedio deja de propagarse automáticamente mientras la nota siga
-- protegida (sección D).
--
-- Mismo patrón arquitectónico ya establecido en este proyecto para
-- Nota Comisión (migración 079, columna estado_nota_comision +
-- actualizar_notas_secundarias_con_auditoria) y para tablas de
-- append-only (migración 087, usuario_observaciones_administrativas):
--   A) Columna de estado independiente para Delegado (estado_nota_delegado),
--      NUNCA mezclada con estado_nota_comision — ambas notas siguen
--      actualizándose de forma completamente independiente.
--   B) Tabla de historial dedicada y append-only
--      (rodeo_notas_delegado_correcciones), más una entrada adicional en la
--      auditoría genérica ya existente (auditoria) — reutilizada, no
--      duplicada.
--   C) RPC existente (actualizar_notas_secundarias_con_auditoria) se
--      reemplaza (DROP + CREATE, no ALTER — cambia la firma al agregar un
--      parámetro) agregando el comentario obligatorio ANTE CAMBIO EFECTIVO y
--      el registro de historial para Delegado, SIN TOCAR la lógica de
--      Comisión.
--   D) RPC nueva (sincronizar_nota_delegado_automatica) para que la cartilla
--      digital deje de hacer un UPSERT directo desde Node — la verificación
--      de protección y la escritura ocurren atómicamente en una sola
--      transacción (candado FOR UPDATE, mismo orden que la RPC
--      administrativa: rodeos primero, luego la fila de notas).
--
-- AJUSTE 2 (compatibilidad histórica): en producción existen 94 registros
-- con Nota Delegado cuyo origen real (cartilla digital vs. carga manual
-- anterior a este desarrollo) NO está verificado. Etiquetarlos como
-- "automatica" habría afirmado implícitamente un origen que no se puede
-- confirmar. Se usa en su lugar un tercer estado explícito,
-- 'historica_sin_clasificar', que:
--   - NUNCA se asigna a una nota nueva (solo lo deja el ADD COLUMN de esta
--     migración, una única vez, sobre las filas que ya existían).
--   - Bloquea la sincronización automática exactamente igual que
--     'corregida_admin' (una cartilla digital NUNCA sobrescribe en silencio
--     una nota histórica de origen desconocido) — pero con un motivo
--     distinguible en el resultado de la sincronización.
--   - El administrador SIEMPRE puede modificarla igual que cualquier otra
--     (con comentario, ante cambio efectivo) — al modificarla pasa a
--     'corregida_admin', nunca queda "a medio clasificar".
--   - NO afecta a una fila existente cuyo nota_delegado sea NULL (sin nota
--     real que proteger): esas filas sí permiten la primera sincronización
--     automática con normalidad, aunque el ADD COLUMN les haya puesto el
--     mismo valor por defecto.
--
-- AJUSTE 3 (compatibilidad de despliegue): el reemplazo de
-- actualizar_notas_secundarias_con_auditoria ocurre dentro de una única
-- transacción (BEGIN...COMMIT) — cualquier llamada concurrente a la función
-- queda en espera (lock sobre el catálogo) hasta el COMMIT, nunca ve un
-- estado "función no existe" a mitad de camino. Primero se DROPea
-- explícitamente la firma VIEJA de 8 parámetros (si existe) y luego se usa
-- CREATE OR REPLACE para la firma NUEVA de 9 — así nunca queda la vieja
-- coexistiendo como un segundo overload (que permitiría invocarla sin la
-- protección de Delegado), y una reejecución de este archivo (ver
-- IDEMPOTENCIA más abajo) encuentra el DROP como no-op y el CREATE OR
-- REPLACE reemplazando en el lugar la misma firma nueva, sin error "la
-- función ya existe". Al final de este archivo se emite
-- NOTIFY pgrst, 'reload schema' — mecanismo estándar de Supabase/PostgREST
-- para forzar la recarga inmediata de su caché de funciones RPC, evitando
-- depender de la recarga automática periódica tras cambiar una firma.
--
-- PROCEDIMIENTO DE PUBLICACIÓN (orden obligatorio, para que la ventana de
-- riesgo de sobrescritura indebida sea CERO, no solo mínima): primero
-- commit + push + deploy del backend/frontend nuevo en Render, confirmar
-- que el deploy nuevo está activo, y SOLO DESPUÉS aplicar esta migración.
-- Nunca al revés. Motivo: el backend actualmente publicado
-- (cartillaDelegadoNotas.js) sincroniza la Nota Delegado con un UPSERT
-- directo sobre rodeo_notas_secundarias que NUNCA revisa estado_nota_
-- delegado — si esta migración se aplicara ANTES de desplegar el código
-- nuevo, un reenvío de cartilla durante esa ventana sobrescribiría en
-- silencio una nota protegida o histórica, exactamente lo que esta
-- migración busca impedir. Aplicando primero el código nuevo (que sí usa
-- las RPC protegidas) y la migración después, la única consecuencia de la
-- ventana transitoria es que esas dos RPC todavía no existen: el guardado
-- administrativo de Notas secundarias devuelve un error 500 controlado
-- (sin escribir nada, la función no existe y Postgres nunca llega a
-- abrir una escritura) y la sincronización automática de la cartilla
-- degrada a resultado "error_tecnico" (la cartilla se guarda igual, solo
-- queda pendiente de sincronizar) — nunca una sobrescritura indebida.
--
-- IDEMPOTENCIA: todos los DDL usan IF NOT EXISTS/IF EXISTS o CREATE OR
-- REPLACE; ninguna sentencia de este archivo falla si se repite completo.
-- ═══════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- A) Estado de protección de Nota Delegado — independiente de
--    estado_nota_comision. Tres valores posibles:
--    'historica_sin_clasificar' = preexistente a esta migración, origen no
--        verificado (AJUSTE 2) — bloquea sincronización automática, igual
--        que una corrección administrativa, pero con motivo distinguible.
--    'automatica' = fue escrita por una cartilla digital después de esta
--        migración — puede seguir actualizándose desde otra cartilla.
--    'corregida_admin' = el administrador la registró o corrigió
--        manualmente — una cartilla digital ya no puede sobrescribirla.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE rodeo_notas_secundarias
    ADD COLUMN IF NOT EXISTS estado_nota_delegado TEXT NOT NULL DEFAULT 'historica_sin_clasificar';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'rns_estado_nota_delegado_check'
    ) THEN
        ALTER TABLE rodeo_notas_secundarias
            ADD CONSTRAINT rns_estado_nota_delegado_check
            CHECK (estado_nota_delegado IN ('historica_sin_clasificar', 'automatica', 'corregida_admin'));
    END IF;
END $$;

COMMENT ON COLUMN rodeo_notas_secundarias.estado_nota_delegado IS
    'Protección de Nota Delegado (088): historica_sin_clasificar = preexistente a esta migración, origen no verificado (NUNCA se asigna a una nota nueva) — bloquea sincronización automática igual que corregida_admin, pero se distingue en el resultado. automatica = escrita por una cartilla digital tras esta migración, puede seguir sincronizándose. corregida_admin = el administrador la registró/corrigió manualmente; una cartilla digital ya no puede sobrescribirla (el administrador SIEMPRE puede volver a modificarla).';

-- ─────────────────────────────────────────────────────────────────────────
-- B) Historial append-only de modificaciones administrativas de Nota
--    Delegado. Mismo criterio de permisos que usuario_observaciones_
--    administrativas (087): ni siquiera service_role tiene UPDATE/DELETE.
--    rodeo_id SIN ON DELETE CASCADE (mismo patrón que comision_evaluaciones_
--    correcciones, migración 079): un historial de correcciones administrativas
--    NUNCA debe desaparecer en cascada solo porque se borre el rodeo que
--    referencia — con el comportamiento por defecto (NO ACTION) Postgres
--    rechaza el DELETE de un rodeo mientras tenga historial, en vez de
--    eliminar silenciosamente la auditoría.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rodeo_notas_delegado_correcciones (
    id                    BIGSERIAL PRIMARY KEY,
    rodeo_id              UUID NOT NULL REFERENCES rodeos(id),
    nota_anterior         NUMERIC(3,1),
    nota_nueva            NUMERIC(3,1) NOT NULL CHECK (nota_nueva >= 1.0 AND nota_nueva <= 7.0),
    comentario            TEXT NOT NULL CHECK (btrim(comentario) <> ''),
    administrador_id      UUID NOT NULL,
    origen_administrativo TEXT NOT NULL DEFAULT 'notas_secundarias_admin',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rodeo_notas_delegado_correcciones_rodeo
    ON rodeo_notas_delegado_correcciones(rodeo_id);

COMMENT ON TABLE rodeo_notas_delegado_correcciones IS
    'Historial append-only (088) de cada modificación EFECTIVA (valor numérico distinto) de Nota Delegado: rodeo, nota anterior, nota nueva, comentario obligatorio, administrador responsable, fecha/hora y origen. Nunca se actualiza ni se borra, y nunca se inserta una fila para un reenvío con el mismo valor.';

ALTER TABLE rodeo_notas_delegado_correcciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE rodeo_notas_delegado_correcciones FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE rodeo_notas_delegado_correcciones TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- C) actualizar_notas_secundarias_con_auditoria — se reemplaza para agregar
--    el comentario obligatorio y el historial de Delegado. Lógica de
--    Comisión 100% intacta (mismo código, sin cambios).
--
--    AJUSTE 1 (comentario solo ante cambio real): v_delegado_cambio_real
--    compara el valor NUMÉRICO nuevo contra el valor NUMÉRICO ya guardado
--    (IS DISTINCT FROM, nunca comparación de texto) — NUNCA contra lo que
--    el cliente diga que "antes" había, evitando que una solicitud directa
--    fabrique una corrección ficticia. Si no hay cambio real:
--      - no exige comentario,
--      - no escribe nota_delegado ni cambia estado_nota_delegado,
--      - no inserta fila en el historial ni en la auditoría de Delegado.
--    Esto aplica igual sin importar el estado previo (historica_sin_
--    clasificar, automatica o corregida_admin ya existentes) — reenviar el
--    mismo valor nunca es una "corrección", sea cual sea su origen.
--    REGLA PRINCIPAL: el administrador SIEMPRE puede escribir un valor
--    DISTINTO, en cualquier estado previo — nunca se exige confirmación ni
--    se bloquea por estar ya protegida, a diferencia de Comisión.
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID);

CREATE OR REPLACE FUNCTION actualizar_notas_secundarias_con_auditoria(
    p_rodeo_id UUID,
    p_actualizar_comision BOOLEAN,
    p_nota_comision NUMERIC,
    p_actualizar_delegado BOOLEAN,
    p_nota_delegado NUMERIC,
    p_confirma_sobrescritura_historica BOOLEAN,
    p_motivo TEXT,
    p_administrador_id UUID,
    p_comentario_delegado TEXT DEFAULT NULL
) RETURNS rodeo_notas_secundarias AS $$
DECLARE
    v_anterior RECORD;
    v_fila rodeo_notas_secundarias;
    v_estado_protegido BOOLEAN;
    v_delegado_cambio_real BOOLEAN;
BEGIN
    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    SELECT * INTO v_anterior FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id FOR UPDATE;

    IF p_actualizar_comision THEN
        IF v_anterior.requiere_revision_admin IS TRUE THEN
            RAISE EXCEPTION 'REQUIERE_RESOLUCION_ADMINISTRATIVA_PRIMERO';
        END IF;
        v_estado_protegido := COALESCE(v_anterior.estado_nota_comision, 'sin_evaluar') IN ('historica_sin_desglose', 'completa', 'corregida_admin');
        IF v_estado_protegido THEN
            IF NOT p_confirma_sobrescritura_historica THEN
                RAISE EXCEPTION 'NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION';
            END IF;
            IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN
                RAISE EXCEPTION 'MOTIVO_OBLIGATORIO';
            END IF;
            IF p_nota_comision IS NULL OR p_nota_comision < 1.0 OR p_nota_comision > 7.0 THEN
                RAISE EXCEPTION 'NOTA_FUERA_DE_RANGO';
            END IF;
        END IF;
    END IF;

    -- AJUSTE 1: "cambio real" = valor numérico distinto del ya guardado
    -- (NULL anterior + un valor nuevo real también cuenta como cambio).
    v_delegado_cambio_real := false;
    IF p_actualizar_delegado THEN
        IF p_nota_delegado IS NULL OR p_nota_delegado < 1.0 OR p_nota_delegado > 7.0 THEN
            RAISE EXCEPTION 'NOTA_DELEGADO_FUERA_DE_RANGO';
        END IF;
        v_delegado_cambio_real := (v_anterior.nota_delegado IS DISTINCT FROM p_nota_delegado);
        IF v_delegado_cambio_real THEN
            IF p_comentario_delegado IS NULL OR btrim(p_comentario_delegado) = '' THEN
                RAISE EXCEPTION 'COMENTARIO_DELEGADO_OBLIGATORIO';
            END IF;
        END IF;
    END IF;

    INSERT INTO rodeo_notas_secundarias (rodeo_id, nota_comision, nota_delegado, estado_nota_comision, estado_nota_delegado, actualizado_por, actualizado_en, updated_at)
    VALUES (
        p_rodeo_id,
        CASE WHEN p_actualizar_comision THEN p_nota_comision ELSE NULL END,
        CASE WHEN v_delegado_cambio_real THEN p_nota_delegado ELSE NULL END,
        CASE WHEN p_actualizar_comision THEN 'corregida_admin' ELSE 'sin_evaluar' END,
        CASE WHEN v_delegado_cambio_real THEN 'corregida_admin' ELSE 'historica_sin_clasificar' END,
        p_administrador_id::text, now(), now()
    )
    ON CONFLICT (rodeo_id) DO UPDATE SET
        nota_comision = CASE WHEN p_actualizar_comision THEN EXCLUDED.nota_comision ELSE rodeo_notas_secundarias.nota_comision END,
        nota_delegado = CASE WHEN v_delegado_cambio_real THEN EXCLUDED.nota_delegado ELSE rodeo_notas_secundarias.nota_delegado END,
        estado_nota_comision = CASE WHEN p_actualizar_comision THEN 'corregida_admin' ELSE rodeo_notas_secundarias.estado_nota_comision END,
        estado_nota_delegado = CASE WHEN v_delegado_cambio_real THEN 'corregida_admin' ELSE rodeo_notas_secundarias.estado_nota_delegado END,
        actualizado_por = p_administrador_id::text,
        actualizado_en = now(),
        updated_at = now()
    RETURNING * INTO v_fila;

    IF p_actualizar_comision THEN
        INSERT INTO comision_evaluaciones_correcciones (rodeo_id, evaluacion_id, motivo, datos_anteriores, datos_nuevos, administrador_id)
        VALUES (p_rodeo_id, NULL, p_motivo, to_jsonb(v_anterior), to_jsonb(v_fila), p_administrador_id);
    END IF;

    -- Delegado (088): historial dedicado append-only + auditoría genérica,
    -- SOLO ante cambio real (AJUSTE 1) — nunca una fila por un reenvío del
    -- mismo valor.
    IF v_delegado_cambio_real THEN
        INSERT INTO rodeo_notas_delegado_correcciones (rodeo_id, nota_anterior, nota_nueva, comentario, administrador_id, origen_administrativo)
        VALUES (p_rodeo_id, v_anterior.nota_delegado, p_nota_delegado, p_comentario_delegado, p_administrador_id, 'notas_secundarias_admin');

        INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
        VALUES ('rodeo_notas_secundarias', p_rodeo_id::text, 'corregir_nota_delegado',
            jsonb_build_object('nota_delegado', v_anterior.nota_delegado),
            jsonb_build_object('nota_delegado', p_nota_delegado),
            p_administrador_id::text, 'administrador', p_comentario_delegado);
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES ('rodeo_notas_secundarias', p_rodeo_id::text, 'editar',
        to_jsonb(v_anterior), to_jsonb(v_fila), p_administrador_id::text, 'administrador', p_motivo);

    RETURN v_fila;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION actualizar_notas_secundarias_con_auditoria IS
    'Comisión (079) y Delegado (088) independientes, nunca uno limpia al otro. Comisión: exige confirmación explícita + motivo real para sobrescribir una nota protegida, rechaza si hay revisión administrativa pendiente. Delegado: el administrador SIEMPRE puede escribir un valor distinto (nunca se bloquea); exige comentario real SOLO si el valor numérico efectivamente cambia (nunca ante un reenvío del mismo valor); cada cambio real deja una fila nueva en rodeo_notas_delegado_correcciones además de la auditoría genérica.';

-- ─────────────────────────────────────────────────────────────────────────
-- D) Sincronización automática desde la cartilla digital — reemplaza el
--    UPSERT directo que hacía services/cartillaDelegadoNotas.js desde Node.
--    Verificación + escritura atómicas en una sola transacción (candado
--    FOR UPDATE sobre rodeos primero, igual orden que la RPC administrativa
--    de arriba). Nunca toca nota_comision/estado_nota_comision.
--
--    AJUSTE 2: distingue 4 resultados posibles (nunca un solo booleano):
--      'aplicada'                          -> se sincronizó normalmente.
--      'omitida_borrador_incompleto'       -> no había nota que sincronizar.
--      'omitida_proteccion_administrativa' -> ya hay una corrección admin.
--      'omitida_historica_sin_clasificar'  -> nota histórica preexistente de
--                                             origen no verificado; nunca se
--                                             sobrescribe en silencio.
--    Un error técnico (ej. BD caída) nunca es parte de este enum: sigue
--    propagándose como excepción real, capturada por el servicio Node.
--    Una fila con nota_delegado NULL (sin nota real, aunque su estado haya
--    quedado en 'historica_sin_clasificar' por el ADD COLUMN) SÍ permite la
--    primera sincronización con normalidad — no hay nada que proteger.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sincronizar_nota_delegado_automatica(
    p_rodeo_id UUID,
    p_nota_delegado NUMERIC,
    p_actor_id TEXT
) RETURNS TABLE (resultado TEXT, nota_delegado_vigente NUMERIC) AS $$
DECLARE
    v_estado TEXT;
    v_nota_actual NUMERIC;
BEGIN
    -- Borrador incompleto (nunca hay nada que sincronizar) — nunca toca la BD.
    IF p_nota_delegado IS NULL THEN
        RETURN QUERY SELECT 'omitida_borrador_incompleto'::TEXT, NULL::NUMERIC;
        RETURN;
    END IF;
    IF p_nota_delegado < 1.0 OR p_nota_delegado > 7.0 THEN
        RAISE EXCEPTION 'NOTA_DELEGADO_FUERA_DE_RANGO';
    END IF;

    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;

    SELECT estado_nota_delegado, nota_delegado INTO v_estado, v_nota_actual
    FROM rodeo_notas_secundarias WHERE rodeo_id = p_rodeo_id FOR UPDATE;

    -- Solo bloquea si HAY una nota real que proteger — una fila sin
    -- nota_delegado (NULL) nunca bloquea la primera sincronización, aunque
    -- su estado haya quedado en 'historica_sin_clasificar' por el ADD
    -- COLUMN de esta migración.
    IF v_nota_actual IS NOT NULL AND v_estado = 'corregida_admin' THEN
        RETURN QUERY SELECT 'omitida_proteccion_administrativa'::TEXT, v_nota_actual;
        RETURN;
    END IF;
    IF v_nota_actual IS NOT NULL AND v_estado = 'historica_sin_clasificar' THEN
        RETURN QUERY SELECT 'omitida_historica_sin_clasificar'::TEXT, v_nota_actual;
        RETURN;
    END IF;

    INSERT INTO rodeo_notas_secundarias (rodeo_id, nota_delegado, estado_nota_delegado, actualizado_por, actualizado_en, updated_at)
    VALUES (p_rodeo_id, p_nota_delegado, 'automatica', p_actor_id, now(), now())
    ON CONFLICT (rodeo_id) DO UPDATE SET
        nota_delegado = EXCLUDED.nota_delegado,
        estado_nota_delegado = 'automatica',
        actualizado_por = EXCLUDED.actualizado_por,
        actualizado_en = now(),
        updated_at = now();

    RETURN QUERY SELECT 'aplicada'::TEXT, p_nota_delegado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sincronizar_nota_delegado_automatica IS
    '088: sincronización automática de Nota Delegado desde una cartilla digital, al enviar/reenviar. Verificación + escritura atómicas (candado FOR UPDATE). resultado distingue: aplicada / omitida_borrador_incompleto / omitida_proteccion_administrativa / omitida_historica_sin_clasificar. Una nota histórica preexistente de origen no verificado nunca se sobrescribe en silencio, igual que una corrección administrativa. Nunca toca nota_comision.';

-- ─────────────────────────────────────────────────────────────────────────
-- Permisos — mismo patrón ya establecido (085/087): REVOKE explícito antes
-- de GRANT (un GRANT nunca elimina privilegios previamente concedidos por
-- ALTER DEFAULT PRIVILEGES a nivel de esquema).
-- ─────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION sincronizar_nota_delegado_automatica(UUID, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sincronizar_nota_delegado_automatica(UUID, NUMERIC, TEXT) TO service_role;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- AJUSTE 3: fuerza la recarga inmediata de la caché de esquema de
-- PostgREST (Supabase) tras cambiar la firma de una función RPC — sin
-- esto, el recálculo automático de PostgREST podría demorar y, mientras
-- tanto, las llamadas a la función nueva (con el parámetro adicional)
-- podrían fallar con "could not find function" aunque la función ya exista
-- en la base. Deliberadamente fuera del BEGIN/COMMIT (es una notificación,
-- no una operación transaccional) — idempotente, seguro de repetir.
-- ─────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────
-- Verificación
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    RAISE NOTICE 'columna estado_nota_delegado existe: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'rodeo_notas_secundarias' AND column_name = 'estado_nota_delegado'
        ));
    RAISE NOTICE 'tabla rodeo_notas_delegado_correcciones existe: %',
        (SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'rodeo_notas_delegado_correcciones'
        ));
    -- Confirma que las notas históricas preexistentes (94 en producción al
    -- momento de escribir esta migración) quedaron protegidas y con su
    -- valor intacto: nunca "automatica", nunca NULL.
    RAISE NOTICE 'filas con nota_delegado preexistente marcadas historica_sin_clasificar: % (de % con nota_delegado no nulo)',
        (SELECT count(*) FROM rodeo_notas_secundarias WHERE nota_delegado IS NOT NULL AND estado_nota_delegado = 'historica_sin_clasificar'),
        (SELECT count(*) FROM rodeo_notas_secundarias WHERE nota_delegado IS NOT NULL);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Rollback manual (solo si se detecta un problema grave tras aplicar):
--   DROP FUNCTION IF EXISTS sincronizar_nota_delegado_automatica(UUID, NUMERIC, TEXT);
--   DROP FUNCTION IF EXISTS actualizar_notas_secundarias_con_auditoria(UUID, BOOLEAN, NUMERIC, BOOLEAN, NUMERIC, BOOLEAN, TEXT, UUID, TEXT);
--   -- (habría que recrear la versión de 8 parámetros de la migración 079 si se revierte)
--   NOTIFY pgrst, 'reload schema';
--   DROP TABLE IF EXISTS rodeo_notas_delegado_correcciones;
--   ALTER TABLE rodeo_notas_secundarias DROP CONSTRAINT IF EXISTS rns_estado_nota_delegado_check;
--   ALTER TABLE rodeo_notas_secundarias DROP COLUMN IF EXISTS estado_nota_delegado;
-- ─────────────────────────────────────────────────────────────────────────
