-- ═════════════════════════════════════════════════════════════════════════
-- 101: Resultados de la Serie de Campeones desde la Importación de Control
--      de Gestión (columnas OPCIONALES "1° / 2° / 3° lugar puntaje" de la
--      hoja "Importación sistema").
--
-- Destino: datos_monitor_rodeo.puntaje_oficial_1er / 2do / 3er — las MISMAS
-- columnas que ya edita el Monitor a mano (PUT /admin/rodeos/:id/datos-
-- monitor) y que leen el Reporte Deportivo y la Evaluación Técnica. Son TEXT
-- desde la migración 032: los desempates ("27+8", "27-1", "22+5+3") se
-- guardan tal cual, nunca como número. Esta migración NO cambia el esquema
-- de ninguna tabla: solo agrega una RPC.
--
-- RPC aplicar_resultados_serie_campeones_rodeo — una transacción por rodeo:
--   1. Valida el formato de cada puntaje (dígitos con desempates +N / -N).
--      NULL = "no informado": nunca se convierte en 0 ni borra un valor.
--   2. Comprueba que el rodeo exista y no esté anulado (bloqueo FOR SHARE).
--   3. Bloquea la fila de datos_monitor_rodeo (FOR UPDATE; la crea vacía si
--      no existía) y decide LUGAR POR LUGAR con el valor VIGENTE en ese
--      instante (no con el que vio la previsualización):
--        - Excel vacío                         -> no_informado (no se toca)
--        - actual vacío                        -> importado
--        - actual = Excel (sin espacios)       -> igual (no se toca)
--        - actual distinto, sin p_reemplazar   -> conflicto_conservado
--        - actual distinto, con p_reemplazar y el actual sigue siendo el que
--          el administrador vio en la previsualización (p_esperados)
--                                              -> reemplazado
--        - actual distinto, con p_reemplazar, pero cambió desde la
--          previsualización                    -> conflicto_cambio_concurrente
--          (se conserva: nunca se pisa un valor que el administrador no vio)
--   4. Si cambió algo, actualiza SOLO las columnas de puntaje (+ updated_at;
--      comentario_monitor y control_gestion_ultimo_bloque nunca se tocan) y
--      registra en `auditoria` los valores anteriores y nuevos, en la misma
--      transacción.
--
-- No crea situaciones (control_gestion_situaciones) ni toca la RPC
-- confirmar_control_gestion_rodeo (migración 056): los resultados NO son
-- situaciones de Control de Gestión.
--
-- Seguridad: SECURITY INVOKER, search_path fijo, EXECUTE solo service_role
-- (el backend ya exige Monitor o Administrador pleno en la ruta).
-- Idempotente: CREATE OR REPLACE.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.aplicar_resultados_serie_campeones_rodeo(
    p_rodeo_id       UUID,
    p_puntajes       TEXT[],
    p_reemplazar     BOOLEAN,
    p_esperados      TEXT[],
    p_importacion_id UUID,
    p_actor_id       UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_estado_rodeo TEXT;
    v_fila         public.datos_monitor_rodeo%ROWTYPE;
    v_actuales     TEXT[];
    v_finales      TEXT[];
    v_nuevo        TEXT;
    v_actual       TEXT;
    v_esperado     TEXT;
    v_estado       TEXT;
    v_lugares      JSONB := '[]'::jsonb;
    v_cambio       BOOLEAN := false;
    v_informados   INTEGER := 0;
    i              INTEGER;
BEGIN
    IF p_actor_id IS NULL THEN RAISE EXCEPTION 'ACTOR_REQUERIDO'; END IF;
    IF p_rodeo_id IS NULL THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;
    IF p_puntajes IS NULL OR array_length(p_puntajes, 1) IS DISTINCT FROM 3 THEN
        RAISE EXCEPTION 'PUNTAJES_INVALIDOS: se esperan exactamente 3 lugares';
    END IF;
    IF COALESCE(p_reemplazar, false)
       AND (p_esperados IS NULL OR array_length(p_esperados, 1) IS DISTINCT FROM 3) THEN
        RAISE EXCEPTION 'ESPERADOS_REQUERIDOS';
    END IF;

    FOR i IN 1..3 LOOP
        v_nuevo := NULLIF(regexp_replace(COALESCE(p_puntajes[i], ''), '\s+', '', 'g'), '');
        IF v_nuevo IS NOT NULL THEN
            v_informados := v_informados + 1;
            IF length(v_nuevo) > 30 OR v_nuevo !~ '^[0-9]+([+-][0-9]+)*$' THEN
                RAISE EXCEPTION 'PUNTAJE_FORMATO_INVALIDO: lugar %', i;
            END IF;
        END IF;
    END LOOP;
    IF v_informados = 0 THEN RAISE EXCEPTION 'SIN_RESULTADOS'; END IF;

    SELECT estado INTO v_estado_rodeo FROM public.rodeos WHERE id = p_rodeo_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'RODEO_NO_ENCONTRADO'; END IF;
    IF v_estado_rodeo IS DISTINCT FROM 'activo' THEN RAISE EXCEPTION 'RODEO_ANULADO'; END IF;

    INSERT INTO public.datos_monitor_rodeo (rodeo_id) VALUES (p_rodeo_id)
    ON CONFLICT (rodeo_id) DO NOTHING;
    SELECT * INTO v_fila FROM public.datos_monitor_rodeo WHERE rodeo_id = p_rodeo_id FOR UPDATE;

    v_actuales := ARRAY[v_fila.puntaje_oficial_1er, v_fila.puntaje_oficial_2do, v_fila.puntaje_oficial_3er];
    v_finales  := v_actuales;

    FOR i IN 1..3 LOOP
        v_nuevo    := NULLIF(regexp_replace(COALESCE(p_puntajes[i], ''), '\s+', '', 'g'), '');
        v_actual   := NULLIF(regexp_replace(COALESCE(v_actuales[i], ''), '\s+', '', 'g'), '');
        v_esperado := CASE WHEN p_esperados IS NULL THEN NULL
                           ELSE NULLIF(regexp_replace(COALESCE(p_esperados[i], ''), '\s+', '', 'g'), '') END;

        IF v_nuevo IS NULL THEN
            v_estado := 'no_informado';
        ELSIF v_actual IS NULL THEN
            v_estado := 'importado';
            v_finales[i] := v_nuevo;
        ELSIF v_actual = v_nuevo THEN
            v_estado := 'igual';
        ELSIF COALESCE(p_reemplazar, false) AND v_esperado IS NOT DISTINCT FROM v_actual THEN
            v_estado := 'reemplazado';
            v_finales[i] := v_nuevo;
        ELSIF COALESCE(p_reemplazar, false) THEN
            v_estado := 'conflicto_cambio_concurrente';
        ELSE
            v_estado := 'conflicto_conservado';
        END IF;

        IF v_estado IN ('importado', 'reemplazado') THEN v_cambio := true; END IF;

        v_lugares := v_lugares || jsonb_build_object(
            'lugar', i, 'estado', v_estado,
            'anterior', v_actuales[i], 'excel', v_nuevo, 'final', v_finales[i]
        );
    END LOOP;

    IF v_cambio THEN
        UPDATE public.datos_monitor_rodeo
        SET puntaje_oficial_1er = v_finales[1],
            puntaje_oficial_2do = v_finales[2],
            puntaje_oficial_3er = v_finales[3],
            updated_at          = now()
        WHERE rodeo_id = p_rodeo_id;

        INSERT INTO public.auditoria (
            tabla, registro_id, accion, datos_anteriores, datos_nuevos,
            actor_id, actor_tipo, descripcion
        ) VALUES (
            'datos_monitor_rodeo', p_rodeo_id::text, 'importar_resultados_serie_campeones',
            jsonb_build_object('puntaje_oficial_1er', v_actuales[1],
                               'puntaje_oficial_2do', v_actuales[2],
                               'puntaje_oficial_3er', v_actuales[3]),
            jsonb_build_object('puntaje_oficial_1er', v_finales[1],
                               'puntaje_oficial_2do', v_finales[2],
                               'puntaje_oficial_3er', v_finales[3],
                               'importacion_id', p_importacion_id,
                               'reemplazo_autorizado', COALESCE(p_reemplazar, false)),
            p_actor_id::text, 'administrador',
            'Resultados Serie de Campeones importados desde Control de Gestión'
        );
    END IF;

    RETURN jsonb_build_object('rodeo_id', p_rodeo_id, 'cambio', v_cambio, 'lugares', v_lugares);
END;
$$;

COMMENT ON FUNCTION public.aplicar_resultados_serie_campeones_rodeo(UUID, TEXT[], BOOLEAN, TEXT[], UUID, UUID) IS
    'Migración 101: aplica los puntajes 1°/2°/3° de la Serie de Campeones importados desde Control de Gestión en datos_monitor_rodeo. Nunca sobrescribe un valor existente distinto salvo reemplazo explícito sobre el valor que el administrador vio; vacío = no informado. Audita en la misma transacción.';

REVOKE ALL ON FUNCTION public.aplicar_resultados_serie_campeones_rodeo(UUID, TEXT[], BOOLEAN, TEXT[], UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.aplicar_resultados_serie_campeones_rodeo(UUID, TEXT[], BOOLEAN, TEXT[], UUID, UUID)
    TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
