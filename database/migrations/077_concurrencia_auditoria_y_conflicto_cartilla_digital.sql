-- ═════════════════════════════════════════════════════════════════════════
-- 077_concurrencia_auditoria_y_conflicto_cartilla_digital.sql
-- Auditoría y corrección final de la migración 076 (revisión solicitada
-- antes de autorizar producción). SUPERSEDE a 076 (que a su vez superseda a
-- 075 y 074) — aplicar ESTA migración en vez de 076; autocontenida (incluye
-- también las columnas/índice/constraint de 076 con IF NOT EXISTS), por lo
-- que funciona igual se haya aplicado 076 antes o no.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- ═════════════════════════════════════════════════════════════════════════
-- RIESGOS REVISADOS Y CORREGIDOS (auditoría de 076):
--
-- 1) AUDITORÍA FALTANTE — clasificar_adjunto_cartilla_delegado_historico()
--    recibía p_administrador_id pero nunca registraba nada en `auditoria`.
--    Corregido: ambas RPC (la de alta `registrar_version_cartilla_delegado_
--    adjunta` y la de clasificación histórica) insertan ahora un evento en
--    `auditoria` (tabla, registro_id, clasificación anterior/nueva, rodeo,
--    número de versión si corresponde, actor, fecha) DENTRO de la misma
--    transacción — si el INSERT fallara, Postgres revierte TODA la función
--    (la clasificación/alta incluida), sin necesidad de un bloque de
--    excepción explícito: es una sola transacción real. El backend
--    (admin/adjuntos.js) nunca registra un evento paralelo para estas dos
--    acciones, así que no hay riesgo de duplicado.
--
-- 2) ENDURECIMIENTO DE PRIVILEGIOS INCOMPLETO — 076 solo hardenizaba la
--    función NUEVA (clasificar_adjunto_cartilla_delegado_historico) y
--    asumía que registrar_version_cartilla_delegado_adjunta ya estaba
--    hardenizada por la migración 075 — pero 075 NUNCA se va a aplicar (fue
--    descartada en favor de 076/077). Como esta será la PRIMERA vez que
--    registrar_version_cartilla_delegado_adjunta se crea realmente en
--    producción, sin un REVOKE/GRANT explícito quedaría con el privilegio
--    POR DEFECTO de Postgres para funciones nuevas: EXECUTE para PUBLIC —
--    es decir, ejecutable directamente vía PostgREST con cualquier JWT
--    válido (anon/authenticated), sin pasar por el middleware de admin de
--    Express. Corregido: mismo criterio que 071/073/075 (REVOKE de PUBLIC/
--    anon/authenticated, GRANT solo a service_role, search_path fijo).
--    crear_o_adjuntar_cartilla_institucional NO necesita repetirse por el
--    mismo motivo (su firma de 7 argumentos no cambia desde que 071 ya la
--    hardenizó en producción, y CREATE OR REPLACE FUNCTION conserva el ACL
--    existente cuando la firma no cambia) — se repite aquí de todas formas,
--    de forma puramente defensiva e idempotente (mismo criterio que el
--    propio encabezado de 071: "REVOKE/GRANT/ALTER FUNCTION ... SET son
--    seguros de repetir"), para no depender de memorizar ese detalle.
--
-- 3) ORDEN DE LOCKS INCONSISTENTE (riesgo real de deadlock) — registrar_
--    version_cartilla_delegado_adjunta() y crear_o_adjuntar_cartilla_
--    institucional() bloquean primero `rodeos` y recién después tocan
--    `rodeo_adjuntos`. clasificar_adjunto_cartilla_delegado_historico()
--    hacía lo CONTRARIO: bloqueaba primero la fila puntual de
--    `rodeo_adjuntos` y recién después `rodeos`. Dos sesiones concurrentes
--    operando en orden cruzado (una esperando el lock de `rodeo_adjuntos`
--    que la otra ya tiene, mientras la otra espera el lock de `rodeos` que
--    la primera ya tiene) forman un ciclo de espera clásico -> deadlock.
--    Corregido: clasificar_adjunto_cartilla_delegado_historico() ahora
--    bloquea SIEMPRE `rodeos` PRIMERO (mismo orden que las otras 2 RPCs) —
--    para eso, primero hace una lectura SIN lock de la fila para ubicar su
--    rodeo_id, bloquea `rodeos`, y SOLO DESPUÉS relee y bloquea la fila
--    puntual de `rodeo_adjuntos`, revalidando su estado real ('pendiente')
--    con los locks ya en mano (nunca confía en la lectura sin lock de
--    arriba para decidir nada). Con las 3 RPCs adquiriendo locks siempre en
--    el mismo orden (rodeos -> rodeo_adjuntos), el grafo de espera nunca
--    puede formar un ciclo: deadlock estructuralmente imposible entre ellas.
--    LIMITACIÓN HONESTA DE LAS PRUEBAS: el fixture de pruebas (PGlite vía
--    pgliteServidor.js) usa UNA sola conexión física, serializada por una
--    cola interna — no puede reproducir un deadlock real (que exige 2+
--    sesiones concurrentes, cada una reteniendo un lock que la otra espera).
--    La prueba agregada demuestra la corrección del NUEVO patrón "releer y
--    revalidar tras el lock" y la ausencia de corrupción de estado al
--    clasificar 2 archivos distintos del mismo rodeo en cualquier orden —
--    no la ausencia física de deadlocks, que es una propiedad garantizada
--    por construcción (orden de locks consistente), no por una prueba
--    empírica contra este fixture. Validar con 2 conexiones reales (ej.
--    contra un Postgres real) queda fuera de este alcance (no se ejecutó
--    nada contra producción ni se instaló infraestructura nueva).
--
-- 4) DESBLOQUEO ACCIDENTAL SI DESAPARECE `cartilla_vigente=true` — el
--    chequeo de bloqueo (SQL y su espejo en institucional/cartilla.js)
--    exigía ADEMÁS cartilla_vigente=true para considerar bloqueante una
--    fila 'version_cartilla'. Si esa fila se eliminara o el booleano se
--    perdiera por cualquier vía (ej. un DELETE administrativo, ver punto 5),
--    quedaría una fila 'version_cartilla' con vigente=false y NINGUNA con
--    vigente=true — el chequeo antiguo NO bloquearía, reabriendo el riesgo
--    original. Corregido: el bloqueo ahora depende SOLO de
--    cartilla_clasificacion='version_cartilla' (vigente o histórica, no
--    importa) — mientras exista cualquier versión oficial confirmada, el
--    rodeo sigue bloqueado para una cartilla digital nueva, sin depender
--    únicamente del booleano `cartilla_vigente`. Mismo criterio aplicado en
--    el espejo JS (institucional/cartilla.js) y en el indicador
--    administrativo (rodeosListado.js).
--
-- 5) ELIMINACIÓN ADMINISTRATIVA SIN PROTECCIÓN — DELETE /api/admin/adjuntos/
--    :id podía borrar CUALQUIER adjunto, incluida una versión oficial ya
--    confirmada ('version_cartilla'), dejando el rodeo en un estado
--    inconsistente (o, si era la vigente, sin ninguna versión identificable
--    — exactamente el escenario que el punto 4 ahora blinda de todas
--    formas). Corregido en el backend (admin/adjuntos.js, fuera de esta
--    migración SQL): esa ruta ahora responde 409
--    CARTILLA_OFICIAL_NO_SE_PUEDE_ELIMINAR para cualquier fila
--    tipo_adjunto='cartilla_delegado' con cartilla_clasificacion=
--    'version_cartilla'. No existe hoy un flujo administrativo para
--    "desclasificar" una versión ya confirmada — hasta que exista, se
--    bloquea la eliminación por completo (no se inventa ese flujo en esta
--    pasada, por alcance).
--
-- 6) CARTILLA DIGITAL PREVIA + ADJUNTO OFICIAL POSTERIOR (SIN AVISO) — tanto
--    al dar de alta un archivo nuevo como oficial (registrar_version_
--    cartilla_delegado_adjunta, p_es_version_cartilla=true) como al
--    clasificar uno histórico como oficial (clasificar_adjunto_cartilla_
--    delegado_historico, p_es_version_cartilla=true), si YA existía una
--    cartilla digital (institucional o de Delegado Rentado) para ese
--    rodeo, la operación procedía en silencio. Corregido: ambas RPC
--    reciben un nuevo parámetro p_confirma_conflicto_cartilla_digital
--    (BOOLEAN DEFAULT false, compatible con llamadas existentes) — si existe
--    una cartilla digital para el rodeo y no viene confirmado, se levanta
--    CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION (409 en el backend,
--    nunca 500: no es una falla, es una decisión pendiente). La cartilla
--    digital NUNCA se borra ni se altera en ningún caso — solo se exige que
--    el Administrador la vea y confirme antes de dejar un archivo como
--    oficial. Los 3 casos reales "Rentado + adjunto" no se ven afectados:
--    sus adjuntos ya están (o quedarán) clasificados como 'pendiente' o
--    'complementario', nunca como 'version_cartilla', así que esta
--    confirmación nunca se les exige salvo que un Administrador decida
--    activamente marcarlos como oficiales (que es exactamente cuándo SÍ
--    debe exigirse).
--
-- 7) INDICADOR "CD" DEL LISTADO ADMINISTRATIVO — `cd` (¿existe algún archivo
--    tipo_adjunto='cartilla_delegado'?) se mantiene EXACTAMENTE igual, para
--    no romper el filtro existente (cartilla_delegado=con/sin en Rodeos) ni
--    la exportación a Excel (ambos siguen usando solo ese booleano). Se
--    agregó (fuera de esta migración SQL, en rodeosListado.js) un campo
--    adicional `cd_estado` ('vigente'|'pendiente'|'complementario'|null)
--    para que la tabla principal del Administrador pueda distinguir con un
--    tooltip una cartilla oficial confirmada de un archivo histórico
--    pendiente de revisión o de documentos exclusivamente complementarios
--    — sin tocar filtros ni exportaciones.
--
-- Se mantienen TODAS las protecciones ya probadas en 076: 3 estados
-- explícitos y persistentes ('pendiente' DEFAULT retroactivo / 'version_
-- cartilla' / 'complementario'), SAGRADA FAMILIA/AGUANEGRA sigue bloqueado
-- antes de clasificar nada, los 3 casos reales "Rentado + adjunto" intactos.
--
-- ═════════════════════════════════════════════════════════════════════════
-- CORRECCIONES DE LA REVISIÓN POSTERIOR (sobre este mismo archivo, antes de
-- autorizar producción — se corrige directamente acá, sin crear una 078):
--
-- 8) CONFIRMACIÓN DE CONFLICTO NO RECHAZABA UN NULL — ambas RPC comprobaban
--    `AND NOT p_confirma_conflicto_cartilla_digital`. En SQL, `NOT NULL` es
--    NULL, y `TRUE AND NULL` es NULL — una condición IF que evalúa a NULL se
--    trata como FALSE, es decir, el RAISE EXCEPTION nunca se ejecutaba y la
--    operación procedía como si estuviera confirmada. Un caller que enviara
--    el parámetro como NULL (en vez de omitirlo, que sí usa el DEFAULT
--    false) habría quedado tratado como "confirmado" sin serlo. Corregido:
--    la condición ahora es `p_confirma_conflicto_cartilla_digital IS NOT
--    TRUE` — exige explícitamente el valor TRUE para considerar confirmado;
--    cualquier otro valor (FALSE o NULL) se trata como "no confirmado".
--
-- 9) AUDITORÍA OMITIDA EN VEZ DE RECHAZAR LA OPERACIÓN — registrar_version_
--    cartilla_delegado_adjunta() solo escribía en `auditoria` cuando
--    p_created_by IS NOT NULL — si llegara NULL, el alta se completaba
--    igual, SIN ningún rastro auditable (en vez de fallar). Corregido: se
--    agrega una validación explícita al inicio de la función
--    (`IF p_created_by IS NULL THEN RAISE EXCEPTION
--    'ADMINISTRADOR_REQUERIDO'; END IF;`) y el INSERT INTO auditoria deja de
--    ser condicional — ahora es SIEMPRE obligatorio. El único caller real
--    hoy (admin/adjuntos.js) siempre informa el administrador autenticado,
--    así que esto no cambia el comportamiento observable en producción —
--    solo cierra la posibilidad de una alta sin trazabilidad.
--
-- 10) NUMERACIÓN V1/V2/V3 POR ORDEN DE CLASIFICACIÓN, NO POR FECHA ORIGINAL
--     DE CARGA — el número de versión se asignaba con `COALESCE(MAX(...),0)
--     + 1` en el momento en que CADA archivo se clasificaba, y la fila
--     recién clasificada quedaba SIEMPRE como la vigente. Para los 180
--     archivos históricos reales esto es un riesgo concreto: si un
--     Administrador clasifica primero un archivo subido más recientemente y
--     DESPUÉS uno subido antes (orden de revisión arbitrario, no
--     necesariamente cronológico), el archivo más ANTIGUO terminaría
--     numerado como la versión más alta y marcado vigente=true — exactamente
--     al revés de lo esperado. Corregido con una regla explícita y
--     comprobable: cada vez que una fila pasa a 'version_cartilla' (en
--     cualquiera de las 2 RPC), se RECALCULA la numeración de TODAS las
--     filas 'version_cartilla' de ese rodeo ordenadas por su `created_at`
--     real (la fecha original de carga, columna ya existente, NUNCA
--     alterada por esta migración) — V1 es siempre la más antigua, el
--     número más alto siempre corresponde a la más reciente, y SOLO esa
--     (la de `created_at` máximo) queda `cartilla_vigente=true`. El
--     resultado final ya no depende del orden en que el Administrador las
--     revisó, solo de cuándo se subieron realmente. Probado explícitamente
--     clasificando un archivo reciente ANTES que uno antiguo.
--
-- ALCANCE REAL DE LA PROTECCIÓN — DELEGADO RENTADO QUEDA FUERA DE ESTA
-- MIGRACIÓN: toda la cadena 074→077 (las 3 RPC, el chequeo espejo en
-- institucional/cartilla.js, y los campos cartilla_delegado_adjunta/estado
-- en institucional/rodeos.js) protege EXCLUSIVAMENTE el flujo institucional
-- (Delegado de Asociación). El flujo de Delegado Rentado
-- (routes/usuario/cartilla-delegado.js, GET/POST/PATCH /api/usuario/
-- cartilla-delegado/rodeo/:rodeo_id) usa un camino completamente distinto:
-- lee/escribe `cartillas_delegado` con INSERT/UPDATE directos de Supabase
-- (nunca a través de crear_o_adjuntar_cartilla_institucional), y NUNCA
-- consulta `rodeo_adjuntos` — no tiene ningún chequeo, viejo ni nuevo, sobre
-- si ya existe una Cartilla de Delegado oficial adjuntada. Es decir: un
-- Delegado Rentado puede crear/editar su cartilla digital sin que esta
-- migración (ni ninguna de 074 a 077) lo bloquee, incluso si el rodeo ya
-- tiene un archivo oficial adjuntado. Esto NO es un bug introducido por esta
-- migración — es el alcance que tuvo desde el inicio toda esta serie
-- (074-077), que se diseñó específicamente para el bug reportado en el
-- flujo institucional. Documentado aquí para que la protección NO se
-- presuma "global para todo tipo de cartilla" sin esa salvedad explícita.
-- Extenderla al flujo de Delegado Rentado NO se implementa en esta pasada
-- (requiere autorización separada, y tocar un módulo distinto).
--
-- ═════════════════════════════════════════════════════════════════════════
-- CORRECCIÓN TÉCNICA FINAL (sobre este mismo archivo, sin crear una 078):
--
-- 11) EL RECÁLCULO POR created_at (punto 10) PODÍA VIOLAR TRANSITORIAMENTE
--     uq_rodeo_adjuntos_cartilla_vigente — el recálculo original usaba UN
--     SOLO UPDATE con una función de ventana para fijar
--     cartilla_numero_version Y cartilla_vigente de todas las filas
--     'version_cartilla' del rodeo a la vez. Postgres NO difiere la
--     verificación de un índice único NOT DEFERRABLE hasta el final del
--     statement: la chequea fila por fila, en el orden interno (no
--     garantizado) en que el planificador procesa las filas del UPDATE. Si
--     esa ejecución interna llegaba a escribir "fila B vigente=true" ANTES
--     de haber escrito "fila A (la vigente anterior) vigente=false", se
--     produciría un "duplicate key value violates unique constraint
--     uq_rodeo_adjuntos_cartilla_vigente" real — exactamente el error
--     clásico de Postgres al reasignar valores únicos entre filas con un
--     solo UPDATE (sin DEFERRABLE). Las pruebas de la revisión anterior
--     pasaron porque el orden interno que usó PGlite en esos casos
--     concretos resultó no colisionar — no porque el patrón fuera seguro
--     por construcción. Corregido separando el recálculo en 3 pasos
--     DENTRO de la misma transacción (nunca en llamadas HTTP ni
--     transacciones distintas), siempre con `rodeos` ya bloqueado FOR
--     UPDATE desde antes (mismo orden de locks, sin cambios):
--       a) UPDATE: todas las filas 'version_cartilla' del rodeo que tengan
--          cartilla_vigente=true pasan a false (nunca puede violar el
--          índice — poner algo en false no puede duplicar nada).
--       b) UPDATE: se recalcula cartilla_numero_version de TODAS las filas
--          'version_cartilla' del rodeo por ROW_NUMBER() OVER (ORDER BY
--          created_at ASC, id ASC) — esta columna no tiene ningún índice
--          único, así que no hay riesgo de violación en ningún orden.
--       c) UPDATE de UNA SOLA FILA (la de created_at más reciente, vía
--          subconsulta con ORDER BY ... DESC LIMIT 1): recién acá se pone
--          cartilla_vigente=true. Como el paso (a) ya dejó a TODAS las
--          filas del rodeo en false, este UPDATE de una fila nunca puede
--          coincidir con otra fila vigente=true al mismo tiempo —
--          estructuralmente imposible, no depende de ningún orden interno.
--     Los 3 pasos ocurren en la MISMA invocación de la función (misma
--     transacción real) — si cualquiera fallara, se revierten los 3 (y la
--     clasificación/alta completa) sin excepción explícita, por ser una
--     sola transacción.
--
-- AUDITORÍA DE EFECTOS SOBRE OTRAS VERSIONES (mismo punto): el recálculo de
-- los pasos (a)-(c) puede cambiar cartilla_numero_version/cartilla_vigente
-- de filas 'version_cartilla' DISTINTAS a la que el Administrador acaba de
-- registrar o clasificar (ej.: al clasificar un archivo más antiguo que el
-- que hoy es vigente, ESE otro archivo deja de ser vigente y/o cambia de
-- número). Antes, solo se auditaba la fila directamente accionada. Ahora se
-- toma una fotografía (numero_version, vigente) de todas las demás filas
-- 'version_cartilla' del rodeo ANTES de los 3 pasos y otra DESPUÉS, y por
-- cada fila (distinta de la principal, que ya tiene su propio evento) cuyo
-- valor cambió, se inserta un evento adicional en `auditoria`
-- (accion='renumerar_version_cartilla', con datos_anteriores/datos_nuevos
-- reales) — nunca se pierde la trazabilidad de un efecto colateral.
-- ═════════════════════════════════════════════════════════════════════════

