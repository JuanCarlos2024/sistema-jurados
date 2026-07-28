# Prueba de Carga — Evaluación Práctica Ferochi 2026 (TEST)

> Generado por `scenarios_70.py` · Actualizado manualmente con conclusiones formales  
> Fecha de prueba UTC: 2026-07-28T13:31  
> Commit productivo: `7e9d8fa`  
> Infraestructura: Render Pro / 2 CPU / 4 GB / 1 instancia / Autoscaling OFF + Supabase Pro

---

## 7 Conclusiones Formales — Escenario de 70 Usuarios

Estas conclusiones registran únicamente lo que fue medido y verificado.  
**Los resultados APROBADO de /responder y DEGRADADO del login son independientes y no deben mezclarse.**

**1. Una instancia Render Pro soportó 70 usuarios realistas.**  
70/70 usuarios completaron el flujo íntegro (login → capacitaciones → iniciar → 60 respuestas → finalizar → resultado). 4 200/4 200 respuestas almacenadas en BD. 0 errores HTTP. 0 timeouts. La infraestructura no se reinició.

**2. El backend del botón Siguiente no reprodujo el incidente histórico.**  
El endpoint `POST /usuario/capacitaciones/intentos/:id/responder` procesó todas las solicitudes correctamente bajo pico. 70/70 respuestas por intento almacenadas. 0 duplicados en BD. El mecanismo de upsert ON `(intento_id, pregunta_id)` demostró ser efectivo bajo concurrencia real.

**3. 70 solicitudes dentro de una ventana de 100 ms fueron procesadas sin errores.**  
Pico 4 del escenario 70-C: 70 solicitudes simultáneas enviadas dentro de una ventana de 100 ms. ok=70/70. avg=405 ms. p95=503 ms. 0 errores. 0 timeouts. 0 duplicados en BD.

**4. El único componente degradado fue el login simultáneo.**  
Escenario 70-B (70 logins simultáneos, barrier): 70/70 logins exitosos, 0 errores, 0 timeouts.  
avg=14 167 ms · p95=22 737 ms · max=22 909 ms.  
Clasificación: **DEGRADADO** — todos ingresaron en menos de 30 s, pero el 97% tardó más de 5 s.  
Causa probable: serialización de bcrypt bajo concurrencia de 70 requests en 2 CPUs.  
Este resultado corresponde exclusivamente al escenario de 70 logins simultáneos, no al flujo realista (70-A).

**5. Los videos de YouTube no atravesaron Render.**  
Las preguntas de tipo `video_alternativas` y `verdadero_falso_video` almacenan únicamente la URL del video. El contenido del video lo sirve YouTube directamente al browser del usuario. La verificación confirmó 60/60 preguntas activas con `video_url` presente. Render Pro no procesó tráfico de video durante la prueba.

**6. Playwright quedó pendiente.**  
Playwright no está instalado en el entorno de prueba. El escenario 70-D no pudo ejecutarse.  
Hallazgo asociado: `apiFetch()` en `frontend/js/api.js` usa `fetch()` sin `AbortController`, sin `signal`, sin timeout. Los usuarios ven un spinner indefinido durante picos de login. Corrección preparada en rama `fix/login-ux-timeout`.

**7. Todavía no se puede afirmar un margen del 30% hasta probar 100 usuarios.**  
Los 70 usuarios representan la carga validada hasta esta fecha. No se ha probado 100 usuarios. El margen de seguridad respecto de la carga operativa real (≤ 70 evaluados por jornada) no puede calcularse con los datos actuales.

---

## Resumen de resultados — 70 usuarios

| Escenario | Descripción | Resultado |
|-----------|-------------|-----------|
| 70-A | Flujo realista (70 usuarios, 60 s progresivo) | **APROBADO** |
| 70-B | Login simultáneo (70 logins en 1 s) | **DEGRADADO** |
| 70-C | Picos de /responder (ventanas 1 s / 500 ms / 250 ms / 100 ms / 1 s) | **APROBADO** |
| 70-D | Playwright (5 browsers) | **PENDIENTE** |

> Los resultados de 70-A y 70-C son independientes del resultado de 70-B.  
> El flujo real de evaluación (usuarios que ingresan escalonadamente) corresponde a 70-A.

---

## Datos — Escenario 70-A: Flujo realista

**Configuración:** 70 usuarios · entrada progresiva 60 s · pausas 1–3 s · timeout 15 s por request

- Usuarios completados: **70/70**
- Respuestas enviadas: 4 200
- Respuestas OK: 4 200
- Respuestas error: 0
- Duración total: 201.4 s

| Endpoint | avg (ms) | p95 (ms) | p99 (ms) | max (ms) |
|----------|----------|----------|----------|----------|
| login | 734 | 1 063 | 1 362 | 1 362 |
| iniciar | 695 | 1 483 | 1 602 | 1 602 |
| **responder** | **284** | **539** | **901** | **1 200** |
| finalizar | 251 | 275 | 292 | 292 |
| resultado | 339 | 372 | 418 | 418 |

**Intervalos:** `2026-07-28T13:34:04Z` → `2026-07-28T13:37:26Z`

### Integridad de datos (Supabase REST)

| Verificación | Resultado |
|--------------|-----------|
| Intentos íntegros | 70/70 |
| orden_preguntas_json = 60 IDs | 70/70 |
| snapshot_contenido_json presente | 70/70 |
| orden_alternativas_json presente | 70/70 |
| 60 respuestas por intento en BD | 70/70 |
| 0 duplicados por intento | 70/70 |
| **Total respuestas en BD** | **4 200 / 4 200** |

