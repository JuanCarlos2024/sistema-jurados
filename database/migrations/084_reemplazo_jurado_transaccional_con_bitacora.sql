-- ═════════════════════════════════════════════════════════════════════════
-- 084_reemplazo_jurado_transaccional_con_bitacora.sql
-- Fase 1B — Reemplazos de jurados con trazabilidad transaccional.
--
-- ✅ APLICADA en producción (jurados_2026) el 2026-10-29, con autorización
-- expresa, tras verificación local (113 suites / 2.948 tests) y verificación
-- en vivo post-aplicación (función en INVOKER, EXECUTE solo para
-- service_role, CHECK con los 6 estados esperados, conteos de bonos/
-- asignaciones/notas/cartillas/bitácora sin alteraciones).
--
-- Depende de 083 (bitacora_designaciones, catalogo_motivos_designacion,
-- registrar_movimiento_designacion) — ya viva en producción desde antes,
-- junto con su corrección de permisos (085_fase1a_correccion_privilegios_
-- default_acl.sql, registrada como versión pero ya aplicada previamente).
--
-- ALCANCE: una única función RPC, única vía nueva que conecta el cambio de
-- jurado de una asignación con bitacora_designaciones, garantizando que
-- ambas escrituras (asignación + historial) se confirmen o fallen juntas en
-- la misma transacción de Postgres. Esta migración NO modifica el endpoint
-- PATCH /api/admin/asignaciones/:id existente (sigue intacto, sin bitácora,
-- para no romper nada operativo) — agrega un endpoint NUEVO y adicional
-- (POST .../:id/reemplazar, fuera de esta migración, en el código del
-- backend) que es el único consumidor de esta función. No toca el motor de
-- propuestas, pagos existentes, bonos, cartillas ni evaluaciones.
--
-- ───────────────────────────────────────────────────────────────────────
-- DECISIÓN 1 — Alcance exclusivo a tipo_persona='jurado'. El Delegado
-- Rentado (mismo campo tipo_persona en asignaciones) queda fuera: no tiene
-- cartillas_jurado, no tiene comision_evaluaciones_jurado, y su propio
-- control transaccional (trigger 067) ya opera sobre cualquier UPDATE de
-- asignaciones sin cambios. Mezclar ambos casos en una sola función
-- hubiera requerido replicar ahí lógica ajena (067) sin necesidad real.
--
-- DECISIÓN 2 — Reutiliza registrar_movimiento_designacion(...) (083) para
-- la escritura en bitácora, en vez de duplicar un INSERT propio — misma
-- única vía de escritura que ya reciben todos los demás orígenes futuros
-- (Fase 1B solo agrega UN llamador más, nunca una segunda puerta).
--
-- DECISIÓN 3 — "Antecedentes sensibles" (notas_rodeo, bonos_solicitados
-- activos, cartillas_jurado) BLOQUEAN el reemplazo con un código de error
-- específico, en vez de reasignarlos en silencio al nuevo jurado — no existe
-- todavía una solución de rectificación para esos antecedentes (sección 5
-- del pedido de Fase 1B). comision_evaluaciones_jurado NO se verifica aquí
-- a propósito: la migración 079 (ya viva en producción según verificación
-- de Fase 0, aunque su archivo siga marcado "NO APLICADA" — mismo patrón de
-- documentación desactualizada ya visto en Fase 0 para 047/079) ya
-- desvincula automáticamente, vía trigger AFTER UPDATE sobre asignaciones,
-- cualquier evaluación de Comisión cuando cambia la identidad del jurado de
-- una asignación — bloquear además aquí sería una restricción redundante,
-- no una protección adicional.
--
-- DECISIÓN 4 — Verificación de concurrencia óptima: p_usuario_pagado_id_
-- anterior_esperado (opcional) permite al llamador declarar qué jurado creía
-- vigente al abrir el formulario. Si no coincide con el real al momento de
-- aplicar (otro administrador ya reemplazó esta misma asignación), se
-- aborta con CONFLICTO_DESIGNACION_MODIFICADA — nunca se sobrescribe un
-- reemplazo ajeno sin que el segundo administrador lo sepa. El SELECT...FOR
-- UPDATE sobre la fila de asignaciones (tomado antes de esta comparación)
-- es, en cualquier caso, la garantía real contra una carrera genuina: la
-- segunda transacción concurrente espera a que la primera confirme y
-- siempre relee el valor ya confirmado antes de comparar.
--
-- DECISIÓN 5 — Protección contra dos designaciones vigentes incompatibles:
-- el jurado nuevo no puede ya estar designado vigente (activo, no
-- rechazado) en OTRA asignación del MISMO rodeo — evita terminar con la
-- misma persona ocupando dos cupos de jurado del mismo rodeo por error.
--
-- DECISIÓN 6 — La identidad del jurado nuevo (nombre_importado y el
-- snapshot de la bitácora) se lee SIEMPRE de usuarios_pagados en el momento
-- de la escritura, nunca de un parámetro de texto libre — ningún llamador
-- puede hacer que la asignación o la bitácora registren un nombre que no
-- corresponda al usuario_pagado_id_nuevo real.
--
-- DECISIÓN 7 — categoria_aplicada/valor_diario_aplicado/pago_base_calculado
-- se reciben ya calculados (el backend reutiliza calcularPagoBase/
-- obtenerTarifas — misma función real que ya usa el PATCH existente y el
-- motor de propuestas, nunca una copia de esa lógica en SQL). El CHECK ya
-- existente de asignaciones (categoria_aplicada IN ('A','B','C') o NULL)
-- sigue protegiendo este campo igual que protege cualquier otra escritura.
--
-- DECISIÓN 8 — SECURITY INVOKER (no se declara SECURITY DEFINER), mismo
-- criterio que registrar_movimiento_designacion (083) y las 4 RPC de 071:
-- el único rol con EXECUTE es service_role, que ya tiene GRANT directo
-- sobre todas las tablas que esta función toca — DEFINER no otorgaría
-- ninguna capacidad adicional, solo ampliaría la superficie de ataque.
--
-- DECISIÓN 9 (revisión correctiva) — orden de locks {rodeos, luego
-- asignaciones}, nunca el inverso: se agregó un PERFORM ... FOR UPDATE sobre
-- `rodeos` ANTES de bloquear la fila de `asignaciones`. Sin esto, dos
-- reemplazos concurrentes sobre DOS asignaciones distintas del mismo rodeo
-- (p. ej. ambos intentando designar al mismo jurado nuevo) podían pasar
-- ambos el chequeo JURADO_YA_DESIGNADO_EN_RODEO antes de que el otro
-- confirmara su UPDATE (ventana real bajo READ COMMITTED: un EXISTS sin
-- bloqueo de fila no impide que otra transacción inserte/actualice una fila
-- que lo volvería verdadero). Mismo orden ya documentado y exigido por
-- 067/079 para evitar deadlocks contra sus propias funciones.
--
-- DECISIÓN 10 (revisión correctiva) — el UPDATE ya no deja intactos
-- estado_designacion/aceptado_en/observacion_designacion/distancia_km: el
-- reemplazante siempre queda en estado_designacion='pendiente' (reutiliza
-- la misma semántica que la rama "pendiente" de POST /:id/estado), sin
-- heredar la aceptación/rechazo/kilometraje de la persona anterior —
-- hallazgo de la revisión correctiva de Fase 1B: una aceptación/rechazo
-- pertenece a una identidad, nunca a una fila. `publicado` se conserva
-- intacto a propósito (ver comentario junto al UPDATE).
--
-- LIMITACIÓN DOCUMENTADA — un "enroque" (dos asignaciones que intercambian
-- jurado) requiere DOS llamadas a esta función, una por asignación, con el
-- mismo p_operacion_id para correlacionarlas en la bitácora. Esas dos
-- llamadas NO son conjuntamente atómicas entre sí (cada una sí lo es,
-- íntegramente, por separado) — si la segunda falla tras confirmar la
-- primera, el enroque queda a medias y requiere una corrección manual
-- posterior. Una función dedicada que mueva ambas asignaciones dentro de
-- una sola transacción es un diseño de alcance mayor, no incluido en esta
-- migración — ver el informe de Fase 1B.
--
-- ───────────────────────────────────────────────────────────────────────
-- SEGUNDA REVISIÓN CORRECTIVA — hallazgo real en Supabase (jurados_2026):
-- 37 de 46 designaciones activas futuras (80,4 %) tenían un bono pendiente
-- o aprobado_auto, lo que bloqueaba la gran mayoría de los reemplazos
-- reales (sustituciones habituales el día antes del rodeo). Correcciones:
--
-- DECISIÓN 11 — Tratamiento de bonos ya NO es "bloquear siempre": se
-- distingue por estado real, sin inventar ningún estado de pago que no
-- exista:
--   - 'pendiente' / 'aprobado_auto' (21+16 = 37 de los 46 casos reales):
--     nunca hubo dinero decidido por un administrador (pendiente = sin
--     revisar; aprobado_auto = siempre $0, km<350). Se DESVINCULAN (nuevo
--     valor de estado 'desvinculado_por_cambio_designacion', agregado
--     aditivamente al CHECK — nunca se borran, igual criterio que
--     comision_evaluaciones_jurado.estado='desvinculada_por_cambio_designacion'
--     de la migración 079) — el reemplazo NUNCA se bloquea por esto.
--     usuario_pagado_id de la fila de bonos_solicitados (columna propia,
--     independiente de asignaciones.usuario_pagado_id) ya identifica para
--     siempre al titular original — no requiere ningún snapshot nuevo.
--   - 'aprobado' / 'modificado': un administrador SÍ decidió un monto real
--     (no cero) para esta persona — es la aproximación más honesta
--     disponible de "pago efectivamente autorizado" sin inventar una
--     columna de pago que el sistema nunca tuvo (el sistema no registra
--     "pagado", solo "aprobado para el próximo export"). Sigue
--     bloqueando como ANTECEDENTE_SENSIBLE_BONO — requiere el
--     procedimiento excepcional documentado en el informe de esta ronda.
--   - 'rechazado': sin cambios, nunca bloquea (como ya era).
-- Los bonos desvinculados quedan excluidos de toda agregación de pago:
-- exportacion.js/reportes.js (agregarBonos) usan allowlists positivas
-- (['aprobado','modificado'] o con 'aprobado_auto'), nunca una exclusión
-- negativa de 'rechazado' — un estado nuevo, no listado, se excluye solo,
-- sin tocar esos archivos. bonos.js (aprobar/rechazar) exige
-- estado='pendiente'/IN('pendiente','aprobado','modificado') — un bono
-- desvinculado tampoco puede reabrirse por ahí, sin cambios en ese archivo.
-- Corregido además, en el código del backend (fuera de esta migración):
-- upsertBonoDistanciaAdmin (admin/asignaciones.js) y la búsqueda de
-- POST /admin/bonos/regularizar-distancia filtraban "bono existente" solo
-- por asignacion_id con `estado <> 'rechazado'` — sin excluir el nuevo
-- estado, habrían re-escrito por error la fila histórica desvinculada en
-- vez de crear una solicitud nueva e independiente para el reemplazante.
-- usuario/bonos.js YA filtraba también por usuario_pagado_id (nunca tocaba
-- el problema) — se deja intacto.
--
-- DECISIÓN 12 — notas_rodeo y cartillas_jurado NO se tocan en esta ronda:
-- el hallazgo medido en producción fue específicamente sobre bonos (0
-- designaciones bloqueadas por nota/cartilla en la muestra reportada).
-- Debilitar esos dos controles sin un hallazgo real análogo sería alcance
-- no solicitado — quedan exactamente como en la revisión anterior.
--
-- DECISIÓN 13 — Concurrencia entre RODEOS distintos: el lock de `rodeos`
-- (Decisión 9) solo serializa operaciones sobre el MISMO rodeo — dos
-- reemplazos concurrentes en rodeos DIFERENTES que compiten por el MISMO
-- jurado nuevo (p. ej. mismo fin de semana, fechas cruzadas) no estaban
-- protegidos. Se agrega `pg_advisory_xact_lock` sobre un hash del
-- usuario_pagado_id_nuevo — PRIMERA operación de la función, antes de
-- cualquier otro lock — para serializar TODOS los reemplazos que compitan
-- por la MISMA persona sin importar el rodeo. Un advisory lock vive en un
-- espacio de recursos separado de los locks de fila: no puede formar un
-- ciclo con el orden {rodeos, luego asignaciones} ya establecido (ningún
-- otro código de este proyecto toma advisory locks), y se libera solo al
-- terminar la transacción (variante _xact_, sin necesidad de liberarlo
-- manualmente ni en el camino de error). Con el lock tomado, se agrega una
-- verificación de cruce de fechas contra TODAS las demás asignaciones
-- vigentes de ese jurado en CUALQUIER rodeo (no solo el mismo) — la misma
-- regla que ya aplica POST /admin/asignaciones y /propuestas/:id/aplicar,
-- ahora reforzada aquí DENTRO de la transacción y bajo el lock, para que
-- sea una garantía real y no solo una verificación previa en JavaScript
-- (que por sí sola no alcanza bajo una carrera genuina: ver el chequeo
-- equivalente en el backend, pensado solo como aviso rápido no autoritativo).
-- Limitación reconocida, aceptada por el usuario para proceder con el
-- despliegue: esta migración no pudo verificarse con dos conexiones TCP
-- genuinamente concurrentes antes de aplicarse (no hay un binario de
-- PostgreSQL real disponible en el entorno de desarrollo local) — mismo
-- límite ya documentado y aceptado en 067 (Fase 3.2), donde esa
-- verificación se hizo con un script externo, fuera de la suite
-- automatizada. Script preparado en tests/concurrency/
-- prueba_concurrencia_real_reemplazo.sh, pendiente de ejecutarse cuando el
-- usuario complete su instalación local de PostgreSQL — riesgo residual
-- documentado, no bloqueante por decisión explícita del usuario.
--
-- DECISIÓN 14 (revisión previa al despliegue) — el REVOKE de la función
-- nueva se extendió a incluir explícitamente anon, authenticated y
-- service_role (no solo PUBLIC), replicando la corrección ya aplicada en
-- producción para 083 (fase1a_correccion_privilegios_default_acl): el
-- proyecto jurados_2026 tiene ALTER DEFAULT PRIVILEGES a nivel de esquema
-- que otorga EXECUTE directamente a anon/authenticated (no por herencia de
-- PUBLIC) sobre cualquier función nueva. Revocar solo de PUBLIC habría
-- dejado esta función de reemplazo transaccional ejecutable por roles que
-- nunca debieron tener acceso a ella. Verificado antes de aplicar, no
-- después — a diferencia de 083, donde se detectó post-aplicación.
--
-- Migración envuelta en una transacción explícita. Idempotente: CREATE OR
-- REPLACE FUNCTION es seguro de repetir. Reversible: ver bloque al final.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Decisión 11 — nuevo valor de estado para bonos_solicitados, aditivo
-- (mismo patrón que la migración 012 al agregar 'aprobado_auto'). Nunca se
-- quita ningún valor existente, nunca se tocan filas ya escritas.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE bonos_solicitados DROP CONSTRAINT IF EXISTS bonos_solicitados_estado_check;
ALTER TABLE bonos_solicitados ADD CONSTRAINT bonos_solicitados_estado_check
    CHECK (estado IN ('pendiente', 'aprobado', 'rechazado', 'modificado', 'aprobado_auto', 'desvinculado_por_cambio_designacion'));

