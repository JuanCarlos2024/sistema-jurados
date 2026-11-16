// ═════════════════════════════════════════════════════════════════════════
// Importación de Control de Gestión — columnas OPCIONALES de resultados de
// la Serie de Campeones ("1° / 2° / 3° lugar puntaje").
//
// Excel REALES construidos con el mismo paquete `xlsx` del servicio y un
// Supabase EN MEMORIA que aplica los filtros de verdad (supabaseMemoria):
// se verifica qué se lee, a qué rodeo se vincula, qué se consulta y qué se
// escribe. La RPC de la migración 101 se prueba aparte contra Postgres real
// (resultadosSerieCampeones.rpc.test.js); aquí se registra su invocación.
// ═════════════════════════════════════════════════════════════════════════
const XLSX = require('xlsx');
const { crearSupabaseMemoria } = require('./__fixtures__/supabaseMemoria');

jest.mock('../config/supabase', () => ({
    from: (...a) => global.__sb.from(...a),
    rpc: (...a) => global.__sb.rpc(...a)
}));

const {
    parsearWorkbook, generarPreview, confirmarImportacion,
    validarPuntajeSerie, compararResultadosSerie
} = require('./controlGestion');

const R1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const R2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const R_ANULADO = 'aaaaaaaa-0000-4000-8000-000000000003';
const R_INEXISTENTE = 'aaaaaaaa-0000-4000-8000-0000000000ff';

const RODEOS = () => ([
    { id: R1, club: 'SAN CARLOS', asociacion: 'ÑUBLE', fecha: '2026-09-18', estado: 'activo' },
    { id: R2, club: 'CURICO', asociacion: 'MAULE', fecha: '2026-09-19', estado: 'activo' },
    { id: R_ANULADO, club: 'PUCON', asociacion: 'CAUTIN', fecha: '2026-09-20', estado: 'anulado' }
]);

const FILA_BASE = {
    'Versión formato': 'CG-1.0', 'Rodeo ID': R1, 'Fecha rodeo': '18/09/2026',
    'Club': 'SAN CARLOS', 'Asociación': 'ÑUBLE', 'Jurado Oficial': 'JUAN PEREZ',
    'Clave de vinculación': 'CLV-1', 'N° situaciones': 1, 'Categorías': 'Servicios básicos',
    'Resumen breve monitor': 'Corte de energía.',
    'Texto comentario monitor': 'Rodeo: SAN CARLOS - ÑUBLE; Fecha: 18/09/2026\nComentario del monitor: Corte de energía.',
    'IDs situaciones': 'SIT-001', 'Estado vinculación': 'Vinculado al reporte', 'Importar': 'Sí'
};
const FILA_R2 = { ...FILA_BASE, 'Rodeo ID': R2, 'Fecha rodeo': '19/09/2026', 'Club': 'CURICO', 'Asociación': 'MAULE', 'IDs situaciones': 'SIT-002', 'Texto comentario monitor': 'Rodeo: CURICO' };
const SIT = (id, extra = {}) => ({
    'ID Situación': id, 'Fecha situación': '18/09/2026', 'Hora': '10:30', 'Fecha rodeo': '', 'Club': '', 'Asociación': '',
    'Jurado chat': 'Juan', 'Jurado oficial': '', 'Área': 'Servicios', 'Categoría principal': 'Servicios básicos',
    'Subcategoría': 'Energía', 'Impacto': 'Alto', 'Descripción unificada': 'Corte de energía.',
    'Estado / resultado': 'Reanudado', 'Incluir en comentario': 'Sí', 'Vinculación': 'Vinculado al reporte',
    'Confianza': 'Alta', 'Líneas chat': '[10:30] Juan: se cortó la luz', 'Clave de vinculación': 'CLV-1',
    'Evidencia textual': `se cortó la luz ${id}`, ...extra
});
const SITUACIONES = [SIT('SIT-001'), SIT('SIT-002', { 'Fecha situación': '19/09/2026' })];

