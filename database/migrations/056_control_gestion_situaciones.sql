-- ═════════════════════════════════════════════════════════════════════════
-- 056_control_gestion_situaciones.sql
-- Importación de Control de Gestión (Excel generado por GPT desde el chat
-- de WhatsApp de los jurados) — cabecera de trazabilidad + detalle de
-- situaciones, y la función que aplica ambos cambios de forma atómica.
--
-- ✅ APLICADA EN PRODUCCIÓN (aplicada vía MCP Supabase apply_migration el
--    2026-09-23, con precheck/postcheck de solo lectura antes y después,
--    mismo protocolo que 050-055; conteos PRE/POST de importaciones y
--    datos_monitor_rodeo verificados idénticos — 0 filas alteradas; RPC y
--    grants verificados leyendo la definición REAL instalada, no solo el
--    archivo local. NO volver a ejecutarla.
--
-- ─────────────────────────────────────────────────────────────────────────
-- A. importaciones.tipo — aditiva, distingue Rodeos de Control de Gestión
-- ─────────────────────────────────────────────────────────────────────────
-- Todas las filas históricas de `importaciones` son, por definición, del
-- importador de Rodeos (el único que existía) — DEFAULT 'rodeos' las deja
-- exactamente igual sin tocarlas una por una.
ALTER TABLE importaciones
    ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'rodeos';

ALTER TABLE importaciones
    DROP CONSTRAINT IF EXISTS chk_importaciones_tipo;
ALTER TABLE importaciones
    ADD CONSTRAINT chk_importaciones_tipo CHECK (tipo IN ('rodeos', 'control_gestion'));

-- ─────────────────────────────────────────────────────────────────────────
-- B. control_gestion_situaciones — detalle de cada situación importada
-- ─────────────────────────────────────────────────────────────────────────
-- rodeo_id ON DELETE CASCADE: mismo criterio que adjuntos_rodeo/cartillas_
-- jurado/cartilla_delegado (migraciones 004/018/037) para datos que viven
-- exclusivamente "dentro" de un rodeo. rodeos.estado='anulado' es un soft
-- delete (la fila nunca se borra realmente), así que en la práctica este
-- CASCADE no se dispara en el flujo normal.
--
-- importacion_id sin ON DELETE explícito (comportamiento por defecto de
-- Postgres = NO ACTION/RESTRICT, mismo patrón que propuestas_designacion.
-- configuracion_version_id de la migración 050): no existe endpoint que
-- borre filas de `importaciones`, así que esto es solo una salvaguarda.
--
-- fingerprint: NUNCA se recibe del cliente/Excel — el backend la calcula
-- (ver services/controlGestion.js, calcularFingerprint()) a partir de
-- rodeo_id + fecha_situacion + hora + un NÚCLEO priorizado hacia el dato más
-- crudo/estable del chat: evidencia_textual normalizada si existe, si no
-- lineas_chat normalizada, y SOLO si ambas vienen vacías un respaldo con
-- categoría+subcategoría+jurado+descripción (más débil, documentado como
-- limitación conocida). NUNCA se basa principalmente en descripcion_
-- unificada — es la redactada por GPT en cada corrida y puede parafrasearse
-- distinto para el mismo hecho real entre una exportación y otra.
-- id_situacion_excel se conserva por trazabilidad (para saber qué SIT-XXX
-- generó GPT) pero NUNCA participa en la deduplicación — dos exportaciones
-- del mismo chat pueden numerar la misma situación como SIT-007 la primera
-- vez y SIT-008 la segunda; el UNIQUE real vive en (rodeo_id, fingerprint).
-- confianza / incluir_en_comentario (Fase 2.1.1 — Punto 6 y Punto 4):
-- columnas del contrato oficial CG-1.0 que NO estaban en el primer diseño.
-- confianza: TEXT libre, SIN CHECK — el Prompt Maestro V2 espera
-- Alta/Media/Baja/Pendiente, pero un valor inesperado de GPT NO debe
-- bloquear la importación ("no necesariamente bloquea por sí sola", pedido
-- explícito) — una CHECK constraint SÍ la bloquearía a nivel de base de
-- datos, por eso se documenta el valor esperado solo en comentario.
-- incluir_en_comentario: BOOLEAN — Sí/No del Excel ya normalizado por el
-- backend antes de llegar aquí; NUNCA afecta comentario_monitor (ese texto
-- sigue viniendo verbatim de "Texto comentario monitor", Punto 9/11), se
-- persiste únicamente para detalle/auditoría (Punto 4).
-- club/asociacion/fecha_rodeo/jurado_oficial de la situación NO se
-- duplican aquí — son derivables por relación con `rodeos` vía rodeo_id
-- (permitido explícitamente, Punto 8); el parser sí los lee y cruza contra
-- su fila antes de llegar a este INSERT (ver cruzarSituacionesConFila).
CREATE TABLE IF NOT EXISTS control_gestion_situaciones (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id               UUID        NOT NULL REFERENCES rodeos(id) ON DELETE CASCADE,
    importacion_id         UUID        REFERENCES importaciones(id),
    id_situacion_excel     TEXT        NOT NULL,
    fingerprint            TEXT        NOT NULL,
    fecha_situacion        DATE,
    hora                   TEXT,
    area                   TEXT,
    categoria_principal    TEXT,
    subcategoria           TEXT,
    impacto                TEXT,
    descripcion_unificada  TEXT,
    estado_resultado       TEXT,
    incluir_en_comentario  BOOLEAN,
    confianza              TEXT,
    jurado_chat            TEXT,
    lineas_chat            TEXT,
    evidencia_textual      TEXT,
    clave_vinculacion      TEXT,
    version_formato        TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by             UUID        REFERENCES administradores(id),

    CONSTRAINT uq_control_gestion_situacion_fingerprint UNIQUE (rodeo_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_cg_situaciones_rodeo ON control_gestion_situaciones(rodeo_id);
CREATE INDEX IF NOT EXISTS idx_cg_situaciones_importacion ON control_gestion_situaciones(importacion_id);

-- ─────────────────────────────────────────────────────────────────────────
-- C. datos_monitor_rodeo.control_gestion_ultimo_bloque — aditiva
-- ─────────────────────────────────────────────────────────────────────────
-- JUSTIFICACIÓN (revisión post-implementación, caso "A+B -> A+B+C"): con
-- `comentario_monitor` como un único TEXT sin estructura, no hay forma
-- confiable de distinguir "texto manual del administrador" de "el último
-- bloque compacto que escribió Control de Gestión" — si GPT reprocesa el
-- mismo rodeo y ahora consolida A+B+C (antes A+B), la acción "Agregar"
-- terminaría concatenando un bloque nuevo encima del anterior, duplicando
-- información sobre los mismos hechos.
--
-- Esta columna guarda EXACTAMENTE el último bloque compacto (el mismo texto
-- de construirComentarioCompacto()) que Control de Gestión escribió para
-- ese rodeo — nada más. Con eso, la próxima vez que "Agregar" encuentre que
-- comentario_monitor contiene ese bloque exacto, lo REEMPLAZA por el nuevo
-- consolidado en el mismo lugar (en vez de concatenar), preservando intacto
-- cualquier texto manual alrededor. Si el administrador editó o borró ese
-- bloque manualmente, la coincidencia exacta deja de encontrarse y el
-- sistema vuelve al comportamiento seguro por defecto: agregar al final.
--
-- Nullable, sin DEFAULT, aditiva — las filas históricas (todas manuales)
-- quedan en NULL, comportándose exactamente como antes (agregar al final).
-- Solo la RPC de abajo escribe esta columna; PUT /admin/rodeos/:id/datos-
-- monitor (guardado manual, sin cambios) nunca la incluye en su payload, así
-- que nunca la toca -- ni para leerla ni para modificarla.
ALTER TABLE datos_monitor_rodeo
    ADD COLUMN IF NOT EXISTS control_gestion_ultimo_bloque TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- D. RPC confirmar_control_gestion_rodeo — unidad atómica POR RODEO
-- ─────────────────────────────────────────────────────────────────────────
-- Supabase-js no expone transacciones reales entre llamadas REST separadas
-- (cada .from(...) es un round-trip HTTP independiente) — la única forma de
-- garantizar que "actualizar comentario_monitor" + "insertar situaciones"
-- queden consistentes (todo o nada) es una función PL/pgSQL: una función es,
-- por definición, una única transacción implícita — si cualquier sentencia
-- interna falla, TODO su efecto se revierte automáticamente. Mismo patrón
-- que activar_configuracion_designacion() (migración 050).
--
-- p_comentario_final YA viene resuelto (con el merge Agregar/Reemplazar/
-- reemplazo-de-bloque ya aplicado por construirComentarioFinal() en JS) —
-- esta función NO decide la estrategia de merge, solo escribe de forma
-- atómica. Actualiza EXCLUSIVAMENTE comentario_monitor y control_gestion_
-- ultimo_bloque: el INSERT ... ON CONFLICT DO UPDATE solo trae esas dos
-- columnas en su SET, así que puntaje_oficial_1er/2do/3er de una fila
-- EXISTENTE nunca se tocan; y en una fila NUEVA quedan en NULL (el DEFAULT
-- de la columna) — nunca se inventa un valor.
--
-- ORDEN IMPORTANTE (revisión post-implementación, "sin novedad"): las
-- situaciones se insertan PRIMERO — así se sabe, ANTES de decidir si tocar
-- el comentario, si hubo al menos una situación realmente NUEVA. Si
-- p_es_agregar=true y TODAS las situaciones entrantes ya existían
-- (v_insertadas=0 habiendo enviado al menos una), el comentario NO se
-- toca — evita que reprocesar el mismo chat, con una redacción de resumen
-- ligeramente distinta, siga agregando bloques sobre los mismos hechos ya
-- registrados. p_es_agregar=false (Reemplazar) siempre escribe: es una
-- decisión explícita del administrador, no un merge automático.
--
-- p_situaciones es un array JSONB de objetos ya validados y con fingerprint
-- ya calculado por el backend (nunca confiar en un fingerprint externo,
-- pero aquí ya llega calculado por controlGestion.js antes de invocar la
-- RPC — la función solo persiste, no recalcula). ON CONFLICT (rodeo_id,
-- fingerprint) DO NOTHING: una situación que ya existía con el mismo
-- fingerprint no se duplica ni se sobrescribe — se cuenta como "duplicada",
-- NUNCA como un error (es el comportamiento esperado de una reimportación).
--
-- Retorna { comentario_actualizado, situaciones_insertadas,
--           situaciones_duplicadas, sin_novedad }.
CREATE OR REPLACE FUNCTION confirmar_control_gestion_rodeo(
    p_rodeo_id          UUID,
    p_comentario_final  TEXT,
    p_bloque_cg         TEXT,
    p_es_agregar        BOOLEAN,
    p_situaciones       JSONB,
    p_importacion_id    UUID,
    p_actor_id          UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_comentario_actualizado BOOLEAN := false;
    v_insertadas INTEGER := 0;
    v_duplicadas INTEGER := 0;
    v_sin_novedad BOOLEAN := false;
    v_situacion JSONB;
    v_filas_afectadas INTEGER;
BEGIN
    -- 1) Situaciones PRIMERO — determina si hubo novedad real.
    IF p_situaciones IS NOT NULL THEN
        FOR v_situacion IN SELECT * FROM jsonb_array_elements(p_situaciones)
        LOOP
            INSERT INTO control_gestion_situaciones (
                rodeo_id, importacion_id, id_situacion_excel, fingerprint,
                fecha_situacion, hora, area, categoria_principal, subcategoria,
                impacto, descripcion_unificada, estado_resultado,
                incluir_en_comentario, confianza, jurado_chat,
                lineas_chat, evidencia_textual, clave_vinculacion, version_formato,
                created_by
            ) VALUES (
                p_rodeo_id, p_importacion_id,
                v_situacion->>'id_situacion_excel', v_situacion->>'fingerprint',
                NULLIF(v_situacion->>'fecha_situacion', '')::DATE,
                v_situacion->>'hora', v_situacion->>'area',
                v_situacion->>'categoria_principal', v_situacion->>'subcategoria',
                v_situacion->>'impacto', v_situacion->>'descripcion_unificada',
                v_situacion->>'estado_resultado',
                (v_situacion->>'incluir_en_comentario')::BOOLEAN, v_situacion->>'confianza',
                v_situacion->>'jurado_chat',
                v_situacion->>'lineas_chat', v_situacion->>'evidencia_textual',
                v_situacion->>'clave_vinculacion', v_situacion->>'version_formato',
                p_actor_id
            )
            ON CONFLICT (rodeo_id, fingerprint) DO NOTHING;

            GET DIAGNOSTICS v_filas_afectadas = ROW_COUNT;
            IF v_filas_afectadas > 0 THEN
                v_insertadas := v_insertadas + 1;
            ELSE
                v_duplicadas := v_duplicadas + 1;
            END IF;
        END LOOP;
    END IF;

    -- "Sin novedad" = se enviaron situaciones, pero TODAS ya existían.
    v_sin_novedad := (COALESCE(jsonb_array_length(p_situaciones), 0) > 0) AND (v_insertadas = 0);

    -- 2) Comentario — se salta SOLO si Agregar Y sin novedad; Reemplazar
    -- siempre escribe (decisión explícita del administrador).
    IF p_comentario_final IS NOT NULL AND NOT (p_es_agregar AND v_sin_novedad) THEN
        INSERT INTO datos_monitor_rodeo (rodeo_id, comentario_monitor, control_gestion_ultimo_bloque, updated_at)
        VALUES (p_rodeo_id, p_comentario_final, p_bloque_cg, now())
        ON CONFLICT (rodeo_id) DO UPDATE
            SET comentario_monitor = EXCLUDED.comentario_monitor,
                control_gestion_ultimo_bloque = EXCLUDED.control_gestion_ultimo_bloque,
                updated_at = EXCLUDED.updated_at;
        v_comentario_actualizado := true;
    END IF;

    RETURN jsonb_build_object(
        'comentario_actualizado', v_comentario_actualizado,
        'situaciones_insertadas', v_insertadas,
        'situaciones_duplicadas', v_duplicadas,
        'sin_novedad', v_sin_novedad
    );
END;
$$;

-- Mismo criterio de permisos que el resto de funciones RPC del proyecto
-- (migración 050): revocada de PUBLIC/anon/authenticated, otorgada
-- explícitamente a service_role (el backend siempre usa la service_role key,
-- nunca la anon key — verificado en INSTRUCCIONES.md sección 11).
REVOKE ALL ON FUNCTION confirmar_control_gestion_rodeo(UUID, TEXT, TEXT, BOOLEAN, JSONB, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION confirmar_control_gestion_rodeo(UUID, TEXT, TEXT, BOOLEAN, JSONB, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION confirmar_control_gestion_rodeo(UUID, TEXT, TEXT, BOOLEAN, JSONB, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION confirmar_control_gestion_rodeo(UUID, TEXT, TEXT, BOOLEAN, JSONB, UUID, UUID) TO service_role;

-- ── Verificación sugerida post-aplicación (no destructiva) ─────────────────
--
-- SELECT column_name, data_type, column_default FROM information_schema.columns
--   WHERE table_name = 'importaciones' AND column_name = 'tipo';
--   -- debe mostrar default 'rodeos'::text.
--
-- SELECT count(*) FROM importaciones WHERE tipo IS NULL; -- debe ser 0.
--
-- SELECT conname, contype FROM pg_constraint
--   WHERE conrelid = 'control_gestion_situaciones'::regclass AND contype = 'u';
--   -- debe incluir uq_control_gestion_situacion_fingerprint.
--
-- SELECT column_name, is_nullable FROM information_schema.columns
--   WHERE table_name = 'datos_monitor_rodeo' AND column_name = 'control_gestion_ultimo_bloque';
--   -- debe existir, is_nullable = 'YES'.
--
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name = 'control_gestion_situaciones' AND column_name IN ('confianza', 'incluir_en_comentario')
--   ORDER BY column_name;
--   -- confianza: text, YES. incluir_en_comentario: boolean, YES. Ninguna con CHECK.
--
-- SELECT proname, prosecdef FROM pg_proc WHERE proname = 'confirmar_control_gestion_rodeo';
--   -- prosecdef = true (SECURITY DEFINER).
--
-- SELECT grantee, privilege_type FROM information_schema.routine_privileges
--   WHERE routine_name = 'confirmar_control_gestion_rodeo';
--   -- debe mostrar EXECUTE únicamente para service_role (y el owner) — nunca
--   -- para anon/authenticated/PUBLIC.