-- Autocontenida (igual criterio que 075/076 sobre su antecesora): incluye
-- también las columnas/índice/constraint de 076 con IF NOT EXISTS.
ALTER TABLE rodeo_adjuntos
    ADD COLUMN IF NOT EXISTS cartilla_numero_version INTEGER,
    ADD COLUMN IF NOT EXISTS cartilla_vigente BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS cartilla_clasificacion TEXT NOT NULL DEFAULT 'pendiente';

CREATE UNIQUE INDEX IF NOT EXISTS uq_rodeo_adjuntos_cartilla_vigente
    ON rodeo_adjuntos (rodeo_id)
    WHERE tipo_adjunto = 'cartilla_delegado' AND cartilla_vigente = true;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'rodeo_adjuntos'::regclass AND conname = 'chk_rodeo_adjuntos_cartilla_clasificacion'
    ) THEN
        ALTER TABLE rodeo_adjuntos
            ADD CONSTRAINT chk_rodeo_adjuntos_cartilla_clasificacion
            CHECK (cartilla_clasificacion IN ('pendiente', 'version_cartilla', 'complementario'));
    END IF;
END $$;

COMMENT ON COLUMN rodeo_adjuntos.cartilla_clasificacion IS
    'Corrección final del versionado: distingue explícita y persistentemente "pendiente" (nunca revisado — DEFAULT, incluye retroactivamente todo lo histórico) de "complementario" (revisado y confirmado que NO es la cartilla) y "version_cartilla" (revisado y confirmado que SÍ lo es). Nunca se infiere de columnas NULL. Solo "complementario" no bloquea el portal institucional.';

