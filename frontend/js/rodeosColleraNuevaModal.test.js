// Vista previa admin (rodeos.html:renderEtapa3Modal) — "Corre por los
// premios" / "Deja puntos para la próxima temporada" (nuevo). Mismo patrón
// que rodeosCartillaDigitalBadge.test.js: se extrae el código REAL de la
// función y se ejecuta con un `sanitizar` simulado (identidad) — nunca se
// reimplementa la lógica de renderEtapa3Modal.
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

describe('renderEtapa3Modal() — "Corre por los premios" / "Deja puntos" (vista previa admin, nuevo)', () => {
    test('rj = null/undefined (cartilla sin ningún dato) -> NUNCA retorna vacío, muestra "No informado" para ambas preguntas', () => {
        [null, undefined, {}].forEach((rj) => {
            const out = ejecutar(rj);
            expect(out).toContain('Colleras que corren por los premios');
            expect(out).toContain('¿Hay colleras que corren por los premios?');
            expect(out).toContain('Colleras que dejan puntos para la próxima temporada');
            expect(out).toContain('No informado');
        });
    });

    test('respuesta "no" -> muestra "No" (nunca "No informado")', () => {
        const out = ejecutar({ corre_premios: { respuesta: 'no', items: [] } });
        expect(out).toMatch(/¿Hay colleras que corren por los premios\?<\/strong> No(?!\s*informado)/);
    });

    test('respuesta "si" con colleras -> tabla con N°, Jinete 1, Jinete 2, Caballo 1, Caballo 2, Lugar y el contenido real', () => {
        const out = ejecutar({
            corre_premios: {
                respuesta: 'si',
                items: [{ rut1: '11.111.111-1', nombre1: 'Juan Pérez', rut2: '7.654.321-6', nombre2: 'Pedro Soto', num_caballo1: '12', nombre_caballo1: 'Relámpago', num_caballo2: '7', nombre_caballo2: 'Trueno', lugar: '1°' }]
            }
        });
        expect(out).toContain('<th');
        expect(out).toContain('Caballo 1');
        expect(out).toContain('Juan Pérez');
        expect(out).toContain('Relámpago');
        expect(out).toContain('1°');
    });

    test('INDEPENDENCIA: colleras de premios y de puntos nunca se mezclan en la vista previa', () => {
        const out = ejecutar({
            corre_premios:         { respuesta: 'si', items: [{ nombre1: 'Jinete PREMIO' }] },
            deja_puntos_temporada: { respuesta: 'si', items: [{ nombre1: 'Jinete PUNTOS' }] }
        });
        expect(out).toContain('Jinete PREMIO');
        expect(out).toContain('Jinete PUNTOS');
        // cada nombre aparece exactamente una vez (no se duplicó entre secciones)
        expect((out.match(/Jinete PREMIO/g) || []).length).toBe(1);
        expect((out.match(/Jinete PUNTOS/g) || []).length).toBe(1);
    });

    test('"si" sin colleras -> muestra el aviso "Sin colleras registradas", nunca una tabla vacía', () => {
        const out = ejecutar({ corre_premios: { respuesta: 'si', items: [] } });
        expect(out).toContain('Sin colleras registradas.');
    });

    test('nunca mezcla con Colleras Invitadas (sección completamente distinta, sigue intacta)', () => {
        const out = ejecutar({
            colleras_invitadas: { no_hubo: false, items: [{ jinete1: 'Invitado Uno', jinete2: 'Invitado Dos', club: 'Club Invitado', asociacion: 'Asoc Invitada' }] },
            corre_premios: { respuesta: 'si', items: [{ nombre1: 'Jinete Premios' }] }
        });
        expect(out).toContain('VIII. Informe de colleras invitadas');
        expect(out).toContain('Invitado Uno');
        expect(out).toContain('Jinete Premios');
    });
});
