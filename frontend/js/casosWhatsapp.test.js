const fs = require('fs'), path = require('path');
const CW = require('./casosWhatsapp');

describe('valor a mostrar (análisis antiguos sin el dato = 0)', () => {
    test('undefined, null y vacío se ven como 0 (registros anteriores a la funcionalidad)', () => {
        for (const v of [undefined, null, '']) expect(CW.cwValorMostrar(v)).toBe(0);
    });
    test('enteros guardados se muestran tal cual; valores corruptos no rompen la pantalla', () => {
        expect(CW.cwValorMostrar(0)).toBe(0);
        expect(CW.cwValorMostrar(4)).toBe(4);
        expect(CW.cwValorMostrar('7')).toBe(7);
        for (const v of [-3, 2.5, 'abc', NaN]) expect(CW.cwValorMostrar(v)).toBe(0);
    });
});

describe('lectura del campo (ayuda de pantalla; el backend valida de nuevo)', () => {
    test('vacío = 0; enteros >= 0 válidos', () => {
        expect(CW.cwLeerInput('')).toEqual({ ok: true, valor: 0 });
        expect(CW.cwLeerInput('  ')).toEqual({ ok: true, valor: 0 });
        expect(CW.cwLeerInput('0')).toEqual({ ok: true, valor: 0 });
        expect(CW.cwLeerInput('3')).toEqual({ ok: true, valor: 3 });
        expect(CW.cwLeerInput(' 12 ')).toEqual({ ok: true, valor: 12 });
    });
    test.each([['-1'], ['1.5'], ['1,5'], ['tres'], ['1e3'], ['+2'], ['NaN'], ['Infinity'], ['99999999999']])('%j se rechaza con mensaje', (t) => {
        const r = CW.cwLeerInput(t);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/entero mayor o igual a 0/);
    });
});

describe('HTML del campo', () => {
    test('analista: input numérico 0..∞ de paso 1 con el valor guardado, dentro del formulario del análisis', () => {
        const h = CW.cwHtmlCampo(4, true);
        expect(h).toMatch(/Casos por WhatsApp/);
        expect(h).toMatch(/<input type="number" id="ad-casos_whatsapp"[^>]*value="4" min="0" step="1"/);
    });
    test('análisis antiguo (sin dato): el campo muestra 0', () => {
        expect(CW.cwHtmlCampo(undefined, true)).toMatch(/value="0"/);
        expect(CW.cwHtmlCampo(null, false)).toMatch(/>0<\/div>/);
    });
    test('sin permiso de edición: solo lectura (sin input)', () => {
        const h = CW.cwHtmlCampo(3, false);
        expect(h).not.toMatch(/<input/);
        expect(h).toMatch(/id="ad-casos_whatsapp_lectura"[^>]*>3</);
    });
    test('nunca imprime undefined / null / NaN', () => {
        for (const v of [undefined, null, NaN, 'x', -1, 2]) for (const e of [true, false]) expect(CW.cwHtmlCampo(v, e)).not.toMatch(/undefined|null|NaN/);
    });
});

describe('evaluacion-detalle.html (guardas estáticas)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'evaluacion-detalle.html'), 'utf8').replace(/\r\n/g, '\n');
    test('carga el helper y muestra el campo dentro de Análisis deportivo, tras los puntajes y antes de la observación', () => {
        expect(html).toMatch(/<script src="\/js\/casosWhatsapp\.js"><\/script>/);
        const iPuntajes = html.indexOf("filasPuntajes('3er lugar'");
        const iCampo = html.indexOf('cwHtmlCampo(ev.casos_whatsapp, esAnalista)');
        const iObs = html.indexOf('Observación general del análisis');
        expect(iPuntajes).toBeGreaterThan(0);
        expect(iCampo).toBeGreaterThan(iPuntajes);
        expect(iObs).toBeGreaterThan(iCampo);
    });
    test('el campo respeta el mismo permiso de edición del resto del análisis (esAnalista) y se guarda con el MISMO botón', () => {
        expect(html).toMatch(/cwHtmlCampo\(ev\.casos_whatsapp, esAnalista\)/);
        expect(html).toMatch(/onclick="guardarAnalisisDeportivo\(\)">Guardar análisis deportivo/);
        expect(html.match(/casos_whatsapp/g).length).toBeGreaterThan(2);
        expect(html).not.toMatch(/guardarCasosWhatsapp/);                      // no hay botón independiente
        expect(html).toMatch(/if \(casos_whatsapp !== undefined\) body\.casos_whatsapp = casos_whatsapp;/);
        expect(html).toMatch(/api\.patch\(`\/admin\/evaluaciones\/\$\{evalId\}\/datos-deportivos`, body\)/);
    });
    test('el valor inválido detiene el guardado con aviso (validación de pantalla)', () => {
        expect(html).toMatch(/const cw = cwLeerInput\(cwEl\.value\);\n\s+if \(!cw\.ok\) \{ mostrarToast\(cw\.error, 'error'\); return; \}/);
    });
    test('no se confunde con la nota del jurado: la pantalla no toca notas_rodeo ni Comisión/Delegado con este campo', () => {
        const fragmento = html.slice(html.indexOf('async function guardarAnalisisDeportivo'), html.indexOf('// ── Banco de Situaciones'));
        expect(fragmento).not.toMatch(/notas_rodeo|nota_comision|nota_delegado|notas-secundarias/);
    });
});
