// Comisión de Asociación (082): el formulario de evaluación
// (institucional/comision/rodeos.html) ya no debe mostrar ninguna
// ponderación junto al nombre de cada criterio, y su vista previa de nota
// debe usar promedio simple — nunca los porcentajes antiguos (20/30/40/10 o
// 16/24/32/8/20). CASO 1 y CASO 9 del pedido.
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(
    path.join(__dirname, '..', 'institucional', 'comision', 'rodeos.html'),
    'utf8'
);

describe('CASO 1 — el formulario no muestra ninguna ponderación', () => {
    test('las etiquetas de los criterios no incluyen ningún porcentaje', () => {
        const bloqueCriterios = HTML.match(/const CRITERIOS = \[[\s\S]*?\];/)[0];
        expect(bloqueCriterios).not.toMatch(/\d+\s*%/);
        expect(bloqueCriterios).toContain("label: 'Apiñadero'");
        expect(bloqueCriterios).toContain("label: 'Cancha'");
        expect(bloqueCriterios).toContain("label: 'Atajadas'");
        expect(bloqueCriterios).toContain("label: 'Cuarta carrera'");
    });

    test('ningún porcentaje conocido (10/20/25/30/40%) aparece en todo el archivo', () => {
        for (const pct of ['10%', '20%', '25%', '30%', '40%']) {
            expect(HTML).not.toContain(pct);
        }
    });

    test('"Jura del Movimiento a la Rienda" se sigue mostrando, sin ponderación', () => {
        expect(HTML).toContain('Jura del Movimiento a la Rienda');
        const linea = HTML.split('\n').find(l => l.includes('Jura del Movimiento a la Rienda'));
        expect(linea).not.toMatch(/\d+\s*%/);
    });
});

describe('CASO 9 — sin referencias activas a la ponderación antigua en la lógica del formulario', () => {
    test('la vista previa de nota ya no usa los literales de ponderación antiguos', () => {
        const bloqueCalculo = HTML.match(/function calcularNotaPreview\(\)[\s\S]*?\n}/)[0];
        for (const literal of ['0.16', '0.24', '0.32', '0.08', '0.20', '0.30', '0.40', '0.10']) {
            expect(bloqueCalculo).not.toContain(literal);
        }
        // En su lugar, debe dividir dinámicamente por la cantidad de criterios aplicables.
        expect(bloqueCalculo).toMatch(/suma\s*\/\s*cantidad/);
    });

    test('CASO 2 (replicado en la vista previa del frontend): 4, 2.5, 5.5, 7 -> 4.8 tras el mismo redondeo oficial', () => {
        // Extrae y ejecuta la función real del archivo (nunca una reimplementación
        // paralela) para probar la MISMA lógica que ve el usuario.
        const cuerpo = HTML.match(/function calcularNotaPreview\(\)[\s\S]*?\n}/)[0];
        const fn = new Function(
            '_valores', '_huboRienda', '_valorRienda',
            cuerpo.replace('function calcularNotaPreview()', 'return (function calcularNotaPreview()') + ')()'
        );
        const preview = fn({ apinadero: 4, cancha: 2.5, atajadas: 5.5, cuarta: 7 }, false, null);
        expect(preview).toBeCloseTo(4.8, 5);
    });

    test('CASO 5 (replicado en la vista previa): con Rienda, 4+5+6+7+3 / 5 = 5.0', () => {
        const cuerpo = HTML.match(/function calcularNotaPreview\(\)[\s\S]*?\n}/)[0];
        const fn = new Function(
            '_valores', '_huboRienda', '_valorRienda',
            cuerpo.replace('function calcularNotaPreview()', 'return (function calcularNotaPreview()') + ')()'
        );
        const preview = fn({ apinadero: 4, cancha: 5, atajadas: 6, cuarta: 7 }, true, 3);
        expect(preview).toBeCloseTo(5.0, 5);
    });
});
