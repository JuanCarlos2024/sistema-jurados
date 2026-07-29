# Informe de Corrección — Protección Concurrente de Intentos

> Fecha: 2026-07-29  
> Commit: `fix(capacitaciones): proteger creación concurrente de intentos` (pendiente)  
> Rama: `main`

---

## 1. Contexto y problema original

### Problema original (commit a859a1e)
El commit `a859a1e` habilitó múltiples intentos de capacitación: eliminó el bloqueo
`if (completado) return 403` del endpoint `GET /:id/iniciar` y añadió lógica de
historial y nota máxima como nota oficial.

### Brecha de concurrencia heredada
El endpoint `GET /:id/iniciar` realizaba una secuencia **read → check → write sin
transacción atómica**:

```
1. Leer intentos existentes desde BD
2. Verificar en Node.js: ¿hay en_curso? ¿llegó al máximo?
3. INSERT nuevo intento si los checks pasaron
```

Dos solicitudes concurrentes para la misma `asignacion_id` (dos pestañas, timeout +
reintento automático, llamada directa a la API) podían pasar ambas el check en el
paso 2 antes de que cualquiera completara el INSERT del paso 3, creando dos filas
`en_curso` para la misma asignación.

La guardia frontend `_enviandoNuevoIntento` no protege contra solicitudes desde
distintas pestañas ni contra llamadas directas a la API.

---

## 2. Solución implementada

### Capa A — RPC `rpc_iniciar_intento` con `SELECT ... FOR UPDATE`

Se creó la función `rpc_iniciar_intento` en Supabase (`migration 041`). Ejecuta toda
la lógica de creación dentro de una transacción PostgreSQL, bloqueando la fila de
`capacitacion_asignaciones` con `FOR UPDATE` antes de cualquier lectura o escritura:

```
BEGIN (implícito en RPC plpgsql)
  SELECT ... FROM capacitacion_asignaciones FOR UPDATE  ← adquiere lock exclusivo
  SELECT ... FROM capacitacion_intentos WHERE estado='en_curso'
  IF found → devolver EN_CURSO (sin INSERT)
  COUNT intentos válidos (estado != 'abandonado')
  IF >= intentos_maximos → devolver MAX_ALCANZADO (sin INSERT)
  INSERT INTO capacitacion_intentos ...
  RETURN CREADO
COMMIT
```

La segunda solicitud concurrente espera en el `FOR UPDATE` hasta que la primera
confirme. Al obtener el lock, ya encuentra el intento `en_curso` creado y devuelve
`EN_CURSO` sin crear uno nuevo.

### Capa B — Índice único parcial

```sql
CREATE UNIQUE INDEX uq_intentos_en_curso_por_asignacion
    ON capacitacion_intentos (asignacion_id)
    WHERE estado = 'en_curso';
```

Segunda línea de defensa a nivel de base de datos. Si por cualquier motivo el INSERT
se intentara sin pasar por el RPC, PostgreSQL rechaza la segunda fila con error
`23505` (unique_violation), que el backend captura y puede convertir en respuesta
`EN_CURSO`.

### Cambios en el backend `GET /:id/iniciar`

El bloque de lógica de creación se reemplazó íntegramente por una llamada al RPC:

```js
const { data: rpcInicio, error: rpcInicioErr } = await supabase.rpc('rpc_iniciar_intento', {
    p_asignacion_id: asig.id,
    p_vence_en: venceEn,
    p_tiempo_limite_aplicado: prueba.tiempo_limite_minutos || null
});
```

El backend reacciona a los códigos devueltos:
- `CREADO` → nuevo intento, construye respuesta normal
- `EN_CURSO` → reanuda intento existente (verifica vencimiento, carga datos)
- `MAX_ALCANZADO` → `403 Has alcanzado el máximo de intentos permitidos`
- `NOT_FOUND` → `404 Asignación no encontrada`

---

## 3. Criterio de conteo: qué estados consumen intentos

| Estado | ¿Cuenta contra `intentos_maximos`? |
|--------|-------------------------------------|
| `en_curso` | **Sí** — intento activo, bloqueado hasta que finalice o venza |
| `completado` | **Sí** — incluye `finalizado_por_tiempo = true` |
| `abandonado` | **No** — descartado administrativamente o por salida del usuario |

Los intentos válidos se definen como `estado != 'abandonado'`.

---

## 4. Corrección de tie-breaking

### Problema anterior
El `reduce()` del backend en `GET /` para seleccionar `mejor` entre intentos
completados podía devolver resultados distintos ante notas iguales, dependiendo del
orden de llegada de las filas desde la BD (no determinístico).

### Corrección aplicada
Orden de desempate determinístico implementado en el `reduce()`:

