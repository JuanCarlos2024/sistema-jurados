// Protección estática (regex sobre el código fuente — este proyecto no tiene
// entorno DOM para frontend, mismo patrón que matrizParticipacionSticky.test.js
// / casosWhatsapp.test.js) del Portal de Delegados de Asociación (Fase 2).
const fs = require('fs');
const path = require('path');

function leer(carpeta, archivo) {
    return fs.readFileSync(path.join(__dirname, '..', carpeta, archivo), 'utf8').replace(/\r\n/g, '\n');
}

const dashboard = leer('institucional', 'dashboard.html');
const rodeos = leer('institucional', 'rodeos.html');
const perfil = leer('institucional', 'perfil.html');
const index = leer('.', 'index.html');

describe('index.html — tercera pestaña de login institucional, sin tocar las 2 existentes', () => {
    test('existen las 3 pestañas: Administrador, Jurado/Delegado, Delegado de Asociación', () => {
        expect(index).toMatch(/mostrarTab\('admin'\)/);
        expect(index).toMatch(/mostrarTab\('usuario'\)/);
        expect(index).toMatch(/mostrarTab\('institucional'\)/);
    });

    test('el login institucional llama a POST /institucional/auth/login (namespace separado, nunca /auth/usuario/login)', () => {
        expect(index).toMatch(/makeFetchLogin\('\/institucional\/auth\/login'\)/);
    });

    test('Fase 3.3 — tras login exitoso, primer_login=true redirige a perfil institucional con el flag; si no, DIRECTO a Mis Rodeos (ya no a Mi Panel)', () => {
        const bloque = index.slice(index.indexOf('institucionalLoginHandler'), index.indexOf('institucionalLoginHandler') + 700);
        expect(bloque).toMatch(/primer_login[\s\S]{0,60}'\/institucional\/perfil\.html\?primer_login=1'/);
        expect(bloque).toMatch(/'\/institucional\/rodeos\.html'/);
        expect(bloque).not.toMatch(/'\/institucional\/dashboard\.html'/);
    });

    test('Fase 3.3 — sesión ya iniciada con tipo="cuenta_institucional" redirige DIRECTO a Mis Rodeos (no a Mi Panel, no al de usuario/admin)', () => {
        expect(index).toMatch(/u\.tipo === 'cuenta_institucional'[\s\S]{0,150}'\/institucional\/rodeos\.html'/);
    });

    test('mostrarTab() también oculta/activa el formulario institucional (no queda huérfano)', () => {
        const bloque = index.slice(index.indexOf('function mostrarTab'), index.indexOf('function mostrarTab') + 700);
        expect(bloque).toMatch(/form-institucional/);
        expect(bloque).toMatch(/tab-institucional/);
    });
});

describe.each([
    ['rodeos.html', rodeos],
    ['perfil.html', perfil]
])('%s — protección y exclusiones financieras', (nombre, html) => {
    test(`${nombre}: llama protegerRuta('cuenta_institucional') — nunca otro tipo`, () => {
        expect(html).toMatch(/protegerRuta\('cuenta_institucional'\)/);
    });

    test(`${nombre}: el menú NO incluye Mis Pagos, Bonos, ni ninguna pantalla financiera/exclusiva de Delegado Rentado`, () => {
        for (const prohibido of ['Mis Pagos', 'resumen.html', 'bonos', 'Bonos', 'capacitaciones.html', 'evaluaciones.html']) {
            expect(html).not.toContain(prohibido);
        }
    });

    test(`${nombre}: Fase 3.3 — el menú SÍ incluye las 2 secciones permitidas (Mis Rodeos / Mi Perfil), y "Mi Panel" quedó ELIMINADO del menú`, () => {
        const nav = html.slice(html.indexOf('sidebar-nav'), html.indexOf('/nav>'));
        expect(nav).toMatch(/Mis Rodeos/);
        expect(nav).toMatch(/Mi Perfil/);
        expect(nav).not.toMatch(/Mi Panel/);
        expect(nav).not.toMatch(/dashboard\.html/);
    });

    test(`${nombre}: tiene un botón para Cerrar Sesión (api.cerrarSesion)`, () => {
        expect(html).toMatch(/api\.cerrarSesion\(\)/);
    });
});

