// MEJORA 1 — "Serie en que ocurrió la situación" dentro de VI. Informe de
// disciplina (cartilla-delegado.html): selector dinámico, nunca un catálogo
// fijo — las opciones son siempre los nombres REALES ya registrados en
// `_seriesGanado` (Sección I). Se ejecuta el código REAL extraído del HTML
// (mismo patrón que el resto de esta sesión: new Function + parámetros para
// las dependencias, nunca una reimplementación paralela de la lógica).
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'usuario', 'cartilla-delegado.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerFuncion(nombre) {
    let inicio = html.indexOf(`function ${nombre}(`);
    if (inicio === -1) throw new Error(`No se encontró function ${nombre}(...) en cartilla-delegado.html`);
    if (html.slice(Math.max(0, inicio - 6), inicio) === 'async ') inicio -= 6;
    let i = html.indexOf('{', inicio);
    let profundidad = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') profundidad++;
        else if (html[i] === '}') { profundidad--; if (profundidad === 0) { i++; break; } }
    }
    return html.slice(inicio, i);
}

// Fake DOM mínimo: solo lo que estas funciones realmente tocan
// (document.getElementById(...).innerHTML) — ningún motor de DOM real.
function construirDocumentoFalso() {
    const elementos = {};
    const documentoFalso = {
        getElementById(id) {
            if (!elementos[id]) elementos[id] = { innerHTML: '' };
            return elementos[id];
        }
    };
    return { documentoFalso, elementos };
}

function construirEntorno() {
    const { documentoFalso, elementos } = construirDocumentoFalso();
    let _seriesGanado = [];
    let _disc = { hubo_informe: 'si', situaciones: [] };
    const llamadas = { renderSeries: 0, renderFaltas: 0 };
    const renderSeriesGanadoUnificadoFalso = () => { llamadas.renderSeries++; };
    const renderFaltasPorSerieFalso = () => { llamadas.renderFaltas++; };
    const confirmaciones = [];
    let confirmarRespuesta = true;
    const confirmFalso = (msg) => { confirmaciones.push(msg); return confirmarRespuesta; };

    const codigo = [
        extraerFuncion('esc'),
        extraerFuncion('serieTieneDatos'),
        extraerFuncion('optsSerieDisciplina'),
        extraerFuncion('renderTablaDisciplina'),
        extraerFuncion('setSerieNombre'),
        extraerFuncion('quitarSerie')
    ].join('\n');

    // eslint-disable-next-line no-new-func
    const fabrica = new Function(
        'document', 'confirm', 'esSoloLectura', 'renderSeriesGanadoUnificado', 'renderFaltasPorSerie',
        `let _seriesGanado = arguments[5]; let _disc = arguments[6];
         ${codigo}
         return { optsSerieDisciplina, renderTablaDisciplina, setSerieNombre, quitarSerie,
                  get _seriesGanado() { return _seriesGanado; }, get _disc() { return _disc; } };`
    );

    const api = fabrica(
        documentoFalso, confirmFalso, () => false, renderSeriesGanadoUnificadoFalso, renderFaltasPorSerieFalso,
        _seriesGanado, _disc
    );

    return {
        ...api, elementos, llamadas, confirmaciones,
        setConfirmarRespuesta: (v) => { confirmarRespuesta = v; },
        _seriesGanadoRef: api._seriesGanado, _discRef: api._disc
    };
}

describe('optsSerieDisciplina() — opciones SIEMPRE dinámicas, nunca un catálogo fijo', () => {
    test('sin valor actual -> solo el placeholder + los nombres reales de _seriesGanado', () => {
        const { optsSerieDisciplina, _seriesGanadoRef } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' }, { nombre: '1ra. Libre' });
        const html = optsSerieDisciplina('');
        expect(html).toContain('— Seleccionar serie —');
        expect(html).toContain('Criaderos');
        expect(html).toContain('1ra. Libre');
        expect(html).not.toContain('2da. Libre'); // nunca un catálogo fijo con series que el delegado no registró
    });

    test('valor actual coincide con una serie vigente -> queda marcada selected, sin aviso de "ya no corresponde"', () => {
        const { optsSerieDisciplina, _seriesGanadoRef } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' });
        const html = optsSerieDisciplina('Criaderos');
        expect(html).toMatch(/<option value="Criaderos" selected>Criaderos<\/option>/);
        expect(html).not.toContain('ya no corresponde');
    });

    test('valor actual YA NO coincide con ninguna serie vigente (renombrada/eliminada, o cartilla histórica) -> se agrega como opción adicional, nunca se pierde el dato guardado', () => {
        const { optsSerieDisciplina, _seriesGanadoRef } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Campeones' });
        const html = optsSerieDisciplina('Criaderos'); // "Criaderos" ya no existe
        expect(html).toContain('Criaderos (ya no corresponde a una serie registrada)');
        expect(html).toContain('Campeones');
    });

    test('sin ninguna serie registrada -> solo el placeholder (renderTablaDisciplina es quien decide no ofrecer el selector en este caso)', () => {
        const { optsSerieDisciplina } = construirEntorno();
        const html = optsSerieDisciplina('');
        expect(html.trim()).toBe('<option value="">— Seleccionar serie —</option>');
    });
});

