// Protección estática (regex sobre el código fuente, mismo patrón que
// matrizParticipacionSticky.test.js / casosWhatsapp.test.js — este proyecto
// no tiene entorno DOM para frontend) del redirect de protegerRuta() cuando
// el tipo de sesión no coincide con el requerido por la página. Fase 2:
// agrega el caso "cuenta_institucional" sin romper los 2 casos existentes
// (administrador / usuario_pagado).
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf8').replace(/\r\n/g, '\n');
const bloque = html.slice(html.indexOf('function protegerRuta'), html.indexOf('function protegerRuta') + 1100);

describe('protegerRuta() — redirect por tipo de sesión no coincidente', () => {
    test('administrador sigue redirigiendo a /admin/dashboard.html (sin cambios)', () => {
        expect(bloque).toMatch(/usuario\.tipo === 'administrador'[\s\S]{0,80}'\/admin\/dashboard\.html'/);
    });

    test('cuenta_institucional redirige a /institucional/dashboard.html (nuevo, Fase 2)', () => {
        expect(bloque).toMatch(/usuario\.tipo === 'cuenta_institucional'[\s\S]{0,80}'\/institucional\/dashboard\.html'/);
    });

    test('cualquier otro tipo (usuario_pagado: jurado/delegado rentado) sigue cayendo en /usuario/dashboard.html', () => {
        expect(bloque).toMatch(/else[\s\S]{0,40}'\/usuario\/dashboard\.html'/);
    });

    test('la rama de cuenta_institucional está ANTES del else genérico (si no, nunca se alcanzaría)', () => {
        const iInstitucional = bloque.indexOf("'cuenta_institucional'");
        const iElseGenerico = bloque.lastIndexOf("'/usuario/dashboard.html'");
        expect(iInstitucional).toBeGreaterThan(-1);
        expect(iInstitucional).toBeLessThan(iElseGenerico);
    });
});

// Fase 3: protegerRuta(['usuario_pagado','cuenta_institucional']) — necesaria
// para compartir la MISMA página de Cartilla de Delegado entre ambos tipos de
// sesión (requisito explícito: reutilizar el formulario, no duplicarlo).
// Ejecuta la función REAL extraída del archivo fuente (no la reimplementa),
// con api/window simulados — más confiable que solo regex para lógica
// genuinamente condicional (array vs string).
describe('protegerRuta() — soporte de arreglo de tipos (ejecución real de la función)', () => {
    function extraerFuncion() {
        const inicio = html.indexOf('function protegerRuta');
        const fin = html.indexOf('\nfunction ', inicio + 20); // siguiente función top-level tras protegerRuta
        return html.slice(inicio, fin);
    }

    function simular(usuarioSimulado, tipoRequerido) {
        const codigo = extraerFuncion();
        const redirecciones = [];
        const apiFalso = { getUsuario: () => usuarioSimulado, getToken: () => (usuarioSimulado ? 'tok' : null) };
        const windowFalso = { location: {} };
        Object.defineProperty(windowFalso.location, 'href', { set(v) { redirecciones.push(v); }, get() { return redirecciones[redirecciones.length - 1]; } });
        // eslint-disable-next-line no-new-func
        const fabrica = new Function('api', 'window', `${codigo}\nreturn protegerRuta;`);
        const protegerRutaReal = fabrica(apiFalso, windowFalso);
        const resultado = protegerRutaReal(tipoRequerido);
        return { resultado, redirecciones };
    }

    test('usuario_pagado pasa protegerRuta([\'usuario_pagado\',\'cuenta_institucional\']) sin redirigir', () => {
        const { resultado, redirecciones } = simular({ tipo: 'usuario_pagado' }, ['usuario_pagado', 'cuenta_institucional']);
        expect(resultado).toBe(true);
        expect(redirecciones).toHaveLength(0);
    });

    test('cuenta_institucional TAMBIÉN pasa el mismo arreglo sin redirigir', () => {
        const { resultado, redirecciones } = simular({ tipo: 'cuenta_institucional' }, ['usuario_pagado', 'cuenta_institucional']);
        expect(resultado).toBe(true);
        expect(redirecciones).toHaveLength(0);
    });

    test('administrador NO pasa ese arreglo -> redirige a /admin/dashboard.html', () => {
        const { resultado, redirecciones } = simular({ tipo: 'administrador' }, ['usuario_pagado', 'cuenta_institucional']);
        expect(resultado).toBe(false);
        expect(redirecciones).toEqual(['/admin/dashboard.html']);
    });

    test('retrocompatibilidad: un string simple sigue funcionando exactamente igual que antes', () => {
        const { resultado } = simular({ tipo: 'usuario_pagado' }, 'usuario_pagado');
        expect(resultado).toBe(true);
        const { resultado: bloqueado, redirecciones } = simular({ tipo: 'cuenta_institucional' }, 'usuario_pagado');
        expect(bloqueado).toBe(false);
        expect(redirecciones).toEqual(['/institucional/dashboard.html']);
    });
});
