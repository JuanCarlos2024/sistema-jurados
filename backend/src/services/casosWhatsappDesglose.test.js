// Migración 107 — desglose Bien jurado / Mal jurado de "Casos por WhatsApp":
// validación (backend y pantalla), agregación en Evaluación de Desempeño
// Jurados, convivencia con el "Mal jurado" manual (081) y texto de Excel.
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const fs = require('fs');
const path = require('path');
const { normalizarDesgloseWhatsapp, validarSumaDesglose } = require('./casosWhatsapp');
const { construirFilas, combinarMalJurado, textoDesglose, ordenar } = require('./evaluacionDesempenoJurados');
const front = require('../../../frontend/js/casosWhatsapp');

describe('backend: normalizarDesgloseWhatsapp / validarSumaDesglose', () => {
    test('no vienen → no cambia el desglose guardado', () => {
        expect(normalizarDesgloseWhatsapp(undefined, undefined)).toEqual({ ok: true, cambia: false });
    });
    test('ambos vacíos → sin registrar (NULL), nunca 0', () => {
        for (const v of [null, '', '  ']) expect(normalizarDesgloseWhatsapp(v, v)).toEqual({ ok: true, cambia: true, bien: null, mal: null });
    });
    test('enteros >= 0 (número o texto) → válidos', () => {
        expect(normalizarDesgloseWhatsapp(5, 15)).toEqual({ ok: true, cambia: true, bien: 5, mal: 15 });
        expect(normalizarDesgloseWhatsapp('0', ' 3 ')).toEqual({ ok: true, cambia: true, bien: 0, mal: 3 });
    });
    test.each([[-1, 2], [1.5, 2], ['abc', 1], [true, 1], [{}, 1], [NaN, 1], ['1e2', 1]])('inválido %p / %p → rechazado', (b, m) => {
        expect(normalizarDesgloseWhatsapp(b, m).ok).toBe(false);
    });
    test('uno vacío y el otro no → rechazado', () => {
        expect(normalizarDesgloseWhatsapp(5, null).ok).toBe(false);
        expect(normalizarDesgloseWhatsapp('', 3).ok).toBe(false);
        expect(normalizarDesgloseWhatsapp(5, undefined).ok).toBe(false);
    });
    test('la suma debe igualar el total; sin desglose siempre es válido', () => {
        expect(validarSumaDesglose(5, 15, 20)).toBeNull();
        expect(validarSumaDesglose(0, 0, 0)).toBeNull();
        expect(validarSumaDesglose(null, null, 20)).toBeNull();
        expect(validarSumaDesglose(5, 14, 20)).toMatch(/\(19\).*\(20\)/);
        expect(validarSumaDesglose(5, 16, 20)).toMatch(/igual al total/);
    });
});

describe('pantalla Análisis Deportivo: cwLeerDesglose / cwHtmlCampo', () => {
    test('valida igual que el backend', () => {
        expect(front.cwLeerDesglose('5', '15', 20)).toEqual({ ok: true, bien: 5, mal: 15 });
        expect(front.cwLeerDesglose('', '', 20)).toEqual({ ok: true, bien: null, mal: null });
        expect(front.cwLeerDesglose('5', '', 20).ok).toBe(false);
        expect(front.cwLeerDesglose('5', '14', 20).error).toMatch(/igual al total/);
        expect(front.cwLeerDesglose('-1', '21', 20).ok).toBe(false);
        expect(front.cwLeerDesglose('2.5', '17.5', 20).ok).toBe(false);
    });
    test('editable: muestra los 3 campos con los valores guardados (al volver a abrir)', () => {
        const html = front.cwHtmlCampo(20, true, 5, 15);
        expect(html).toMatch(/id="ad-casos_whatsapp"[^>]*value="20"/);
        expect(html).toMatch(/id="ad-casos_whatsapp_bien_jurado"[^>]*value="5"/);
        expect(html).toMatch(/id="ad-casos_whatsapp_mal_jurado"[^>]*value="15"/);
        expect(html).toContain('Bien jurado');
        expect(html).toContain('Mal jurado');
    });
    test('registro sin desglose: campos vacíos (editable) o "Sin registrar" (lectura), nunca 0', () => {
        expect(front.cwHtmlCampo(4, true, null, null)).toMatch(/id="ad-casos_whatsapp_bien_jurado"[^>]*value=""/);
        const lectura = front.cwHtmlCampo(4, false, undefined, undefined);
        expect((lectura.match(/Sin registrar/g) || []).length).toBe(2);
    });
    test('la pantalla envía el desglose al guardar y lo lee del análisis guardado', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../../frontend/admin/evaluacion-detalle.html'), 'utf8');
        expect(html).toContain('cwHtmlCampo(ev.casos_whatsapp, esAnalista, ev.casos_whatsapp_bien_jurado, ev.casos_whatsapp_mal_jurado)');
        expect(html).toMatch(/body\.casos_whatsapp_bien_jurado = desgloseWs\.bien/);
        expect(html).toMatch(/body\.casos_whatsapp_mal_jurado\s+= desgloseWs\.mal/);
    });
});