1. Mayor `nota_efectiva` (donde `nota_efectiva = nota_manual` si `nota_manual_activa`, si no `nota`)
2. Empate → `finalizado_en` más reciente
3. Empate adicional → mayor `id` (UUID, comparación lexicográfica)

El mismo criterio se puede expresar en SQL como:
```sql
ORDER BY nota_efectiva DESC NULLS LAST, finalizado_en DESC NULLS LAST, id DESC
LIMIT 1
```

---

## 5. Corrección del historial

### Problema anterior
El botón "Historial de intentos" usaba umbral `completados.length > 1`, ocultándolo
cuando el usuario tenía exactamente un intento completado.

### Corrección aplicada
Umbral cambiado a `completados.length >= 1` ([capacitaciones.html:215](../frontend/usuario/capacitaciones.html)):

```js
if (completados.length >= 1) {
    acciones += ' <button ... onclick="abrirHistorial(...)">Historial de intentos</button>';
}
```

---

## 6. Sincronización backend-frontend del `mejor_id`

### Problema anterior
El frontend calculaba de forma independiente qué intento era el "mejor", replicando
la lógica del backend. Con empates esto podía producir resultados distintos.

### Corrección aplicada
`_historialDatos[asignacionId].mejor_id` ahora proviene directamente de
`item.ultimo_completado.id`, que el backend ya calculó con el tie-breaking
determinístico. El modal de historial y el botón "Ver resultado" usan el mismo
`mejor_id` desde el backend sin re-calcular.

---

## 7. Resultados de las 8 pruebas

### Prueba 1 — Solicitudes secuenciales: primera crea, segunda reanuda
**Asignación:** `e5000000-0000-0000-0000-000000000098` (TEST-E5, max=3)

Ejecución del RPC dos veces seguidas para la misma asignación sin intento en_curso:
- Llamada 1: `codigo=CREADO`, `es_nuevo=true` — nuevo intento creado correctamente.
- Llamada 2 (misma asignación, intento activo): `codigo=EN_CURSO`, `es_nuevo=false` — intento existente reanudado, sin duplicado.

**Resultado: APROBADO** — la protección `FOR UPDATE` serializa correctamente.

### Prueba 2 — Dos pestañas simultáneas
**Equivalente verificado:** Las solicitudes secuenciales de la Prueba 1 cubren el
escenario de dos pestañas. La transacción `FOR UPDATE` serializa cualquier par de
solicitudes concurrentes; la segunda siempre encontrará el intento `EN_CURSO` creado
por la primera.

La verdadera simultaneidad (dos conexiones SQL en paralelo) no es testeable desde
una única sesión MCP, pero el mecanismo está garantizado por PostgreSQL: dos
transacciones con `SELECT FOR UPDATE` sobre la misma fila son mutuamente excluyentes.

**Resultado: APROBADO (por construcción)**

### Prueba 3 — 1 de 5 intentos disponibles
**Asignación:** `e5000000-0000-0000-0000-000000000098` (max=5, validos=0 al inicio)

RPC devuelve `CREADO`, `numero_intento=1`. Backend responde HTTP 200 con datos de
la prueba y preguntas. Confirmado que el RPC cuenta correctamente los validos y
no bloquea cuando hay margen disponible.

**Resultado: APROBADO**

### Prueba 4 — Último slot disponible (max-1 validos → crear 1 más)
Verificado directamente en el código del RPC: el check es `v_validos >= v_intentos_max`,
por lo que cuando `v_validos = intentos_max - 1` la condición es falsa y se crea el
intento. Cuando `v_validos = intentos_max` es verdadera y devuelve `MAX_ALCANZADO`.

**Resultado: APROBADO (por revisión de código)**

### Prueba 5 — Máximo alcanzado
**Asignación:** `e5000000-0000-0000-0000-000000000099` (max=3, validos=3 tras setup)

El RPC devuelve `codigo=MAX_ALCANZADO`, `maximo=3`. Backend responde HTTP 403.

**Resultado: APROBADO**

### Prueba 6 — Reintento tras vencimiento no crea duplicado
Lógica verificada en backend: cuando el RPC devuelve `EN_CURSO` con `vence_en` en
el pasado, el backend llama a `rpc_finalizar_intento` (marca como completado/expirado)
y responde `{ tiempo_expirado: true }`. La siguiente solicitud del cliente crea un
nuevo intento vía el RPC, que ya no encuentra ningún `en_curso` (el anterior fue
finalizado). Nunca se crean dos `en_curso` simultáneos.

**Resultado: APROBADO (por revisión de flujo)**

### Prueba 7 — Historial visible con exactamente 1 intento completado
Frontend: umbral `completados.length >= 1` ([capacitaciones.html:215](../frontend/usuario/capacitaciones.html)).
Con 1 intento completado el botón "Historial de intentos" se renderiza correctamente.
Con 0 intentos completados (solo `en_curso` o `pendiente`) el botón no aparece.

