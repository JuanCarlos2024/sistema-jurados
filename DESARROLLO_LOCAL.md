# Ambiente local de pruebas visuales (Fase 2.5)

Esta guía es solo para desarrollo en tu computador. No afecta producción (Render) de ninguna forma.

## Causa del problema original

Si abrías el proyecto con la extensión **Live Preview** de VS Code (o similar), esa
herramienta sirve la carpeta del **proyecto completo** como raíz web, no `frontend/`.
Por eso la URL quedaba como `.../frontend/institucional/dashboard.html` y el CSS,
el logo y el JavaScript (que usan rutas absolutas como `/css/style.css`) no cargaban:
esa ruta absoluta se buscaba en la raíz del proyecto, donde no existe `css/` (vive
dentro de `frontend/css/`). Además, Live Preview **no ejecuta el backend**, así que
ninguna llamada a `/api/...` podía funcionar tampoco.

En este computador, Live Preview además quedó escuchando en el puerto **3000**, el
mismo puerto que usa normalmente el backend real — por eso el servidor real no podía
ni siquiera arrancar ahí (`EADDRINUSE`). Por eso el modo de vista previa usa el
puerto **3100** en vez de 3000: así nunca compite con Live Preview, sin que tengas
que acordarte de cerrarlo cada vez.

**No se modificó ninguna ruta absoluta del frontend** — eso habría sido parchar el
síntoma. La solución correcta es usar el servidor real (Express), que ya sirve
`frontend/` como raíz correctamente.

## Cómo iniciar

Desde la terminal integrada de VS Code (PowerShell), parado en la carpeta del proyecto:

```
cd backend
npm run dev:preview
```

Esto arranca el backend real con `nodemon` (reinicio automático si editas archivos
`.js` del backend), en modo demostración institucional activado, en el puerto 3100.

## URL exacta

Abre en Chrome:

```
http://127.0.0.1:3100/
```

- Pestañas de login normales (Administrador / Jurado-Delegado) funcionan igual que
  siempre, **contra producción real** (misma Supabase de siempre) — ten cuidado si
  pruebas con credenciales reales desde aquí, es la base de datos real.
- La pestaña **"Delegado de Asociación"** usa el **modo demostración** (ver abajo):
  nunca toca Supabase para ese namespace.

## Cómo detener

En la terminal donde corre `npm run dev:preview`, presiona `Ctrl+C`. También puedes
cerrar la terminal integrada.

## Modo demostración — acceso y escenarios

El modo demostración se activa automáticamente con `npm run dev:preview` (variable
`DEMO_INSTITUCIONAL=1`). Todos los datos son **ficticios, en memoria**, se pierden al
reiniciar el servidor, y **nunca se guardan en Supabase**. La contraseña es la misma
para los 3 escenarios: `DEMO1234`.

| Escenario | Correo | Qué muestra |
|---|---|---|
| A — Flujo normal | `demo-osorno@ferochi.com` | 3 delegados certificados, rodeos activos y uno anulado, varios estados de cartilla, permite cambiar el delegado seleccionado |
| B — Sin delegados | `demo-sinregistros@ferochi.com` | Catálogo de delegados vacío — para ver el mensaje correspondiente y confirmar que no se puede seleccionar a nadie |
| C — Todos los estados de cartilla | `demo-estados@ferochi.com` | Un rodeo por cada estado (sin cartilla, borrador, enviada, observada, reenviada, aprobada, cerrada) + un rodeo anulado + un caso de "múltiples cartillas sin resolver". Esta cuenta además tiene `primer_login=true`, para ver el flujo de cambio de contraseña obligatorio |

## Cómo actualizar después de modificar archivos

- **Archivos de `frontend/`** (HTML, CSS, JS): el servidor los lee del disco en cada
  request — solo guarda el archivo y **recarga la página en Chrome** (F5). No hace
  falta reiniciar nada.
- **Archivos de `backend/src/`**: `nodemon` reinicia el proceso solo al guardar.
  Espera a ver de nuevo la línea `🚀 Servidor corriendo...` en la terminal y recién
  ahí recarga el navegador.

## Cómo volver al funcionamiento normal

El modo demostración **nunca se activa solo**: requiere la variable
`DEMO_INSTITUCIONAL=1` explícita y `NODE_ENV` distinto de `production` al mismo
tiempo (doble condición, verificada también en un test automatizado). Para trabajar
sin datos ficticios, usa el comando normal de siempre:

```
cd backend
npm run dev
```

Eso levanta el backend real en el puerto 3000 (si Live Preview no lo está ocupando)
contra la base de datos real, sin modo demostración.

## Qué es ficticio vs. qué requiere base real

- **Ficticio (modo demostración):** todo el namespace `/api/institucional/*`
  (login, delegados, rodeos, perfil) cuando `npm run dev:preview` está activo.
- **Real siempre:** el login de Administrador y de Jurado/Delegado Rentado, y
  *todo* lo demás del sistema (`/api/admin/*`, `/api/usuario/*`) — ninguno de esos
  tiene modo demostración; seguirán usando la Supabase real aunque corras
  `dev:preview`.
- **Para probar el Portal de Delegado de Asociación contra datos reales** (una vez
  que se autoricen y ejecuten las migraciones 061-064 y se cargue al menos una
  cuenta institucional real), usa `npm run dev` normal — el modo demostración deja
  de ser necesario en ese momento.