-- Las firmas de ambas RPC cambian (se agrega un parámetro nuevo al final) —
-- se elimina la firma antigua primero para que CREATE OR REPLACE no deje un
-- segundo overload "fantasma" si 076 llegó a aplicarse antes. No aplica a
-- crear_o_adjuntar_cartilla_institucional (su firma de 7 argumentos no cambia).
DROP FUNCTION IF EXISTS registrar_version_cartilla_delegado_adjunta(UUID, BOOLEAN, UUID, BOOLEAN, TEXT, TEXT, TEXT, INTEGER, UUID);
DROP FUNCTION IF EXISTS clasificar_adjunto_cartilla_delegado_historico(UUID, BOOLEAN, UUID);

-- ─── RPC de alta (nuevos archivos): fija cartilla_clasificacion, avisa de
-- conflicto con una cartilla digital preexistente, y registra auditoría ──
CREATE OR REPLACE FUNCTION registrar_version_cartilla_delegado_adjunta(
    p_rodeo_id UUID,
    p_es_version_cartilla BOOLEAN,
    p_usuario_pagado_id UUID,
    p_subido_por_admin BOOLEAN,
    p_nombre_archivo TEXT,
    p_storage_path TEXT,
    p_mime_type TEXT,
    p_tamano_bytes INTEGER,
    p_created_by UUID,
    p_confirma_conflicto_cartilla_digital BOOLEAN DEFAULT false
) RETURNS rodeo_adjuntos AS $$
DECLARE
    v_tiene_cartilla_digital BOOLEAN;
    v_resultado rodeo_adjuntos;
    v_antes JSONB;
    v_despues JSONB;
    v_id_otro TEXT;