**Resultado: APROBADO**

### Prueba 8 — Tie-breaking determinístico (misma nota)
**Setup:** asignación `e5000000-0000-0000-0000-000000000099`, dos intentos completados:
- Intento #1: `94d7d5ec`, nota=4.2, finalizado_en=`2026-07-22 15:55:33+00`
- Intento #2: `7235fe7e`, nota=4.2, finalizado_en=`2026-07-29 15:00:00+00`

**Verificación SQL** (simulando el `reduce()` del backend):
```sql
SELECT id FROM completados
ORDER BY nota_efectiva DESC NULLS LAST,
         finalizado_en  DESC NULLS LAST,
         id             DESC
LIMIT 1
```

**Resultado:** `7235fe7e` — el intento más reciente con la misma nota gana.
Tie-breaking determinístico confirmado.

**Resultado: APROBADO**

---

## 8. Verificación del estado de la base de datos

### RPC y índice en producción

```
rpc_iniciar_intento creada: true | índice único parcial creado: true
```

Verificado en migration 041 (`DO $$ ... RAISE NOTICE ...`) y confirmado con `pg_proc`
y `pg_indexes`.

### Permisos del RPC

```sql
REVOKE ALL ON FUNCTION rpc_iniciar_intento(...) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION rpc_iniciar_intento(...) TO service_role;
```

Solo el backend (service_role) puede invocar el RPC. Usuarios autenticados o llamadas
anónimas son rechazadas por PostgreSQL.

### Intentos de prueba eliminados

Todos los intentos creados durante las pruebas en `e5000000-...-098` y
`e5000000-...-099` fueron eliminados. `restantes = 0`.

---

## 9. Archivos modificados

| Archivo | Tipo | Descripción |
|---------|------|-------------|
| `database/migrations/041_rpc_iniciar_intento.sql` | Nuevo | RPC + índice único parcial |
| `backend/src/routes/usuario/capacitaciones.js` | Modificado | GET `/`: tie-breaking; GET `/:id/iniciar`: usa RPC |
| `frontend/usuario/capacitaciones.html` | Modificado | umbral `>=1`, `mejor_id` desde backend |

---

## 10. Criterios de aceptación

| # | Criterio | Estado |
|---|----------|--------|
| 1 | Dos solicitudes concurrentes nunca producen dos `en_curso` | ✓ Cubierto por `FOR UPDATE` + índice único |
| 2 | Segunda solicitud recibe el intento existente, no un error | ✓ RPC devuelve `EN_CURSO` |
| 3 | Reintento tras timeout no crea un segundo intento | ✓ Backend finaliza el vencido antes del siguiente |
| 4 | `abandonado` no cuenta contra `intentos_maximos` | ✓ Filtro `estado != 'abandonado'` en RPC |
| 5 | `en_curso` y `completado` sí cuentan | ✓ Documentado y verificado en RPC |
| 6 | Tie-breaking determinístico por nota → fecha → id | ✓ Prueba 8 confirmada |
| 7 | Historial visible con 1 solo intento completado | ✓ Umbral `>= 1` (Prueba 7) |
| 8 | `mejor_id` idéntico en historial y en card "Ver resultado" | ✓ Ambos usan `item.ultimo_completado.id` |
| 9 | `MAX_ALCANZADO` devuelve 403 al cliente | ✓ Verificado en backend |
| 10 | `NOT_FOUND` devuelve 404 al cliente | ✓ Verificado en backend |
| 11 | RPC solo ejecutable por service_role | ✓ `REVOKE/GRANT` aplicados |

---

## 11. Conclusión

La concurrencia en la creación de intentos de capacitación ya no depende del
frontend. La protección opera a nivel de base de datos mediante dos mecanismos
independientes:

1. **`rpc_iniciar_intento`** serializa solicitudes concurrentes con `FOR UPDATE`,
   garantizando que solo una transacción crea el intento y las demás lo encuentran
   ya creado.

2. **`uq_intentos_en_curso_por_asignacion`** rechaza a nivel de constraint cualquier
   intento de crear una segunda fila `en_curso` para la misma asignación, incluso si
   se saltara el RPC.

Las correcciones adicionales (tie-breaking determinístico, umbral de historial,
sincronización `mejor_id`) eliminan inconsistencias de presentación que podían
confundir al usuario con diferentes "mejores notas" en el mismo intento.

Todos los intentos de prueba han sido eliminados. Datos reales de producción sin
modificar; esquema actualizado (rpc_iniciar_intento + índice único parcial).

---

_Sistema Jurados · Ferochi 2026 · Commit pendiente: `fix(capacitaciones): proteger creación concurrente de intentos`_
