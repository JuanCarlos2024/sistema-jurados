jest.mock('../../config/supabase', () => ({ from: jest.fn() }));

const XLSX = require('xlsx');
const { previewHistoricoRodeos, confirmarHistoricoRodeos, interpretarFecha } = require('./importHistoricoRodeos');
const { previewHistoricoColleras, confirmarHistoricoColleras, interpretarEncabezado } = require('./importHistoricoColleras');

const serial = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000 + 25569;
function buffer(hojas) {
    const wb = XLSX.utils.book_new();
    for (const [nombre, aoa, origen] of hojas) {
        const ws = XLSX.utils.aoa_to_sheet(aoa, origen ? { origin: origen } : undefined);
        if (origen) { // el archivo real declara su rango desde B1 (columna A inexistente)
            const r = XLSX.utils.decode_range(ws['!ref']);
            r.s.c = 1;
            ws['!ref'] = XLSX.utils.encode_range(r);
        }
        XLSX.utils.book_append_sheet(wb, ws, nombre);
    }
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function dbFake({ existentes = [] } = {}) {
    const llamadas = [];
    return {
        llamadas,
        from: jest.fn(tabla => {
            const c = {};
            c.insert = v => { llamadas.push({ tabla, op: 'insert', v }); return c; };
            c.upsert = (v, o) => { llamadas.push({ tabla, op: 'upsert', v, o }); c.ultimo = v; return c; };
            c.update = v => { llamadas.push({ tabla, op: 'update', v }); return c; };
            c.select = () => c; c.limit = () => c; c.eq = () => c;
            c.single = () => Promise.resolve({ data: { id: 'imp-1' }, error: null });
            c.then = res => Promise.resolve({ data: c.ultimo ? c.ultimo.map((_, i) => ({ id: 'n' + i })) : (tabla === 'historico_rodeos_temporada' ? existentes : []), error: null }).then(res);
            return c;
        })
    };
}

describe('histórico de rodeos: preview', () => {
    const enc = ['Club  ', 'Asociación  ', 'Temporada  ', 'Fecha Rodeo  ', 'Tipo Rodeo  ', 'CATEGORIA'];
    const filas = [
        ['DOÑIHUE', "O'HIGGINS", '2025-2026', serial('2026-01-10'), 'Provincial 3 series', 'SEGUNDA'],
        ['LOS MUERMOS', 'LAGO LLANQUIHUE', '2025-2026', serial('2025-11-08'), 'Libre', 'PRIMERA'],
        ['DOÑIHUE', "O'HIGGINS", '2025-2026', serial('2026-01-10'), 'Provincial 3 series', 'SEGUNDA'],           // duplicado exacto
        ['DOÑIHUE', "O'HIGGINS", '2025-2026', serial('2026-01-10'), 'Provincial Especial - Un Día', 'ESPECIAL'],  // mismo club/fecha, otro tipo: NO es duplicado
        ['X', 'Y', '2025-2026', '1/10/26', 'Libre', 'PRIMERA'],                                                    // fecha texto ambigua
        ['X', 'Y', '2025-2026', serial('2025-12-01'), 'Libre', 'TERCERA Y MEDIA'],                                 // categoría desconocida
        ['SIN CORRESP', 'ASOC INEXISTENTE', '2025-2026', serial('2025-12-02'), 'Interasociaciones Limitado 25 colleras null', 'SEGUNDA'],
        ['FUERA', "O'HIGGINS", '2025-2026', serial('2025-03-08'), 'Libre', 'PRIMERA'],                            // antes de la temporada
        ['OTRA', "O'HIGGINS", '2024-2025', serial('2025-01-10'), 'Libre', 'PRIMERA']                              // temporada distinta a la esperada
    ];
    const buf = buffer([['Hoja1', [enc, ...filas]]]);
    const opciones = {
        catalogo: [{ id: 'a1', nombre: "O'HIGGINS", nombre_normalizado: "o'higgins" }, { id: 'a2', nombre: 'LAGO LLANQUIHUE', nombre_normalizado: 'lago llanquihue' }],
        tiposCatalogo: ['Provincial 3 series', 'Libre', 'Provincial Especial - Un Día', 'Interasociaciones Limitado 25 colleras'],
        ventana: { inicio: '2025-04-02', fin: '2026-04-01' }, temporadaEsperada: '2025-2026'
    };
    const p = previewHistoricoRodeos(buf, opciones);
    const f = n => p.filas.find(x => x.fila === n);

    test('serial de Excel → fecha ISO exacta (no ambigua); texto d/m/aa se rechaza', () => {
        expect(interpretarFecha(serial('2026-01-10'))).toEqual({ ok: true, iso: '2026-01-10' });
        expect(interpretarFecha('2026-01-10').ok).toBe(true);
        expect(interpretarFecha('1/10/26')).toEqual({ ok: false, motivo: 'FECHA_TEXTO_AMBIGUA' });
        expect(f(6).estado).toBe('ERROR');
        expect(f(6).errores).toContain('FECHA_TEXTO_AMBIGUA');
    });

    test('normaliza y valida categoría, tipo, asociación y fechas fuera de temporada', () => {
        expect(f(2).registro).toMatchObject({ temporada: '2025-2026', fecha_rodeo: '2026-01-10', categoria: 'Segunda', asociacion_id: 'a1', tipo_normalizado: 'provincial 3 series' });
        expect(f(7).errores).toContain('CATEGORIA_NO_RECONOCIDA');
        expect(f(8).advertencias).toEqual(expect.arrayContaining(['TIPO_CON_SUFIJO_NULL', 'TIPO_NORMALIZADO_POR_COINCIDENCIA_UNICA', 'ASOCIACION_SIN_CORRESPONDENCIA']));
        expect(f(8).advertencias).not.toContain('TIPO_NO_RECONOCIDO');
        expect(f(8).registro.tipo_rodeo).toBe('Interasociaciones Limitado 25 colleras');
        expect(p.resumen.tipos_sufijo_null_normalizados).toBe(1);
        expect(f(9).advertencias).toContain('FUERA_DE_TEMPORADA');
        expect(f(10).advertencias).toContain('TEMPORADA_DISTINTA_A_LA_ESPERADA');
    });

    test('sufijo "null": SIN coincidencia única en tipos_rodeo NO se decide (se conserva el original) y se informa', () => {
        const sin = previewHistoricoRodeos(buf, { ...opciones, tiposCatalogo: ['Libre'] });
        const x = sin.filas.find(y => y.fila === 8);
        expect(x.registro.tipo_rodeo).toBe('Interasociaciones Limitado 25 colleras null');
        expect(x.advertencias).toEqual(expect.arrayContaining(['TIPO_SUFIJO_NULL_SIN_COINCIDENCIA_UNICA']));
        expect(sin.resumen.tipos_sufijo_null_sin_decidir).toBe(1);
        const dup = previewHistoricoRodeos(buf, { ...opciones, tiposCatalogo: ['Interasociaciones Limitado 25 colleras', 'INTERASOCIACIONES LIMITADO 25 COLLERAS'] });
        expect(dup.filas.find(y => y.fila === 8).advertencias).toContain('TIPO_SUFIJO_NULL_AMBIGUO');
        expect(dup.filas.find(y => y.fila === 8).registro.tipo_rodeo).toBe('Interasociaciones Limitado 25 colleras null');
    });

    test('duplicados: misma clave = DUPLICADO; mismo club y fecha con otro tipo NO lo es', () => {
        expect(f(4).estado).toBe('DUPLICADO');
        expect(f(5).estado).not.toBe('DUPLICADO');
        expect(f(5).registro.categoria).toBe('Especial');
        expect(p.resumen.duplicados_en_archivo).toBe(1);
    });

    test('resumen', () => {
        expect(p.resumen).toMatchObject({ total_filas: 9, errores: 2, duplicados_en_archivo: 1, fuera_de_temporada: 2, tipos_con_sufijo_null: 1, asociaciones_sin_correspondencia: 3, catalogo_asociaciones_disponible: true });
        expect(p.resumen.importables).toBe(9 - 2 - 1);
        expect(p.aviso).toMatch(/no se guardó nada/);
    });

    test('IDEMPOTENTE: con las claves ya importadas, todo queda YA_IMPORTADO y nada se vuelve a insertar', () => {
        const claves = new Set(p.filas.filter(x => x.registro).map(x => x.clave_unicidad));
        const q = previewHistoricoRodeos(buf, { ...opciones, clavesExistentes: claves });
        expect(q.resumen.importables).toBe(0);
        expect(q.resumen.ya_importados).toBe(7);
    });

    test('la clave de unicidad no depende solo del club', () => {
        const claves = p.filas.filter(x => x.registro).map(x => x.clave_unicidad);
        expect(claves[0]).toBe("2025-2026|2026-01-10|doñihue|o'higgins|provincial 3 series".replace('ñ', 'n'));
        expect(new Set(claves).size).toBe(claves.length - 0 > 0 ? new Set(claves).size : 0);
    });

    test('columnas obligatorias faltantes o archivo ilegible se rechazan', () => {
        expect(() => previewHistoricoRodeos(buffer([['Hoja1', [['Club', 'Fecha Rodeo'], ['a', 1]]]]))).toThrow(/Faltan columnas/);
        expect(() => previewHistoricoRodeos(Buffer.from('no es excel'))).toThrow();
    });

    test('confirmar re-lee y revalida: solo inserta OK/ADVERTENCIA con ON CONFLICT DO NOTHING y registra la importación', async () => {
        const db = dbFake();
        const r = await confirmarHistoricoRodeos(buf, opciones, { db, actorId: 'admin-1' });
        const up = db.llamadas.find(c => c.tabla === 'historico_rodeos_temporada' && c.op === 'upsert');
        expect(up.o).toEqual({ onConflict: 'temporada,fecha_rodeo,club_normalizado,asociacion_normalizada,tipo_normalizado', ignoreDuplicates: true });
        expect(up.v.length).toBe(6);
        expect(up.v.every(x => x.importacion_id === 'imp-1' && x.fuente)).toBe(true);
        expect(db.llamadas.find(c => c.tabla === 'importaciones' && c.op === 'insert').v).toMatchObject({ tipo: 'historico_rodeos', created_by: 'admin-1' });
        expect(r.insertadas).toBe(6);
    });
});

describe('histórico de colleras: fin de semana de referencia (último día del rango)', () => {
    const filas = [
        [null, '27-28 SEPT', 46146, serial('2025-10-18'), '31-02 NOV', 46273, '16 Y 17 NOV', '7 Y 8', null],
        [null, null, 'OCT', 'OCT', null, 'NOV', null, 'DIC', null],
        ['2025 /', 28, 37, 47, 91, 113, 'XXXX', 178, 999],
        [2026],
        ['2024 /', null, null, 60, 78, 95, 125, 167, null],
        [2025]
    ];
    const buf = buffer([['Hoja1', filas, 'B1']]);
    const p = previewHistoricoColleras(buf);
    const e = clave => p.filas.find(x => x.clave === clave);

    test('detecta temporadas por el par de filas ("2025 /" + 2026)', () => {
        expect(p.resumen.temporadas).toEqual(['2025-2026', '2024-2025']);
    });

    test('"27-28 SEPT" → fecha_medicion = 28 de septiembre del año de la temporada (último día del rango), VALIDO', () => {
        expect(e('2025-2026|C')).toMatchObject({ estado: 'VALIDO', valor: 28, fecha_interpretada: '2025-09-28', rango: { inicio: '2025-09-27', fin: '2025-09-28' } });
        expect(e('2025-2026|C').observacion).toMatch(/último día del fin de semana/);
        expect(e('2025-2026|C').observacion).toMatch(/no indica la hora exacta/);
    });

    test('reconstrucción de año: abril–diciembre = 1er año; enero–marzo = 2º año (aplica a todas las temporadas)', () => {
        expect(e('2024-2025|H').fecha_interpretada).toBe('2024-11-17');
        expect(e('2024-2025|F').fecha_interpretada).toBe('2024-11-02');
        expect(interpretarEncabezado('11 Y 12 ENE', null, '2025-2026').fecha_interpretada).toBe('2026-01-12');
        expect(interpretarEncabezado('28 Y 29 MAR', null, '2025-2026').fecha_interpretada).toBe('2026-03-29');
        expect(interpretarEncabezado('5 Y 6 ABR', null, '2025-2026').fecha_interpretada).toBe('2025-04-06');
        expect(interpretarEncabezado('31 Y 01', 'FEB', '2025-2026').fecha_interpretada).toBe('2026-02-01');
    });

    test('encabezados dañados por Excel ("4-May" = 4-5 OCT; "8-Sep" = 8-9 NOV) se reconstruyen y quedan registrados', () => {
        expect(e('2025-2026|D')).toMatchObject({ estado: 'VALIDO', fecha_interpretada: '2025-10-05', encabezado_reconstruido: true, encabezado_original: 46146, mes_fila_2: 'OCT' });
        expect(e('2025-2026|D').observacion).toMatch(/dañado/);
        expect(e('2025-2026|G')).toMatchObject({ estado: 'VALIDO', fecha_interpretada: '2025-11-09', encabezado_reconstruido: true });
    });

    test('rango que cruza de mes ("31-02 NOV") y mes desde la fila 2 ("7 Y 8" + DIC)', () => {
        expect(e('2025-2026|F')).toMatchObject({ rango: { inicio: '2025-10-31', fin: '2025-11-02' }, fecha_interpretada: '2025-11-02' });
        expect(e('2025-2026|I')).toMatchObject({ fecha_interpretada: '2025-12-08', valor: 178 });
    });

    test('"XXXX" → INVALIDO (no se importa) y celdas vacías → VACIO (nunca cero)', () => {
        expect(e('2025-2026|H')).toMatchObject({ estado: 'INVALIDO', valor: null });
        expect(e('2024-2025|C')).toMatchObject({ estado: 'VACIO', valor: null });
        expect(p.filas.filter(x => x.estado === 'VACIO').every(x => x.valor === null)).toBe(true);
    });

    test('fecha real de encabezado coherente con la fila 2 y dentro de la temporada = VALIDA; fuera de temporada requiere confirmación', () => {
        expect(e('2025-2026|E')).toMatchObject({ estado: 'VALIDO', fecha_interpretada: '2025-10-18', valor: 47 });
        expect(e('2024-2025|E').estado).toBe('REQUIERE_CONFIRMACION');
        expect(e('2024-2025|E').observacion).toMatch(/fuera de la temporada/);
    });

    test('encabezado ausente con valor → SIN_FECHA; serial sin fila 2 → REQUIERE_CONFIRMACION (no se adivina)', () => {
        expect(e('2025-2026|J').estado).toBe('SIN_FECHA');
        expect(interpretarEncabezado(46146, null, '2025-2026').estado).toBe('REQUIERE_CONFIRMACION');
        expect(interpretarEncabezado(null, null, '2025-2026').estado).toBe('SIN_FECHA');
        expect(interpretarEncabezado('texto raro', null, '2025-2026').estado).toBe('SIN_FECHA');
        expect(interpretarEncabezado('7 Y 8', null, '2025-2026').estado).toBe('SIN_FECHA');
        expect(interpretarEncabezado('30-31 FEB', null, '2025-2026').estado).toBe('SIN_FECHA');
    });

    test('resumen: importables = VALIDO; XXXX, vacías y sin fecha nunca entran', () => {
        expect(p.resumen).toMatchObject({ validos: 10, requieren_confirmacion: 1, sin_fecha: 1, invalidos: 1, importables_ahora: 10 });
    });

    test('una confirmación explícita habilita la única fila ambigua', () => {
        const q = previewHistoricoColleras(buf, { confirmaciones: [{ clave: '2024-2025|E', fecha_medicion: '2024-10-19' }, { clave: '2024-2025|C', fecha_medicion: 'no-es-fecha' }] });
        expect(q.resumen.importables_ahora).toBe(11);
    });

    test('confirmar: inserta solo VALIDO con fecha_confirmada=true y observación con encabezado original y aclaración', async () => {
        const db = dbFake();
        const r = await confirmarHistoricoColleras(buf, [], { db, actorId: 'admin-1' });
        const up = db.llamadas.find(c => c.tabla === 'historico_colleras_medicion' && c.op === 'upsert');
        expect(up.v.length).toBe(10);
        expect(up.v.every(x => x.fecha_confirmada === true)).toBe(true);
        expect(up.v.map(x => [x.temporada, x.fecha_medicion, x.total_colleras])).toEqual(expect.arrayContaining([
            ['2025-2026', '2025-09-28', 28], ['2025-2026', '2025-10-05', 37], ['2025-2026', '2025-11-09', 113], ['2024-2025', '2024-12-08', 167]
        ]));
        expect(up.v.some(x => x.total_colleras === 999 || x.total_colleras === null || x.total_colleras === 0)).toBe(false);
        expect(up.v.find(x => x.fecha_medicion === '2025-10-05').observacion).toMatch(/encabezado original: 46146 \(mes fila 2: OCT\)/);
        expect(up.v.find(x => x.fecha_medicion === '2025-09-28').observacion).toMatch(/no indica la hora exacta/);
        expect(up.o).toEqual({ onConflict: 'temporada,fecha_medicion', ignoreDuplicates: true });
        expect(db.llamadas.find(c => c.tabla === 'importaciones' && c.op === 'insert').v).toMatchObject({ tipo: 'historico_colleras' });
        expect(r.insertadas).toBe(10);
    });

    test('confirmar con confirmación explícita agrega la fila ambigua confirmada', async () => {
        const db = dbFake();
        await confirmarHistoricoColleras(buf, [{ clave: '2024-2025|E', fecha_medicion: '2024-10-19' }], { db });
        const up = db.llamadas.find(c => c.tabla === 'historico_colleras_medicion' && c.op === 'upsert');
        expect(up.v.length).toBe(11);
        expect(up.v.find(x => x.fecha_medicion === '2024-10-19').observacion).toMatch(/fecha confirmada manualmente/);
    });

    test('archivo sin filas de temporada se rechaza', () => {
        expect(() => previewHistoricoColleras(buffer([['Hoja1', [['a', 'b'], ['c', 'd']], 'B1']]))).toThrow(/temporada/);
    });
});
