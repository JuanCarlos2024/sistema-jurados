// Protección estática (regex sobre el código fuente — este proyecto no tiene
// entorno DOM para frontend) de la reutilización de cartilla-delegado.html
// entre Delegado Rentado y Delegado de Asociación (Fase 3). El objetivo
// explícito del pedido es "no crear un formulario simplificado": esta MISMA
// página debe servir a ambos, con la autorización/namespace de API como la
// única diferencia real.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'usuario', 'cartilla-delegado.html'), 'utf8').replace(/\r\n/g, '\n');

describe('Gate de acceso — compartido entre usuario_pagado y cuenta_institucional', () => {
    test("protegerRuta(['usuario_pagado','cuenta_institucional']) — nunca un string simple (que excluiría a uno de los dos)", () => {
        expect(html).toMatch(/protegerRuta\(\['usuario_pagado',\s*'cuenta_institucional'\]\)/);
    });

    test('la restricción a delegado_rentado dentro de usuario_pagado solo aplica cuando NO es institucional', () => {
        const bloque = html.slice(html.indexOf('_esInstitucional ='), html.indexOf('_esInstitucional =') + 250);
        expect(bloque).toMatch(/if \(!_esInstitucional && _usr\?\.tipo_persona !== 'delegado_rentado'\)/);
    });
});

