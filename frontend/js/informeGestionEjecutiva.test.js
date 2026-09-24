// Capa ejecutiva (Directorio): helpers de presentación. No calculan: solo dan formato a lo que entrega el backend.
const fs = require('fs'), path = require('path');
const IG = require('./informeGestionHelpers');

const evol = (over = {}) => ({
    evolucion_corte: {
        disponible: true,
        actual: { corte: '2026-09-20', bloque: { etiqueta: '18–20 SEP' } },
        anterior: { corte: '2026-09-13', bloque: { etiqueta: '12–13 SEP' } },
        cambios: [
            { clave: 'RODEOS_ACUMULADOS', etiqueta: 'Rodeos acumulados', actual: 175, anterior: 149, delta: 26, disponible: true, advertencia: null },
            { clave: 'COLLERAS_COMPLETAS', etiqueta: 'Colleras completas', actual: 35, anterior: null, delta: null, disponible: false, advertencia: null },
            { clave: 'RODEOS_CON_FALTA_REGLAMENTARIA', etiqueta: 'Rodeos con falta reglamentaria', actual: 32, anterior: 32, delta: 0, disponible: true, advertencia: null },
            { clave: 'RESULTADOS_ALTERADOS', etiqueta: 'Resultados alterados', actual: 40, anterior: 45, delta: -5, disponible: true, advertencia: 'COBERTURA_INSUFICIENTE', denominador_actual: 81, denominador_anterior: 90 }
        ],
        ...over
    }
});

describe('cambios desde el corte deportivo anterior', () => {
    test('muestra corte actual y corte anterior con su bloque, y los cambios con signo', () => {
        const r = IG.resumenEvolucion(evol());
        expect(r).toMatchObject({ disponible: true, actual: '20/09/2026 · bloque 18–20 SEP', anterior: '13/09/2026 · bloque 12–13 SEP' });
        expect(r.cambios.map(c => c.valor)).toEqual(['+26', 'SIN DATO', '0', '-5']);
        expect(r.cambios[0].detalle).toBe('175 vs 149');
    });
    test('sin cambio se dice explícitamente; no se usa color de valoración (solo texto)', () => {
        const c = IG.resumenEvolucion(evol()).cambios[2];
        expect(c).toMatchObject({ valor: '0', detalle: '32 vs 32 · sin cambio' });
    });
    test('colleras sin medición anterior: SIN DATO (no 0)', () => {
        expect(IG.resumenEvolucion(evol()).cambios[1]).toMatchObject({ valor: 'SIN DATO', detalle: 'Sin medición anterior', sinDato: true });
    });
    test('resultados alterados: numerador y denominador de publicadas de cada corte y advertencia de cobertura', () => {
        const c = IG.resumenEvolucion(evol()).cambios[3];
        expect(c.detalle).toBe('40 / 81 vs 45 / 90 publicadas');
        expect(c.advertencia).toBe('COBERTURA_INSUFICIENTE');
    });
    test('sin corte anterior: "SIN CORTE ANTERIOR COMPARABLE" y ningún cambio inventado', () => {
        expect(IG.resumenEvolucion({ evolucion_corte: { disponible: false, cambios: [] } })).toEqual({ disponible: false, etiqueta: 'SIN CORTE ANTERIOR COMPARABLE', cambios: [] });
        expect(IG.resumenEvolucion({}).disponible).toBe(false);   // payload anterior (sin la sección): compatible
    });
});