const con = (fila, p1, p2, p3) => ({ ...fila, '1° lugar puntaje': p1, '2° lugar puntaje': p2, '3° lugar puntaje': p3 });

// Construye un .xlsx real. `alterar(hoja)` permite fijar celdas con tipo
// específico (fórmula, fecha, número) tal como las dejaría Excel.
function buffer(filas, { alterar, situaciones = SITUACIONES } = {}) {
    const wb = XLSX.utils.book_new();
    const hoja = XLSX.utils.json_to_sheet(filas);
    if (alterar) alterar(hoja);
    XLSX.utils.book_append_sheet(wb, hoja, 'Importación sistema');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(situaciones), 'Situaciones detectadas');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function montar({ datosMonitor = [], rpcResultados } = {}) {
    const llamadasRpc = [];
    const sb = crearSupabaseMemoria({
        tablas: { rodeos: RODEOS(), datos_monitor_rodeo: datosMonitor, importaciones: [], control_gestion_situaciones: [] },
        rpc: {
            confirmar_control_gestion_rodeo: (args) => {
                llamadasRpc.push({ nombre: 'confirmar_control_gestion_rodeo', args });
                return { data: { comentario_actualizado: true, situaciones_insertadas: (args.p_situaciones || []).length, situaciones_duplicadas: 0, sin_novedad: false }, error: null };
            },
            aplicar_resultados_serie_campeones_rodeo: (args) => {
                llamadasRpc.push({ nombre: 'aplicar_resultados_serie_campeones_rodeo', args });
                if (rpcResultados) return rpcResultados(args);
                return { data: { cambio: true, lugares: args.p_puntajes.map((v, i) => ({ lugar: i + 1, estado: v === null ? 'no_informado' : 'importado', anterior: null, excel: v, final: v })) }, error: null };
            }
        }
    });
    global.__sb = sb;
    const consultas = (tabla) => sb.calls.filter(c => c.tabla === tabla);
    return { sb, llamadasRpc, consultas, rpcResultados: () => llamadasRpc.filter(l => l.nombre === 'aplicar_resultados_serie_campeones_rodeo') };
}