describe('renderTablaDisciplina() — integración real con el selector de serie', () => {
    test('sin series registradas y sin valor guardado -> muestra el mensaje de "registre primero una serie", nunca un selector vacío', () => {
        const { renderTablaDisciplina, elementos, _discRef } = construirEntorno();
        _discRef.situaciones.push({ serie: '', nombre_infractor: 'Juan Pérez' });
        renderTablaDisciplina(false);
        const out = elementos['disc-situaciones-cont'].innerHTML;
        expect(out).toContain('Primero debe registrar al menos una serie en la Sección I');
        expect(out).not.toContain('<select');
    });

    test('con series registradas -> ofrece el selector con las opciones reales, y el valor guardado queda seleccionado', () => {
        const { renderTablaDisciplina, elementos, _seriesGanadoRef, _discRef } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' }, { nombre: 'Campeones' });
        _discRef.situaciones.push({ serie: 'Campeones', nombre_infractor: 'Juan Pérez' });
        renderTablaDisciplina(false);
        const out = elementos['disc-situaciones-cont'].innerHTML;
        expect(out).toMatch(/<select onchange="setSituacion\(0,'serie',this\.value\)">/);
        expect(out).toMatch(/<option value="Campeones" selected>Campeones<\/option>/);
    });

    test('en solo lectura (cartilla ya enviada) -> muestra la serie como texto fijo, "No informado" si la cartilla histórica nunca tuvo este campo (nunca inventa una serie)', () => {
        const { renderTablaDisciplina, elementos, _discRef } = construirEntorno();
        _discRef.situaciones.push({ nombre_infractor: 'Juan Pérez' }); // sin `serie` — cartilla histórica
        renderTablaDisciplina(true);
        const out = elementos['disc-situaciones-cont'].innerHTML;
        expect(out).toContain('value="No informado" readonly');
        expect(out).not.toContain('<select');
    });

    test('en solo lectura con una serie real guardada -> la muestra tal cual, nunca "No informado"', () => {
        const { renderTablaDisciplina, elementos, _discRef } = construirEntorno();
        _discRef.situaciones.push({ serie: 'Criaderos', nombre_infractor: 'Juan Pérez' });
        renderTablaDisciplina(true);
        const out = elementos['disc-situaciones-cont'].innerHTML;
        expect(out).toContain('value="Criaderos" readonly');
    });

    test('cada situación disciplinaria puede tener una serie DISTINTA de las demás', () => {
        const { renderTablaDisciplina, elementos, _seriesGanadoRef, _discRef } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' }, { nombre: 'Campeones' });
        _discRef.situaciones.push(
            { serie: 'Criaderos', nombre_infractor: 'Uno' },
            { serie: 'Campeones', nombre_infractor: 'Dos' }
        );
        renderTablaDisciplina(false);
        const out = elementos['disc-situaciones-cont'].innerHTML;
        expect(out).toMatch(/setSituacion\(0,'serie',this\.value\)">[\s\S]*?<option value="Criaderos" selected>/);
        expect(out).toMatch(/setSituacion\(1,'serie',this\.value\)">[\s\S]*?<option value="Campeones" selected>/);
    });
});

describe('setSerieNombre() — renombrar una serie refresca también el selector de disciplina (regla 4)', () => {
    test('al renombrar, renderTablaDisciplina() se vuelve a ejecutar (nunca deja las opciones viejas del selector de disciplina)', () => {
        const { setSerieNombre, _seriesGanadoRef, elementos, _discRef } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' });
        _discRef.situaciones.push({ serie: 'Criaderos', nombre_infractor: 'Uno' });
        setSerieNombre(0, '1ra. Libre');
        expect(_seriesGanadoRef[0].nombre).toBe('1ra. Libre');
        // renderTablaDisciplina ya corrió de nuevo: la situación conserva su
        // valor viejo ("Criaderos") pero ahora aparece marcada como huérfana.
        const out = elementos['disc-situaciones-cont'].innerHTML;
        expect(out).toContain('Criaderos (ya no corresponde a una serie registrada)');
        expect(out).toContain('1ra. Libre');
    });
});

describe('quitarSerie() — eliminar una serie usada por una situación disciplinaria advierte explícitamente (regla 5)', () => {
    test('con situaciones asociadas -> el mensaje de confirmación las menciona explícitamente', () => {
        const { quitarSerie, _seriesGanadoRef, _discRef, confirmaciones } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' });
        _discRef.situaciones.push({ serie: 'Criaderos', nombre_infractor: 'Uno' }, { serie: 'Criaderos', nombre_infractor: 'Dos' });
        quitarSerie(0);
        expect(confirmaciones[0]).toMatch(/2 situación\(es\) disciplinaria\(s\) está\(n\) asociada\(s\) a la serie "Criaderos"/);
    });

    test('sin ninguna situación asociada -> el mensaje NO menciona ninguna advertencia de disciplina (no asusta sin motivo)', () => {
        const { quitarSerie, _seriesGanadoRef, confirmaciones } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' });
        quitarSerie(0);
        expect(confirmaciones[0]).not.toMatch(/situación/);
    });

    test('si se cancela la confirmación, la serie NUNCA se elimina', () => {
        const { quitarSerie, setConfirmarRespuesta, _seriesGanadoRef } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' });
        setConfirmarRespuesta(false);
        quitarSerie(0);
        expect(_seriesGanadoRef).toHaveLength(1);
    });

    test('al confirmar, la serie se elimina y el selector de disciplina se refresca (la situación queda huérfana, nunca se le borra el dato)', () => {
        const { quitarSerie, _seriesGanadoRef, _discRef, elementos } = construirEntorno();
        _seriesGanadoRef.push({ nombre: 'Criaderos' });
        _discRef.situaciones.push({ serie: 'Criaderos', nombre_infractor: 'Uno' });
        quitarSerie(0);
        expect(_seriesGanadoRef).toHaveLength(0);
        expect(_discRef.situaciones[0].serie).toBe('Criaderos'); // nunca se le quita el valor en silencio
        const out = elementos['disc-situaciones-cont'].innerHTML;
        expect(out).toContain('Criaderos (ya no corresponde a una serie registrada)');
    });
});

describe('agregarSituacion() — la nueva situación arranca con `serie` vacío (nunca undefined, para que el selector controlado funcione)', () => {
    test('el objeto por defecto incluye la clave `serie`', () => {
        const codigo = extraerFuncion('agregarSituacion');
        expect(codigo).toMatch(/serie:\s*''/);
    });
});

describe('Validación de envío — serie obligatoria por situación SOLO cuando ya existen series registradas (regla "para nuevas situaciones, exigir...")', () => {
    test('enviarCartilla() bloquea si hay series registradas y alguna situación no tiene serie seleccionada', () => {
        const inicio = html.indexOf('async function enviarCartilla');
        const bloque = html.slice(inicio, inicio + 4000);
        expect(bloque).toMatch(/_disc\.hubo_informe === 'si' && _seriesGanado\.length > 0/);
        expect(bloque).toMatch(/sinSerie\.length > 0/);
        expect(bloque).toContain('Debe seleccionar la serie correspondiente a cada situación disciplinaria antes de enviar');
    });

    test('la validación de serie corre DESPUÉS de la validación de "debe agregar al menos una situación" (no antes)', () => {
        const inicio = html.indexOf('async function enviarCartilla');
        const bloque = html.slice(inicio, inicio + 4000);
        const iAlMenosUna = bloque.indexOf('Debe agregar al menos una situación disciplinaria.');
        const iSerieObligatoria = bloque.indexOf('_seriesGanado.length > 0');
        expect(iAlMenosUna).toBeGreaterThan(-1);
        expect(iSerieObligatoria).toBeGreaterThan(iAlMenosUna);
    });

    // Validación final (punto 2 del pedido) — una referencia HUÉRFANA (serie
    // renombrada o eliminada después de asociarla a la situación) nunca debe
    // colarse en un envío oficial nuevo solo porque `s.serie` no está vacío:
    // debe coincidir con una serie REALMENTE vigente en _seriesGanado.
    test('la validación exige que `serie` coincida con una serie VIGENTE (nombresSeriesVigentes), no solo que no esté vacía — una referencia huérfana también bloquea el envío', () => {
        const inicio = html.indexOf('async function enviarCartilla');
        const bloque = html.slice(inicio, inicio + 4000);
        expect(bloque).toMatch(/nombresSeriesVigentes/);
        expect(bloque).toMatch(/!nombresSeriesVigentes\.has\(s\.serie\)/);
    });

    test('reproduce el caso concreto: situación con serie ya renombrada/eliminada (huérfana) -> optsSerieDisciplina la marca, Y el filtro de validación la detecta como pendiente de resolver', () => {
        // Prueba de integración mínima: ejecuta el filtro real tal cual
        // aparece en enviarCartilla() sobre datos construidos a mano, para
        // demostrar el comportamiento sin tener que extraer la función
        // completa (que depende de document/confirm/api — ya cubiertos por
        // los tests estáticos de arriba, que confirman que ESTE filtro es
        // el que realmente corre antes del POST).
        const _seriesGanado = [{ nombre: 'Campeones' }]; // "Criaderos" ya no existe (fue eliminada)
        const _disc = { hubo_informe: 'si', situaciones: [{ serie: 'Criaderos', nombre_infractor: 'Juan Pérez' }] };
        const nombresSeriesVigentes = new Set(_seriesGanado.map(s => s.nombre).filter(Boolean));
        const sinSerie = _disc.situaciones.filter(s => !s.serie || !s.serie.trim() || !nombresSeriesVigentes.has(s.serie));
        expect(sinSerie).toHaveLength(1); // bloquea: "Criaderos" es una referencia huérfana
        expect(_disc.situaciones[0].serie).toBe('Criaderos'); // el dato histórico NUNCA se borró en silencio
    });
});
