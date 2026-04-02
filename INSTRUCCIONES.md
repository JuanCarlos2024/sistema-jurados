# Sistema de Jurados — Federación de Rodeo Chileno
## Guía de instalación y uso

---

## 1. Requisitos previos

Instale las siguientes herramientas en su computador:

| Herramienta | Versión mínima | Descarga |
|-------------|---------------|----------|
| Node.js     | 18 o superior | https://nodejs.org |
| npm         | Incluido con Node.js | — |

Verifique que están instalados:
```
node --version
npm --version
```

---

## 2. Configurar Supabase

### 2.1 Crear proyecto

1. Ingrese a https://supabase.com y cree una cuenta gratuita
2. Haga clic en "New project"
3. Complete: nombre del proyecto, contraseña de base de datos, región (elija la más cercana)
4. Espere que el proyecto se inicialice (1-2 minutos)

### 2.2 Crear las tablas

1. En Supabase, vaya a **SQL Editor** (ícono de base de datos en la barra lateral)
2. Haga clic en **New query**
3. Copie y pegue todo el contenido del archivo `database/schema.sql`
4. Haga clic en **Run** (botón verde)
5. Debe aparecer: "Success. No rows returned"

### 2.3 Obtener las credenciales

1. En Supabase, vaya a **Project Settings** → **API**
2. Copie los siguientes valores (los necesitará en el paso 3):
   - **Project URL** (ej: `https://abcdefgh.supabase.co`)
   - **service_role key** (empieza con `eyJ...`) — NO use la anon key

---

## 3. Configurar el backend

### 3.1 Instalar dependencias

Abra una terminal/consola en la carpeta del proyecto:

```
cd backend
npm install
```

Esto instalará todas las librerías necesarias (puede demorar 1-2 minutos).

### 3.2 Crear archivo de configuración

1. Copie el archivo `backend/.env.example` y llámelo `backend/.env`
2. Abra `backend/.env` con cualquier editor de texto (Bloc de notas, etc.)
3. Complete los valores:

```
PORT=3000
SUPABASE_URL=https://SU-PROYECTO.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
JWT_SECRET=una-frase-larga-y-segura-que-nadie-adivine-2024
JWT_EXPIRES_IN=8h
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
```

**Importante:**
- `JWT_SECRET`: escriba cualquier texto largo y seguro (mínimo 32 caracteres)
- `SUPABASE_URL`: la URL de su proyecto (paso 2.3)
- `SUPABASE_SERVICE_KEY`: la service_role key (paso 2.3)

---

## 4. Setup inicial completo (UNA SOLA VEZ)

Ejecute este comando único que hace todo en orden:

```
cd backend
npm run setup
```

Esto ejecuta 3 pasos automáticamente:
1. Crea el administrador principal
2. Importa los 54 tipos de rodeo desde `Maestro de tipos de rodeo.xlsx`
3. Importa los 81 jurados desde `Maestro de jurados.xlsx`

Al finalizar verá:
```
✅ Setup completado exitosamente
→ Admin: admin@rodeo.cl / Admin2024!
```

**Cambie la contraseña después del primer ingreso** desde Configuración → Administradores.

Si prefiere ejecutar paso a paso:
```
npm run setup:admin    # solo crea el administrador
npm run setup:tipos    # solo importa tipos de rodeo
npm run setup:jurados  # solo importa jurados
```

**Nota:** Si en el futuro agrega jurados al archivo `Maestro de jurados.xlsx`,
puede volver a ejecutar `npm run setup:jurados` — los jurados ya existentes
se actualizarán solo si cambió su categoría; no se crearán duplicados.

---

## 5. Iniciar el sistema

### Opción A — Desarrollo (recomendado para comenzar)

```
cd backend
npm run dev
```

El sistema quedará disponible en: **http://localhost:3000**

La consola mostrará:
```
🚀 Servidor corriendo en http://localhost:3000
📁 Frontend servido desde: .../frontend
```

### Opción B — Producción

```
cd backend
npm start
```

---

## 6. Primer ingreso

1. Abra su navegador e ingrese a: **http://localhost:3000**
2. Seleccione la pestaña **"Administrador"**
3. Ingrese:
   - Email: `admin@rodeo.cl`
   - Contraseña: `Admin2024!`
4. Se abrirá el dashboard de administrador

---

## 7. Configuración inicial del sistema

Los tipos de rodeo y jurados ya fueron cargados por `npm run setup`.
Verifique y ajuste si es necesario:

### 7.1 Verificar tarifas
- Menú → **Configuración**
- Sección "Tarifas por categoría"
- Los valores iniciales ya están cargados (A: $292.000/día, B: $245.000/día, C: $213.500/día)
- Ajuste si es necesario

### 7.2 Verificar retención
- Sección "Retención"
- Valor inicial: 15.25%
- Ajuste si es necesario

### 7.3 Verificar bonos de distancia
- Sección "Bonos por distancia"
- Valores iniciales: 350-499 km = $35.000 / 500+ km = $55.000
- Ajuste si es necesario

### 7.4 Verificar tipos de rodeo
- Menú → **Rodeos** → botón "Tipos de Rodeo"
- Los 54 tipos ya fueron importados desde `Maestro de tipos de rodeo.xlsx`
- Puede agregar nuevos tipos desde la interfaz si es necesario