// ─────────────────────────────────────────────────────────────────────────
describe('1. Compatibilidad CG-1.0 — Excel SIN las columnas nuevas', () => {
    test('preview idéntico al de siempre + resultados "sin_columnas", sin consultas adicionales', async () => {
        const { consultas } = montar();
        const { filas, resumen } = await generarPreview(buffer([FILA_BASE]));
        expect(filas[0].estado).toBe('ok');
        expect(filas[0].comentario_nuevo).toBe(FILA_BASE['Texto comentario monitor']);
        expect(resumen).toMatchObject({ total_filas: 1, importables: 1, omitidas_por_filtro: 0, con_advertencia: 0, con_error: 0 });
        expect(filas[0].resultados_serie).toMatchObject({ estado: 'sin_columnas', columnas_presentes: false, accion_sugerida: 'omitir' });
        expect(resumen.resultados_serie.columnas_presentes).toBe(false);
        // Solo las consultas del flujo de siempre: 1 rodeo (matching) + 1 comentario actual.
        expect(consultas('rodeos')).toHaveLength(1);
        expect(consultas('datos_monitor_rodeo')).toHaveLength(1);
    });

    test('confirmar: mismos contadores de siempre y la RPC de resultados NUNCA se invoca', async () => {
        const { llamadasRpc } = montar();
        const r = await confirmarImportacion(buffer([FILA_BASE]), [{ fila_index: 0, accion: 'reemplazar' }], 'cg.xlsx', 'admin-1');
        expect(r).toMatchObject({ procesados: 1, exitosos: 1, omitidos: 0, errores: 0, duplicados: 0 });
        expect(llamadasRpc.map(l => l.nombre)).toEqual(['confirmar_control_gestion_rodeo']);
        expect(r.resultados_serie.columnas_presentes).toBe(false);
        expect(r.resultados_serie.rodeos_procesados).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('2. Lectura de las columnas (valores como TEXTO)', () => {
    test('desempates del pedido se leen exactos; vacío = no informado (nunca 0)', () => {
        const { resultadosSerie, columnasResultados } = parsearWorkbook(buffer([
            con(FILA_BASE, '27+8', '27-1', '30+12'),
            con(FILA_R2, '22+5+3', '', '24+8')
        ]));
        expect(columnasResultados.presentes).toBe(true);
        expect(resultadosSerie[0]).toEqual({ columnas_presentes: true, valores: ['27+8', '27-1', '30+12'], errores: [] });
        expect(resultadosSerie[1]).toEqual({ columnas_presentes: true, valores: ['22+5+3', null, '24+8'], errores: [] });
    });

    test('celda numérica entera 27 -> "27" (texto); espacios se eliminan', () => {
        const { resultadosSerie } = parsearWorkbook(buffer([con(FILA_BASE, 27, ' 24 + 8 ', '   ')]));
        expect(resultadosSerie[0].valores).toEqual(['27', '24+8', null]);
        expect(typeof resultadosSerie[0].valores[0]).toBe('string');
    });

    test('fórmula (=27+8 -> 35) y fecha (27-1 -> 27/ene) de Excel se RECHAZAN, nunca se guardan', () => {
        const { resultadosSerie } = parsearWorkbook(buffer([con(FILA_BASE, '', '', '')], {
            alterar: (h) => {
                const cols = XLSX.utils.sheet_to_json(h, { header: 1 })[0];
                const c1 = cols.indexOf('1° lugar puntaje'); const c2 = cols.indexOf('2° lugar puntaje');
                h[XLSX.utils.encode_cell({ r: 1, c: c1 })] = { t: 'n', v: 35, f: '27+8' };
                h[XLSX.utils.encode_cell({ r: 1, c: c2 })] = { t: 'd', v: new Date(2026, 0, 27) };
            }
        }));
        expect(resultadosSerie[0].valores).toEqual([null, null, null]);
        expect(resultadosSerie[0].errores.join(' ')).toMatch(/1° lugar puntaje: la celda contiene una fórmula/);
        expect(resultadosSerie[0].errores.join(' ')).toMatch(/2° lugar puntaje: Excel interpretó el valor como fecha/);
    });

    test.each([['abc'], ['27.5'], ['27++8'], ['+8'], ['27 lugar']])('formato inválido %p -> error de la fila', (v) => {
        const { resultadosSerie } = parsearWorkbook(buffer([con(FILA_BASE, v, '', '')]));
        expect(resultadosSerie[0].errores[0]).toMatch(/no tiene formato de puntaje/);
    });

    test('encabezados tolerantes: "1º" (ordinal), mayúsculas, sin tildes; columnas parciales', () => {
        const fila = { ...FILA_BASE, '1º LUGAR PUNTAJE': '27+8', '3er lugar puntaje': '20' };
        const { resultadosSerie, columnasResultados } = parsearWorkbook(buffer([fila]));
        expect(columnasResultados.columnas[2]).toBeNull();
        expect(resultadosSerie[0].valores).toEqual(['27+8', null, '20']);
    });

    test('columna duplicada (1° escrito dos veces) -> resultados en error, nunca se elige una', () => {
        const fila = { ...FILA_BASE, '1° lugar puntaje': '27', '1º lugar puntaje': '28' };
        const { resultadosSerie } = parsearWorkbook(buffer([fila]));
        expect(resultadosSerie[0].valores).toEqual([null, null, null]);
        expect(resultadosSerie[0].errores[0]).toMatch(/duplicada/);
    });

    test('filas en blanco intermedias: cada fila lee SUS celdas (no se desplazan)', () => {
        const { resultadosSerie, filasImportacion } = parsearWorkbook(buffer([con(FILA_BASE, '27', '', ''), con(FILA_R2, '19+3', '', '')], {
            alterar: (h) => {
                // inserta una fila vacía entre ambas moviendo la 3ª fila a la 4ª
                const rango = XLSX.utils.decode_range(h['!ref']);
                for (let c = rango.s.c; c <= rango.e.c; c++) {
                    const de = XLSX.utils.encode_cell({ r: 2, c }); const a = XLSX.utils.encode_cell({ r: 3, c });
                    if (h[de]) { h[a] = h[de]; delete h[de]; }
                }
                rango.e.r = 3; h['!ref'] = XLSX.utils.encode_range(rango);
            }
        }));
        expect(filasImportacion.map(f => f['Rodeo ID'])).toEqual([R1, R2]);
        expect(resultadosSerie.map(r => r.valores[0])).toEqual(['27', '19+3']);
    });

    test('validarPuntajeSerie / compararResultadosSerie (puras)', () => {
        expect(validarPuntajeSerie('')).toEqual({ valor: null, error: null });
        expect(validarPuntajeSerie('0').valor).toBe('0');
        expect(compararResultadosSerie(['27+8', null, '20'], ['27 + 8', '25', '19'])
            .map(l => l.comparacion)).toEqual(['igual', 'no_informado', 'conflicto']);
        expect(compararResultadosSerie(['27', '26', '25'], [null, '', null]).map(l => l.comparacion)).toEqual(['nuevo', 'nuevo', 'nuevo']);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('3. Vinculación EXCLUSIVA por Rodeo ID', () => {
    test('Rodeo ID inexistente -> "rodeo_no_encontrado", no se asigna a otro rodeo aunque Club/Fecha coincidan', async () => {
        const { consultas } = montar();
        const fila = con({ ...FILA_BASE, 'Rodeo ID': R_INEXISTENTE }, '27', '', '');
        const { filas, resumen } = await generarPreview(buffer([fila]));
        expect(filas[0].resultados_serie.estado).toBe('rodeo_no_encontrado');
        expect(filas[0].resultados_serie.rodeo_id).toBeNull();
        expect(resumen.resultados_serie.rodeo_id_no_encontrados).toBe(1);
        // Nunca se buscó por fecha/club (fallback): solo por id.
        expect(consultas('rodeos').every(c => c.filtros.every(f => /id/.test(JSON.stringify(f))))).toBe(true);
    });

    test('Sin Rodeo ID -> "sin_rodeo_id" aunque exista un rodeo con mismo Club/Asociación/Fecha', async () => {
        const { rpcResultados } = montar();
        const fila = con({ ...FILA_BASE, 'Rodeo ID': '', 'Jurado Oficial': '' }, '27', '', '');
        const { filas } = await generarPreview(buffer([fila]));
        // El flujo de comentario sigue usando su respaldo de siempre (sin cambios)...
        expect(filas[0].rodeo_id_resuelto).toBe(R1);
        // ...pero los resultados NO se vinculan sin Rodeo ID.
        expect(filas[0].resultados_serie.estado).toBe('sin_rodeo_id');
        const r = await confirmarImportacion(buffer([fila]), [{ fila_index: 0, accion: 'omitir', accion_resultados: 'completar' }], 'cg.xlsx', 'admin-1');
        expect(rpcResultados()).toHaveLength(0);
        expect(r.resultados_serie.sin_rodeo_id).toBe(1);
    });

    test('Rodeo ID con formato inválido -> no encontrado sin consultar la base', async () => {
        const { consultas } = montar();
        const { filas } = await generarPreview(buffer([con({ ...FILA_BASE, 'Rodeo ID': 'R-123', 'Importar': 'No' }, '27', '', '')]));
        expect(filas[0].resultados_serie.estado).toBe('rodeo_no_encontrado');
        expect(consultas('rodeos')).toHaveLength(0);
    });

    test('Rodeo ID existe pero Fecha/Club no coinciden -> advertencia, no aplicable', async () => {
        montar();
        const { filas } = await generarPreview(buffer([con({ ...FILA_BASE, 'Club': 'OTRO CLUB' }, '27', '', '')]));
        expect(filas[0].resultados_serie.estado).toBe('advertencia');
        expect(filas[0].resultados_serie.accion_sugerida).toBe('omitir');
    });

    test('Rodeo anulado -> error', async () => {
        montar();
        const fila = con({ ...FILA_BASE, 'Rodeo ID': R_ANULADO, 'Club': 'PUCON', 'Asociación': 'CAUTIN', 'Fecha rodeo': '20/09/2026' }, '27', '', '');
        const { filas } = await generarPreview(buffer([fila]));
        expect(filas[0].resultados_serie.estado).toBe('error');
        expect(filas[0].resultados_serie.errores[0]).toMatch(/anulado/);
    });

    test('mismo Rodeo ID en 2 filas: idénticos -> se aplica una vez; distintos -> ninguno', async () => {
        const { rpcResultados } = montar();
        const iguales = [con(FILA_BASE, '27', '', ''), con({ ...FILA_BASE, 'Importar': 'No' }, '27', '', '')];
        const p1 = await generarPreview(buffer(iguales));
        expect(p1.filas.map(f => f.resultados_serie.estado)).toEqual(['listo', 'duplicada']);
        await confirmarImportacion(buffer(iguales), [{ fila_index: 0, accion: 'omitir', accion_resultados: 'completar' }, { fila_index: 1, accion: 'omitir', accion_resultados: 'completar' }], 'cg.xlsx', 'admin-1');
        expect(rpcResultados()).toHaveLength(1);

        const distintos = [con(FILA_BASE, '27', '', ''), con({ ...FILA_BASE, 'Importar': 'No' }, '28', '', '')];
        const p2 = await generarPreview(buffer(distintos));
        expect(p2.filas.map(f => f.resultados_serie.estado)).toEqual(['error', 'error']);
        expect(p2.filas[0].resultados_serie.errores[0]).toMatch(/resultados distintos/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('4. Independencia del flujo de situaciones / comentario', () => {
    test('fila con Importar="No" (omitida por filtro) igual ofrece sus resultados; comentario/situaciones siguen omitidos', async () => {
        const { llamadasRpc } = montar();
        const fila = con({ ...FILA_BASE, 'Importar': 'No' }, '27+8', '', '');
        const { filas } = await generarPreview(buffer([fila]));
        expect(filas[0].estado).toBe('omitida_por_filtro');
        expect(filas[0].resultados_serie.estado).toBe('listo');
        const r = await confirmarImportacion(buffer([fila]), [{ fila_index: 0, accion: 'omitir', accion_resultados: 'completar' }], 'cg.xlsx', 'admin-1');
        expect(r.omitidos).toBe(1);
        expect(llamadasRpc.map(l => l.nombre)).toEqual(['aplicar_resultados_serie_campeones_rodeo']);
        expect(r.resultados_serie.importados_1).toBe(1);
    });

    test('los resultados NO generan situaciones: p_situaciones de la RPC de CG es exactamente la de antes', async () => {
        const { llamadasRpc, consultas } = montar();
        const r = await confirmarImportacion(buffer([con(FILA_BASE, '27', '26', '25')]),
            [{ fila_index: 0, accion: 'reemplazar', accion_resultados: 'completar' }], 'cg.xlsx', 'admin-1');
        const cg = llamadasRpc.find(l => l.nombre === 'confirmar_control_gestion_rodeo');
        expect(cg.args.p_situaciones.map(s => s.id_situacion_excel)).toEqual(['SIT-001']);
        expect(JSON.stringify(cg.args)).not.toMatch(/lugar puntaje|27\b.*26\b.*25\b/);
        expect(r.situaciones_insertadas).toBe(1);
        expect(consultas('control_gestion_situaciones').filter(c => c.op !== 'select')).toHaveLength(0);
    });

    test('N° situaciones / IDs / Estado vinculación: un error de situaciones no cambia por tener resultados', async () => {
        montar();
        const fila = con({ ...FILA_BASE, 'N° situaciones': 2 }, '27', '', ''); // declara 2 pero lista 1 ID
        const { filas } = await generarPreview(buffer([fila]));
        expect(filas[0].estado).toBe('error');
        expect(filas[0].errores.join(' ')).toMatch(/N° situaciones \(2\) no coincide/);
        expect(filas[0].resultados_serie.estado).toBe('listo');
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('5. Resultados ya registrados — previsualización y decisión explícita', () => {
    const DM = () => [{ rodeo_id: R1, puntaje_oficial_1er: '27+8', puntaje_oficial_2do: '25', puntaje_oficial_3er: null, comentario_monitor: 'manual' }];

    test('preview muestra valores existentes y del Excel; conflicto sugiere CONSERVAR (nunca reemplazar)', async () => {
        montar({ datosMonitor: DM() });
        const { filas, resumen } = await generarPreview(buffer([con(FILA_BASE, '27 + 8', '26', '22')]));
        const rs = filas[0].resultados_serie;
        expect(rs.estado).toBe('conflicto');
        expect(rs.lugares).toEqual([
            { lugar: 1, excel: '27+8', actual: '27+8', comparacion: 'igual' },
            { lugar: 2, excel: '26', actual: '25', comparacion: 'conflicto' },
            { lugar: 3, excel: '22', actual: null, comparacion: 'nuevo' }
        ]);
        expect(rs.accion_sugerida).toBe('completar');
        expect(resumen.resultados_serie).toMatchObject({ conflictos: 1, filas_con_resultados: 1 });
    });

    test('preview no escribe nada', async () => {
        const { sb } = montar({ datosMonitor: DM() });
        await generarPreview(buffer([con(FILA_BASE, '28', '26', '22')]));
        expect(sb.calls.filter(c => c.op !== 'select' && c.op !== 'rpc')).toHaveLength(0);
        expect(sb.calls.filter(c => c.op === 'rpc')).toHaveLength(0);
    });

    test('reemplazar envía a la RPC los valores que el administrador vio; completar no', async () => {
        const { rpcResultados } = montar({ datosMonitor: DM() });
        await confirmarImportacion(buffer([con(FILA_BASE, '28', '26', '22')]), [{
            fila_index: 0, accion: 'omitir', accion_resultados: 'reemplazar', resultados_actuales_vistos: ['27+8', '25', null]
        }], 'cg.xlsx', 'admin-1');
        expect(rpcResultados()[0].args).toMatchObject({
            p_rodeo_id: R1, p_puntajes: ['28', '26', '22'], p_reemplazar: true,
            p_esperados: ['27+8', '25', null], p_actor_id: 'admin-1', p_importacion_id: expect.any(String)
        });

        const m2 = montar({ datosMonitor: DM() });
        await confirmarImportacion(buffer([con(FILA_BASE, '28', '26', '22')]), [{ fila_index: 0, accion: 'omitir', accion_resultados: 'completar' }], 'cg.xlsx', 'admin-1');
        expect(m2.rpcResultados()[0].args).toMatchObject({ p_reemplazar: false, p_esperados: null });
    });

    test('sin decisión de resultados = omitir (seguro por defecto)', async () => {
        const { rpcResultados } = montar();
        const r = await confirmarImportacion(buffer([con(FILA_BASE, '27', '', '')]), [{ fila_index: 0, accion: 'agregar' }], 'cg.xlsx', 'admin-1');
        expect(rpcResultados()).toHaveLength(0);
        expect(r.resultados_serie.omitidos_por_usuario).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────
describe('6. Informe final (punto 14 del pedido)', () => {
    test('contadores por lugar, sin resultados, conflictos y Rodeo ID no encontrados', async () => {
        const { sb } = montar({
            datosMonitor: [{ rodeo_id: R2, puntaje_oficial_1er: '19', puntaje_oficial_2do: null, puntaje_oficial_3er: null }],
            rpcResultados: (a) => a.p_rodeo_id === R1
                ? { data: { cambio: true, lugares: [
                    { lugar: 1, estado: 'importado', anterior: null, excel: '27+8', final: '27+8' },
                    { lugar: 2, estado: 'importado', anterior: null, excel: '27-1', final: '27-1' },
                    { lugar: 3, estado: 'no_informado', anterior: null, excel: null, final: null }] }, error: null }
                : { data: { cambio: true, lugares: [
                    { lugar: 1, estado: 'conflicto_conservado', anterior: '19', excel: '20', final: '19' },
                    { lugar: 2, estado: 'importado', anterior: null, excel: '18', final: '18' },
                    { lugar: 3, estado: 'importado', anterior: null, excel: '17', final: '17' }] }, error: null }
        });
        const filas = [
            con(FILA_BASE, '27+8', '27-1', ''),
            con(FILA_R2, '20', '18', '17'),
            con({ ...FILA_BASE, 'Rodeo ID': R_INEXISTENTE, 'Importar': 'No' }, '30', '', ''),
            con({ ...FILA_BASE, 'Importar': 'No', 'Rodeo ID': R2, 'Club': 'CURICO', 'Asociación': 'MAULE', 'Fecha rodeo': '19/09/2026' }, '', '', '')
        ];
        const r = await confirmarImportacion(buffer(filas), [
            { fila_index: 0, accion: 'reemplazar', accion_resultados: 'completar' },
            { fila_index: 1, accion: 'reemplazar', accion_resultados: 'completar' },
            { fila_index: 2, accion: 'omitir', accion_resultados: 'completar' }
        ], 'cg.xlsx', 'admin-1');
        expect(r.resultados_serie).toMatchObject({
            columnas_presentes: true, rodeos_procesados: 2,
            importados_1: 1, importados_2: 2, importados_3: 1,
            rodeos_sin_resultados: 1, conflictos: 1, conflictos_conservados: 1,
            rodeo_id_no_encontrados: 1, con_error: 0
        });
        // el flujo de comentario conserva sus propios contadores
        expect(r).toMatchObject({ procesados: 4, exitosos: 2, omitidos: 2, errores: 0 });
        expect(sb.calls.filter(c => c.tabla === 'datos_monitor_rodeo' && c.op !== 'select')).toHaveLength(0); // solo vía RPC
    });

    test('RPC ausente (migración 101 sin aplicar) -> error claro por fila, el resto de la importación sigue', async () => {
        montar({ rpcResultados: () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) });
        const r = await confirmarImportacion(buffer([con(FILA_BASE, '27', '', '')]),
            [{ fila_index: 0, accion: 'reemplazar', accion_resultados: 'completar' }], 'cg.xlsx', 'admin-1');
        expect(r.exitosos).toBe(1);
        expect(r.resultados_serie.con_error).toBe(1);
        expect(r.resultados_serie.detalle[0].errores[0]).toMatch(/migración 101/);
    });

    test('rodeo eliminado entre previsualización y confirmación -> cuenta como Rodeo ID no encontrado', async () => {
        montar({ rpcResultados: () => ({ data: null, error: { code: 'P0001', message: 'RODEO_NO_ENCONTRADO' } }) });
        const r = await confirmarImportacion(buffer([con({ ...FILA_BASE, 'Importar': 'No' }, '27', '', '')]),
            [{ fila_index: 0, accion: 'omitir', accion_resultados: 'completar' }], 'cg.xlsx', 'admin-1');
        expect(r.resultados_serie.rodeo_id_no_encontrados).toBe(1);
        expect(r.resultados_serie.rodeos_procesados).toBe(0);
    });
});