describe('Fase 3.3 — dashboard.html eliminado como pantalla, conservado SOLO como redirección segura', () => {
    test('protege la ruta igual que cualquier otra pantalla institucional (nunca queda abierta sin sesión)', () => {
        expect(dashboard).toMatch(/protegerRuta\('cuenta_institucional'\)/);
    });

    test('redirige inmediatamente a Mis Rodeos (meta refresh + window.location.replace, nunca deja contenido propio)', () => {
        expect(dashboard).toMatch(/meta http-equiv="refresh" content="0; url=\/institucional\/rodeos\.html"/);
        expect(dashboard).toMatch(/window\.location\.replace\('\/institucional\/rodeos\.html'\)/);
    });

    test('ya no tiene selector de delegado, KPIs ni ningún contenido propio de "Mi Panel"', () => {
        expect(dashboard).not.toMatch(/sel-delegado/);
        expect(dashboard).not.toMatch(/kpi-/);
        expect(dashboard).not.toMatch(/cambiarDelegadoSeleccionado/);
    });
});

describe('rodeos.html — Ajuste Fase 2.5: fecha deportiva sin conversión de huso horario', () => {
    test('NO usa fmtFechaChile() para mostrar la fecha del rodeo (esa función hace conversión UTC->Chile, retrocede un día para una fecha sin hora)', () => {
        expect(rodeos).not.toMatch(/fmtFechaChile\(r\.fecha\)/);
    });

    test('usa un formateador local (fmtFechaRodeo) basado en slicing de texto, sin crear ningún objeto Date ni tocar huso horario', () => {
        const bloque = rodeos.slice(rodeos.indexOf('function fmtFechaRodeo'), rodeos.indexOf('function fmtFechaRodeo') + 300);
        expect(bloque).toMatch(/\.split\('T'\)\[0\]\.split\('-'\)/);
        expect(bloque).not.toMatch(/new Date\(/);
        expect(bloque).not.toMatch(/Intl\.DateTimeFormat/);
    });

    test('fmtFechaRodeo("2026-09-18") = "18-09-2026" (nunca "17-09-2026", sin importar el huso horario de quien lo ejecute)', () => {
        // Extrae y ejecuta la función real del archivo fuente (no la reimplementa).
        const fnTexto = rodeos.slice(rodeos.indexOf('function fmtFechaRodeo'), rodeos.indexOf('\n}', rodeos.indexOf('function fmtFechaRodeo')) + 2);
        const fmtFechaRodeo = new Function(`${fnTexto}; return fmtFechaRodeo;`)();
        expect(fmtFechaRodeo('2026-09-18')).toBe('18-09-2026');
        expect(fmtFechaRodeo('2026-09-18T00:00:00.000Z')).toBe('18-09-2026'); // con hora/zona embebida tampoco se desplaza
        expect(fmtFechaRodeo(null)).toBe('—');
    });

    test('la celda de Fecha en la tabla llama a fmtFechaRodeo(r.fecha)', () => {
        expect(rodeos).toMatch(/<td>\$\{fmtFechaRodeo\(r\.fecha\)\}<\/td>/);
    });
});

describe('rodeos.html — listado de solo lectura (Fase 3: "Completar cartilla" ya navega a la cartilla real)', () => {
    test('rodeo activo: "Completar cartilla" es un enlace funcional a la cartilla compartida, con el rodeo_id correcto', () => {
        expect(rodeos).toMatch(/r\.estado_rodeo === 'anulado'/);
        expect(rodeos).toMatch(/\/usuario\/cartilla-delegado\.html\?rodeo_id=\$\{encodeURIComponent\(r\.id\)\}/);
    });

    test('rodeo anulado: el botón sigue deshabilitado (nunca se puede crear/abrir una cartilla para un rodeo anulado desde acá)', () => {
        expect(rodeos).toMatch(/disabled title="Rodeo anulado: no admite cartilla"/);
    });

    test('esta pantalla (listado) sigue sin hacer ningún POST/PUT/PATCH/DELETE directo hacia cartillas — eso ya ocurre en la página de la cartilla, no aquí', () => {
        expect(rodeos).not.toMatch(/api\.(post|put|patch|delete)\([^)]*cartilla/i);
    });

    test('consume GET /institucional/rodeos (namespace institucional, nunca /usuario/*)', () => {
        expect(rodeos).toMatch(/api\.get\('\/institucional\/rodeos'\)/);
    });

    test('maneja el caso "sin temporada vigente" (mensaje) y "sin rodeos" (tabla vacía) sin romperse', () => {
        expect(rodeos).toMatch(/mensaje/);
        expect(rodeos).toMatch(/tabla-vacia/);
    });

    test('el estado "multiples_cartillas_sin_resolver" se muestra como condición controlada, no se resuelve arbitrariamente', () => {
        expect(rodeos).toMatch(/multiples_cartillas_sin_resolver/);
    });
});

describe('rodeos.html — Fase 3.3: "Tipo de Delegado" / "Nombre del Delegado" / Acción', () => {
    function extraerFuncion(nombre, contextoExtra = '') {
        const inicio = rodeos.indexOf(`function ${nombre}`);
        const fin = rodeos.indexOf('\n}', inicio) + 2;
        const texto = rodeos.slice(inicio, fin);
        return new Function(`${contextoExtra}\n${texto}; return ${nombre};`)();
    }
    // sanitizar() viene de utils.js (no cargado en este entorno sin DOM) — se
    // provee un stub mínimo (identidad) solo para poder extraer y ejecutar
    // estas funciones aisladas, igual que ya se hacía para fmtFechaRodeo.
    const STUB = "function sanitizar(s){return s;}";
    // Extrae también el objeto de mapeo real del archivo (no lo reinventa),
    // así celdaTipoDelegado() se ejecuta con el MISMO literal que en producción.
    const ETIQUETA_TIPO_DELEGADO_SRC = rodeos.slice(rodeos.indexOf('const ETIQUETA_TIPO_DELEGADO'), rodeos.indexOf('};', rodeos.indexOf('const ETIQUETA_TIPO_DELEGADO')) + 2);
    const CTX_TIPO_DELEGADO = ETIQUETA_TIPO_DELEGADO_SRC;

    test('celdaTipoDelegado: Rentado -> badge "Delegado Rentado"', () => {
        const celdaTipoDelegado = extraerFuncion('celdaTipoDelegado', CTX_TIPO_DELEGADO);
        expect(celdaTipoDelegado({ tipo_delegado: 'delegado_rentado' })).toMatch(/Delegado Rentado/);
    });

    test('celdaTipoDelegado: Asociación -> badge "Delegado de Asociación"', () => {
        const celdaTipoDelegado = extraerFuncion('celdaTipoDelegado', CTX_TIPO_DELEGADO);
        expect(celdaTipoDelegado({ tipo_delegado: 'delegado_asociacion' })).toMatch(/Delegado de Asociación/);
    });

    test('celdaTipoDelegado: conflicto -> "Situación excepcional", nunca inventa una modalidad', () => {
        const celdaTipoDelegado = extraerFuncion('celdaTipoDelegado', CTX_TIPO_DELEGADO);
        expect(celdaTipoDelegado({ tipo_delegado: 'conflicto' })).toMatch(/Situación excepcional/);
    });

    test('celdaNombreDelegado: Rentado con nombre resuelto -> texto plano, sin selector', () => {
        const celdaNombreDelegado = extraerFuncion('celdaNombreDelegado', STUB);
        const html = celdaNombreDelegado({ tipo_delegado: 'delegado_rentado', nombre_delegado: 'Pedro González' });
        expect(html).toContain('Pedro González');
        expect(html).not.toMatch(/<select/);
    });

    test('celdaNombreDelegado: Rentado sin nombre resuelto -> "No disponible", nunca un valor inventado', () => {
        const celdaNombreDelegado = extraerFuncion('celdaNombreDelegado', STUB);
        const html = celdaNombreDelegado({ tipo_delegado: 'delegado_rentado', nombre_delegado: null });
        expect(html).toMatch(/No disponible/);
    });

    test('celdaNombreDelegado: Asociación, catálogo con delegados, SIN selección -> placeholder "Seleccionar delegado", nunca autocompleta el primero', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'},{id:'d2',nombre:'Bruno Díaz'}]; let ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaNombreDelegado = extraerFuncion('celdaNombreDelegado', ctx);
        const html = celdaNombreDelegado({ tipo_delegado: 'delegado_asociacion', estado_cartilla: 'sin_cartilla', delegado_asociacion_id_seleccionado: null });
        expect(html).toMatch(/<select/);
        expect(html).toMatch(/— Seleccionar delegado —/);
        expect(html).not.toMatch(/value="d1" selected/);
    });

    test('celdaNombreDelegado: Asociación SIN delegados certificados en el catálogo -> mensaje explícito, nunca un selector vacío', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = []; let ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaNombreDelegado = extraerFuncion('celdaNombreDelegado', ctx);
        const html = celdaNombreDelegado({ tipo_delegado: 'delegado_asociacion', estado_cartilla: 'sin_cartilla', delegado_asociacion_id_seleccionado: null });
        expect(html).toMatch(/Sin delegados certificados/);
        expect(html).not.toMatch(/<select/);
    });

    test('celdaNombreDelegado: Asociación, cartilla ya ENVIADA -> solo lectura (nunca un <select> editable)', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}]; let ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaNombreDelegado = extraerFuncion('celdaNombreDelegado', ctx);
        const html = celdaNombreDelegado({ tipo_delegado: 'delegado_asociacion', estado_cartilla: 'enviada', nombre_delegado: 'Ana Soto', delegado_asociacion_id_seleccionado: 'd1' });
        expect(html).toContain('Ana Soto');
        expect(html).not.toMatch(/<select/);
    });

    test('celdaAccion: Delegado Rentado designado -> botón deshabilitado con el mensaje EXACTO pedido para el Caso A', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: true, tipo_delegado: 'delegado_rentado' });
        expect(html).toMatch(/disabled/);
        expect(html).toContain('Este rodeo tiene un Delegado Rentado designado. La cartilla corresponde a dicho delegado.');
    });

    test('celdaAccion: Asociación SIN selección y SIN cartilla iniciada -> deshabilitado, nunca abre el formulario sin elegir delegado', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: false, delegado_asociacion_id_seleccionado: null, estado_cartilla: 'sin_cartilla' });
        expect(html).toMatch(/disabled/);
        expect(html).toMatch(/Seleccione un delegado/);
    });

    test('celdaAccion: Asociación SIN delegados certificados en el catálogo -> deshabilitado con mensaje específico', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: false, delegado_asociacion_id_seleccionado: null, estado_cartilla: 'sin_cartilla' });
        expect(html).toMatch(/Sin delegados certificados/);
    });

    test('celdaAccion: con selección hecha, sin_cartilla -> "Completar cartilla" (enlace habilitado)', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: false, delegado_asociacion_id_seleccionado: 'd1', estado_cartilla: 'sin_cartilla' });
        expect(html).toMatch(/\/usuario\/cartilla-delegado\.html\?rodeo_id=r1/);
        expect(html).not.toMatch(/disabled/);
        expect(html).toContain('Completar cartilla');
    });

    test('celdaAccion: cartilla en borrador -> "Continuar cartilla"', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}]; const ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: true, delegado_asociacion_id_seleccionado: 'd1', estado_cartilla: 'borrador' });
        expect(html).toContain('Continuar cartilla');
    });

    test('celdaAccion: cartilla enviada/aprobada/etc -> "Ver cartilla" (solo lectura, la propia página de cartilla aplica el bloqueo real)', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}]; const ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: true, delegado_asociacion_id_seleccionado: 'd1', estado_cartilla: 'enviada' });
        expect(html).toContain('Ver cartilla');
    });

    test('celdaAccion: anulado siempre tiene prioridad sobre todo lo demás', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'anulado', delegado_rentado_designado: true, tipo_delegado: 'delegado_rentado' });
        expect(html).toContain('Rodeo anulado: no admite cartilla');
    });

    test('Fase 3.4 — celdaAccion: cartilla ENVIADA -> "Ver cartilla" Y "Descargar PDF" en la MISMA fila', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}]; const ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: true, delegado_asociacion_id_seleccionado: 'd1', estado_cartilla: 'enviada', cartilla_id: 'cart-1' });
        expect(html).toContain('Ver cartilla');
        expect(html).toContain('Descargar PDF');
        expect(html).toMatch(/descargarPdfCartilla\('r1'\)/);
    });

    test('Fase 3.4 — celdaAccion: cartilla APROBADA/CERRADA -> también "Ver cartilla" + "Descargar PDF" (mismas reglas que enviada)', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}]; const ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        for (const estado of ['aprobada', 'cerrada', 'reenviada']) {
            const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: true, delegado_asociacion_id_seleccionado: 'd1', estado_cartilla: estado, cartilla_id: 'cart-1' });
            expect(html).toContain('Ver cartilla');
            expect(html).toContain('Descargar PDF');
        }
    });

    test('Fase 3.4 — celdaAccion: cartilla OBSERVADA -> respeta el flujo existente ("Continuar cartilla", NUNCA Descargar PDF — no es un estado bloqueado)', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}]; const ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: true, delegado_asociacion_id_seleccionado: 'd1', estado_cartilla: 'observada', cartilla_id: 'cart-1' });
        expect(html).toContain('Continuar cartilla');
        expect(html).not.toMatch(/Descargar PDF/);
    });

    test('Fase 3.4 — celdaAccion: estado bloqueado pero SIN cartilla_id (defensivo) -> "Ver cartilla" sin botón de PDF roto', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}]; const ESTADOS_CARTILLA_BLOQUEADOS=['enviada','reenviada','aprobada','cerrada'];";
        const celdaAccion = extraerFuncion('celdaAccion', ctx);
        const html = celdaAccion({ id: 'r1', estado_rodeo: 'activo', delegado_rentado_designado: false, tipo_delegado: 'delegado_asociacion', cartilla_iniciada: true, delegado_asociacion_id_seleccionado: 'd1', estado_cartilla: 'enviada', cartilla_id: null });
        expect(html).toContain('Ver cartilla');
        expect(html).not.toMatch(/Descargar PDF/);
    });
});

