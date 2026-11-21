-- ═════════════════════════════════════════════════════════════════════════
-- 105_seguridad_cerrar_acceso_api_publica.sql
-- CORRECCIÓN DE SEGURIDAD PRIORITARIA — cierra el acceso de la Data API de
-- Supabase (roles anon / authenticated) al esquema public.
--
-- ⚠️ NO APLICADA — preparada para revisión. Requiere autorización explícita.
-- INDEPENDIENTE de la migración 103 (no comparte archivos ni depende de ella;
-- puede aplicarse antes o después). Recomendado: ANTES de la 103.
--
-- HALLAZGO (verificado en producción 2026-11-19, solo lectura):
--   · El esquema public está expuesto por PostgREST (/rest/v1) — así lo
--     reporta el asesor de seguridad de Supabase (32 errores
--     "rls_disabled_in_public").
--   · 32 tablas SIN RLS conceden todos los privilegios (arwdDxtm) a anon y
--     authenticated, entre ellas public.administradores: 15 filas con email,
--     password_hash, activo y rol_evaluacion. Verificado con SET ROLE anon:
--     anon lee las 15 filas y el planificador acepta un UPDATE (EXPLAIN, sin
--     ejecutar). Quien tenga la clave publicable (anon) podría leer los
--     hashes, darse rol de Administrador pleno o crear un administrador, y
--     modificar rodeos, asignaciones, cartillas, tarifas, etc.
--   · Vista v_asignaciones_completas: SECURITY DEFINER (sin security_invoker)
--     y legible por anon → expone datos de usuarios_pagados (RUT, nombres)
--     aunque esa tabla ya no concede nada a anon.
--   · publicar_evaluacion (SECURITY DEFINER) ejecutable por PUBLIC/anon/
--     authenticated vía /rest/v1/rpc. (La 103 también lo corrige; aquí se
--     cierra antes, de forma idempotente.)
--   · 6 secuencias con USAGE/UPDATE para anon (setval permitiría alterar
--     correlativos, p. ej. seq_codigo_usuario).
--   · ALTER DEFAULT PRIVILEGES del esquema public otorga todo a anon/
--     authenticated en cada objeto nuevo (ver 085): por eso el problema
--     reaparece en cada tabla nueva que no se revoca a mano.
--
-- POR QUÉ NO ROMPE NADA (verificado 2026-11-19):
--   · El backend usa exclusivamente la clave secreta (service_role, con
--     BYPASSRLS) — config/supabase.js y scripts usan SUPABASE_SERVICE_KEY.
--   · Registros de la API (24 h): 29.685 solicitudes REST, el 100 % con la
--     clave secreta (Render y desarrollo local). Cero con la clave publicable.
--   · El frontend no tiene cliente Supabase (solo habla con el backend).
--   · Ninguna política de Storage ni función de otro esquema depende de
--     estos objetos vía anon. El bucket público capacitaciones-imagenes usa
--     su propia política en storage.objects (no se toca).
--   · service_role conserva EXACTAMENTE sus privilegios actuales: aquí solo
--     se revoca a PUBLIC/anon/authenticated (ninguna función de public tiene
--     ACL NULL, por lo que service_role no dependía de PUBLIC). Se respetan
--     las restricciones intencionales ya existentes para service_role
--     (p. ej. _validar_estructura_configuracion_designacion y
--     configuracion_designacion_prioridad_clasificaciones).
--   · postgres (dueño, BYPASSRLS) y las funciones SECURITY DEFINER siguen
--     operando igual; activar RLS sin políticas solo afecta a roles sin
--     BYPASSRLS (anon/authenticated).
--
-- NO SE TOCA: ningún dato, ninguna función/trigger/tabla en su definición,
-- los privilegios de service_role ni los esquemas auth/storage.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- 0. Nunca esperar indefinidamente un bloqueo: ENABLE ROW LEVEL SECURITY y
--    ALTER VIEW toman un bloqueo exclusivo breve por tabla, retenido hasta
--    el COMMIT. Si alguna tabla está ocupada más de 5 s (p. ej. una consulta
--    larga), Postgres aborta con 55P03 (lock_not_available) y la transacción
--    COMPLETA se revierte: no queda ningún cambio parcial. Basta reintentar
--    en un momento de menor uso. LOCAL: solo rige dentro de esta transacción.
SET LOCAL lock_timeout = '5s';

-- 1. Tablas, vistas y vistas materializadas de public: sin privilegios para
--    los roles de la Data API. (PUBLIC no tiene privilegios de tabla.)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 2. Secuencias.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 3. Funciones: sin EXECUTE para PUBLIC, anon ni authenticated (cierra
--    /rest/v1/rpc/*). service_role mantiene sus GRANT explícitos.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- 4. RLS (defensa en profundidad) en las 34 tablas que no lo tenían: las 32
--    expuestas + usuarios_pagados y usuario_observaciones_administrativas
--    (ya sin privilegios para anon desde 087, pero aún sin RLS). Sin
--    políticas: anon/authenticated no ven filas aunque algún día recibieran
--    un GRANT por error; service_role y postgres tienen BYPASSRLS.
ALTER TABLE public.administradores                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asignaciones                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auditoria                           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bonos_config                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bonos_solicitados                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_alternativas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_asignaciones           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_banco_alternativas     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_banco_preguntas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_intentos               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_preguntas              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_pruebas                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capacitacion_respuestas             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cartillas_delegado                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cartillas_jurado                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias_rodeo                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clasificacion_categoria_matriz      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clasificaciones_designacion         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.club_ubicaciones                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comunas_chile                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuracion_retencion             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuracion_tarifas               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.control_gestion_situaciones         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disponibilidad_usuarios             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evaluacion_banco_situaciones        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evaluacion_comentarios_jurado_ciclo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.importaciones                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.importaciones_pendientes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rodeo_adjuntos                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rodeo_links                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rodeos                              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tipos_rodeo                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuario_observaciones_administrativas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios_pagados                    ENABLE ROW LEVEL SECURITY;

-- 5. La vista respeta los permisos y RLS de QUIEN consulta (no del dueño).
--    No la usa el backend ni el frontend; service_role la sigue leyendo.
ALTER VIEW public.v_asignaciones_completas SET (security_invoker = true);

-- 6. Objetos FUTUROS creados por postgres en public: sin privilegios
--    automáticos para anon/authenticated (cierra el origen del problema;
--    service_role conserva su default). Nota: el EXECUTE implícito a PUBLIC
--    de las funciones nuevas es un default GLOBAL de Postgres (no por
--    esquema): cada migración con funciones debe seguir revocándolo de forma
--    explícita, como ya hacen 083–104. La verificación 022 lo controla.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Verificación: database/maintenance/022_verificacion_migracion_105.sql
-- Reversión de EMERGENCIA (reabre la vulnerabilidad; solo con autorización):
--   database/maintenance/023_reversion_migracion_105.sql