BEGIN
    -- Riesgo 9: auditoría obligatoria, nunca omitida — se rechaza la
    -- operación completa si no hay un administrador real, en vez de
    -- completar el alta sin ningún rastro auditable.
    IF p_created_by IS NULL THEN
        RAISE EXCEPTION 'ADMINISTRADOR_REQUERIDO';
    END IF;

    -- Orden de locks: `rodeos` SIEMPRE primero (ver riesgo 3 en la cabecera) —
    -- mismo orden en las 3 RPCs de este módulo.
    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;

    IF p_es_version_cartilla THEN
        -- Cartilla digital previa + adjunto oficial posterior (riesgo 6):
        -- nunca en silencio. "Cartilla digital" = institucional o de
        -- Delegado Rentado (delegado_asociacion_id XOR delegado_id, ver
        -- migración 065) — cualquiera de las dos cuenta. Riesgo 8: se exige
        -- el valor TRUE explícito — NULL o FALSE se tratan igual, como "no
        -- confirmado" (nunca se interpreta un NULL como confirmación).
        SELECT EXISTS(SELECT 1 FROM cartillas_delegado WHERE rodeo_id = p_rodeo_id)
            INTO v_tiene_cartilla_digital;

        IF v_tiene_cartilla_digital AND p_confirma_conflicto_cartilla_digital IS NOT TRUE THEN
            RAISE EXCEPTION 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION';
        END IF;

        -- Fotografía de las versiones oficiales YA existentes (nunca
        -- incluye la fila nueva, que todavía no se inserta) — para poder
        -- auditar más abajo cualquier efecto colateral del recálculo sobre
        -- ELLAS (riesgo 11).
        SELECT jsonb_object_agg(id::text, jsonb_build_object('cartilla_numero_version', cartilla_numero_version, 'cartilla_vigente', cartilla_vigente))
        INTO v_antes
        FROM rodeo_adjuntos
        WHERE rodeo_id = p_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla';
    END IF;

    -- cartilla_numero_version/cartilla_vigente se insertan como placeholder
    -- (NULL/false) cuando es version_cartilla — el valor real lo fija el
    -- recálculo de 3 pasos de más abajo (riesgo 10/11), nunca el orden de
    -- esta alta.
    INSERT INTO rodeo_adjuntos (
        rodeo_id, usuario_pagado_id, subido_por_admin, tipo_adjunto,
        nombre_archivo, storage_path, mime_type, tamano_bytes, created_by,
        cartilla_numero_version, cartilla_vigente, cartilla_clasificacion
    ) VALUES (
        p_rodeo_id, p_usuario_pagado_id, p_subido_por_admin, 'cartilla_delegado',
        p_nombre_archivo, p_storage_path, p_mime_type, p_tamano_bytes, p_created_by,
        NULL, false,
        CASE WHEN p_es_version_cartilla THEN 'version_cartilla' ELSE 'complementario' END
    )
    RETURNING * INTO v_resultado;

    IF p_es_version_cartilla THEN
        -- Riesgo 11: recálculo en 3 pasos separados, nunca en un solo
        -- UPDATE — evita violar transitoriamente uq_rodeo_adjuntos_
        -- cartilla_vigente (Postgres no difiere el chequeo de un índice
        -- único NOT DEFERRABLE hasta el final del statement).
        --
        -- Paso (a): todas las vigentes de este rodeo pasan a false primero
        -- — nunca puede colisionar (poner en false no duplica nada).
        UPDATE rodeo_adjuntos SET cartilla_vigente = false
            WHERE rodeo_id = p_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_vigente = true;

        -- Paso (b): recalcula cartilla_numero_version de TODAS las
        -- versiones oficiales de este rodeo por su fecha REAL de carga
        -- (created_at, columna ya existente, nunca alterada por esta
        -- migración) — V1 siempre la más antigua. Esta columna no tiene
        -- índice único, así que no hay riesgo de violación en ningún orden.
        -- `id` como desempate secundario solo para un resultado
        -- determinista ante timestamps idénticos (sin significado
        -- cronológico propio).
        UPDATE rodeo_adjuntos ra SET cartilla_numero_version = o.rn
        FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
            FROM rodeo_adjuntos
            WHERE rodeo_id = p_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla'
        ) o
        WHERE ra.id = o.id;

        -- Paso (c): recién ahora se marca vigente=true, en UNA SOLA fila
        -- (la de created_at más reciente). Como el paso (a) ya dejó a
        -- TODAS en false, este UPDATE de una fila nunca puede coincidir
        -- con otra vigente=true al mismo tiempo — imposible por
        -- construcción, no depende de ningún orden interno de ejecución.
        UPDATE rodeo_adjuntos SET cartilla_vigente = true
        WHERE id = (
            SELECT id FROM rodeo_adjuntos
            WHERE rodeo_id = p_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla'
            ORDER BY created_at DESC, id DESC LIMIT 1
        );

        SELECT * INTO v_resultado FROM rodeo_adjuntos WHERE id = v_resultado.id;

        -- Auditoría de efectos colaterales (riesgo 11): cualquier OTRA
        -- versión oficial de este rodeo cuyo numero_version/vigente haya
        -- cambiado por este recálculo (ej. dejó de ser la vigente, o se
        -- corrió su número) queda su propio evento, con valores
        -- anteriores/posteriores reales — nunca se pierde esa trazabilidad.
        SELECT jsonb_object_agg(id::text, jsonb_build_object('cartilla_numero_version', cartilla_numero_version, 'cartilla_vigente', cartilla_vigente))
        INTO v_despues
        FROM rodeo_adjuntos
        WHERE rodeo_id = p_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla';

        FOR v_id_otro IN SELECT jsonb_object_keys(v_despues) LOOP
            IF v_id_otro = v_resultado.id::text THEN CONTINUE; END IF; -- la fila principal ya se audita aparte, más abajo
            IF (v_antes -> v_id_otro) IS DISTINCT FROM (v_despues -> v_id_otro) THEN
                INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
                VALUES (
                    'rodeo_adjuntos', v_id_otro, 'renumerar_version_cartilla',
                    jsonb_build_object('rodeo_id', p_rodeo_id) || COALESCE(v_antes -> v_id_otro, '{}'::jsonb),
                    jsonb_build_object('rodeo_id', p_rodeo_id) || (v_despues -> v_id_otro),
                    p_created_by::text, 'administrador',
                    'Renumeración/cambio de vigencia por una nueva versión oficial del mismo rodeo'
                );
            END IF;
        END LOOP;
    END IF;

    -- Auditoría (riesgo 1/9): SIEMPRE, nunca condicional — ya se rechazó
    -- arriba la operación si no había administrador, así que este INSERT
    -- nunca viola el NOT NULL de actor_id.
    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'rodeo_adjuntos', v_resultado.id::text, 'crear',
        jsonb_build_object(
            'rodeo_id', p_rodeo_id,
            'cartilla_clasificacion', v_resultado.cartilla_clasificacion,
            'cartilla_vigente', v_resultado.cartilla_vigente,
            'cartilla_numero_version', v_resultado.cartilla_numero_version
        ),
        p_created_by::text, 'administrador',
        format('Alta de adjunto cartilla_delegado -> %s', v_resultado.cartilla_clasificacion)
    );

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION registrar_version_cartilla_delegado_adjunta IS
    'Cartilla única por rodeo, con versiones y clasificación en tres estados (076/077): alta atómica de un archivo tipo_adjunto=cartilla_delegado, SIEMPRE clasificado explícitamente al subirlo (version_cartilla o complementario — nunca queda en "pendiente", ese estado es solo para archivos históricos previos a esta funcionalidad), con lock FOR UPDATE sobre el rodeo (siempre adquirido antes que cualquier fila de rodeo_adjuntos). La numeración V1/V2/V3 y cuál queda vigente se recalculan por la fecha REAL de carga (created_at) de todas las versiones oficiales del rodeo, nunca por el orden en que se dieron de alta, en 3 pasos separados (desmarcar vigentes, renumerar, marcar la única vigente) para nunca violar transitoriamente uq_rodeo_adjuntos_cartilla_vigente, con auditoría propia para cualquier OTRA versión afectada como efecto colateral. Exige confirmación EXPLÍCITA (TRUE, nunca NULL) si ya existe una cartilla digital para el rodeo. Rechaza la operación (ADMINISTRADOR_REQUERIDO) si no hay un administrador real — la auditoría nunca es opcional. Registra auditoría en la misma transacción.';

