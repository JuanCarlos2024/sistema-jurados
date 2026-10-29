# Pauta de prueba manual — modal "Reemplazar jurado" (Fase 1B)

Sin navegador automatizado disponible en esta sesión (sin Playwright/Puppeteer instalados, sin WSL, sin Docker). Esta pauta cubre lo que la verificación estática/DOM simulada (`frontend/js/rodeosReemplazarJurado.test.js`) no puede confirmar: que la pantalla REALMENTE se ve y se comporta así en un navegador real.

**Entorno recomendado:** backend local (`npm run dev`) apuntando a una base de **prueba**, nunca a producción — ver `backend/.env`. Si solo tiene acceso a la base de producción, use una cuenta y rodeos de prueba exclusivos, y **no aplique todavía la migración 084** (está pendiente de autorización) — sin ella, el endpoint `POST /:id/reemplazar` devolverá error 500 al intentar llamar a la función, lo cual sigue siendo útil para verificar los pasos 1-6 (todo lo que ocurre antes de la llamada a la API).

## Preparación
1. Tener al menos un rodeo activo con una asignación de **jurado** (no delegado rentado).
2. Tener al menos dos jurados activos distintos en el sistema, para poder elegir un reemplazante.

## Pasos

| # | Acción | Resultado esperado |
|---|--------|---------------------|
| 1 | Abrir **Rodeos → ver detalle** de un rodeo con un jurado asignado. | Aparece el botón **"Reemplazar"** junto a "Editar", solo en la fila del jurado (nunca en una fila de Delegado Rentado). |
| 2 | Clic en **"Reemplazar"**. | Se abre el modal "Reemplazar jurado", con una alerta mostrando el **nombre del jurado actual** y su categoría, y una advertencia de que el cambio queda registrado en la bitácora. |
| 3 | Escribir 2+ letras en "Nuevo jurado". | Aparece una lista de resultados (solo jurados, nunca delegados) excluyendo al jurado actual. |
| 4 | Seleccionar un jurado de la lista. | El campo de búsqueda se completa con su nombre, aparece un aviso "Reemplazante: [nombre] — el pago base se recalculará con su propia tarifa", y el botón "Confirmar reemplazo" sigue deshabilitado (falta el motivo). |
| 5 | Abrir el selector "Motivo del reemplazo". | Se listan los motivos reales del catálogo (ej. "Indisponibilidad del jurado", "Rechazo de designación", etc. — 10 en total), nunca vacío. |
| 6 | Elegir un motivo. | El botón "Confirmar reemplazo" se habilita. |
| 7 | (Opcional) Escribir un comentario. | Se acepta libremente, no es obligatorio para habilitar el botón. |
| 8 | Clic en "Confirmar reemplazo". | Aparece un diálogo de confirmación explícito antes de enviar nada. |
| 9 | Cancelar ese diálogo. | No ocurre ninguna llamada de red (verificar en la pestaña Red/Network del navegador); el modal permanece abierto. |
| 10 | Repetir 8 y esta vez **aceptar** la confirmación. | Se envía `POST /api/admin/asignaciones/:id/reemplazar`; si la migración 084 está aplicada: toast "Jurado reemplazado correctamente" y el detalle del rodeo se recarga mostrando ya al nuevo jurado. |
| 11 | Repetir el reemplazo sobre una asignación con un bono **aprobado** (monto real, no automático). | Error 409 visible como toast, mencionando que requiere un procedimiento administrativo aparte — el jurado NO cambia. |
| 12 | Intentar reemplazar por un jurado que ya está designado en otro rodeo con fechas que se cruzan con el actual. | Error 409 "ya está asignado a otro rodeo en fechas que se cruzan" — el jurado NO cambia. |
| 13 | Abrir el mismo modal en dos pestañas del navegador (simulando dos administradores), completar el reemplazo en la primera, y luego confirmar en la segunda sin recargar. | La segunda pestaña recibe el error de "modificado por otro administrador" y recarga automáticamente el detalle del rodeo. |
| 14 | Abrir el modal **"Editar"** (no "Reemplazar") de una asignación de jurado. | Ya NO aparece ningún campo para cambiar la persona — solo override de valor diario, km y observación, exactamente como antes. Sigue funcionando para guardar esos campos. |

## Qué anotar al ejecutar esta pauta
- Capturas de pantalla o grabación de cada paso, si es posible.
- Cualquier paso cuyo resultado no coincida con lo esperado, con el mensaje de error exacto visto en consola/Network.
