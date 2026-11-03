// Protección estática + ejecución REAL del bloque "badge digital CD" de
// admin/rodeos.html (mismo patrón que rodeosReemplazarJurado.test.js: este
// proyecto no tiene entorno DOM para frontend, se extrae el código REAL de
// renderTabla() tal como está en el archivo y se ejecuta con los objetos
// ESTADO_DIGITAL_TXT/ESTADO_DIGITAL_COLOR también extraídos — nunca se
// reimplementa la lógica).
//
// Cubre la mejora: check "✓" junto a la letra A/R cuando la cartilla
// digital de Delegado (Rentado o Asociación) ya fue efectivamente enviada
// (enviada, reenviada, aprobada, cerrada) y su ausencia en borrador/observada.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerBloqueBadgeDigital() {
    const inicio = html.indexOf('const ESTADO_DIGITAL_TXT = {');
    const finMarcador = '\n            const indicHtml = ';
    const fin = html.indexOf(finMarcador, inicio);
    if (inicio === -1 || fin === -1) {
        throw new Error('No se encontró el bloque de badge digital en rodeos.html (¿cambió el código?)');
    }
    return html.slice(inicio, fin);
}

const BLOQUE = extraerBloqueBadgeDigital();

function construirBadge(ind) {
    // eslint-disable-next-line no-new-func
    const fn = new Function('ind', `${BLOQUE}\nreturn digitalBadge;`);
    return fn(ind);
}

describe('rodeos.html — badge digital CD: check "✓" cuando ya fue enviada', () => {
    test('el bloque extraído existe y contiene la lógica esperada', () => {
        expect(BLOQUE).toContain('ESTADOS_DIGITAL_ENVIADA');
        expect(BLOQUE).toContain("['enviada', 'reenviada', 'aprobada', 'cerrada']");
    });

    describe('Delegado de Asociación (letra A)', () => {
        test('borrador: recuadro sin check', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_asociacion', estado: 'borrador' } });
            expect(badge).toContain('📱A');
            expect(badge).not.toContain('✓');
            expect(badge).toContain('color:#aaa');
            expect(badge).not.toContain('(enviada)');
        });

        test('enviada: recuadro verde con "A ✓"', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_asociacion', estado: 'enviada' } });
            expect(badge).toContain('📱A ✓');
            expect(badge).toContain('color:#27ae60');
            expect(badge).toContain('(enviada)');
        });

        test('reenviada: con check', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_asociacion', estado: 'reenviada' } });
            expect(badge).toContain('📱A ✓');
        });

        test('aprobada: con check', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_asociacion', estado: 'aprobada' } });
            expect(badge).toContain('📱A ✓');
        });

        test('cerrada: con check', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_asociacion', estado: 'cerrada' } });
            expect(badge).toContain('📱A ✓');
        });

        test('observada: sin check (debe corregir y reenviar, no es "enviada" vigente)', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_asociacion', estado: 'observada' } });
            expect(badge).toContain('📱A');
            expect(badge).not.toContain('✓');
        });
    });

    describe('Delegado Rentado (letra R)', () => {
        test('borrador: recuadro gris sin check', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_rentado', estado: 'borrador' } });
            expect(badge).toContain('📱R');
            expect(badge).not.toContain('✓');
            expect(badge).toContain('color:#aaa');
        });

        test('enviada: recuadro verde con "R ✓"', () => {
            const badge = construirBadge({ cd_digital: { modalidad: 'delegado_rentado', estado: 'enviada' } });
            expect(badge).toContain('📱R ✓');
            expect(badge).toContain('color:#27ae60');
        });
    });

    test('sin cartilla digital: no se agrega badge', () => {
        const badge = construirBadge({ cd_digital: null });
        expect(badge).toBe('');
    });

    test('compatibilidad: no modifica el color/texto por estado (ESTADO_DIGITAL_TXT/COLOR intactos)', () => {
        expect(BLOQUE).toContain("borrador: '#aaa', enviada: '#27ae60', reenviada: '#1e8449'");
        expect(BLOQUE).toContain("observada: '#e67e22', aprobada: '#1a5276', cerrada: '#5d6d7e'");
    });
});