-- ─── RPC: clasificar un archivo HISTÓRICO ya existente ('pendiente') ──────
-- Orden de locks corregido (riesgo 3): `rodeos` SIEMPRE antes que la fila
-- puntual de rodeo_adjuntos — se lee primero SIN lock solo para ubicar el
-- rodeo, y se relee/revalida CON lock recién después de bloquear `rodeos`.
CREATE OR REPLACE FUNCTION clasificar_adjunto_cartilla_delegado_historico(
    p_adjunto_id UUID,
    p_es_version_cartilla BOOLEAN,
    p_administrador_id UUID,
    p_confirma_conflicto_cartilla_digital BOOLEAN DEFAULT false
) RETURNS rodeo_adjuntos AS $$
DECLARE
    v_rodeo_id UUID;
    v_adjunto rodeo_adjuntos;
    v_clasificacion_anterior TEXT;
    v_vigente_anterior BOOLEAN;
    v_version_anterior INTEGER;
    v_tiene_cartilla_digital BOOLEAN;
    v_resultado rodeo_adjuntos;
    v_antes JSONB;
    v_despues JSONB;
    v_id_otro TEXT;
BEGIN
    -- Riesgo 9 (mismo criterio que registrar_version_cartilla_delegado_
    -- adjunta): auditoría obligatoria, nunca omitida — se rechaza la
    -- operación completa si no hay un administrador real.
    IF p_administrador_id IS NULL THEN
        RAISE EXCEPTION 'ADMINISTRADOR_REQUERIDO';
    END IF;

    -- Lectura SIN lock: solo para ubicar el rodeo (necesario para fijar el
    -- ORDEN de locks correcto). Nunca se usa para decidir nada más — su
    -- estado real se vuelve a leer CON lock más abajo.
    SELECT rodeo_id INTO v_rodeo_id FROM rodeo_adjuntos
        WHERE id = p_adjunto_id AND tipo_adjunto = 'cartilla_delegado';

    IF v_rodeo_id IS NULL THEN
        RAISE EXCEPTION 'ADJUNTO_NO_ENCONTRADO';
    END IF;

    -- Lock de `rodeos` PRIMERO — mismo orden que registrar_version_
    -- cartilla_delegado_adjunta() y crear_o_adjuntar_cartilla_institucional(),
    -- para que las 3 RPCs nunca puedan formar un ciclo de espera entre sí.
    PERFORM 1 FROM rodeos WHERE id = v_rodeo_id FOR UPDATE;

    -- Releer y bloquear AHORA la fila puntual, ya con el lock de `rodeos`
    -- en mano, y revalidar su estado real (nunca confiar en la lectura de
    -- arriba, hecha sin lock).
    SELECT * INTO v_adjunto FROM rodeo_adjuntos WHERE id = p_adjunto_id FOR UPDATE;

    IF v_adjunto IS NULL THEN
        RAISE EXCEPTION 'ADJUNTO_NO_ENCONTRADO';
    END IF;
    IF v_adjunto.cartilla_clasificacion <> 'pendiente' THEN
        RAISE EXCEPTION 'ADJUNTO_YA_CLASIFICADO';
    END IF;

    v_clasificacion_anterior := v_adjunto.cartilla_clasificacion;
    v_vigente_anterior := v_adjunto.cartilla_vigente;
    v_version_anterior := v_adjunto.cartilla_numero_version;

    IF p_es_version_cartilla THEN
        -- Cartilla digital previa + clasificación posterior como oficial
        -- (riesgo 6): mismo chequeo que al dar de alta un archivo nuevo.
        -- Riesgo 8: exige TRUE explícito — NULL o FALSE son "no confirmado".
        SELECT EXISTS(SELECT 1 FROM cartillas_delegado WHERE rodeo_id = v_rodeo_id)
            INTO v_tiene_cartilla_digital;

        IF v_tiene_cartilla_digital AND p_confirma_conflicto_cartilla_digital IS NOT TRUE THEN
            RAISE EXCEPTION 'CARTILLA_DIGITAL_EXISTENTE_REQUIERE_CONFIRMACION';
        END IF;

        -- Fotografía de las versiones oficiales YA existentes (el adjunto
        -- que se está clasificando todavía es 'pendiente' en este punto,
        -- así que no aparece acá) — para auditar más abajo cualquier
        -- efecto colateral del recálculo sobre ELLAS (riesgo 11).
        SELECT jsonb_object_agg(id::text, jsonb_build_object('cartilla_numero_version', cartilla_numero_version, 'cartilla_vigente', cartilla_vigente))
        INTO v_antes
        FROM rodeo_adjuntos
        WHERE rodeo_id = v_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla';

        UPDATE rodeo_adjuntos SET cartilla_clasificacion = 'version_cartilla'
        WHERE id = p_adjunto_id
        RETURNING * INTO v_resultado;

        -- Riesgo 11: recálculo en 3 pasos separados (mismo criterio que
        -- registrar_version_cartilla_delegado_adjunta) — evita violar
        -- transitoriamente uq_rodeo_adjuntos_cartilla_vigente.
        --
        -- Paso (a): todas las vigentes de este rodeo pasan a false primero.
        UPDATE rodeo_adjuntos SET cartilla_vigente = false
            WHERE rodeo_id = v_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_vigente = true;

        -- Paso (b): recalcula cartilla_numero_version de TODAS las
        -- versiones oficiales de este rodeo por su created_at real — V1 es
        -- siempre la más antigua, sin importar el orden en que el
        -- Administrador fue clasificando cada archivo.
        UPDATE rodeo_adjuntos ra SET cartilla_numero_version = o.rn
        FROM (
            SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
            FROM rodeo_adjuntos
            WHERE rodeo_id = v_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla'
        ) o
        WHERE ra.id = o.id;

        -- Paso (c): recién ahora se marca vigente=true, en UNA SOLA fila
        -- (la de created_at más reciente) — con el paso (a) ya en false
        -- para todas, nunca puede colisionar con el índice único.
        UPDATE rodeo_adjuntos SET cartilla_vigente = true
        WHERE id = (
            SELECT id FROM rodeo_adjuntos
            WHERE rodeo_id = v_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla'
            ORDER BY created_at DESC, id DESC LIMIT 1
        );

        SELECT * INTO v_resultado FROM rodeo_adjuntos WHERE id = p_adjunto_id;

        -- Auditoría de efectos colaterales (riesgo 11) sobre OTRAS
        -- versiones oficiales del mismo rodeo — ver nota equivalente en
        -- registrar_version_cartilla_delegado_adjunta.
        SELECT jsonb_object_agg(id::text, jsonb_build_object('cartilla_numero_version', cartilla_numero_version, 'cartilla_vigente', cartilla_vigente))
        INTO v_despues
        FROM rodeo_adjuntos
        WHERE rodeo_id = v_rodeo_id AND tipo_adjunto = 'cartilla_delegado' AND cartilla_clasificacion = 'version_cartilla';

        FOR v_id_otro IN SELECT jsonb_object_keys(v_despues) LOOP
            IF v_id_otro = p_adjunto_id::text THEN CONTINUE; END IF; -- la fila principal ya se audita aparte, más abajo
            IF (v_antes -> v_id_otro) IS DISTINCT FROM (v_despues -> v_id_otro) THEN
                INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
                VALUES (
                    'rodeo_adjuntos', v_id_otro, 'renumerar_version_cartilla',
                    jsonb_build_object('rodeo_id', v_rodeo_id) || COALESCE(v_antes -> v_id_otro, '{}'::jsonb),
                    jsonb_build_object('rodeo_id', v_rodeo_id) || (v_despues -> v_id_otro),
                    p_administrador_id::text, 'administrador',
                    'Renumeración/cambio de vigencia por la clasificación de otro archivo histórico del mismo rodeo'
                );
            END IF;
        END LOOP;
    ELSE
        UPDATE rodeo_adjuntos SET cartilla_clasificacion = 'complementario'
        WHERE id = p_adjunto_id
        RETURNING * INTO v_resultado;
    END IF;

    -- Auditoría (riesgo 1) — administrador, adjunto, rodeo, clasificación
    -- anterior/nueva y número de versión cuando corresponde, en la MISMA
    -- transacción: si este INSERT fallara, se revierte también la
    -- clasificación de arriba (atomicidad real, sin bloque de excepción).
    INSERT INTO auditoria (tabla, registro_id, accion, datos_anteriores, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'rodeo_adjuntos', p_adjunto_id::text, 'clasificar_historico',
        jsonb_build_object(
            'rodeo_id', v_rodeo_id,
            'cartilla_clasificacion', v_clasificacion_anterior,
            'cartilla_vigente', v_vigente_anterior,
            'cartilla_numero_version', v_version_anterior
        ),
        jsonb_build_object(
            'rodeo_id', v_rodeo_id,
            'cartilla_clasificacion', v_resultado.cartilla_clasificacion,
            'cartilla_vigente', v_resultado.cartilla_vigente,
            'cartilla_numero_version', v_resultado.cartilla_numero_version
        ),
        p_administrador_id::text, 'administrador',
        format('Clasificación de adjunto histórico (cartilla_delegado) -> %s', v_resultado.cartilla_clasificacion)
    );

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION clasificar_adjunto_cartilla_delegado_historico IS
    'Resuelve UN archivo histórico "pendiente" hacia version_cartilla o complementario — nunca automático, siempre una decisión explícita del Administrador, uno a la vez. Bloquea `rodeos` ANTES que la fila puntual de rodeo_adjuntos (mismo orden que las otras 2 RPCs del módulo, evita deadlocks por orden cruzado) y revalida el estado real tras adquirir los locks. Al marcar version_cartilla, renumera TODAS las versiones oficiales del rodeo por su created_at real (nunca por el orden de clasificación) en 3 pasos separados (desmarcar vigentes, renumerar, marcar la única vigente) para nunca violar transitoriamente uq_rodeo_adjuntos_cartilla_vigente, y audita en eventos propios cualquier OTRA versión cuyo numero_version/vigente cambió como efecto colateral. Exige confirmación EXPLÍCITA (TRUE, nunca NULL) si ya existe una cartilla digital para el rodeo. Rechaza la operación (ADMINISTRADOR_REQUERIDO) si no hay un administrador real. Registra auditoría (clasificación anterior/nueva) en la misma transacción. No se ejecuta sobre los 180 archivos reales sin autorización separada (ver informe).';