describe('rodeos.html — Fase 3.4: "Jurado designado" reemplaza la columna "Estado rodeo"', () => {
    function extraerFuncion(nombre, contextoExtra = '') {
        const inicio = rodeos.indexOf(`function ${nombre}`);
        const fin = rodeos.indexOf('\n}', inicio) + 2;
        const texto = rodeos.slice(inicio, fin);
        return new Function(`${contextoExtra}\n${texto}; return ${nombre};`)();
    }
    const STUB = "function sanitizar(s){return s;}";

    test('la columna "Estado rodeo" fue reemplazada por "Jurado designado" en el encabezado de la tabla', () => {
        expect(rodeos).toMatch(/<th>Jurado designado<\/th>/);
        expect(rodeos).not.toMatch(/<th>Estado rodeo<\/th>/);
    });

    test('el orden de columnas sigue el pedido: Fecha, Club, Asociación, Tipo, Jurado designado, Tipo de Delegado, Nombre del Delegado, Cartilla, Acción', () => {
        const bloque = rodeos.slice(rodeos.indexOf('<thead>'), rodeos.indexOf('</thead>'));
        const columnas = [...bloque.matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1]);
        expect(columnas).toEqual(['Fecha', 'Club', 'Asociación', 'Tipo', 'Jurado designado', 'Tipo de Delegado', 'Nombre del Delegado', 'Cartilla', 'Acción']);
    });

    test('celdaJurados: sin jurados publicados -> "Pendiente de designación"', () => {
        const celdaJurados = extraerFuncion('celdaJurados', STUB);
        expect(celdaJurados({ jurados_designados: [] })).toMatch(/Pendiente de designación/);
    });

    test('celdaJurados: UN jurado publicado -> muestra su nombre', () => {
        const celdaJurados = extraerFuncion('celdaJurados', STUB);
        expect(celdaJurados({ jurados_designados: ['Juan Pérez'] })).toContain('Juan Pérez');
    });

    test('celdaJurados: DOS jurados publicados -> muestra AMBOS nombres de forma legible', () => {
        const celdaJurados = extraerFuncion('celdaJurados', STUB);
        const html = celdaJurados({ jurados_designados: ['Juan Pérez', 'Pedro González'] });
        expect(html).toContain('Juan Pérez');
        expect(html).toContain('Pedro González');
    });

    test('estado_rodeo NUNCA se elimina del backend/frontend: el rodeo anulado sigue identificable visualmente (badge junto al club)', () => {
        expect(rodeos).toMatch(/r\.estado_rodeo === 'anulado'[\s\S]{0,80}badge-anulado/);
        // La fila sigue usando estado_rodeo para bloquear la acción (no solo visual).
        const bloqueAccion = rodeos.slice(rodeos.indexOf('function celdaAccion'), rodeos.indexOf('function celdaAccion') + 300);
        expect(bloqueAccion).toMatch(/r\.estado_rodeo === 'anulado'/);
    });
});

