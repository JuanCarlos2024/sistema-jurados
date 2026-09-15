// ═════════════════════════════════════════════════════════════════════════
// Tests de cartillaDelegadoNotas.js — "III. Informe sobre el desempeño del
// Jurado" (Cartilla Delegado, nuevo formato 2026-2027). Cubre exactamente
// lo pedido: validación 1.0-7.0, cálculo automático del promedio, NULL/
// undefined nunca se convierte en 0, y la sincronización hacia la MISMA
// columna rodeo_notas_secundarias.nota_delegado que ya usan los reportes.
// ═════════════════════════════════════════════════════════════════════════
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
const supabase = require('../config/supabase');
const {
    ASPECTOS_DESEMPENO_JURADO, validarAspectosDesempeno, calcularPromedioDesempeno,
    sincronizarNotaDelegado
} = require('./cartillaDelegadoNotas');

describe('ASPECTOS_DESEMPENO_JURADO — exactamente 4 aspectos, con el texto oficial', () => {
    test('hay exactamente 4 aspectos', () => {
        expect(ASPECTOS_DESEMPENO_JURADO).toHaveLength(4);
    });
    test('claves aspecto_1..aspecto_4', () => {
        expect(ASPECTOS_DESEMPENO_JURADO.map(a => a.key)).toEqual(['aspecto_1', 'aspecto_2', 'aspecto_3', 'aspecto_4']);
    });
});

describe('validarAspectosDesempeno — rango 1.0-7.0', () => {
    test('las 4 notas dentro de rango -> válido', () => {
        expect(validarAspectosDesempeno({ aspecto_1: 6, aspecto_2: 5, aspecto_3: 7, aspecto_4: 6 })).toEqual({ valido: true, error: null, camposInvalidos: [] });
    });
    test('objeto vacío (borrador sin empezar) -> válido (ausencia permitida)', () => {
        expect(validarAspectosDesempeno({})).toEqual({ valido: true, error: null, camposInvalidos: [] });
    });
    test('undefined -> válido', () => {
        expect(validarAspectosDesempeno(undefined)).toEqual({ valido: true, error: null, camposInvalidos: [] });
    });
    test('borrador parcial (2 de 4 notas) -> válido', () => {
        expect(validarAspectosDesempeno({ aspecto_1: 6, aspecto_2: 5 })).toEqual({ valido: true, error: null, camposInvalidos: [] });
    });
    test('nota bajo 1.0 -> inválido', () => {
        const r = validarAspectosDesempeno({ aspecto_1: 0.9 });
        expect(r.valido).toBe(false);
        expect(r.camposInvalidos).toEqual(['aspecto_1']);
    });
    test('nota sobre 7.0 -> inválido', () => {
        const r = validarAspectosDesempeno({ aspecto_2: 7.1 });
        expect(r.valido).toBe(false);
        expect(r.camposInvalidos).toEqual(['aspecto_2']);
    });
    test('nota = 0 -> inválido (fuera del rango 1.0-7.0, nunca se acepta como "ausente")', () => {
        const r = validarAspectosDesempeno({ aspecto_1: 0 });
        expect(r.valido).toBe(false);
    });
    test('límites exactos 1.0 y 7.0 son válidos', () => {
        expect(validarAspectosDesempeno({ aspecto_1: 1.0, aspecto_2: 7.0 }).valido).toBe(true);
    });
    test('valor no numérico -> inválido', () => {
        expect(validarAspectosDesempeno({ aspecto_1: 'no es numero' }).valido).toBe(false);
    });
    test('varios aspectos inválidos a la vez -> se reportan todos', () => {
        const r = validarAspectosDesempeno({ aspecto_1: 0, aspecto_2: 8, aspecto_3: 5 });
        expect(r.valido).toBe(false);
        expect(r.camposInvalidos.sort()).toEqual(['aspecto_1', 'aspecto_2']);
    });
});

describe('calcularPromedioDesempeno — (n1+n2+n3+n4)/4, automático', () => {
    test('CASO 6 del pedido: 6.0, 5.0, 7.0, 6.0 -> 6.0', () => {
        expect(calcularPromedioDesempeno({ aspecto_1: 6.0, aspecto_2: 5.0, aspecto_3: 7.0, aspecto_4: 6.0 })).toBe(6.0);
    });
    test('promedio con decimales se redondea a 1 decimal (mismo NUMERIC(3,1) que nota_delegado)', () => {
        expect(calcularPromedioDesempeno({ aspecto_1: 6, aspecto_2: 6, aspecto_3: 6, aspecto_4: 7 })).toBe(6.3); // 25/4=6.25 -> 6.3 (redondeo estándar)
    });
    test('falta un aspecto -> null (NUNCA 0) — equivalente a "Pendiente"', () => {
        expect(calcularPromedioDesempeno({ aspecto_1: 6, aspecto_2: 5, aspecto_3: 7 })).toBeNull();
    });
    test('objeto vacío -> null', () => {
        expect(calcularPromedioDesempeno({})).toBeNull();
    });
    test('undefined -> null', () => {
        expect(calcularPromedioDesempeno(undefined)).toBeNull();
    });
    test('un aspecto fuera de rango -> null (nunca calcula con un valor inválido)', () => {
        expect(calcularPromedioDesempeno({ aspecto_1: 6, aspecto_2: 5, aspecto_3: 7, aspecto_4: 9 })).toBeNull();
    });
    test('las 4 notas en el mínimo (1.0) -> promedio 1.0, no null, no 0', () => {
        expect(calcularPromedioDesempeno({ aspecto_1: 1, aspecto_2: 1, aspecto_3: 1, aspecto_4: 1 })).toBe(1.0);
    });
});

describe('sincronizarNotaDelegado — alimenta rodeo_notas_secundarias.nota_delegado (fuente única, sin nota paralela)', () => {
    let upsertMock;
    beforeEach(() => {
        upsertMock = jest.fn().mockResolvedValue({ error: null });
        supabase.from.mockReset();
        supabase.from.mockImplementation(tabla => ({ upsert: upsertMock }));
    });

    test('promedio válido -> hace upsert por rodeo_id con onConflict, sin tocar nota_comision', async () => {
        const r = await sincronizarNotaDelegado('rodeo-1', 6.3, 'delegado-1');
        expect(r).toEqual({ sincronizado: true, nota_delegado: 6.3 });
        expect(supabase.from).toHaveBeenCalledWith('rodeo_notas_secundarias');
        const [payload, opts] = upsertMock.mock.calls[0];
        expect(payload.rodeo_id).toBe('rodeo-1');
        expect(payload.nota_delegado).toBe(6.3);
        expect(payload.actualizado_por).toBe('delegado-1');
        expect(payload).not.toHaveProperty('nota_comision'); // nunca se incluye -> el UPDATE del conflicto no la toca
        expect(opts).toEqual({ onConflict: 'rodeo_id' });
    });

    test('promedio null (borrador incompleto) -> NO hace ninguna escritura', async () => {
        const r = await sincronizarNotaDelegado('rodeo-1', null, 'delegado-1');
        expect(r).toEqual({ sincronizado: false });
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('error de BD -> lanza excepción con mensaje claro (para que la ruta la capture, sin romper el envío ya guardado)', async () => {
        upsertMock.mockResolvedValue({ error: { message: 'fallo simulado' } });
        await expect(sincronizarNotaDelegado('rodeo-1', 5.5, 'delegado-1')).rejects.toThrow(/fallo simulado/);
    });
});