-- ─── crear_o_adjuntar_cartilla_institucional: bloquea por CUALQUIER versión
-- oficial confirmada (vigente o no) O por 'pendiente' — nunca depende solo
-- del booleano cartilla_vigente (riesgo 4) ─────────────────────────────────
CREATE OR REPLACE FUNCTION crear_o_adjuntar_cartilla_institucional(
    p_rodeo_id UUID,
    p_delegado_asociacion_id UUID,
    p_delegado_nombre TEXT,
    p_cuenta_institucional_id UUID,
    p_temporada TEXT,
    p_fecha_rodeo DATE,
    p_tipo_rodeo TEXT
) RETURNS cartillas_delegado AS $$
DECLARE
    v_rentado_designado BOOLEAN;
    v_rentado_cartilla_existe BOOLEAN;
    v_tiene_version_oficial BOOLEAN;
    v_tiene_pendiente BOOLEAN;
    v_resultado cartillas_delegado;
BEGIN
    PERFORM 1 FROM rodeos WHERE id = p_rodeo_id FOR UPDATE;

    -- Riesgo 4: ya NO se exige además cartilla_vigente=true. Mientras
    -- exista CUALQUIER fila confirmada como 'version_cartilla' (vigente o
    -- histórica), el rodeo sigue bloqueado — nunca depender únicamente de
    -- ese booleano (podría desaparecer por una eliminación administrativa
    -- u otra causa sin que eso deba habilitar una cartilla digital nueva).
    SELECT EXISTS(
        SELECT 1 FROM rodeo_adjuntos
        WHERE rodeo_id = p_rodeo_id AND tipo_adjunto = 'cartilla_delegado'
          AND cartilla_clasificacion = 'version_cartilla'
    ) INTO v_tiene_version_oficial;

    IF v_tiene_version_oficial THEN
        RAISE EXCEPTION 'CARTILLA_DELEGADO_ADJUNTA';
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM rodeo_adjuntos
        WHERE rodeo_id = p_rodeo_id AND tipo_adjunto = 'cartilla_delegado'
          AND cartilla_clasificacion = 'pendiente'
    ) INTO v_tiene_pendiente;

    IF v_tiene_pendiente THEN
        RAISE EXCEPTION 'CARTILLA_DELEGADO_PENDIENTE_REVISION';
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM asignaciones
        WHERE rodeo_id = p_rodeo_id
          AND tipo_persona = 'delegado_rentado'
          AND estado = 'activo'
          AND publicado = true
          AND estado_designacion <> 'rechazado'
    ) INTO v_rentado_designado;

    IF v_rentado_designado THEN
        RAISE EXCEPTION 'DELEGADO_RENTADO_DESIGNADO';
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM cartillas_delegado
        WHERE rodeo_id = p_rodeo_id AND delegado_id IS NOT NULL
    ) INTO v_rentado_cartilla_existe;

    IF v_rentado_cartilla_existe THEN
        RAISE EXCEPTION 'CARTILLA_RENTADO_EXISTENTE';
    END IF;

    INSERT INTO cartillas_delegado (
        rodeo_id, delegado_asociacion_id, delegado_nombre,
        creado_por_cuenta_institucional_id, actualizado_por_cuenta_institucional_id,
        temporada, fecha_rodeo, tipo_rodeo,
        estado, version
    ) VALUES (
        p_rodeo_id, p_delegado_asociacion_id, p_delegado_nombre,
        p_cuenta_institucional_id, p_cuenta_institucional_id,
        p_temporada, p_fecha_rodeo, p_tipo_rodeo,
        'borrador', 1
    )
    ON CONFLICT (rodeo_id) WHERE delegado_asociacion_id IS NOT NULL
    DO UPDATE SET
        delegado_asociacion_id = EXCLUDED.delegado_asociacion_id,
        delegado_nombre = EXCLUDED.delegado_nombre,
        actualizado_por_cuenta_institucional_id = EXCLUDED.actualizado_por_cuenta_institucional_id,
        version = cartillas_delegado.version + 1,
        updated_at = now()
    WHERE cartillas_delegado.estado NOT IN ('enviada', 'reenviada', 'aprobada', 'cerrada')
    RETURNING * INTO v_resultado;

    IF v_resultado IS NULL THEN
        RAISE EXCEPTION 'CARTILLA_BLOQUEADA_PARA_CAMBIO_DE_DELEGADO';
    END IF;

    INSERT INTO auditoria (tabla, registro_id, accion, datos_nuevos, actor_id, actor_tipo, descripcion)
    VALUES (
        'cartillas_delegado', v_resultado.id::text,
        CASE WHEN v_resultado.version = 1 THEN 'crear' ELSE 'guardar' END,
        jsonb_build_object('delegado_asociacion_id', p_delegado_asociacion_id, 'delegado_nombre', p_delegado_nombre, 'version', v_resultado.version),
        p_cuenta_institucional_id::text, 'cuenta_institucional',
        format('%s de cartilla institucional — delegado: %s',
            CASE WHEN v_resultado.version = 1 THEN 'Creación' ELSE 'Adjunto' END, p_delegado_nombre)
    );

    RETURN v_resultado;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION crear_o_adjuntar_cartilla_institucional IS
    'Fase 3.1 (cierre) + 3.5.1 + cartilla única por rodeo con versiones y clasificación en tres estados (076/077, auditoría y endurecimiento final): crea o adjunta la cartilla institucional, serializada contra Delegado Rentado concurrente y contra cualquier archivo cartilla_delegado que NO esté confirmado como complementario (version_cartilla, vigente o histórica, o pendiente de revisión), con mensajes/códigos distintos para cada caso. Nunca depende únicamente del booleano cartilla_vigente. Registra su propio evento de auditoría en la MISMA transacción.';