describe('rodeos.html — Fase 3.4: filtros (fecha, club, tipo)', () => {
    function extraerFuncion(nombre, contextoExtra = '') {
        const inicio = rodeos.indexOf(`function ${nombre}`);
        const fin = rodeos.indexOf('\n}', inicio) + 2;
        const texto = rodeos.slice(inicio, fin);
        return new Function(`${contextoExtra}\n${texto}; return ${nombre};`)();
    }

    test('fechaComparable(): nunca crea un objeto Date (sin conversión de huso horario), solo recorta la parte de fecha', () => {
        const fechaComparable = extraerFuncion('fechaComparable');
        expect(fechaComparable('2026-09-18')).toBe('2026-09-18');
        expect(fechaComparable('2026-09-18T00:00:00.000Z')).toBe('2026-09-18');
        expect(fechaComparable(null)).toBe('');
    });

    test('existen los 3 inputs/selects de filtro y el botón "Limpiar filtros"', () => {
        expect(rodeos).toMatch(/id="f-fecha-desde"/);
        expect(rodeos).toMatch(/id="f-fecha-hasta"/);
        expect(rodeos).toMatch(/id="f-club"/);
        expect(rodeos).toMatch(/id="f-tipo"/);
        expect(rodeos).toMatch(/onclick="limpiarFiltros\(\)"/);
    });

    test('aplicarFiltros() combina fecha (inclusiva), club y tipo con AND, sobre la lista COMPLETA ya cargada (nunca sobre lo ya filtrado)', () => {
        const bloque = rodeos.slice(rodeos.indexOf('function aplicarFiltros'), rodeos.indexOf('function limpiarFiltros'));
        expect(bloque).toMatch(/_rodeosActuales\.filter/);
        expect(bloque).not.toMatch(/_rodeosFiltrados\.filter/); // nunca filtra sobre el resultado anterior
    });

    test('aplicarFiltros() valida que "desde" no supere "hasta" y muestra un mensaje claro sin aplicar el filtro', () => {
        const bloque = rodeos.slice(rodeos.indexOf('function aplicarFiltros'), rodeos.indexOf('function limpiarFiltros'));
        expect(bloque).toMatch(/desde && hasta && desde > hasta/);
        expect(bloque).toMatch(/no puede ser posterior/);
    });

    test('limpiarFiltros() resetea los 4 campos y vuelve a mostrar la lista completa', () => {
        const bloque = rodeos.slice(rodeos.indexOf('function limpiarFiltros'), rodeos.indexOf('function limpiarFiltros') + 600);
        expect(bloque).toMatch(/f-fecha-desde['"]\)\.value = ''/);
        expect(bloque).toMatch(/f-fecha-hasta['"]\)\.value = ''/);
        expect(bloque).toMatch(/f-club['"]\)\.value = ''/);
        expect(bloque).toMatch(/f-tipo['"]\)\.value = ''/);
        expect(bloque).toMatch(/_rodeosFiltrados = \[\.\.\._rodeosActuales\]/);
    });

    test('poblarSelectsFiltro() nunca duplica clubes/tipos y ordena alfabéticamente', () => {
        expect(rodeos).toMatch(/new Set\(_rodeosActuales\.map\(r => r\.club\)/);
        expect(rodeos).toMatch(/new Set\(_rodeosActuales\.map\(r => r\.tipo_rodeo\)/);
        expect(rodeos).toMatch(/\.sort\(\(a, b\) => a\.localeCompare\(b, 'es'\)\)/);
    });

    test('muestra la cantidad de rodeos encontrados y un mensaje claro cuando no hay resultados', () => {
        expect(rodeos).toMatch(/rodeo\(s\) encontrado\(s\)/);
        expect(rodeos).toMatch(/Ningún rodeo coincide con los filtros aplicados/);
    });
});

describe('rodeos.html — Fase 3.4: "Descargar PDF" reutiliza el generador oficial (api.descargar), nunca simula éxito', () => {
    function extraerFuncion(nombre, contextoExtra = '') {
        const inicio = rodeos.indexOf(`function ${nombre}`);
        const fin = rodeos.indexOf('\n}', inicio) + 2;
        const texto = rodeos.slice(inicio, fin);
        return new Function(`${contextoExtra}\n${texto}; return ${nombre};`)();
    }

    test('nombreArchivoPDF(): mismo criterio de sanitización que el backend (acentos fuera, sin caracteres inválidos) y fecha sin huso horario', () => {
        const nombreArchivoPDF = extraerFuncion('nombreArchivoPDF');
        expect(nombreArchivoPDF('Club Río Negro (DEMO)', '2026-09-18')).toBe('Cartilla_Delegado_Club_Rio_Negro_DEMO_18-09-2026.pdf');
        expect(nombreArchivoPDF(null, null)).toBe('Cartilla_Delegado_rodeo_sin-fecha.pdf');
    });

    test('descargarPdfCartilla() llama a api.descargar con el endpoint institucional correcto (nunca el del administrador)', () => {
        const bloque = rodeos.slice(rodeos.indexOf('async function descargarPdfCartilla'), rodeos.indexOf('async function descargarPdfCartilla') + 500);
        expect(bloque).toMatch(/api\.descargar\(`\/institucional\/cartilla\/\$\{encodeURIComponent\(r\.cartilla_id\)\}\/pdf`/);
    });

    test('descargarPdfCartilla() nunca simula éxito: cualquier error real se muestra con mostrarError(), no se ignora', () => {
        const bloque = rodeos.slice(rodeos.indexOf('async function descargarPdfCartilla'), rodeos.indexOf('async function descargarPdfCartilla') + 500);
        expect(bloque).toMatch(/catch \(err\)/);
        expect(bloque).toMatch(/mostrarError\(err\)/);
    });

    test('GET /institucional/rodeos expone cartilla_id (necesario para construir el enlace de descarga)', () => {
        expect(rodeos).toMatch(/r\.cartilla_id/);
    });
});

describe('rodeos.html — Fase 3.3: selección de delegado INDEPENDIENTE por rodeo (reemplaza el selector global de Fase 2)', () => {
    test('ya NO existe ningún selector/estado global de delegado (sessionStorage, "institucional_delegado_seleccionado")', () => {
        expect(rodeos).not.toMatch(/sessionStorage/);
        expect(rodeos).not.toMatch(/institucional_delegado_seleccionado/);
    });

    test('cada fila construye su <select> con un id ÚNICO por rodeo (sel-delegado-${r.id}) — nunca un id compartido entre filas', () => {
        expect(rodeos).toMatch(/id="sel-delegado-\$\{r\.id\}"/);
    });

    test('el cambio de un selector llama a POST /institucional/rodeos/:rodeo_id/seleccionar-delegado — namespace específico por rodeo', () => {
        expect(rodeos).toMatch(/api\.post\(`\/institucional\/rodeos\/\$\{encodeURIComponent\(rodeoId\)\}\/seleccionar-delegado`/);
    });

    test('confirmarDelegadoRodeo() actualiza SOLO la fila de ese rodeo (por id), nunca repinta ni afecta otras filas', () => {
        const bloque = rodeos.slice(rodeos.indexOf('async function confirmarDelegadoRodeo'), rodeos.indexOf('async function confirmarDelegadoRodeo') + 2400);
        expect(bloque).toMatch(/celda-nombre-\$\{rodeoId\}/);
        expect(bloque).toMatch(/celda-accion-\$\{rodeoId\}/);
    });

    test('el catálogo de delegados se carga UNA sola vez (GET /institucional/delegados) y se reutiliza en todas las filas', () => {
        expect(rodeos).toMatch(/api\.get\('\/institucional\/delegados'\)/);
        const ocurrencias = (rodeos.match(/api\.get\('\/institucional\/delegados'\)/g) || []).length;
        expect(ocurrencias).toBe(1);
    });

    test('la información de la asociación aparece discretamente en la cabecera (GET /institucional/perfil), sin una pantalla "Mi Panel" separada', () => {
        expect(rodeos).toMatch(/api\.get\('\/institucional\/perfil'\)/);
        expect(rodeos).toMatch(/info-asociacion-discreta/);
    });
});

describe('rodeos.html — Fase 3.5: responsable único (bloqueo real del selector) y confirmación explícita', () => {
    function extraerFuncion(nombre, contextoExtra = '') {
        const inicio = rodeos.indexOf(`function ${nombre}`);
        const fin = rodeos.indexOf('\n}', inicio) + 2;
        const texto = rodeos.slice(inicio, fin);
        return new Function(`${contextoExtra}\n${texto}; return ${nombre};`)();
    }
    const STUB = "function sanitizar(s){return s;}";

    test('celdaNombreDelegado: con delegado_asociacion_id_seleccionado -> "Responsable confirmado", SIN IMPORTAR el estado de la cartilla (ni siquiera "borrador" o "sin_cartilla" reabren el selector)', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Juan Pérez'}];";
        const celdaNombreDelegado = extraerFuncion('celdaNombreDelegado', ctx);
        for (const estado of ['sin_cartilla', 'borrador', 'observada', 'enviada', 'aprobada']) {
            const html = celdaNombreDelegado({ tipo_delegado: 'delegado_asociacion', estado_cartilla: estado, nombre_delegado: 'Juan Pérez', delegado_asociacion_id_seleccionado: 'd1' });
            expect(html).toMatch(/Responsable confirmado/);
            expect(html).toContain('Juan Pérez');
            expect(html).not.toMatch(/<select/);
        }
    });

    test('celdaNombreDelegado: SIN selección todavía -> sigue mostrando el <select> con "— Seleccionar delegado —" (no cambia respecto a la Fase 3.3)', () => {
        const ctx = STUB + "\nlet _delegadosCatalogo = [{id:'d1',nombre:'Ana Soto'}];";
        const celdaNombreDelegado = extraerFuncion('celdaNombreDelegado', ctx);
        const html = celdaNombreDelegado({ tipo_delegado: 'delegado_asociacion', estado_cartilla: 'sin_cartilla', delegado_asociacion_id_seleccionado: null });
        expect(html).toMatch(/<select/);
        expect(html).toMatch(/— Seleccionar delegado —/);
    });

    test('el onchange del <select> llama a confirmarDelegadoRodeo (ya no cambiarDelegadoRodeo — ahora es una confirmación, no una edición libre)', () => {
        expect(rodeos).toMatch(/onchange="confirmarDelegadoRodeo\('\$\{r\.id\}'\)"/);
        expect(rodeos).not.toMatch(/cambiarDelegadoRodeo/);
    });

    test('confirmarDelegadoRodeo() usa confirmar() con el texto EXACTO pedido antes de llamar a la API', () => {
        const bloque = rodeos.slice(rodeos.indexOf('async function confirmarDelegadoRodeo'), rodeos.indexOf('async function confirmarDelegadoRodeo') + 2400);
        expect(bloque).toMatch(/await confirmar\(/);
        expect(bloque).toContain('será el Delegado de Asociación responsable de completar la cartilla de este rodeo');
        expect(bloque).toContain('Una vez confirmado, no podrá cambiarlo directamente. Cualquier reemplazo deberá ser autorizado por el administrador.');
        // La llamada a la API ocurre DESPUÉS del await confirmar(...), nunca antes.
        expect(bloque.indexOf('await confirmar(')).toBeLessThan(bloque.indexOf('api.post'));
    });

    test('confirmarDelegadoRodeo() nunca persiste si se cancela: nunca llama a la API en ese bloque antes del if de cancelación', () => {
        const bloque = rodeos.slice(rodeos.indexOf('async function confirmarDelegadoRodeo'), rodeos.indexOf('async function confirmarDelegadoRodeo') + 2400);
        expect(bloque).toMatch(/if \(!confirmado\)[\s\S]{0,80}select\.value = ''/);
        expect(bloque.indexOf('if (!confirmado)')).toBeLessThan(bloque.indexOf('api.post'));
    });

    test('confirmarDelegadoRodeo() maneja el 409 RESPONSABLE_YA_CONFIRMADO (carrera perdida) recargando el estado real, nunca reintentando en silencio', () => {
        const bloque = rodeos.slice(rodeos.indexOf('async function confirmarDelegadoRodeo'), rodeos.indexOf('async function confirmarDelegadoRodeo') + 2400);
        expect(bloque).toMatch(/RESPONSABLE_YA_CONFIRMADO/);
        expect(bloque).toMatch(/await init\(\)/);
    });
});

describe('perfil.html — sin campos financieros ni de otros usuarios', () => {
    test('no expone ningún campo de pago/bono/remuneración', () => {
        for (const prohibido of ['pago_base', 'monto_aprobado', 'bono', 'remuneraci']) {
            expect(perfil.toLowerCase()).not.toContain(prohibido);
        }
    });

    test('el cambio de password llama a POST /institucional/auth/cambiar-password (namespace institucional)', () => {
        expect(perfil).toMatch(/api\.post\('\/institucional\/auth\/cambiar-password'/);
    });

    test('primer_login oculta el campo de contraseña actual (mismo patrón que usuario/perfil.html)', () => {
        expect(perfil).toMatch(/campo-password-actual.*display\s*=\s*'none'/s);
    });
});
