// MEJORA 1 — vista previa admin (rodeos.html:renderEtapa3Modal), sección VI
// "Informe de disciplina": cada situación disciplinaria debe mostrar la
// "Serie en que ocurrió", con "No informado" explícito para cartillas
// históricas que nunca tuvieron este campo. Mismo patrón de extracción real
// que rodeosColleraNuevaModal.test.js — nunca se reimplementa la lógica de
// renderEtapa3Modal.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerFuncion(nombre) {
    const inicio = html.indexOf(`function ${nombre}(`);
    if (inicio === -1) throw new Error(`No se encontró function ${nombre}(...) en rodeos.html`);
    let i = html.indexOf('{', inicio);
    let profundidad = 0;
    for (; i < html.length; i++) {
        if (html[i] === '{') profundidad++;
        else if (html[i] === '}') { profundidad--; if (profundidad === 0) { i++; break; } }
    }
    return html.slice(inicio, i);
}

function ejecutar(rj) {
    const codigo = extraerFuncion('renderEtapa3Modal');
    const fabrica = new Function('sanitizar', `${codigo}\nreturn renderEtapa3Modal;`);
    const renderEtapa3ModalReal = fabrica((s) => s);
    return renderEtapa3ModalReal(rj);
}

describe('renderEtapa3Modal() — Serie en que ocurrió la situación disciplinaria (vista previa admin, MEJORA 1)', () => {
    test('situación con serie informada -> la muestra tal cual', () => {
        const out = ejecutar({
            disciplina_informe: { hubo_informe: 'si', situaciones: [{ serie: 'Criaderos', nombre_infractor: 'Juan Pérez', rut: '1-9' }] }
        });
        expect(out).toContain('Serie en que ocurrió');
        expect(out).toContain('Criaderos');
    });

    test('situación histórica SIN el campo serie -> muestra "No informado" (nunca inventa una serie)', () => {
        const out = ejecutar({
            disciplina_informe: { hubo_informe: 'si', situaciones: [{ nombre_infractor: 'Juan Pérez', rut: '1-9' }] }
        });
        expect(out).toContain('No informado');
    });

    test('dos situaciones con series distintas -> cada una muestra la suya, nunca se mezclan', () => {
        const out = ejecutar({
            disciplina_informe: {
                hubo_informe: 'si',
                situaciones: [
                    { serie: 'Criaderos', nombre_infractor: 'Uno' },
                    { serie: 'Campeones', nombre_infractor: 'Dos' }
                ]
            }
        });
        const iUno = out.indexOf('Uno');
        const iDos = out.indexOf('Dos');
        const iCriaderos = out.indexOf('Criaderos');
        const iCampeones = out.indexOf('Campeones');
        expect(iCriaderos).toBeGreaterThan(-1);
        expect(iCampeones).toBeGreaterThan(-1);
        // "Criaderos" aparece antes que "Dos" (pertenece a la situación "Uno", la primera)
        expect(iCriaderos).toBeLessThan(iDos);
        expect(iCampeones).toBeGreaterThan(iUno);
    });

    test('nunca se mezcla con las demás columnas de la situación (nombre/RUT/socio/tipo de falta/artículo siguen presentes)', () => {
        const out = ejecutar({
            disciplina_informe: { hubo_informe: 'si', situaciones: [{ serie: 'Criaderos', nombre_infractor: 'Juan Pérez', rut: '11.111.111-1', num_socio: '999', tipo_falta: 'Reglamentaria', articulo: '45', testigos: 'Pedro' }] }
        });
        expect(out).toContain('Juan Pérez');
        expect(out).toContain('11.111.111-1');
        expect(out).toContain('999');
        expect(out).toContain('Reglamentaria');
        expect(out).toContain('45');
        expect(out).toContain('Pedro');
    });
});
