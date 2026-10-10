-- ═════════════════════════════════════════════════════════════════════════
-- 068_seleccion_delegado_institucional_por_rodeo.sql
-- Fase 3.3 — selección de Delegado de Asociación INDIVIDUAL por rodeo, antes
-- de que exista cualquier cartilla.
--
-- ⏳ NO APLICADA EN PRODUCCIÓN — pendiente de autorización.
--
-- PROBLEMA que resuelve: la Fase 2 solo tenía una selección GLOBAL y
-- stateless (sessionStorage del navegador, nunca persistida) — se perdía al
-- cambiar de rodeo o de sesión, y un error de UI podía aplicar el mismo
-- delegado a TODOS los rodeos por accidente. La Fase 3 sí persiste un
-- responsable, pero solo DESDE que existe una fila en `cartillas_delegado` —
-- no hay forma de "guardar la elección" de un delegado para un rodeo ANTES
-- de iniciar su cartilla sin, por eso mismo, reservar el rodeo o activar las
-- protecciones de la Fase 3.1/3.2 (índice único parcial, trigger de 067)
-- antes de que exista contenido real que proteger.
--
-- SOLUCIÓN (mínima, aditiva, no toca ninguna tabla existente): una tabla
-- nueva, independiente de `cartillas_delegado`, con UNA fila como máximo por
-- rodeo (UNIQUE(rodeo_id)) — la asociación puede elegir y cambiar de
-- delegado libremente para un rodeo sin cartilla, sin disparar NINGUNA de
-- las protecciones transaccionales de 067 (esas siguen ligadas exclusivamente
-- a `cartillas_delegado`/`asignaciones`, no a esta tabla).
--
-- Cuando SÍ se crea la cartilla (POST /institucional/cartilla/rodeo/:id), el
-- backend lee esta tabla para saber qué delegado usar — nunca se vuelve a
-- pedir en el body de la petición (evita que una selección vieja/incorrecta
-- del cliente se use por error). Esta tabla sigue existiendo DESPUÉS de
-- creada la cartilla (nunca se borra) — es el registro de "qué eligió la
-- asociación", independiente de si la cartilla después cambia de estado.
--
-- NO reemplaza ni modifica `cartillas_delegado.delegado_asociacion_id`
-- (autoría real de la cartilla, Fase 3) — son conceptos relacionados pero
-- DISTINTOS: esta tabla es la "preferencia/elección declarada por rodeo",
-- la columna de cartillas_delegado es la "autoría oficial registrada en la
-- cartilla ya iniciada". Pueden sincronizarse (ver cartilla.js) pero nunca
-- se fusionan en una sola columna.
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rodeos_delegado_institucional (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rodeo_id UUID NOT NULL UNIQUE REFERENCES rodeos(id) ON DELETE CASCADE,
    delegado_asociacion_id UUID NOT NULL REFERENCES delegados_asociacion(id),
    seleccionado_por_cuenta_institucional_id UUID REFERENCES cuentas_institucionales(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE rodeos_delegado_institucional IS
    'Fase 3.3: selección declarada de Delegado de Asociación por rodeo, ANTES de que exista una cartilla. Un máximo de una fila por rodeo (UNIQUE), se actualiza (nunca se duplica) al cambiar de delegado. No activa ninguna protección de la Fase 3.1/3.2 (esas dependen de cartillas_delegado/asignaciones, no de esta tabla).';

CREATE INDEX IF NOT EXISTS idx_rodeos_delegado_institucional_delegado
    ON rodeos_delegado_institucional (delegado_asociacion_id);

-- Reversible: DROP TABLE IF EXISTS rodeos_delegado_institucional;