CREATE OR REPLACE FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    p_asignacion_id                        UUID,
    p_usuario_pagado_id_nuevo              UUID,
    p_categoria_aplicada_nueva             TEXT,
    p_valor_diario_aplicado_nuevo          INTEGER,
    p_pago_base_calculado_nuevo            INTEGER,
    p_motivo_catalogo_id                   UUID,
    p_actor_id                             UUID,
    p_tipo_movimiento                      TEXT DEFAULT 'reemplazo',
    p_usuario_pagado_id_anterior_esperado  UUID DEFAULT NULL,
    p_motivo_detalle                       TEXT DEFAULT NULL,
    p_fecha_efectiva                       TIMESTAMPTZ DEFAULT NULL,
    p_operacion_id                         UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
-- SECURITY INVOKER (ver Decisión 8).
SET search_path = public
AS $$
DECLARE
    v_rodeo_id         UUID;
    v_rodeo_fecha       DATE;
    v_rodeo_duracion    INTEGER;
    v_anterior         asignaciones%ROWTYPE;
    v_nueva            asignaciones%ROWTYPE;
    v_nuevo_jurado      usuarios_pagados%ROWTYPE;
    v_motivo           catalogo_motivos_designacion%ROWTYPE;
    v_bitacora         bitacora_designaciones;
    v_ya_designado     BOOLEAN;
    v_cruce_otro_rodeo BOOLEAN;
