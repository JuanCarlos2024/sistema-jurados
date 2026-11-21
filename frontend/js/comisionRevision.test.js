// Portal de Comisión (frontend/js/comisionRevision.js + admin/comision-revision.html)
// y cambios de Análisis de Casos (admin/evaluaciones.html). Funciones puras
// y verificaciones estáticas (el proyecto no tiene entorno DOM para frontend).
const fs = require('fs');
const path = require('path');
const CR = require('./comisionRevision');

const leer = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const portal = leer('admin/comision-revision.html');
const listado = leer('admin/evaluaciones.html');

describe('YouTube (reproductor embebido, sin URL pública nueva)', () => {
    test.each([
        ['https://youtu.be/abcdefghijk', 'https://www.youtube-nocookie.com/embed/abcdefghijk?playsinline=1&rel=0'],
        ['https://www.youtube.com/watch?v=abcdefghijk&t=1m5s', 'https://www.youtube-nocookie.com/embed/abcdefghijk?playsinline=1&rel=0&start=65'],
        ['https://youtu.be/abcdefghijk?t=42', 'https://www.youtube-nocookie.com/embed/abcdefghijk?playsinline=1&rel=0&start=42']
    ])('%s', (url, esperado) => expect(CR.youtubeEmbed(url)).toBe(esperado));
    test('enlaces que no son de YouTube o vacíos → null (la pantalla muestra "no disponible")', () => {
        expect(CR.youtubeEmbed('https://vimeo.com/123')).toBeNull();
        expect(CR.youtubeEmbed(null)).toBeNull();
        expect(CR.youtubeEmbed('javascript:alert(1)')).toBeNull();
    });
});

describe('textos para la Comisión', () => {
    test('indicador "N revisiones — X de N completadas"', () => {
        expect(CR.textoIndicador({ total: 5, resueltas: 2 })).toBe('5 revisiones — 2 de 5 completadas');
        expect(CR.textoIndicador({ total: 1, resueltas: 0 })).toBe('1 revisión — 0 de 1 completada');
        expect(CR.textoIndicador({ total: 0, resueltas: 0 })).toBe('Sin revisiones en este período');
    });
    test('advertencia de pendientes anteriores al período', () => {
        expect(CR.textoAdvertenciaAnteriores(0)).toBeNull();
        expect(CR.textoAdvertenciaAnteriores(5)).toBe('Hay 5 revisiones pendientes de fechas anteriores al período elegido.');
    });
    test('ERROR/ACIERTO explicados según el tipo; el Tipo A nunca promete cambiar la nota', () => {
        expect(CR.explicacionDecision('resultado_alterado', 'error')).toMatch(/No cambia la nota/);
        expect(CR.explicacionDecision('resultado_alterado', 'acierto')).toMatch(/No cambia la nota/);
        expect(CR.explicacionDecision('video_derivado', 'error', 1)).toBe('Hubo un error del jurado: se mantiene el descuento de 1 punto.');
        expect(CR.explicacionDecision('video_derivado', 'acierto', 2)).toBe('El jurado actuó correctamente: el descuento de 2 puntos NO se aplica.');
    });
    test('confirmación: pregunta exacta, identifica el caso y advierte si es la última pendiente', () => {
        const d = { tipo: 'video_derivado', encabezado: { club: 'Club X', asociacion: 'Ñuble', fecha: '2026-11-08' }, video_derivado: { descuento_propuesto: 1 }, es_ultima_pendiente: true };
        const t = CR.textoConfirmacion(d, 'acierto');
        expect(t.startsWith('¿Confirma que desea registrar esta decisión?')).toBe(true);
        expect(t).toContain('Rodeo: Club X — Ñuble (08/11/2026)');
        expect(t).toContain('Decisión: ACIERTO');
        expect(t).toMatch(/última revisión pendiente.*publicarse automáticamente/);
        expect(CR.textoConfirmacion({ ...d, es_ultima_pendiente: false }, 'error')).not.toMatch(/última revisión/);
    });
    test('validación: decisión obligatoria; observación OPCIONAL (106), solo con largo máximo', () => {
        expect(CR.validarDecision(null, 'x')).toMatch(/ERROR o ACIERTO/);
        expect(CR.validarDecision(null, '')).toMatch(/ERROR o ACIERTO/);
        expect(CR.validarDecision('error', '   ')).toBeNull();
        expect(CR.validarDecision('acierto', '')).toBeNull();
        expect(CR.validarDecision('acierto', undefined)).toBeNull();
        expect(CR.validarDecision('acierto', 'ok')).toBeNull();
        expect(CR.validarDecision('error', 'x'.repeat(2001))).toMatch(/2000/);
    });
    test('consulta: estado por defecto "pendientes"; "todos/todas" no se envían', () => {
        expect(CR.construirQuery({})).toBe('estado=pendientes');
        expect(CR.construirQuery({ desde: '2026-11-01', hasta: '2026-11-30', tipo: 'video_derivado', estado: 'todos', resolucion: 'error' }))
            .toBe('desde=2026-11-01&hasta=2026-11-30&tipo=video_derivado&estado=todos&resolucion=error');
        expect(CR.construirQuery({ tipo: 'todos', resolucion: 'todas' })).toBe('estado=pendientes');
    });
});

