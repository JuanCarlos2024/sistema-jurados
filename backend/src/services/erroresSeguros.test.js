// Incidente 2026-11-25 — respuesta segura de errores internos del dry-run.
const {
    redactarDetalleTecnico, generarReferenciaError, contextoFuncional, construirRespuestaErrorInterno, LARGO_MAXIMO_LOG
} = require('./erroresSeguros');

const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJyb2xlIjoiZmljdGljaW8ifQ', 'firmaFicticia123'].join('.'); // ficticio, armado en ejecución
const CLAVE_SB = ['sb', 'secret', 'AbCdEf123456'].join('_'); // ficticia

describe('redactarDetalleTecnico (solo para el log del servidor)', () => {
    test.each([
        ['JWT', `fallo con ${JWT}`, JWT],
        ['Bearer', 'Authorization: Bearer abcDEF123456789', 'abcDEF123456789'],
        ['clave sb_secret', `clave ${CLAVE_SB}`, CLAVE_SB],
        ['apikey en URL', 'https://x.supabase.co/rest/v1/t?apikey=SECRETO123&select=id', 'SECRETO123'],
        ['password', 'password=Hunter2!', 'Hunter2!'],
        ['cadena postgres', 'postgres://usuario:clave@db.host:5432/postgres', 'usuario:clave']
    ])('redacta %s', (_n, entrada, secreto) => {
        const r = redactarDetalleTecnico(entrada);
        expect(r).not.toContain(secreto);
        expect(r).toMatch(/REDACTAD/);
    });
    test('conserva el diagnóstico útil (mensaje técnico no sensible)', () => {
        expect(redactarDetalleTecnico('No se pudieron cargar notas: TypeError: fetch failed')).toBe('No se pudieron cargar notas: TypeError: fetch failed');
    });
    test('acota el largo (p.ej. una URL de 16 KB) e indica cuánto se omitió', () => {
        const r = redactarDetalleTecnico('x'.repeat(16000));
        expect(r.length).toBeLessThan(LARGO_MAXIMO_LOG + 60);
        expect(r).toMatch(/14000 caracteres omitidos/);
    });
    test('null/undefined no rompen', () => {
        expect(redactarDetalleTecnico(undefined)).toBe('');
        expect(redactarDetalleTecnico(null)).toBe('');
    });
});

describe('contextoFuncional', () => {
    test('conserva el contexto funcional propio del sistema', () => {
        expect(contextoFuncional('No se pudieron cargar notas para métricas de rendimiento: TypeError: fetch failed'))
            .toBe('No se pudieron cargar notas para métricas de rendimiento');
        expect(contextoFuncional('No se pudo cargar disponibilidad: timeout')).toBe('No se pudo cargar disponibilidad');
    });
    test.each([
        'No se pudo cargar notas_rodeo para nota técnica: x',       // nombre de tabla
        "Cannot read properties of undefined (reading 'id')",       // error de JavaScript
        'TypeError: fetch failed',
        'duplicate key value violates unique constraint "x"',
        'No se pudo cargar https://abc.supabase.co/rest/v1/x: 500', // URL interna
        '',
        undefined
    ])('descarta lo que no es un texto funcional propio: %p', (m) => {
        expect(contextoFuncional(m)).toBeNull();
    });
});

describe('construirRespuestaErrorInterno', () => {
    function loggerFalso() { const lineas = []; return { lineas, error: (l) => lineas.push(l) }; }

    test('el caso exacto del incidente: respuesta funcional + referencia; detalle solo en el log', () => {
        const log = loggerFalso();
        const err = new Error('No se pudieron cargar notas para métricas de rendimiento: TypeError: fetch failed');
        const { cuerpo, referencia } = construirRespuestaErrorInterno('[DRY-RUN] Error generando simulación:', 'No se pudo generar la simulación', err, log);

        expect(referencia).toMatch(/^DR-[0-9A-F]{8}$/);
        expect(cuerpo).toEqual({
            error: `No se pudo generar la simulación: No se pudieron cargar notas para métricas de rendimiento. Intente nuevamente; si el problema persiste, informe la referencia ${referencia}.`,
            referencia
        });
        expect(JSON.stringify(cuerpo)).not.toMatch(/fetch|TypeError|at /);
        expect(log.lineas).toHaveLength(1);
        expect(log.lineas[0]).toContain(`ref=${referencia}`);
        expect(log.lineas[0]).toContain('TypeError: fetch failed');
    });

    test('error de JavaScript sin contexto propio → solo el mensaje funcional fijo', () => {
        const log = loggerFalso();
        const { cuerpo } = construirRespuestaErrorInterno('[X]', 'No se pudo generar la simulación', new TypeError("Cannot read properties of undefined (reading 'id')"), log);
        expect(cuerpo.error).toMatch(/^No se pudo generar la simulación\. Intente nuevamente; si el problema persiste, informe la referencia DR-/);
        expect(cuerpo.error).not.toMatch(/Cannot read|undefined/);
        // La traza queda en el log del servidor (redactada), nunca en la respuesta.
        expect(log.lineas[0]).toMatch(/Cannot read properties/);
        expect(log.lineas[0]).toMatch(/erroresSeguros\.test\.js/);
    });

    test('credenciales en el error: ni en la respuesta ni sin redactar en el log', () => {
        const log = loggerFalso();
        const { cuerpo } = construirRespuestaErrorInterno('[X]', 'No se pudo generar la simulación', new Error(`No se pudo cargar jurados: invalid ${JWT}`), log);
        expect(JSON.stringify(cuerpo)).not.toContain(JWT);
        expect(log.lineas[0]).not.toContain(JWT);
        expect(log.lineas[0]).toContain('[TOKEN REDACTADO]');
    });

    test('acepta un string como error (motivo del estado ERROR_TECNICO)', () => {
        const log = loggerFalso();
        const { cuerpo } = construirRespuestaErrorInterno('[X]', 'No se pudo completar', 'x is not a function', log);
        expect(cuerpo.error).not.toMatch(/not a function/);
        expect(log.lineas[0]).toMatch(/x is not a function/);
    });

    test('referencias distintas en cada llamada', () => {
        const refs = new Set(Array.from({ length: 50 }, () => generarReferenciaError()));
        expect(refs.size).toBe(50);
    });
});
