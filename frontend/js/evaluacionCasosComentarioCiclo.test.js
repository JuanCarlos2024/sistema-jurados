// Portal del Jurado — Mis Evaluaciones: feature flag que oculta el cuadro
// "Mi comentario del ciclo" (deshabilitado temporalmente por decisión
// administrativa). Mismo patrón que rodeosReemplazarJurado.test.js: no hay
// entorno DOM/navegador automatizado disponible en esta sesión, así que se
// extrae el bloque REAL de render de usuario/evaluacion-casos.html (desde la
// declaración de _respondidos hasta el final del <script>, dejando fuera solo
// el guard de arranque que llama a protegerRuta()/cargar() inmediatamente) y
// se ejecuta con un DOM simulado — nunca se reimplementa la lógica.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'usuario', 'evaluacion-casos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerBloqueRender() {
    const inicio = html.indexOf('const _respondidos   = new Set();');
    const fin = html.indexOf('</script>', inicio);
    return html.slice(inicio, fin);
}
const BLOQUE = extraerBloqueRender();

function crearDomFalso() {
    const elementos = {};
    const crearElemento = (id) => ({ id, innerHTML: '', textContent: '' });
    return {
        getElementById(id) { if (!elementos[id]) elementos[id] = crearElemento(id); return elementos[id]; },
        addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
        head: { appendChild() {} },
        _elementos: elementos
    };
}

function crearEntorno() {
    const dom = crearDomFalso();
    function labelCiclo(num) {
        return num === 1 ? 'Ciclo 1 — Primeros 3 lugares'
             : num === 2 ? 'Ciclo 2 — 8 Carreras series de Campeones'
             : 'Ciclo ' + num;
    }
    const sandbox = {
        document: dom,
        window: { _ytCallbacks: [] },
        evalId: 'E1',
        cicloParam: 0,
        sanitizar: (s) => s,
        fmtFechaChile: (f) => f,
        mostrarToast: () => {},
        labelCiclo,
        api: { getToken: () => 'tok', get: async () => ({}), post: async () => ({}) }
    };
    const fn = new Function(...Object.keys(sandbox), `${BLOQUE}
        return { render };`);
    const api_ = fn(...Object.values(sandbox));
    return { ...api_, dom };
}

const CICLO_BASE = { id: 'C1', estado: 'abierto', es_ciclo_sin_casos: false, casos: [], mi_comentario: null };

function datosBase({ comentario_ciclo_habilitado, mi_comentario_c1 = null }) {
    return {
        evaluacion: { modo_flujo: 'descuento_automatico', comentario_ciclo_habilitado, rodeo: { club: 'HUEMUL', fecha: '2026-01-01' } },
        ciclo1: { ...CICLO_BASE, mi_comentario: mi_comentario_c1 },
        ciclo2: { ...CICLO_BASE, id: 'C2' }
    };
}

describe('evaluacion-casos.html — cuadro "Mi comentario del ciclo" (feature flag)', () => {
    test('flag deshabilitado: el cuadro no aparece en ningún ciclo (ni formulario ni botones)', () => {
        const { render, dom } = crearEntorno();
        render(datosBase({ comentario_ciclo_habilitado: false }));
        const html = dom.getElementById('contenido').innerHTML;
        expect(html).not.toContain('Mi comentario del ciclo');
        expect(html).not.toContain('Tu comentario del ciclo');
        expect(html).not.toContain('enviarComentarioCiclo');
        expect(html).not.toContain('comentario-ciclo-da');
    });

    test('flag deshabilitado: comentarios históricos ya registrados tampoco se muestran', () => {
        const { render, dom } = crearEntorno();
        render(datosBase({ comentario_ciclo_habilitado: false, mi_comentario_c1: { comentario: 'Acepto todo', estado: 'enviado', enviado_en: '2026-01-02' } }));
        const html = dom.getElementById('contenido').innerHTML;
        expect(html).not.toContain('Acepto todo');
    });

    test('flag deshabilitado: el resto de la información del ciclo (estado, stats, acordeón) sigue intacta', () => {
        const { render, dom } = crearEntorno();
        render(datosBase({ comentario_ciclo_habilitado: false }));
        const html = dom.getElementById('contenido').innerHTML;
        expect(html).toContain('ciclo-accordion');
        expect(html).toContain('Descuento Automático');
    });

    test('flag habilitado: se recupera el formulario para ingresar el comentario (como antes)', () => {
        const { render, dom } = crearEntorno();
        render(datosBase({ comentario_ciclo_habilitado: true }));
        const html = dom.getElementById('contenido').innerHTML;
        expect(html).toContain('Tu comentario del ciclo');
        expect(html).toContain('enviarComentarioCiclo');
    });

    test('flag habilitado: comentarios históricos ya enviados vuelven a mostrarse ("Mi comentario del ciclo")', () => {
        const { render, dom } = crearEntorno();
        render(datosBase({ comentario_ciclo_habilitado: true, mi_comentario_c1: { comentario: 'Acepto todo', estado: 'enviado', enviado_en: '2026-01-02' } }));
        const html = dom.getElementById('contenido').innerHTML;
        expect(html).toContain('Mi comentario del ciclo');
        expect(html).toContain('Acepto todo');
    });
});
