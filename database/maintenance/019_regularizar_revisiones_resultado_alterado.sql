-- ═════════════════════════════════════════════════════════════════════════
-- 019: Regularización de revisiones de Comisión (Tipo A — resultados
--      alterados) para evaluaciones EN CURSO, después de aplicar la 103.
--
-- Requiere: migración 103 aplicada.
-- NO toca evaluaciones aprobadas/publicadas/cerradas, anuladas ni
-- históricas, ni ninguna nota: la propia RPC generar_revision_resultado_
-- alterado() las descarta ('evaluacion_publicada' / 'no_aplica').
-- Idempotente: volver a ejecutarlo no duplica (devuelve 'ya_existe').
--
-- Las evaluaciones con alteración cuyo Ciclo 1 todavía NO está cerrado no
-- reciben revisión aquí: nacerá automáticamente al cerrar el Ciclo 1.
--
-- USO:
--   PASO 1 — vista previa (solo lectura): ejecutar la consulta de abajo.
--   PASO 2 — reemplazar el UUID del administrador que ejecuta (actor de la
--            auditoría) en la línea marcada y ejecutar el bloque DO.
--   PASO 3 — verificación: volver a ejecutar la vista previa (debe quedar
--            'ya_existe' en las que tenían Ciclo 1 cerrado).
-- ═════════════════════════════════════════════════════════════════════════

-- ── PASO 1: vista previa (solo lectura) ──────────────────────────────────
SELECT e.id AS evaluacion_id, r.club, r.asociacion, r.fecha, e.estado,
       c1.estado AS ciclo_1,
       CASE
           WHEN rev.id IS NOT NULL         THEN 'ya_existe (' || rev.estado || ')'
           WHEN c1.estado = 'cerrado'      THEN 'SE CREARÁ revisión pendiente'
           ELSE 'se creará al cerrar el Ciclo 1'
       END AS accion
FROM evaluaciones e
JOIN rodeos r ON r.id = e.rodeo_id
LEFT JOIN evaluacion_ciclos c1 ON c1.evaluacion_id = e.id AND c1.numero_ciclo = 1
LEFT JOIN evaluacion_revisiones_comision rev
       ON rev.evaluacion_id = e.id AND rev.tipo = 'resultado_alterado' AND rev.estado <> 'anulada'
WHERE e.resultados_alterados
  AND NOT COALESCE(e.anulada, false)
  AND NOT COALESCE(e.es_historica_importacion, false)
  AND e.estado NOT IN ('aprobado', 'publicado', 'cerrado')
ORDER BY r.fecha, r.club;

-- ── PASO 2: regularización (escribe) ─────────────────────────────────────
-- DO $$
-- DECLARE
--     v_actor UUID := '00000000-0000-0000-0000-000000000000';  -- ← UUID del administrador que ejecuta
--     v_ev    RECORD;
--     v_res   JSONB;
-- BEGIN
--     IF v_actor = '00000000-0000-0000-0000-000000000000' THEN
--         RAISE EXCEPTION 'Indique el UUID real del administrador que ejecuta la regularización';
--     END IF;
--     FOR v_ev IN
--         SELECT e.id FROM evaluaciones e
--         WHERE e.resultados_alterados
--           AND NOT COALESCE(e.anulada, false)
--           AND NOT COALESCE(e.es_historica_importacion, false)
--           AND e.estado NOT IN ('aprobado', 'publicado', 'cerrado')
--     LOOP
--         v_res := public.generar_revision_resultado_alterado(v_ev.id, v_actor, 'regularizacion');
--         RAISE NOTICE '% → %', v_ev.id, v_res;
--     END LOOP;
-- END $$;
