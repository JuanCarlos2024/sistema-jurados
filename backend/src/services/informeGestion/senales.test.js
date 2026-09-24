const { generarSenales } = require('./senales');

const asoc = (nombre, estado, actual, hist, extra = {}) => ({ asociacion: nombre, estado, rodeos_actuales: actual, rodeos_historicos_equivalentes: hist, variacion_pct: hist ? Math.round((actual - hist) / hist * 1000) / 10 : null, alertable: true, ...extra });
const base = () => ({
    comparacionRodeos: { actual: 190, historico: 171, variacion_pct: 11.1 },
    comparacionColleras: { actual: 35, historico: 28, variacion_pct: 25 },
    asociaciones: {
        catalogo_disponible: true,
        resumen: { umbral_caida_relevante_pct: 30 },
        asociaciones: [
            asoc('CHILOE', 'SIN_ACTIVIDAD', 0, 2), asoc('MAGALLANES', 'SIN_ACTIVIDAD', 0, 0),
            asoc('FEDERACION', 'SIN_ACTIVIDAD', 0, 0, { alertable: false }),
            asoc('COLCHAGUA', 'CAIDA_RELEVANTE', 1, 4), asoc('ARAUCO', 'SIMILAR', 4, 4)
        ]
    },
    alterados: { periodo: { cantidad: 3, denominador: 6, porcentaje: 50 }, anterior: { cantidad: 1, denominador: 8, porcentaje: 12.5 } },
    jurados: { detalle: [
        { jurado: 'A', categoria: 'B', nivel_muestra: 'SUFICIENTE', tamano_muestra: 6, racha_actual_rodeos_con_falta_reglamentaria: 2, racha_actual_rodeos_con_resultado_alterado: 0 },
        { jurado: 'B', categoria: 'C', nivel_muestra: 'INSUFICIENTE', tamano_muestra: 1, racha_actual_rodeos_con_falta_reglamentaria: 3, racha_actual_rodeos_con_resultado_alterado: 2 },
        { jurado: 'C', categoria: 'A', nivel_muestra: 'LIMITADA', tamano_muestra: 3, racha_actual_rodeos_con_falta_reglamentaria: 1, racha_actual_rodeos_con_resultado_alterado: 0 },
        { jurado: 'D', categoria: 'B', nivel_muestra: 'SUFICIENTE', tamano_muestra: 7, racha_actual_rodeos_con_situaciones: 9, racha_actual_rodeos_con_falta_reglamentaria: 0, racha_actual_rodeos_con_resultado_alterado: 1 }
    ] },
    cobertura: { evaluaciones_publicadas: { numerador: 5, denominador: 20, cobertura: 0.25, porcentaje: 25 }, cartillas_jurado: { numerador: 19, denominador: 20, cobertura: 0.95, porcentaje: 95 } }
});
const cod = s => s.map(x => x.codigo);
const por = (s, c) => s.find(x => x.codigo === c);

