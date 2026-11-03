// Protección estática + ejecución REAL del botón "mostrar/ocultar
// contraseña" de frontend/index.html (mismo patrón que
// rodeosCartillaDigitalBadge.test.js: este proyecto no tiene entorno DOM
// para frontend — no hay jsdom/Playwright instalado — así que se extrae el
// código REAL de togglePasswordVisibility() tal como está en el archivo y
// se ejecuta con un DOM mínimo simulado, nunca se reimplementa la lógica).
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerFuncionToggle() {
    const inicio = html.indexOf('function togglePasswordVisibility');
    const fin = html.indexOf('\n    }', inicio) + '\n    }'.length;
    if (inicio === -1) {
        throw new Error('No se encontró togglePasswordVisibility en index.html (¿cambió el código?)');
    }
    return html.slice(inicio, fin);
}

const BLOQUE = extraerFuncionToggle();

function crearInputFalso(tipoInicial) {
    return { type: tipoInicial, value: 'secreto123' };
}

function crearBotonFalso() {
    const clases = new Set();
    const atributos = {};
    return {
        classList: {
            toggle(clase, forzar) {
                const activar = forzar !== undefined ? forzar : !clases.has(clase);
                if (activar) clases.add(clase); else clases.delete(clase);
                return activar;
            },
            contains(clase) { return clases.has(clase); }
        },
        setAttribute(nombre, valor) { atributos[nombre] = valor; },
        getAttribute(nombre) { return atributos[nombre]; }
    };
}

function ejecutarToggle(input, btn) {
    const documentFalso = { getElementById: (id) => (id === 'campo-password' ? input : null) };
    const fn = new Function('document', `${BLOQUE}\nreturn togglePasswordVisibility('campo-password', arguments[1]);`);
    return fn(documentFalso, btn);
}

describe('index.html — botón mostrar/ocultar contraseña', () => {
    test('el bloque extraído existe', () => {
        expect(BLOQUE).toContain('togglePasswordVisibility');
    });

    test('estado inicial oculto -> clic muestra: type pasa a "text", aria-label a "Ocultar contraseña", clase "mostrando" activa', () => {
        const input = crearInputFalso('password');
        const btn = crearBotonFalso();

        ejecutarToggle(input, btn);

        expect(input.type).toBe('text');
        expect(input.value).toBe('secreto123'); // nunca borra el valor
        expect(btn.getAttribute('aria-label')).toBe('Ocultar contraseña');
        expect(btn.classList.contains('mostrando')).toBe(true);
    });

    test('segundo clic vuelve a ocultar: type a "password", aria-label a "Mostrar contraseña", clase "mostrando" se quita', () => {
        const input = crearInputFalso('password');
        const btn = crearBotonFalso();

        ejecutarToggle(input, btn); // 1er clic: muestra
        ejecutarToggle(input, btn); // 2do clic: oculta

        expect(input.type).toBe('password');
        expect(input.value).toBe('secreto123');
        expect(btn.getAttribute('aria-label')).toBe('Mostrar contraseña');
        expect(btn.classList.contains('mostrando')).toBe(false);
    });

    test('tres clics consecutivos alternan correctamente (texto -> oculto -> texto)', () => {
        const input = crearInputFalso('password');
        const btn = crearBotonFalso();

        ejecutarToggle(input, btn);
        expect(input.type).toBe('text');
        ejecutarToggle(input, btn);
        expect(input.type).toBe('password');
        ejecutarToggle(input, btn);
        expect(input.type).toBe('text');
    });
});

describe('index.html — estructura de los 4 campos de contraseña', () => {
    const campos = ['admin-password', 'usr-password', 'inst-password', 'comis-password'];

    test.each(campos)('%s: input oculto por defecto (type="password")', (id) => {
        const regexInput = new RegExp(`<input type="password" id="${id}"`);
        expect(html).toMatch(regexInput);
    });

    test.each(campos)('%s: envuelto en .password-wrapper junto a su botón', (id) => {
        const inicioInput = html.indexOf(`id="${id}" class="form-control"`);
        expect(inicioInput).toBeGreaterThan(-1);
        const bloqueCampo = html.slice(Math.max(0, inicioInput - 400), inicioInput + 900);
        expect(bloqueCampo).toContain('class="password-wrapper"');
        expect(bloqueCampo).toContain(`togglePasswordVisibility('${id}', this)`);
    });

    test.each(campos)('%s: botón es type="button" (nunca envía el formulario) y tiene aria-label inicial "Mostrar contraseña"', (id) => {
        const inicioInput = html.indexOf(`id="${id}" class="form-control"`);
        const bloqueCampo = html.slice(inicioInput, inicioInput + 900);
        expect(bloqueCampo).toContain('<button type="button" class="password-toggle"');
        expect(bloqueCampo).toContain('aria-label="Mostrar contraseña"');
    });

    test.each(campos)('%s: incluye los dos íconos (ojo abierto / ojo tachado)', (id) => {
        const inicioInput = html.indexOf(`id="${id}" class="form-control"`);
        const bloqueCampo = html.slice(inicioInput, inicioInput + 900);
        expect(bloqueCampo).toContain('class="icono-ojo"');
        expect(bloqueCampo).toContain('class="icono-ojo-tachado"');
    });

    test('regresión: el hint "Contraseña inicial: jurados" del campo usr-password sigue presente', () => {
        expect(html).toContain('Contraseña inicial: <strong>jurados</strong>');
    });

    test('regresión: los 4 formularios de login y sus botones de submit no fueron alterados', () => {
        expect(html).toContain('onsubmit="loginAdmin(event)"');
        expect(html).toContain('onsubmit="loginUsuario(event)"');
        expect(html).toContain('onsubmit="loginInstitucional(event)"');
        expect(html).toContain('onsubmit="loginComision(event)"');
    });
});