describe('pantalla de Comisión', () => {
    test('título, filtros por fecha del rodeo, tipo, estado (pendientes por defecto) y resolución', () => {
        expect(portal).toContain('REVISIÓN DE CASOS — COMISIÓN');
        for (const t of ['Fecha del rodeo desde', 'Fecha del rodeo hasta', 'Tipo de revisión', 'Resultados alterados', 'Videos derivados', 'Quitar fechas']) expect(portal).toContain(t);
        expect(portal).toMatch(/<select id="f-estado"[^>]*>\s*<option value="pendientes">Pendientes<\/option>/);
    });
    test('solo dos decisiones visibles: ERROR y ACIERTO; ningún texto de aprobar/rechazar/mantener/revertir', () => {
        expect(portal).toMatch(/<span class="nombre">ERROR<\/span>/);
        expect(portal).toMatch(/<span class="nombre">ACIERTO<\/span>/);
        for (const prohibido of ['Aprobar descuento', 'Rechazar descuento', 'Mantener sanción', 'Revertir sanción']) expect(portal).not.toContain(prohibido);
    });
    test('confirma antes de registrar y no tiene ningún botón para publicar notas', () => {
        expect(portal).toContain('await confirmar(');
        expect(portal).not.toMatch(/publicar_evaluacion|\/aprobar|Publicar nota/i);
    });
    test('datos del analista en solo lectura: no hay campos editables de puntajes, comentarios ni videos', () => {
        const inputs = portal.match(/<(input|textarea|select)\b[^>]*>/g) || [];
        const ids = inputs.map(i => (i.match(/id="([^"]+)"/) || [])[1]);
        expect(ids.sort()).toEqual(['crc-observacion', 'f-desde', 'f-estado', 'f-hasta', 'f-resolucion', 'f-tipo'].sort());
    });
    test('todo lo que viene del servidor se muestra sanitizado', () => {
        expect(portal).toMatch(/sanitizar\(a\.observacion_general/);
        expect(portal).toMatch(/sanitizar\(v\.comentario_analista\)/);
        expect(portal).toMatch(/sanitizar\(ra\.comentario/);
    });
});

describe('Análisis de Casos (vista administrativa)', () => {
    test('columnas nuevas "Resultados alterados" y "Comisión" sin quitar las existentes', () => {
        const ths = (listado.match(/<thead>[\s\S]*?<\/thead>/)[0].match(/<th>([^<]*)<\/th>/g) || []).map(t => t.replace(/<\/?th>/g, ''));
        expect(ths).toEqual(['Club', 'Asociación', 'Fecha rodeo', 'Analista', 'Jurado(s)', 'Faltas', 'Nota final', 'Ciclo 1 — Primeros 3', 'Resultados alterados', 'Ciclo 2 — Campeones', 'Comisión', 'Estado', 'Creada', '']);
    });
    test('filtros nuevos y exportación usan la MISMA función de filtros que la tabla', () => {
        for (const id of ['fil-alterados', 'fil-derivado', 'fil-estado-comision', 'fil-resolucion']) expect(listado).toContain(`id="${id}"`);
        expect(listado).toContain("'/admin/evaluaciones/exportar?' + filtrosListadoQuery()");
        expect(listado).toContain('`/admin/evaluaciones?page=${pagina}&limit=20` + filtrosListadoQuery()');
        expect(listado).toContain('>Exportar Excel</button>');
    });
});