---

## 8. Flujo de trabajo típico

### Para cargar rodeos desde Excel:

1. **Crear jurados primero:** Menú → Jurados y Delegados → "+ Nuevo usuario"
2. **Preparar el Excel** con columnas: Club, Asociación, Fecha, Tipo Rodeo, Nombre Jurado
3. **Importar:** Menú → Importar Excel → seleccionar archivo
4. **Revisar pendientes:** Si hay nombres que no coinciden, resolver manualmente
5. **Aprobar bonos:** Menú → Bonos → revisar solicitudes pendientes

### Para el usuario (jurado/delegado):

1. Ingresar con código USR-XXXX y contraseña "jurados"
2. Completar perfil (obligatorio en primer ingreso)
3. En "Mis Pagos" ver rodeos del mes
4. Solicitar bono por distancia si corresponde
5. Esperar aprobación del administrador

---

## 9. Estructura del Excel de importación

Use como base el archivo `modelo de excel a subir.xlsx` que ya está en la carpeta del proyecto.

**Columnas requeridas** (el sistema las detecta automáticamente aunque tengan espacios al final):

| Columna       | Requerida | Descripción |
|---------------|-----------|-------------|
| Club          | ✅ Sí      | Nombre del club (puede estar vacío → se guarda como "Sin club") |
| Asociación    | ✅ Sí      | Nombre de la asociación |
| Fecha         | ✅ Sí      | Acepta M/D/AA (ej: 2/25/26), DD/MM/YYYY o YYYY-MM-DD |
| Tipo Rodeo    | ✅ Sí      | Debe coincidir con los tipos importados del maestro |
| Nombre Jurado | ✅ Sí      | Debe coincidir con un jurado registrado |
| CAT           | ❌ No      | Ignorada — el sistema recalcula desde la categoría del jurado |
| PAGO          | ❌ No      | Ignorada — el sistema recalcula desde las tarifas vigentes |
| BONO          | ❌ No      | Ignorada |
| TOTAL         | ❌ No      | Ignorada |

**Tolerancias del importador:**
- Espacios al inicio/final de los nombres de columnas → se ignoran automáticamente
- Tildes y acentos en nombres de tipos y jurados → se normalizan (Día = Dia)
- Guiones en tipos de rodeo → "Provincial - Un Día" = "Provincial Un Dia"
- Mayúsculas/minúsculas → se ignoran para matching
- 1 fila sin Club → se importa correctamente con "Sin club"

**Caso conocido de jurado no encontrado:**
- "MARCELO RAUL MOLINA FRITZ" no está en el Maestro de jurados
- Quedará en Pendientes de revisión → resuélvalo manualmente desde la interfaz
- Para evitar esto, agréguelo al maestro y ejecute `npm run setup:jurados`

---

## 10. Solución de problemas frecuentes

### "No se puede conectar con el servidor"
- Verifique que el backend esté corriendo (`npm run dev`)
- Verifique que el puerto 3000 no esté usado por otro programa

### "Error al obtener tarifas"
- Verifique que ejecutó el schema.sql en Supabase correctamente
- Verifique que las credenciales en `.env` sean correctas

### "Credenciales inválidas" al hacer login
- Verifique que ejecutó el script `crear-admin.js`
- Verifique que el email y contraseña sean correctos

### La importación de Excel dice "Jurado no encontrado"
- El jurado debe estar creado en el sistema primero (Menú → Jurados y Delegados)
- El nombre en el Excel debe ser similar al nombre registrado
- Use la función "Resolver" en Pendientes para asignar manualmente

### Los montos del resumen no aparecen
- Verifique que el jurado tiene asignaciones activas en ese mes
- Las asignaciones deben tener estado "activo" (no anulado)

---

## 11. Seguridad importante

- **Nunca comparta** el archivo `.env` con nadie
- **Nunca use** la `anon key` de Supabase en el backend (use solo `service_role`)
- **Cambie las contraseñas** por defecto después de instalar
- **No exponga** el puerto 3000 a internet sin configurar HTTPS primero
- Para uso en producción con múltiples computadores, consulte a un técnico informático

---

## 12. Descripción de archivos del proyecto

```
SISTEMA_JURADOS/
├── database/
│   └── schema.sql          ← Script SQL para crear las tablas en Supabase
├── backend/
│   ├── .env.example        ← Plantilla de configuración (copiar como .env)
│   ├── .env                ← Sus credenciales (NO compartir)
│   ├── package.json        ← Dependencias del proyecto
│   └── src/
│       ├── app.js          ← Servidor principal
│       ├── config/         ← Configuración de Supabase
│       ├── middleware/      ← Autenticación y autorización
│       ├── services/        ← Lógica de cálculo, importación, exportación
│       ├── routes/admin/   ← Rutas del administrador
│       ├── routes/usuario/ ← Rutas del usuario pagado
│       └── scripts/        ← Scripts de utilidad (crear-admin.js)
└── frontend/
    ├── index.html          ← Página de login
    ├── css/style.css       ← Estilos globales
    ├── js/                 ← JavaScript compartido (api.js, utils.js)
    ├── admin/              ← Páginas del administrador
    └── usuario/            ← Páginas del usuario pagado
```