describe('generarSenales (determinístico)', () => {
    const s = generarSenales(base());

    test('cada señal trae la estructura completa', () => {
        s.forEach(x => {
            expect(Object.keys(x).sort()).toEqual(['codigo', 'detalle', 'evidencia', 'nivel', 'referencia', 'titulo', 'valor_actual']);
            expect(['INFO', 'ATENCION', 'PRIORIDAD']).toContain(x.nivel);
        });
    });

    test('misma entrada → misma salida (100 % determinístico)', () => {
        expect(generarSenales(base())).toEqual(generarSenales(base()));
    });

    test('ASOCIACIONES_SIN_RODEOS: excluye asociaciones no alertables (especiales) y lista evidencia', () => {
        const x = por(s, 'ASOCIACIONES_SIN_RODEOS');
        expect(x.valor_actual).toBe(2);
        expect(x.evidencia.map(e => e.asociacion)).toEqual(['CHILOE', 'MAGALLANES']);
        expect(x.nivel).toBe('ATENCION');                    // solo 1 con histórico > 0 (< 3)
        expect(x.detalle).toMatch(/1 de ellas sí tenían rodeos/);
    });

    test('ASOCIACIONES_SIN_RODEOS sube a PRIORIDAD con ≥ 3 asociaciones con histórico positivo', () => {
        const b = base();
        b.asociaciones.asociaciones = ['A', 'B', 'C'].map(n => asoc(n, 'SIN_ACTIVIDAD', 0, 3));
        expect(por(generarSenales(b), 'ASOCIACIONES_SIN_RODEOS').nivel).toBe('PRIORIDAD');
    });

    test('ASOCIACIONES_SIN_RODEOS: 0 actual vs 0 histórico (históricamente similar) es solo INFO', () => {
        const b = base();
        b.asociaciones.asociaciones = [asoc('CHILOE', 'SIN_ACTIVIDAD', 0, 0), asoc('MAGALLANES', 'SIN_ACTIVIDAD', 0, 0)];
        const x = por(generarSenales(b), 'ASOCIACIONES_SIN_RODEOS');
        expect(x.nivel).toBe('INFO');
        expect(x.detalle).toMatch(/históricamente similar/);
    });

    test('JURADO_REINCIDENCIA no se dispara por una racha de "cualquier caso" (rutinaria) sino por faltas reglamentarias o alterados', () => {
        const x = por(s, 'JURADO_REINCIDENCIA');
        expect(x.evidencia.map(e => e.jurado)).not.toContain('D');   // D tiene racha 9 de casos cualesquiera, pero 0 reglamentarias
    });

    test('CAIDA_ACTIVIDAD_ASOCIACION', () => {
        expect(por(s, 'CAIDA_ACTIVIDAD_ASOCIACION')).toMatchObject({ nivel: 'ATENCION', valor_actual: 1 });
    });

    test('RODEOS_SOBRE_HISTORICO / COLLERAS_SOBRE_HISTORICO (INFO) y no existen las señales "bajo"', () => {
        expect(por(s, 'RODEOS_SOBRE_HISTORICO').nivel).toBe('INFO');
        expect(por(s, 'COLLERAS_SOBRE_HISTORICO').nivel).toBe('INFO');
        expect(cod(s)).not.toContain('RODEOS_BAJO_HISTORICO');
    });

    test('bajo el histórico: -5 % ATENCION, -15 % PRIORIDAD; entre -5 y +5 no genera señal', () => {
        const con = v => generarSenales({ comparacionRodeos: { actual: 90, historico: 100, variacion_pct: v }, comparacionColleras: { actual: 1, historico: 1, variacion_pct: 0 } });
        expect(por(con(-5), 'RODEOS_BAJO_HISTORICO').nivel).toBe('ATENCION');
        expect(por(con(-15), 'RODEOS_BAJO_HISTORICO').nivel).toBe('PRIORIDAD');
        expect(con(-4.9)).toEqual([]);
        expect(con(4.9)).toEqual([]);
        expect(con(null)).toEqual([]);
    });

    test('COLLERAS_BAJO_HISTORICO', () => {
        const x = generarSenales({ comparacionColleras: { actual: 80, historico: 100, variacion_pct: -20 } });
        expect(por(x, 'COLLERAS_BAJO_HISTORICO').nivel).toBe('PRIORIDAD');
    });

    test('AUMENTO_RESULTADOS_ALTERADOS exige denominador mínimo en ambos períodos y aumento ≥ 10 pp', () => {
        expect(por(s, 'AUMENTO_RESULTADOS_ALTERADOS')).toMatchObject({ nivel: 'ATENCION', valor_actual: 50, referencia: 12.5 });
        const b = base(); b.alterados.anterior.denominador = 2;
        expect(cod(generarSenales(b))).not.toContain('AUMENTO_RESULTADOS_ALTERADOS');
        const c = base(); c.alterados.anterior.porcentaje = 45;
        expect(cod(generarSenales(c))).not.toContain('AUMENTO_RESULTADOS_ALTERADOS');
    });

    test('JURADO_REINCIDENCIA: solo jurados con muestra ≥ LIMITADA y racha ≥ umbral; lenguaje neutro', () => {
        const x = por(s, 'JURADO_REINCIDENCIA');
        expect(x.evidencia.map(e => e.jurado)).toEqual(['A']);       // B tiene muestra insuficiente; C no alcanza la racha
        expect(x.detalle).toMatch(/no se atribuyen a la persona/);
        expect(x.titulo).toMatch(/en seguimiento/);
        expect(x.evidencia[0]).toHaveProperty('racha_rodeos_con_falta_reglamentaria', 2);
        const texto = JSON.stringify(s).toLowerCase();
        ['mal jurado', 'culpable', 'incompetente', 'negligen'].forEach(p => expect(texto).not.toContain(p));
    });

    test('BAJA_COBERTURA_*: < 50 % ATENCION, < 25 % PRIORIDAD; cobertura suficiente no genera señal', () => {
        expect(por(s, 'BAJA_COBERTURA_EVALUACIONES').nivel).toBe('ATENCION');   // 0.25 no es < 0.25
        expect(cod(s)).not.toContain('BAJA_COBERTURA_CARTILLAS');
        const b = base(); b.cobertura.evaluaciones_publicadas = { numerador: 1, denominador: 20, cobertura: 0.05, porcentaje: 5 };
        expect(por(generarSenales(b), 'BAJA_COBERTURA_EVALUACIONES').nivel).toBe('PRIORIDAD');
        const c = base(); c.cobertura.cartillas_jurado = { numerador: 4, denominador: 20, cobertura: 0.2, porcentaje: 20 };
        expect(por(generarSenales(c), 'BAJA_COBERTURA_CARTILLAS').nivel).toBe('PRIORIDAD');
    });

    test('ordenadas por nivel (PRIORIDAD → ATENCION → INFO)', () => {
        const b = base(); b.cobertura.evaluaciones_publicadas = { numerador: 1, denominador: 20, cobertura: 0.05, porcentaje: 5 };
        const orden = { PRIORIDAD: 0, ATENCION: 1, INFO: 2 };
        const niveles = generarSenales(b).map(x => orden[x.nivel]);
        expect([...niveles].sort((a, b2) => a - b2)).toEqual(niveles);
    });

    test('sin catálogo no se generan señales de asociaciones; umbrales configurables', () => {
        const b = base(); b.asociaciones = { catalogo_disponible: false, asociaciones: [] };
        expect(cod(generarSenales(b))).not.toContain('ASOCIACIONES_SIN_RODEOS');
        const cfg = require('./config');
        const propio = { ...cfg, COMPARACION: { SOBRE_INFO_PCT: 50, BAJO_ATENCION_PCT: -5, BAJO_PRIORIDAD_PCT: -15 } };
        expect(cod(generarSenales(base(), propio))).not.toContain('RODEOS_SOBRE_HISTORICO');
    });
});
