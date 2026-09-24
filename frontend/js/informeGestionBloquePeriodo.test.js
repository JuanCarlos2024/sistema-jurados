// Nota de lectura "bloque de rodeo vs período seleccionado" (presentación; todo dinámico).
const fs = require('fs'), path = require('path');
const IG = require('./informeGestionHelpers');

const punto = (over = {}) => ({ etiqueta: '17–20 SEP', bloque_inicio: '2026-09-17', bloque_fin: '2026-09-20', rodeos_realizados: 26, periodo_seleccionado: { rodeos_inicio_dentro: 25, rodeos_inicio_antes: 1, rodeos_inicio_despues: 0 }, ...over });
const datos = ({ desde = '2026-09-18', hasta = '2026-09-20', total = 25, puntos = [punto()] } = {}) => ({ periodo: { rango: { desde, hasta }, rodeos: { realizados: total } }, series: { situaciones_por_bloque: { puntos } } });

describe('nota de lectura bloque vs período', () => {
    test('B) bloque y período distintos → se muestra la aclaración con rango y total de ambos y el motivo', () => {
        const n = IG.notaBloquePeriodo(datos());
        expect(n).not.toBeNull();
        expect(n.bloque).toMatchObject({ etiqueta: '17–20 SEP', total: 26 });
        expect(n.periodo).toMatchObject({ etiqueta: '18–20 SEP', total: 25 });
        expect(n.texto).toBe('Nota de lectura: el bloque 17–20 SEP contiene 26 rodeos, mientras el período seleccionado 18–20 SEP contiene 25. La diferencia se debe a que 1 rodeo comenzó antes del período seleccionado y termina dentro del bloque.');
    });
    test('A) mismo total y el bloque no excede el rango → NO se muestra nada', () => {
        const d = datos({ total: 26, puntos: [punto({ bloque_inicio: '2026-09-18', bloque_fin: '2026-09-20', etiqueta: '18–20 SEP', periodo_seleccionado: { rodeos_inicio_dentro: 26, rodeos_inicio_antes: 0, rodeos_inicio_despues: 0 } })] });
        expect(IG.notaBloquePeriodo(d)).toBeNull();
    });
    test('un fin de semana normal seleccionado completo no genera nota', () => {
        const d = datos({ desde: '2026-09-05', hasta: '2026-09-06', total: 11, puntos: [punto({ etiqueta: '05–06 SEP', bloque_inicio: '2026-09-05', bloque_fin: '2026-09-06', rodeos_realizados: 11 })] });
        expect(IG.notaBloquePeriodo(d)).toBeNull();
    });
    test('el bloque excede el rango aunque los totales coincidan → se muestra (motivo genérico si no hay conteos)', () => {
        const d = datos({ total: 26, puntos: [punto({ periodo_seleccionado: undefined })] });
        const n = IG.notaBloquePeriodo(d);
        expect(n).not.toBeNull();
        expect(n.motivo).toMatch(/fuera del rango seleccionado/);
    });
    test('C) es dinámica: otras fechas, totales y cantidades cambian el texto (nada hardcodeado)', () => {
        const d = datos({ desde: '2027-01-02', hasta: '2027-01-03', total: 7, puntos: [punto({ etiqueta: '01–03 ENE', bloque_inicio: '2027-01-01', bloque_fin: '2027-01-03', rodeos_realizados: 10, periodo_seleccionado: { rodeos_inicio_dentro: 7, rodeos_inicio_antes: 3, rodeos_inicio_despues: 0 } })] });
        const n = IG.notaBloquePeriodo(d);
        expect(n.texto).toContain('el bloque 01–03 ENE contiene 10 rodeos');
        expect(n.texto).toContain('período seleccionado 02–03 ENE contiene 7');
        expect(n.texto).toContain('3 rodeos comenzaron antes del período seleccionado y terminan dentro del bloque');
        expect(n.texto).not.toMatch(/17–20 SEP|18–20 SEP|26|25/);
    });
    test('rodeos que comienzan después del período (mismo bloque)', () => {
        const d = datos({ desde: '2026-09-19', hasta: '2026-09-19', total: 1, puntos: [punto({ etiqueta: '19–20 SEP', bloque_inicio: '2026-09-19', bloque_fin: '2026-09-20', rodeos_realizados: 2, periodo_seleccionado: { rodeos_inicio_dentro: 1, rodeos_inicio_antes: 0, rodeos_inicio_despues: 1 } })] });
        expect(IG.notaBloquePeriodo(d).texto).toContain('1 rodeo comienza después del período seleccionado y pertenece al mismo bloque');
    });
    test('período de varios bloques o sin datos: no se muestra nota', () => {
        const dos = datos({ desde: '2026-09-05', hasta: '2026-09-20', total: 30, puntos: [punto({ bloque_inicio: '2026-09-05', bloque_fin: '2026-09-06' }), punto()] });
        expect(IG.notaBloquePeriodo(dos)).toBeNull();
        expect(IG.notaBloquePeriodo({})).toBeNull();
        expect(IG.notaBloquePeriodo(datos({ puntos: [] }))).toBeNull();
    });
    test('etiquetaRangoCorto: mismo mes, cruce de mes y un día', () => {
        expect(IG.etiquetaRangoCorto('2026-09-18', '2026-09-20')).toBe('18–20 SEP');
        expect(IG.etiquetaRangoCorto('2026-09-30', '2026-10-02')).toBe('30 SEP–02 OCT');
        expect(IG.etiquetaRangoCorto('2026-09-05', '2026-09-05')).toBe('05 SEP');
    });
    test('texto general: bloque deportivo y período seleccionado son conceptos distintos', () => {
        expect(IG.TEXTO_BLOQUE_VS_PERIODO).toMatch(/Bloque deportivo y período seleccionado pueden no coincidir/);
    });
});

describe('pantalla (guardas estáticas): la nota se construye con el helper y sin cifras fijas', () => {
    const src = fs.readFileSync(path.join(__dirname, 'informeGestionPantalla.js'), 'utf8');
    test('usa notaBloquePeriodo y solo la pinta cuando existe', () => {
        expect(src).toMatch(/H\.notaBloquePeriodo\(d\)/);
        expect(src).toMatch(/nbp \? `<div class="nota-bloque">/);
        expect(src).toMatch(/H\.TEXTO_BLOQUE_VS_PERIODO/);
    });
    test('no hay fechas ni totales de la nota escritos a mano', () => {
        expect(src).not.toMatch(/17–20 SEP|18–20 SEP|contiene 26|contiene 25/);
    });
});