-- ─── Endurecimiento de privilegios (mismo criterio que 071/073/075) ──────
-- registrar_version_cartilla_delegado_adjunta y clasificar_adjunto_cartilla_
-- delegado_historico: firma NUEVA (se agregó un parámetro) -> requieren
-- REVOKE/GRANT explícitos en ESTA migración (riesgo 2). crear_o_adjuntar_
-- cartilla_institucional: firma sin cambios, ya hardenizada por 071 en
-- producción (CREATE OR REPLACE conserva su ACL) — se repite de todas
-- formas, de forma puramente defensiva e idempotente.
REVOKE ALL ON FUNCTION registrar_version_cartilla_delegado_adjunta(UUID, BOOLEAN, UUID, BOOLEAN, TEXT, TEXT, TEXT, INTEGER, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION clasificar_adjunto_cartilla_delegado_historico(UUID, BOOLEAN, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION registrar_version_cartilla_delegado_adjunta(UUID, BOOLEAN, UUID, BOOLEAN, TEXT, TEXT, TEXT, INTEGER, UUID, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION clasificar_adjunto_cartilla_delegado_historico(UUID, BOOLEAN, UUID, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID, TEXT, DATE, TEXT) TO service_role;

ALTER FUNCTION registrar_version_cartilla_delegado_adjunta(UUID, BOOLEAN, UUID, BOOLEAN, TEXT, TEXT, TEXT, INTEGER, UUID, BOOLEAN) SET search_path = public, pg_temp;
ALTER FUNCTION clasificar_adjunto_cartilla_delegado_historico(UUID, BOOLEAN, UUID, BOOLEAN) SET search_path = public, pg_temp;
ALTER FUNCTION crear_o_adjuntar_cartilla_institucional(UUID, UUID, TEXT, UUID, TEXT, DATE, TEXT) SET search_path = public, pg_temp;

-- Reversible:
--   DROP FUNCTION IF EXISTS registrar_version_cartilla_delegado_adjunta(UUID, BOOLEAN, UUID, BOOLEAN, TEXT, TEXT, TEXT, INTEGER, UUID, BOOLEAN);
--   DROP FUNCTION IF EXISTS clasificar_adjunto_cartilla_delegado_historico(UUID, BOOLEAN, UUID, BOOLEAN);
--   ALTER TABLE rodeo_adjuntos DROP CONSTRAINT IF EXISTS chk_rodeo_adjuntos_cartilla_clasificacion;
--   ALTER TABLE rodeo_adjuntos DROP COLUMN IF EXISTS cartilla_clasificacion;
--   (crear_o_adjuntar_cartilla_institucional, registrar_version_cartilla_
--   delegado_adjunta y clasificar_adjunto_cartilla_delegado_historico
--   quedarían sin recrear — reaplicar 076 las deja en su estado anterior,
--   reabriendo los riesgos descritos en la cabecera — NO recomendado).