// j1 y j2 comparten r1; j1 además en r2 y r3.
function fixture(evalMap) {
    return {
        jurados: [
            { id: 'j1', nombre_completo: 'Uno', categoria: 'A' },
            { id: 'j2', nombre_completo: 'Dos', categoria: 'A' },
            { id: 'j3', nombre_completo: 'Tres', categoria: 'B' }
        ],
        todasAsigs: [
            { id: 'a1', usuario_pagado_id: 'j1', rodeos: { id: 'r1' } },
            { id: 'a1-dup', usuario_pagado_id: 'j1', rodeos: { id: 'r1' } },   // asignación repetida: no duplica
            { id: 'a2', usuario_pagado_id: 'j2', rodeos: { id: 'r1' } },
            { id: 'a3', usuario_pagado_id: 'j1', rodeos: { id: 'r2' } },
            { id: 'a4', usuario_pagado_id: 'j1', rodeos: { id: 'r3' } }
        ],
        evalMap, notaDelegadoMap: {}, notaComisionMap: {}, notaADMap: {}
    };
}
const fila = (filas, id) => filas.find(f => f.usuario_pagado_id === id);

describe('reporte: agregación Bien / Mal jurado', () => {
    test('suma por rodeo distinto, mismo criterio que Total consultas WSP (rodeo compartido completo a cada jurado, sin duplicar)', () => {
        const filas = construirFilas(fixture({
            r1: { casos_whatsapp: 20, casos_whatsapp_bien_jurado: 5, casos_whatsapp_mal_jurado: 15 },
            r2: { casos_whatsapp: 4,  casos_whatsapp_bien_jurado: 3, casos_whatsapp_mal_jurado: 1 },
            r3: { casos_whatsapp: 0,  casos_whatsapp_bien_jurado: null, casos_whatsapp_mal_jurado: null }
        }));
        expect(fila(filas, 'j1')).toMatchObject({ consultas_wsp_total: 24, wsp_bien_jurado: 8, wsp_mal_jurado: 16, wsp_rodeos_sin_desglose: 0 });
        expect(fila(filas, 'j2')).toMatchObject({ consultas_wsp_total: 20, wsp_bien_jurado: 5, wsp_mal_jurado: 15, wsp_rodeos_sin_desglose: 0 });
        expect(fila(filas, 'j3')).toMatchObject({ consultas_wsp_total: 0, wsp_bien_jurado: null, wsp_mal_jurado: null });
    });

    test('sin ningún desglose → null ("Sin registrar"), nunca 0 inventado', () => {
        const filas = construirFilas(fixture({ r1: { casos_whatsapp: 20 }, r2: { casos_whatsapp: 0 } }));
        expect(fila(filas, 'j1')).toMatchObject({ wsp_bien_jurado: null, wsp_mal_jurado: null, wsp_rodeos_sin_desglose: 1 });
    });

    test('desglose parcial: suma solo lo registrado e informa los rodeos con consultas sin desglose', () => {
        const filas = construirFilas(fixture({
            r1: { casos_whatsapp: 20 },
            r2: { casos_whatsapp: 4, casos_whatsapp_bien_jurado: 3, casos_whatsapp_mal_jurado: 1 }
        }));
        expect(fila(filas, 'j1')).toMatchObject({ wsp_bien_jurado: 3, wsp_mal_jurado: 1, wsp_rodeos_sin_desglose: 1 });
    });

    test('Mal jurado: el del análisis tiene prioridad; el manual se conserva y se usa solo si no hay desglose', () => {
        expect(combinarMalJurado({ wsp_mal_jurado: 15, wsp_bien_jurado: 5 }, { mal_jurado: 7 }))
            .toEqual({ mal_jurado: 15, mal_jurado_origen: 'analisis', mal_jurado_manual: 7, bien_jurado: 5 });
        expect(combinarMalJurado({ wsp_mal_jurado: null, wsp_bien_jurado: null }, { mal_jurado: 7 }))
            .toEqual({ mal_jurado: 7, mal_jurado_origen: 'manual', mal_jurado_manual: 7, bien_jurado: null });
        expect(combinarMalJurado({ wsp_mal_jurado: null, wsp_bien_jurado: null }, undefined))
            .toEqual({ mal_jurado: null, mal_jurado_origen: null, mal_jurado_manual: null, bien_jurado: null });
        expect(combinarMalJurado({ wsp_mal_jurado: 0, wsp_bien_jurado: 4 }, { mal_jurado: 7 }).mal_jurado).toBe(0);  // 0 registrado es un valor real
    });

    test('texto de pantalla/Excel', () => {
        expect(textoDesglose(null, 0)).toBe('Sin registrar');
        expect(textoDesglose(15, 0)).toBe('15');
        expect(textoDesglose(0, 0)).toBe('0');
        expect(textoDesglose(3, 1)).toBe('3 (+1 rodeo sin registrar)');
        expect(textoDesglose(3, 2)).toBe('3 (+2 rodeos sin registrar)');
    });

    test('se puede ordenar por Bien jurado; los "Sin registrar" quedan al final', () => {
        const filas = [{ nombre: 'a', bien_jurado: 2 }, { nombre: 'b', bien_jurado: null }, { nombre: 'c', bien_jurado: 9 }];
        expect(ordenar(filas, 'bien_jurado_desc').map(f => f.nombre)).toEqual(['c', 'a', 'b']);
        expect(ordenar(filas, 'bien_jurado_asc').map(f => f.nombre)).toEqual(['a', 'c', 'b']);
    });

    test('la consulta del servicio pide las columnas nuevas y la pantalla/Excel muestran Bien jurado', () => {
        const svc = fs.readFileSync(path.join(__dirname, 'evaluacionDesempenoJurados.js'), 'utf8');
        expect(svc).toContain("casos_whatsapp, casos_whatsapp_bien_jurado, casos_whatsapp_mal_jurado')");
        const html = fs.readFileSync(path.join(__dirname, '../../../frontend/admin/evaluacion-desempeno.html'), 'utf8');
        expect(html).toMatch(/key: 'bien_jurado',\s+label: 'Bien jurado'/);
        const excel = fs.readFileSync(path.join(__dirname, '../routes/admin/evaluacion-desempeno.js'), 'utf8');
        expect(excel).toMatch(/header: 'Bien jurado'/);
        expect(excel).toMatch(/header: 'Total consultas WSP'/);
    });
});

describe('migración 107', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../../database/migrations/107_casos_whatsapp_bien_mal_jurado.sql'), 'utf8');
    test('solo agrega columnas NULLABLE sin DEFAULT y la restricción de suma; no toca datos', () => {
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS casos_whatsapp_bien_jurado INTEGER,/);
        expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS casos_whatsapp_mal_jurado\s+INTEGER;/);
        const sinComentarios = sql.replace(/--.*$/gm, '');
        expect(sinComentarios).not.toMatch(/DEFAULT/i);
        expect(sinComentarios).not.toMatch(/\b(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
        expect(sinComentarios).toMatch(/casos_whatsapp_bien_jurado \+ casos_whatsapp_mal_jurado = casos_whatsapp/);
    });
});