BEGIN
    IF p_tipo_movimiento NOT IN (
        'reemplazo', 'cambio_emergencia', 'regularizacion_posterior',
        'rectificacion_administrativa', 'enroque'
    ) THEN
        RAISE EXCEPTION 'TIPO_MOVIMIENTO_NO_PERMITIDO: % no es válido para un reemplazo transaccional', p_tipo_movimiento;
    END IF;
    IF p_actor_id IS NULL THEN
        RAISE EXCEPTION 'ACTOR_REQUERIDO';
    END IF;
    IF p_usuario_pagado_id_nuevo IS NULL THEN
        RAISE EXCEPTION 'JURADO_NUEVO_REQUERIDO';
    END IF;

    -- Decisión 13 — PRIMERA operación de toda la función: advisory lock
    -- sobre el jurado candidato, para serializar entre sí a TODOS los
    -- reemplazos que compitan por la MISMA persona, sin importar en qué
    -- rodeo. Espacio de recursos separado de los locks de fila de más
    -- abajo — no introduce ningún ciclo de deadlock nuevo.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_usuario_pagado_id_nuevo::text, 0));

    -- Punto de serialización por rodeo (Decisión 9): se bloquea `rodeos`
    -- ANTES que la propia fila de `asignaciones`, mismo orden ya usado por
    -- 067/079 para este mismo rodeo, para que dos reemplazos concurrentes
    -- sobre DOS asignaciones distintas del MISMO rodeo (p. ej. ambos
    -- intentando designar al mismo jurado nuevo) se serialicen entre sí —
    -- nunca ambos pueden pasar el chequeo JURADO_YA_DESIGNADO_EN_RODEO de
    -- más abajo con datos obsoletos. rodeo_id de una asignación es
    -- inmutable (ningún código de este proyecto lo actualiza nunca) — es
    -- seguro leerlo sin lock antes de bloquear `rodeos`.
    SELECT rodeo_id INTO v_rodeo_id FROM asignaciones WHERE id = p_asignacion_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ASIGNACION_NO_ENCONTRADA';
    END IF;
    SELECT fecha, duracion_dias INTO v_rodeo_fecha, v_rodeo_duracion FROM rodeos WHERE id = v_rodeo_id FOR UPDATE;

    -- Bloqueo de concurrencia de la fila afectada (Decisión 4) — en ESTE
    -- orden ({rodeos, luego asignaciones}) nunca en el inverso, para no
    -- introducir un ciclo de deadlock contra 067/079 (ver comentario de
    -- fn_detectar_cambio_designacion_post_evaluacion en 079, que documenta
    -- exactamente este mismo razonamiento).
    SELECT * INTO v_anterior FROM asignaciones WHERE id = p_asignacion_id FOR UPDATE;
    IF v_anterior.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'SOLO_JURADO: esta función solo reemplaza asignaciones de tipo_persona = jurado';
    END IF;
    IF v_anterior.estado = 'anulado' THEN
        RAISE EXCEPTION 'ASIGNACION_ANULADA';
    END IF;

    IF p_usuario_pagado_id_anterior_esperado IS NOT NULL
       AND v_anterior.usuario_pagado_id IS DISTINCT FROM p_usuario_pagado_id_anterior_esperado THEN
        RAISE EXCEPTION 'CONFLICTO_DESIGNACION_MODIFICADA: la asignación ya fue modificada por otro administrador';
    END IF;

    SELECT * INTO v_motivo FROM catalogo_motivos_designacion WHERE id = p_motivo_catalogo_id;
    IF NOT FOUND OR v_motivo.activo IS NOT TRUE THEN
        RAISE EXCEPTION 'MOTIVO_INVALIDO';
    END IF;

    -- Identidad del jurado nuevo SIEMPRE leída de la fuente real (Decisión 6).
    SELECT * INTO v_nuevo_jurado FROM usuarios_pagados WHERE id = p_usuario_pagado_id_nuevo;
    IF NOT FOUND OR v_nuevo_jurado.activo IS NOT TRUE OR v_nuevo_jurado.tipo_persona <> 'jurado' THEN
        RAISE EXCEPTION 'JURADO_NUEVO_INVALIDO';
    END IF;

    IF v_anterior.usuario_pagado_id IS NOT DISTINCT FROM p_usuario_pagado_id_nuevo THEN
        RAISE EXCEPTION 'JURADO_NUEVO_IGUAL_AL_ANTERIOR';
    END IF;

    -- Antecedentes sensibles — bloquea, nunca reasigna en silencio.
    -- notas_rodeo y cartillas_jurado: sin cambios (Decisión 12).
    IF EXISTS (SELECT 1 FROM notas_rodeo WHERE asignacion_id = p_asignacion_id) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_NOTA: esta asignación ya tiene una nota de rodeo registrada';
    END IF;
    IF EXISTS (SELECT 1 FROM cartillas_jurado WHERE asignacion_id = p_asignacion_id) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_CARTILLA: esta asignación ya tiene una cartilla de jurado registrada';
    END IF;
    -- bonos_solicitados: solo bloquea si un administrador aprobó un monto
    -- real (Decisión 11) — 'pendiente'/'aprobado_auto' nunca tuvieron
    -- dinero decidido por una persona y se desvinculan más abajo, sin
    -- bloquear.
    IF EXISTS (
        SELECT 1 FROM bonos_solicitados
        WHERE asignacion_id = p_asignacion_id AND estado IN ('aprobado', 'modificado')
    ) THEN
        RAISE EXCEPTION 'ANTECEDENTE_SENSIBLE_BONO: esta asignación tiene un bono de distancia aprobado con monto real';
    END IF;

    -- Protección contra dos designaciones vigentes incompatibles.
    -- (a) Mismo rodeo (Decisión 5).
    SELECT EXISTS (
        SELECT 1 FROM asignaciones
        WHERE rodeo_id = v_anterior.rodeo_id
          AND usuario_pagado_id = p_usuario_pagado_id_nuevo
          AND id <> p_asignacion_id
          AND estado = 'activo'
          AND COALESCE(estado_designacion, 'pendiente') <> 'rechazado'
    ) INTO v_ya_designado;
    IF v_ya_designado THEN
        RAISE EXCEPTION 'JURADO_YA_DESIGNADO_EN_RODEO';
    END IF;

    -- (b) Otro rodeo con fechas que se cruzan (Decisión 13) — garantía real
    -- bajo el advisory lock tomado arriba, no solo una verificación previa
    -- en JavaScript. Mismo criterio de solapamiento que ya usan
    -- POST /admin/asignaciones y /propuestas/:id/aplicar.
    SELECT EXISTS (
        SELECT 1
        FROM asignaciones a2
        JOIN rodeos r2 ON r2.id = a2.rodeo_id
        WHERE a2.usuario_pagado_id = p_usuario_pagado_id_nuevo
          AND a2.id <> p_asignacion_id
          AND a2.rodeo_id <> v_rodeo_id
          AND a2.estado <> 'anulado'
          AND (r2.fecha + (COALESCE(r2.duracion_dias, 1) - 1) * INTERVAL '1 day')::date >= v_rodeo_fecha
          AND r2.fecha <= (v_rodeo_fecha + (COALESCE(v_rodeo_duracion, 1) - 1) * INTERVAL '1 day')::date
    ) INTO v_cruce_otro_rodeo;
    IF v_cruce_otro_rodeo THEN
        RAISE EXCEPTION 'CRUCE_DISPONIBILIDAD: el jurado nuevo ya está asignado a otro rodeo en fechas que se cruzan';
    END IF;

    -- Decisión 11 — bonos 'pendiente'/'aprobado_auto' de ESTA asignación se
    -- desvinculan (nunca se borran, nunca cambian de monto/distancia) antes
    -- de aplicar el reemplazo — quedan permanentemente identificados con el
    -- jurado anterior (usuario_pagado_id de la propia fila, nunca tocado) y
    -- excluidos de aprobación ordinaria y de toda agregación de pago.
    UPDATE bonos_solicitados
        SET estado = 'desvinculado_por_cambio_designacion', updated_at = now()
        WHERE asignacion_id = p_asignacion_id AND estado IN ('pendiente', 'aprobado_auto');

    -- Decisión 10 — el nuevo jurado NUNCA hereda
    -- la respuesta de aceptación/rechazo de la persona anterior: ninguna
    -- "aceptación" o "rechazo" pertenece a una identidad, no a una fila.
    -- Se reutiliza el mismo estado/estructura que ya usa la rama "pendiente"
    -- de POST /:id/estado (reabrir designación) — nunca un estado nuevo.
    -- distancia_km también se limpia: es un dato físico de la persona
    -- (kilómetros declarados), nunca del cupo — con su bono ya desvinculado
    -- (o rechazado) un momento atrás, no debe quedar un valor numérico
    -- atribuido al reemplazante sin ningún bono real que lo respalde.
    -- `publicado`
    -- se preserva intacto a propósito: si el cupo ya estaba publicado, el
    -- reemplazante debe verlo de inmediato en su portal, ahora pendiente de
    -- su propia respuesta — no se exige una republicación manual aparte.
    UPDATE asignaciones SET
        usuario_pagado_id        = p_usuario_pagado_id_nuevo,
        nombre_importado         = v_nuevo_jurado.nombre_completo,
        categoria_aplicada       = p_categoria_aplicada_nueva,
        valor_diario_aplicado    = p_valor_diario_aplicado_nuevo,
        pago_base_calculado      = p_pago_base_calculado_nuevo,
        estado_designacion       = 'pendiente',
        aceptado_en              = NULL,
        observacion_designacion  = NULL,
        distancia_km             = NULL,
        updated_at               = now()
    WHERE id = p_asignacion_id
    RETURNING * INTO v_nueva;

    -- Única vía de escritura hacia la bitácora (Decisión 2) — si esto falla,
    -- toda la función falla y Postgres revierte también el UPDATE de arriba.
    v_bitacora := registrar_movimiento_designacion(
        p_tipo_movimiento            := p_tipo_movimiento,
        p_rodeo_id                   := v_anterior.rodeo_id,
        p_actor_id                   := p_actor_id,
        p_propuesta_detalle_id       := v_anterior.propuesta_detalle_id,
        p_asignacion_id              := p_asignacion_id,
        p_usuario_pagado_id_anterior := v_anterior.usuario_pagado_id,
        p_nombre_anterior_snapshot   := v_anterior.nombre_importado,
        p_usuario_pagado_id_nuevo    := p_usuario_pagado_id_nuevo,
        p_nombre_nuevo_snapshot      := v_nuevo_jurado.nombre_completo,
        p_motivo_catalogo_id         := p_motivo_catalogo_id,
        p_motivo_detalle             := p_motivo_detalle,
        p_actor_tipo                 := 'administrador',
        p_fecha_efectiva             := p_fecha_efectiva,
        p_operacion_id               := p_operacion_id
    );

    RETURN jsonb_build_object(
        'asignacion', row_to_json(v_nueva),
        'bitacora_id', v_bitacora.id,
        'usuario_pagado_id_anterior', v_anterior.usuario_pagado_id,
        'nombre_anterior_snapshot', v_anterior.nombre_importado
    );