describe('evolución de señales en pantalla', () => {
    const es = {
        disponible: true,
        resumen: { nuevas: 8, persistentes: 17, resueltas: 5 },
        por_senal: [
            { codigo: 'BAJA_COBERTURA_EVALUACIONES', estado: 'NUEVA', entidades_nuevas: 0, entidades_resueltas: 0 },
            { codigo: 'CAIDA_ACTIVIDAD_ASOCIACION', estado: 'SE_MANTIENE', entidades_nuevas: 6, entidades_resueltas: 2 },
            { codigo: 'JURADO_REINCIDENCIA', estado: 'SE_MANTIENE', entidades_nuevas: 0, entidades_resueltas: 1 }
        ],
        resueltas: [
            { codigo: 'ASOCIACIONES_SIN_RODEOS', entidad_etiqueta: 'AYSÉN' }, { codigo: 'ASOCIACIONES_SIN_RODEOS', entidad_etiqueta: 'TALCA' },
            { codigo: 'CAIDA_ACTIVIDAD_ASOCIACION', entidad_etiqueta: 'ÑUBLE' }, { codigo: 'CAIDA_ACTIVIDAD_ASOCIACION', entidad_etiqueta: "O'HIGGINS" }, { codigo: 'JURADO_REINCIDENCIA', entidad_etiqueta: 'X' }
        ]
    };
    test('chip por señal: NUEVA / SE MANTIENE, con detalle de entidades nuevas y resueltas', () => {
        expect(IG.chipEstadoSenal('BAJA_COBERTURA_EVALUACIONES', es)).toMatchObject({ texto: 'NUEVA', clase: 'nueva' });
        expect(IG.chipEstadoSenal('CAIDA_ACTIVIDAD_ASOCIACION', es)).toMatchObject({ texto: 'SE MANTIENE', clase: 'mantiene', detalle: '+6 nuevas · −2 resueltas' });
        expect(IG.chipEstadoSenal('JURADO_REINCIDENCIA', es).detalle).toBe('−1 resuelta');
    });
    test('sin corte anterior o señal desconocida: sin chip', () => {
        expect(IG.chipEstadoSenal('X', es)).toBeNull();
        expect(IG.chipEstadoSenal('CAIDA_ACTIVIDAD_ASOCIACION', { disponible: false })).toBeNull();
        expect(IG.chipEstadoSenal('CAIDA_ACTIVIDAD_ASOCIACION', undefined)).toBeNull();
    });
    test('contadores NUEVAS / SE MANTIENEN / RESUELTAS y resueltas visibles: máximo 3 + "+N adicionales"', () => {
        const r = IG.resumenEstadoSenales(es, 3);
        expect(r).toMatchObject({ disponible: true, nuevas: 8, persistentes: 17, resueltas: 5, resueltasExtra: 2 });
        expect(r.resueltasVisibles).toEqual(['Sin rodeos: AYSÉN', 'Sin rodeos: TALCA', 'Menor actividad: ÑUBLE']);
    });
    test('sin corte anterior comparable', () => {
        expect(IG.resumenEstadoSenales({ disponible: false })).toEqual({ disponible: false, etiqueta: 'SIN CORTE ANTERIOR COMPARABLE' });
    });
});

describe('concentración de situaciones (texto dinámico)', () => {
    test('faltas reglamentarias: top N, % y total salen de los datos', () => {
        const f = { total_rodeos_afectados: 32, rodeos_en_top: 18, porcentaje_en_top: 56.3, top: [1, 2, 3, 4, 5].map(i => ({ asociacion: 'A' + i })) };
        expect(IG.textoConcentracionFaltas(f)).toBe('Las 5 asociaciones con más rodeos afectados concentran el 56,3 % de los rodeos con falta reglamentaria (18 de 32).');
        expect(IG.textoConcentracionFaltas({ ...f, top: f.top.slice(0, 3) })).toMatch(/^Las 3 asociaciones/);
        expect(IG.textoConcentracionFaltas({ total_rodeos_afectados: 0, top: [] })).toMatch(/Sin rodeos con falta/);
    });
    test('resultados alterados: sobre evaluaciones publicadas; sin publicadas = SIN DATOS (no 0 %)', () => {
        const a = { total_publicadas: 81, total_alterados: 40, rodeos_en_top: 14, porcentaje_en_top: 35, top: [1, 2, 3, 4, 5].map(i => ({ asociacion: 'A' + i })) };
        expect(IG.textoConcentracionAlterados(a)).toBe('Las 5 asociaciones con más rodeos con resultado alterado reúnen el 35,0 % de los 40 (de 81 evaluaciones publicadas).');
        expect(IG.textoConcentracionAlterados({ total_publicadas: 0, total_alterados: 0, top: [] })).toMatch(/^SIN DATOS/);
        expect(IG.textoConcentracionAlterados({ total_publicadas: 0, total_alterados: 0, top: [] })).not.toMatch(/0 %/);
    });
});