---

## Datos — Escenario 70-B: Login simultáneo

> Este escenario es artificial: 70 logins exactamente simultáneos (barrera de threading).  
> En operación real los usuarios ingresan de forma escalonada (ver 70-A).

**Configuración:** 70 logins simultáneos (barrier) · timeout de medición 45 s

- Éxitos: **70/70** — todos ingresaron
- Errores HTTP: 0
- Timeouts (> 45 s): 0
- avg: 14 167 ms | p95: 22 737 ms | max: 22 909 ms

| Umbral | Logins que lo superaron |
|--------|-------------------------|
| > 5 s  | 68 / 70 |
| > 10 s | 62 / 70 |
| > 15 s | 28 / 70 |
| > 20 s | 12 / 70 |
| > 30 s | 0 / 70 |

**Clasificación: DEGRADADO** — todos ingresaron ≤ 30 s pero p95 > 5 s.

**Intervalos:** `2026-07-28T13:40:17Z` → `2026-07-28T13:40:40Z`

---

## Datos — Escenario 70-C: Picos de /responder

**Configuración:** 5 picos · ventanas 1 s / 500 ms / 250 ms / 100 ms / 1 s

| Pico | Ventana | ok / total | avg (ms) | p95 (ms) | p99 (ms) | BD OK |
|------|---------|------------|----------|----------|----------|-------|
| 1 | 1 000 ms | 70/70 | 262 | 308 | 346 | 70/70 |
| 2 | 500 ms | 70/70 | 262 | 295 | 428 | 70/70 |
| 3 | 250 ms | 70/70 | 352 | 418 | 471 | 70/70 |
| 4 | **100 ms** | **70/70** | **405** | **503** | **524** | **70/70** |
| 5 | 1 000 ms | 70/70 | 247 | 275 | 278 | 70/70 |

p95 máximo entre picos: **503 ms** · Total BD: **350/350** · Duplicados: **0**

**Intervalos:** pico 1 `13:40:43Z` → pico 5 `13:40:51Z`

---

## Datos — Escenario 70-D: Playwright

- Estado: **PENDIENTE** — Playwright no instalado.
- Hallazgo de inspección frontend: `apiFetch()` en `frontend/js/api.js` sin AbortController.
- Impacto: usuarios ven spinner indefinido durante picos de login.
- Corrección: rama `fix/login-ux-timeout` (timeout 35 s, mensajes progresivos a 5 s y 15 s).

---

## Evaluación real — no contaminada

- `REAL_EXAM_ID`: `8a3a8bec-a1f3-4167-8412-faa0abb47c53`
- fecha_fin REAL: `2026-07-09T00:30:00+00:00` — sin modificar.
- fecha_fin TEST extendida para pruebas: `2026-08-01T23:59:00+00:00`.
- fecha_fin TEST original: `2026-07-08T13:23:00+00:00` — pendiente restaurar al terminar.
- 0 usuarios LOADTEST_ en el sistema post-prueba.
- 0 asignaciones LOADTEST_.
- 0 intentos LOADTEST_.
- 0 respuestas LOADTEST_.

---

_Prueba ejecutada con `tests/load/scenarios_70.py` · Sistema Jurados · Ferochi 2026_

---

## Resultado 100-A — Flujo realista (100 usuarios)

> Actualizado: 2026-07-28T16:55:48 UTC | Commit: `7e9d8fa`
> `tests/load/scenarios_100.py`

**Configuración:** 100 usuarios · entrada progresiva 90 s · pausas 1–3 s · timeout 15 s

- Usuarios completados: **100/100**
- Respuestas OK: 6000
- Respuestas error: 0
- Duración total: 226.3 s
- **Total respuestas en BD:** 6000 / 6000 esperadas

| Endpoint | avg (ms) | p95 (ms) | p99 (ms) | max (ms) |
|----------|----------|----------|----------|----------|
| login | 751.4 | 1256.6 | 1412.5 | 1412.5 |
| iniciar | 739.8 | 1360.0 | 2114.7 | 2114.7 |
| **responder** | **302.4** | **625.0** | **981.2** | **1747.4** |
| finalizar | 255.1 | 297.6 | 380.7 | 380.7 |
| resultado | 342.4 | 382.0 | 482.1 | 482.1 |

### Integridad 100-A

| Verificación | Resultado |
|--------------|-----------|
| Intentos íntegros | 100/100 |
| orden_preguntas_json = 60 | 100/100 |
| snapshot_contenido_json | 100/100 |
| orden_alternativas_json | 100/100 |
| 60 respuestas por intento | 100/100 |
| 0 duplicados | 100/100 |
| **Total BD** | **6000 / 6000** |

### Intervalos para dashboards

- 100-A: `2026-07-28T16:51:21.469039+00:00` → `2026-07-28T16:55:07.737314+00:00`

---

## Margen de seguridad validado

**Una instancia Render Pro fue validada con 100 usuarios realistas. Para una evaluación de 70 participantes existe aproximadamente un 30% de margen respecto de la carga validada.**

- Carga validada: 100 usuarios
- Carga operativa máxima esperada: 70 evaluados por jornada
- Margen: ~30%
- Infraestructura validada: Render Pro / 2 CPU / 4 GB / 1 instancia / Autoscaling OFF

---

_Generado por `tests/load/scenarios_100.py` · Sistema Jurados · Ferochi 2026_