END;
$$;

-- REVOKE explícito de anon/authenticated además de PUBLIC: el proyecto
-- jurados_2026 tiene ALTER DEFAULT PRIVILEGES a nivel de esquema que otorga
-- EXECUTE a anon/authenticated/service_role en toda función nueva, de forma
-- directa (no heredada de PUBLIC) — el mismo hallazgo ya corregido en
-- producción para 083 (fase1a_correccion_privilegios_default_acl). Revocar
-- solo de PUBLIC habría dejado la función ejecutable por anon/authenticated.
REVOKE ALL ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION reemplazar_jurado_asignacion_con_bitacora(
    UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID
) TO service_role;

COMMENT ON FUNCTION reemplazar_jurado_asignacion_con_bitacora IS
    'Fase 1B: único camino que conecta un cambio de jurado de una asignación con bitacora_designaciones, de forma atómica (ambas escrituras o ninguna). Bloquea si hay antecedentes sensibles (nota/cartilla, o bono aprobado con monto real) sin solución de rectificación todavía, si el jurado nuevo ya está designado vigente en el mismo rodeo o en otro con fechas que se cruzan (bajo advisory lock por jurado). Bonos pendientes/aprobado_auto se desvinculan, nunca bloquean. No conecta todavía ningún endpoint existente — PATCH /api/admin/asignaciones/:id sigue sin cambios.';

COMMIT;

-- Reversible:
--   DROP FUNCTION IF EXISTS reemplazar_jurado_asignacion_con_bitacora(UUID, UUID, TEXT, INTEGER, INTEGER, UUID, UUID, TEXT, UUID, TEXT, TIMESTAMPTZ, UUID);
--   ALTER TABLE bonos_solicitados DROP CONSTRAINT IF EXISTS bonos_solicitados_estado_check;
--   ALTER TABLE bonos_solicitados ADD CONSTRAINT bonos_solicitados_estado_check CHECK (estado IN ('pendiente','aprobado','rechazado','modificado','aprobado_auto'));
--   (ese rollback del CHECK fallaría si ya existen filas 'desvinculado_por_cambio_designacion' — intencional: no se revierte perdiendo el estado real de datos ya escritos)