describe('utilización del cuerpo de jurados (umbrales vienen del backend)', () => {
    const d = () => ({ utilizacion_jurados: {
        disponibles_sin_designacion: { cantidad: 1, sobre_con_declaracion: 57 },
        alta_disponibilidad_baja_utilizacion: { cantidad: 8, criterio: '≥75 % disponibilidad declarada y ≤25 % utilización' },
        concentracion_designaciones: { jurados_considerados: 59, designaciones: 175, porcentaje_jurados_top: 20, jurados_en_top: 12, porcentaje_designaciones_en_top: 38.3 }
    } });
    test('tres KPI con los valores del motor y el criterio literal del backend', () => {
        const r = IG.resumenUtilizacion(d());
        expect(r.sinDesignacion).toEqual({ valor: '1', sub: 'de 57 con disponibilidad declarada' });
        expect(r.altaBaja).toEqual({ valor: '8', sub: 'Criterio: ≥75 % disponibilidad declarada y ≤25 % utilización.' });
        expect(r.concentracion.valor).toBe('38 %');
        expect(r.concentracion.sub).toBe('El 20 % de los jurados (12 de 59) reúne 38 % de 175 designaciones');
    });
    test('umbrales configurables: si el backend cambia el criterio, el texto cambia (nada fijo en el frontend)', () => {
        const x = d(); x.utilizacion_jurados.alta_disponibilidad_baja_utilizacion.criterio = '≥60 % disponibilidad declarada y ≤30 % utilización';
        x.utilizacion_jurados.concentracion_designaciones.porcentaje_jurados_top = 10;
        const r = IG.resumenUtilizacion(x);
        expect(r.altaBaja.sub).toContain('≥60 %');
        expect(r.concentracion.sub).toMatch(/^El 10 %/);
    });
    test('sin designaciones efectivas: SIN DATOS; payload anterior sin la sección: null', () => {
        const x = d(); x.utilizacion_jurados.concentracion_designaciones.porcentaje_designaciones_en_top = null;
        expect(IG.resumenUtilizacion(x).concentracion.valor).toBe('SIN DATOS');
        expect(IG.resumenUtilizacion({})).toBeNull();
    });
});

describe('pantalla (guardas estáticas de la capa ejecutiva)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'informeGestionPantalla.js'), 'utf8');
    test('los cuatro bloques nuevos existen con su título', () => {
        expect(src).toMatch(/Cambios desde el corte deportivo anterior/);
        expect(src).toMatch(/Situación general de temporada/);
        expect(src).toMatch(/Dónde se concentran las situaciones/);
        expect(src).toMatch(/Utilización del cuerpo de jurados/);
        expect(src).toMatch(/Señales resueltas desde el corte anterior/);
    });
    test('nunca rotula el corte como "informe anterior" (no hay historial de PDFs emitidos)', () => {
        expect(src).not.toMatch(/desde el informe anterior|informe anterior:|Informe anterior</i);   // solo se permite como aclaración ("no es el informe anterior emitido")
    });
    test('usa los helpers y los datos del motor (nada calculado ni fijo en la pantalla)', () => {
        expect(src).toMatch(/H\.resumenEvolucion\(d\)/);
        expect(src).toMatch(/get\(d, 'lectura_ejecutiva', \[\]\)/);
        expect(src).toMatch(/H\.resumenUtilizacion\(d\)/);
        expect(src).toMatch(/H\.chipEstadoSenal\(s\.codigo, d\.estado_senales\)/);
    });
    test('los umbrales de utilización no están escritos en la pantalla ni en los helpers', () => {
        const helpers = fs.readFileSync(path.join(__dirname, 'informeGestionHelpers.js'), 'utf8');
        expect(src).not.toMatch(/≥\s*75|≤\s*25|75 %|>=\s*75/);
        expect(helpers).not.toMatch(/≥\s*75|≤\s*25|>=\s*75|<=\s*25/);
    });
    test('gráfico de disponibilidad (p. 9): nombre completo en el eje (no 2 palabras), truncado solo con "…" y nombre completo en el tooltip', () => {
        expect(src).not.toMatch(/nombreCorto\(x\.jurado\)\.split\(' '\)\.slice\(0, 2\)/);
        expect(src).toMatch(/LARGO_MAX_NOMBRE/);
        expect(src).toMatch(/title: it => nombreCorto\(dd\[it\[0\]\.dataIndex\]\.jurado\)/);
        expect(src).toMatch(/const ALTO_DISP = (1[89]\d|2\d\d)/);   // alto suficiente para 10 filas con 2 barras sin traslape
    });
    test('nota metodológica del corte anterior: texto exacto, visible bajo los cambios y solo con corte anterior comparable', () => {
        expect(IG.NOTA_METODOLOGICA_CORTE).toBe('Nota metodológica: el corte anterior se reconstruye con la información actualmente disponible; no corresponde a una fotografía histórica guardada en esa fecha.');
        expect(src).toMatch(/H\.NOTA_METODOLOGICA_CORTE/);
        expect(src).toMatch(/ev2\.disponible \? `<div class="fila">[^`]*<div class="nota-metodo">/);
    });
    test('lenguaje neutro: sin juicios sobre gestión, jurados o asociaciones', () => {
        expect(src).not.toMatch(/subutiliz|mala gesti|gestión está mal|la temporada es mejor|presenta problemas/i);
    });
});
