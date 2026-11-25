# Incidente 2026-11-25 — Simulación (DRY-RUN) de Propuesta de Designación

## Síntoma

Al ejecutar la simulación, con el motor actual o con el global y con cualquier cantidad de rodeos, la pantalla mostraba
"No se puede conectar con el servidor. Verifique que el backend esté corriendo". El backend estaba operativo.

## Causa raíz

1. **Cabecera de respuesta demasiado grande.** `cargarRendimientoTemporada` (motorPropuestaDesignacion.js) consultaba
   `notas_rodeo` con un único `.in('asignacion_id', ...)` que incluía **todas** las asignaciones de la temporada.
   PostgREST devuelve la consulta completa en la cabecera `Content-Location`. Con unos 390 UUIDs o más, las
   cabeceras de la respuesta superan los 16 KB que acepta Node, y la consulta falla con `UND_ERR_HEADERS_OVERFLOW`
   (`TypeError: fetch failed`), aunque Supabase haya respondido 200. El backend devolvía entonces un 500.
2. **El frontend ocultaba el error real.** `frontend/js/api.js` convertía cualquier error cuyo mensaje contuviera
   "fetch" en "No se puede conectar con el servidor".

El umbral se cruzó el 2026-11-18 a las 17:02 UTC. Desde ese momento no se pudo guardar ninguna propuesta nueva.

## Corrección (rama `fix/dryrun-consultas-lotes`)

- `backend/src/services/consultaPorLotes.js` (nuevo): función común `seleccionarPorLotes`.
  - Lotes de 150 IDs, sin duplicados.
  - Paginación de 900 filas por lote, con orden determinista.
  - Ejecución secuencial.
  - Todo o nada ante errores.
- La función se aplica en `cargarRendimientoTemporada` (notas y evaluaciones) y en `cargarNotaTecnicaPorJurado`
  (notas técnicas). Se mantienen las mismas columnas, filtros y cálculos.
- `frontend/js/api.js`:
  - Solo se informa "sin conexión" cuando `fetch()` mismo falla.
  - Los errores HTTP se clasifican por código (400, 401/403, 500, 502–504, respuesta inválida, timeout y cancelación).
  - Se conserva el mensaje funcional del backend y se omite el detalle técnico.

No se amplió el límite de cabeceras de Node ni ningún tiempo de espera.

## Seguridad de los errores del endpoint dry-run

- Los errores internos de `POST /admin/propuesta-designacion/dry-run` (500 y el estado `ERROR_TECNICO` del motor global, que responde 200) ya no envían el detalle técnico al navegador.
- El navegador recibe un mensaje funcional y una **referencia** (`DR-XXXXXXXX`).
- El detalle completo queda solo en el log del servidor, junto a esa referencia. Antes de registrarse se redactan tokens, claves y credenciales, y el texto se acota a 2000 caracteres (ver `backend/src/services/erroresSeguros.js`).
- `frontend/js/api.js` no escribe nada en la consola del navegador. Si sanea un mensaje, también sanea `err.data`, y conserva los demás campos estructurados (por ejemplo, el 409).

## Dependencia: límite de filas de la API de Supabase (max_rows)

- **Verificado en producción el 2026-11-25:** cada respuesta devuelve como máximo **1000 filas**. Pedir 5000 por `Range` o `limit` devuelve 1000. El valor no está en la base de datos: se configura en el panel de Supabase (API settings, "Max rows").
- **Página del helper:** `consultaPorLotes.js` pagina de a **900 filas**, por debajo de ese límite. Se verificó contra producción con páginas de 900, 50 y 7: las filas coinciden exactamente con SQL (336 notas, 271 técnicas y 324 evaluaciones, sin duplicados).
- **Protección contra pérdida silenciosa:** la primera página de cada lote pide `count=exact`. Al terminar el lote se exige que las filas recuperadas sean iguales al total. Si alguien bajara "Max rows" por debajo de 900, la consulta fallará con "Resultado incompleto…" en vez de devolver datos de menos.
- **Regla para el futuro:** no bajar "Max rows" por debajo de 1000 sin revisar antes `TAMANO_PAGINA` (900) y los demás `PAGINA = 900` del proyecto.

## Pendientes registrados (NO implementados; reutilizar `consultaPorLotes.js`, sin duplicar implementaciones)

Volumen al 2026-11-25:

| Volumen | Cantidad |
|---|---|
| Rodeos de la temporada | 429 |
| Asignaciones activas de la temporada | 486 |
| Asignaciones de jurado efectivas | 408 |
| Evaluaciones | 325 |

Umbral aproximado: 390 UUIDs por consulta.

### Prioridad CRÍTICA (ya fallan en producción)

| Módulo | Archivo / función | Patrón | Evidencia |
|---|---|---|---|
| Listado de rodeos y cálculo de pendientes | `services/rodeosListado.js` `calcularPendientesPorRodeo` (pantalla Rodeos, "priorizar pendientes") y sus cargadores por `rodeo_id` | `rodeos.in('id', todos los ids filtrados)` | 27 de 30 llamadas en 24 h superaron el umbral (hasta 16,8 KB). **Ignora el error**: no marca pendientes y ordena mal, sin avisar |
| Búsqueda de evaluaciones | `routes/admin/evaluaciones.js` (búsqueda) | `or=(rodeo_id.in.(…),analista_id.in.(…))` | 4 de 5 búsquedas grandes superaron el umbral (hasta 17,9 KB) |

### Prioridad ALTA

| Módulo | Archivo | Patrón / riesgo |
|---|---|---|
| Evaluación de Desempeño Jurados | `services/evaluacionDesempenoJurados.js` | `.in` con asignaciones y rodeos del período. Con la temporada completa (~486) falla, con error visible |
| Matriz de Participación | `services/matrizParticipacion.js` | Igual que Evaluación de Desempeño |
| Hoja de Vida | `routes/admin/hojavida.js` | Notas de todas las asignaciones de los pares de categoría, sin límite de fecha |
| Resumen del portal jurado | `routes/usuario/resumen.js` | Igual que Hoja de Vida. Hoy 8,9 KB (227 asignaciones) y **ignora el error** |
| Motor global en el hilo principal | ver la sección siguiente | Bloquea el backend entre 40 y 50 s con 30 rodeos |

### Prioridad MEDIA-ALTA

| Módulo | Archivo | Patrón / riesgo |
|---|---|---|
| Reportes financieros | `routes/admin/reportes.js`, `services/calculo.js`, `routes/admin/dashboard.js` | Asignaciones del rango. Mensual (≤137) es seguro; con rango de temporada, falla |
| Exportaciones Excel y PDF | `routes/admin/exportacion.js` y exportaciones asociadas | Igual que reportes financieros |
| Reporte Deportivo | `routes/admin/reporte-deportivo.js` (y `revisionesComision.js`, `situacionesEvaluacion.js`) | Evaluaciones del filtro: ~325 hoy (~12 KB) |
| Cartillas y adjuntos | Cargadores por `rodeo_id` del listado de rodeos (cartillas_delegado, cartillas_jurado, rodeo_adjuntos, rodeo_links, rodeo_notas_secundarias) | 10,5 KB hoy |

Ya usan lotes, sin acción: `historialDesignaciones`, `importacionHistorica`, `informeGestion/cargaDatos` y `resumenJurados`. Pueden migrarse a `consultaPorLotes.js` para unificar.

## Detalle del pendiente ALTO — desacoplar el motor global del hilo principal

Con 30 rodeos, el motor global calcula de forma continua entre 40 y 50 s en el hilo principal de Node.
Durante ese tiempo el backend no atiende ninguna otra solicitud, de ningún usuario ni portal. Los presupuestos de 8 s
por fase (búsqueda estricta, búsqueda permisiva y prioridad deportiva) no acotan el total: unos 20 s se consumen en
la simulación base, en el precálculo de candidatos y en la reconstrucción final.

Evaluar en una fase independiente, sin cambiar reglas ni criterios del motor:

- Worker Threads frente a un proceso independiente.
- Gestión de concurrencia: una ejecución a la vez por administrador o en total.
- Estado de procesamiento: en cola, en curso, terminado o fallido, consultable desde la pantalla.
- Prevención de ejecuciones duplicadas, por ejemplo con doble clic o reintentos.
- Recuperación ante fallos o reinicios del servicio.
- Límites de recursos (CPU, memoria y tiempo total) con un estado honesto, nunca un resultado parcial presentado
  como completo.
- Indicador de progreso para el administrador.
- Conservación del objetivo de cobertura del 100 % cuando exista una solución factible. Las preferencias siguen
  siendo flexibles.
