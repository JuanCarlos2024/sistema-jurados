const { celdaValor } = require('./cartillaDelegadoPdfTabla');

// Antes la sección de ganado del PDF usaba `s['q'+n+'c'] || '—'` directo
// sobre el valor crudo — un 0 numérico o '0' string (ej. "Corrido: 0",
// "Repetido: 0", "Bajo/sobrepeso: 0") es falsy en JS y se mostraba como
// ausencia de información ('—'), perdiendo un dato real ingresado por el
// delegado. `celdaValor` es el único criterio de formateo de celda usado
// por la tabla del PDF — este test fija ese contrato.
describe('celdaValor', () => {
    test('0 numérico se muestra como "0", nunca como "—"', () => {
        expect(celdaValor(0)).toBe('0');
    });

    test('"0" string se muestra como "0"', () => {
        expect(celdaValor('0')).toBe('0');
    });

    test('null/undefined/"" se muestran como "—"', () => {
        expect(celdaValor(null)).toBe('—');
        expect(celdaValor(undefined)).toBe('—');
        expect(celdaValor('')).toBe('—');
    });

    test('cadena solo con espacios se trata como vacía -> "—"', () => {
        expect(celdaValor('   ')).toBe('—');
    });

    test('valores numéricos distintos de 0 se muestran tal cual', () => {
        expect(celdaValor(420)).toBe('420');
        expect(celdaValor('Muy bueno')).toBe('Muy bueno');
    });
});