describe('Namespace de API — nunca comparte middleware de autorización entre los dos tipos', () => {
    test('_API_BASE apunta a /institucional/cartilla o /usuario/cartilla-delegado según el tipo de sesión', () => {
        expect(html).toMatch(/const _API_BASE = _esInstitucional \? '\/institucional\/cartilla' : '\/usuario\/cartilla-delegado'/);
    });

    test('las 4 llamadas de red usan ${_API_BASE} — ninguna quedó con el prefijo /usuario/cartilla-delegado hardcodeado', () => {
        const ocurrenciasHardcodeadas = (html.match(/[`'"]\/usuario\/cartilla-delegado\//g) || []).length;
        expect(ocurrenciasHardcodeadas).toBe(0); // la única mención literal restante es la definición de _API_BASE, sin barra final
        const ocurrenciasApiBase = (html.match(/\$\{_API_BASE\}/g) || []).length;
        expect(ocurrenciasApiBase).toBeGreaterThanOrEqual(4); // GET, POST crear (x2: guardar y enviar), PATCH, POST enviar
    });
});

describe('Conflicto con cartilla de Delegado Rentado — nunca se toca ni se crea en paralelo', () => {
    test('conflicto_rentado detiene el render del formulario con un mensaje, antes de tocar ningún campo', () => {
        const bloque = html.slice(html.indexOf('function renderCartilla'), html.indexOf('function renderCartilla') + 1500);
        expect(bloque).toMatch(/conflicto_rentado/);
        expect(bloque).toMatch(/requiere revisión administrativa/);
        expect(bloque).toMatch(/return;/);
    });

    test('Fase 3.1 — Caso A (delegado_rentado_designado=true): usa el mensaje EXACTO pedido, no el mensaje histórico genérico', () => {
        const bloque = html.slice(html.indexOf('function renderCartilla'), html.indexOf('function renderCartilla') + 1500);
        expect(bloque).toMatch(/delegado_rentado_designado/);
        expect(bloque).toContain('Este rodeo tiene un Delegado Rentado designado. La cartilla corresponde a dicho delegado.');
    });
});

describe('Fase 3.1 (cierre) — Caso D: bloqueo de escritura tras designación posterior (nunca se oculta la cartilla, solo se congela)', () => {
    test('esSoloLectura() combina los estados históricos (enviada/reenviada/aprobada) CON el flag de bloqueo por designación posterior', () => {
        const bloque = html.slice(html.indexOf('function esSoloLectura'), html.indexOf('function esSoloLectura') + 250);
        expect(bloque).toMatch(/_bloqueadaPorDesignacionPosterior/);
        expect(bloque).toMatch(/enviada.*reenviada.*aprobada/s);
        expect(bloque).not.toMatch(/esSoloLectura\(\)\s*\|\|/); // nunca se auto-invoca (regresión de recursión infinita)
    });

    test('ninguna sección quedó usando el chequeo viejo por separado — todas reutilizan esSoloLectura() (una sola fuente de verdad)', () => {
        // Fuera de la definición de esSoloLectura() misma, el patrón viejo ya no debe aparecer.
        const definicion = html.slice(html.indexOf('function esSoloLectura'), html.indexOf('function esSoloLectura') + 250);
        const restoDelArchivo = html.replace(definicion, '');
        expect(restoDelArchivo).not.toMatch(/\['enviada', 'reenviada', 'aprobada'\]\.includes\(_estado\)/);
    });

    test('renderCartilla() setea _bloqueadaPorDesignacionPosterior desde la respuesta del backend ANTES de calcular el modo solo-lectura', () => {
        const bloque = html.slice(html.indexOf('function renderCartilla'), html.indexOf('function renderCartilla') + 2000);
        const iSet = bloque.indexOf('_bloqueadaPorDesignacionPosterior = ');
        const iYa = bloque.indexOf('esSoloLectura()');
        expect(iSet).toBeGreaterThan(-1);
        expect(iYa).toBeGreaterThan(iSet);
    });

    test('se muestra el mensaje EXACTO pedido para el bloqueo (distinto del mensaje del Caso A), sin detener el render del formulario', () => {
        const bloque = html.slice(html.indexOf('function renderCartilla'), html.indexOf('function renderCartilla') + 6000);
        expect(bloque).toContain('Este rodeo presenta un cambio de designación de Delegado. La cartilla se encuentra temporalmente bloqueada hasta que el Administrador resuelva la situación.');
    });

    test('la barra de Guardar/Enviar solo se oculta cuando esSoloLectura() es true (reutiliza el mismo guard, no uno nuevo paralelo)', () => {
        const bloque = html.slice(html.indexOf('document.getElementById(\'cuerpo-cartilla\').innerHTML = html;'), html.indexOf('document.getElementById(\'cuerpo-cartilla\').innerHTML = html;') + 500);
        expect(bloque).toMatch(/if \(!ya\)/);
    });
});

describe('Fase 3.3 — selección de delegado por rodeo resuelta en el BACKEND, nunca desde un selector global en el cliente', () => {
    test('ya NO existe ningún USO real del selector global de Fase 2 (sessionStorage.getItem/setItem, la clave "institucional_delegado_seleccionado", ni la función)', () => {
        expect(html).not.toMatch(/sessionStorage\.(get|set|remove)Item/);
        expect(html).not.toMatch(/'institucional_delegado_seleccionado'/);
        expect(html).not.toMatch(/function _delegadoInstitucionalSeleccionado/);
    });

    test('guardarBorrador y enviarCartilla llaman a POST .../rodeo/:id con body VACÍO — el backend resuelve el delegado desde la selección guardada por rodeo', () => {
        const bloqueGuardar = html.slice(html.indexOf('async function guardarBorrador'), html.indexOf('async function guardarBorrador') + 1000);
        const bloqueEnviar = html.slice(html.indexOf('async function enviarCartilla'), html.indexOf('async function enviarCartilla') + 7000);
        for (const bloque of [bloqueGuardar, bloqueEnviar]) {
            expect(bloque).toMatch(/api\.post\(`\$\{_API_BASE\}\/rodeo\/\$\{RODEO_ID\}`, \{\}\)/);
        }
    });

    test('el catch de guardarBorrador/enviarCartilla sigue mostrando err.message tal cual (así se ve el 422 "Debe seleccionar un delegado..." sin manejo especial que lo oculte)', () => {
        const bloqueGuardar = html.slice(html.indexOf('async function guardarBorrador'), html.indexOf('async function guardarBorrador') + 1800);
        expect(bloqueGuardar).toMatch(/mostrarToast\(err\.message \|\| 'Error al guardar', 'error'\)/);
    });
});

describe('Concurrencia optimista (Fase 3) — version solo para el flujo institucional', () => {
    test('existe la variable _version junto a _cartillaId/_estado', () => {
        expect(html).toMatch(/let _version\s*=\s*null;/);
    });

    test('_version se fija desde la respuesta del GET/POST de creación', () => {
        expect(html).toMatch(/_version\s*=\s*cartilla \? \(cartilla\.version \?\? null\) : null;/);
        expect(html).toMatch(/_version\s*=\s*r\.cartilla\.version;/);
    });

    test('version solo se agrega al payload cuando _esInstitucional (nunca se le manda al backend de Delegado Rentado)', () => {
        const ocurrencias = (html.match(/if \(_esInstitucional\) datos\.version = _version;/g) || []).length;
        expect(ocurrencias).toBe(2); // guardarBorrador + enviarCartilla
    });

    test('código VERSION_DESACTUALIZADA se maneja en guardar Y enviar: avisa y recarga, nunca sobrescribe en silencio', () => {
        const ocurrencias = (html.match(/VERSION_DESACTUALIZADA/g) || []).length;
        expect(ocurrencias).toBeGreaterThanOrEqual(2);
        expect(html).toMatch(/fue modificada por otra sesión[\s\S]{0,200}setTimeout\(\(\) => init\(\), 1200\)/);
    });
});

describe('Menú y navegación institucional — sin opciones financieras/exclusivas de Delegado Rentado (Fase 3.3: sin "Mi Panel")', () => {
    test('el menú institucional reemplazado NO incluye Mis Pagos/Capacitaciones/Material complementario, y YA NO incluye "Mi Panel"', () => {
        const bloque = html.slice(html.indexOf("document.querySelector('.sidebar-nav').innerHTML"), html.indexOf("document.querySelector('.sidebar-nav').innerHTML") + 400);
        for (const prohibido of ['Mis Pagos', 'resumen.html', 'Capacitaciones', 'Material complementario', 'Mi Panel', 'dashboard.html']) {
            expect(bloque).not.toContain(prohibido);
        }
        expect(bloque).toMatch(/Mis Rodeos/);
        expect(bloque).toMatch(/Mi Perfil/);
    });

    test('Fase 3.3 — los enlaces antiguos a /usuario/dashboard.html se redirigen a Mis Rodeos cuando es institucional (ya no a Mi Panel)', () => {
        expect(html).toMatch(/a\.href = '\/institucional\/rodeos\.html'/);
        expect(html).not.toMatch(/a\.href = '\/institucional\/dashboard\.html'/);
    });
});

describe('Fase 3.5 — HISTORIAL DE RESPONSABLES DE LA CARTILLA (bloque final, solo institucional, solo lectura)', () => {
    test('el bloque solo se agrega cuando _esInstitucional — el flujo de Delegado Rentado nunca lo ve', () => {
        const bloque = html.slice(html.indexOf("// ─── HISTORIAL DE RESPONSABLES DE LA CARTILLA (Fase 3.5) ───────────────\n    // Exclusivo del portal institucional"), html.indexOf("document.getElementById('cuerpo-cartilla').innerHTML = html;"));
        expect(bloque).toMatch(/if \(_esInstitucional\) \{/);
        expect(bloque).toContain('HISTORIAL DE RESPONSABLES DE LA CARTILLA');
    });

    test('se agrega DESPUÉS del bloque de Adjuntos, al final — nunca reemplaza ni reordena las 14 secciones existentes', () => {
        const iAdjuntos = html.indexOf('Adjuntos (fotos, imágenes, documentos PDF)');
        const iHistorial = html.indexOf('HISTORIAL DE RESPONSABLES DE LA CARTILLA');
        expect(iAdjuntos).toBeGreaterThan(-1);
        expect(iHistorial).toBeGreaterThan(iAdjuntos);
    });

    test('renderHistorialResponsables() se llama solo para institucional, DESPUÉS de pintar el HTML', () => {
        const bloque = html.slice(html.indexOf("document.getElementById('cuerpo-cartilla').innerHTML = html;"), html.indexOf("document.getElementById('cuerpo-cartilla').innerHTML = html;") + 400);
        expect(bloque).toMatch(/if \(_esInstitucional\) renderHistorialResponsables\(historial_responsables\);/);
    });

    test('renderHistorialResponsables() nunca fabrica eventos: arreglo vacío -> mensaje explícito, no inventa un historial', () => {
        const bloque = html.slice(html.indexOf('function renderHistorialResponsables'), html.indexOf('function renderHistorialResponsables') + 1500);
        expect(bloque).toMatch(/eventos\.length === 0/);
        expect(bloque).toMatch(/Sin eventos de responsable registrados todavía/);
    });

    test('incluye la nota honesta sobre la cuenta institucional compartida (nunca presenta el nombre declarado como identidad individual autenticada)', () => {
        const bloque = html.slice(html.indexOf('function renderHistorialResponsables'), html.indexOf('function renderHistorialResponsables') + 1500);
        expect(bloque).toContain('credencial compartida');
        expect(bloque).toContain('no certifica la identidad individual');
    });

    test('cada evento se sanitiza (sanitizar()) antes de insertarse — nunca XSS desde descripcion/accion', () => {
        const bloque = html.slice(html.indexOf('function renderHistorialResponsables'), html.indexOf('function renderHistorialResponsables') + 1500);
        expect(bloque).toMatch(/sanitizar\(ev\.descripcion\)/);
    });

    test('fmtFechaHoraEvento() nunca lanza si created_at es nulo/indefinido', () => {
        const inicio = html.indexOf('function fmtFechaHoraEvento');
        const bloque = html.slice(inicio, html.indexOf('\n}', inicio) + 2);
        const fn = new Function(`${bloque}; return fmtFechaHoraEvento;`)();
        expect(fn(null)).toBe('—');
        expect(fn(undefined)).toBe('—');
        expect(() => fn('2026-01-01T12:00:00Z')).not.toThrow();
    });
});
