const H = require('./historialDesignacionesUI');

const base = {
    rodeo: { id: 'R1', club: 'Club <b>X</b>', asociacion: 'Talagante', fecha: '2026-11-14', duracion_dias: 2, tipo_rodeo: 'Provincial', clasificacion: 'Provincial' },
    resumen: { jurado_propuesto_original: 'Jurado A', jurado_confirmado_admin: 'Jurado A', jurado_vigente: 'Jurado B' },
};
const ev = (tipo, extra = {}) => ({ id: tipo, tipo, etiqueta: tipo, origen: 'ADMINISTRADOR', fecha: '2026-11-13T21:30:00Z', responsable: 'Ana', ...extra });

describe('Línea de tiempo compartida (Rodeos / Propuesta / Reporte)', () => {
    test('sin cambios administrativos → mensaje institucional', () => {
        const html = H.hdRenderLineaTiempo({ ...base, eventos: [ev('MOTOR_PROPUESTA', { origen: 'MOTOR' }), ev('ESTADO_FINAL', { fecha: null, origen: 'SISTEMA' })] });
        expect(html).toContain('Se mantiene la propuesta original del motor. Sin modificaciones administrativas registradas.');
    });

    test('con reemplazo: muestra anterior → nuevo, motivo, responsable; sin mensaje de "sin cambios"', () => {
        const html = H.hdRenderLineaTiempo({ ...base, eventos: [
            ev('MOTOR_PROPUESTA', { origen: 'MOTOR' }),
            ev('REEMPLAZO', { jurado_anterior: { id: 'jA', nombre: 'Jurado A' }, jurado_nuevo: { id: 'jB', nombre: 'Jurado B' }, motivo: 'Enfermedad' }),
        ] });
        expect(html).toContain('<strong>Jurado A</strong> → <strong>Jurado B</strong>');
        expect(html).toContain('Motivo: Enfermedad');
        expect(html).not.toContain('Se mantiene la propuesta original');
    });

    test('evidencia faltante se muestra explícitamente; fechas de rodeo sin corrimiento; HTML escapado', () => {
        const html = H.hdRenderLineaTiempo({ ...base, eventos: [ev('ANULACION', { responsable: null, fecha: null })] });
        expect(html).toContain('Responsable: Sin información registrada');
        expect(html).toContain('Sin fecha registrada');
        expect(html).toContain('14/11/2026 (2 días)');
        expect(html).not.toContain('<b>X</b>');
    });

    test('propuesta alternativa no aplicada queda rotulada', () => {
        const html = H.hdRenderLineaTiempo({ ...base, eventos: [ev('MOTOR_PROPUESTA', { origen: 'MOTOR', propuesta_aplicada: false })] });
        expect(html).toContain('Propuesta no aplicada');
    });
});

// ── Categoría junto al nombre del jurado (solo presentación) ──
describe('Badge de categoría del jurado', () => {
    const fs = require('fs');
    const path = require('path');

    test('evento: badge inmediatamente a la derecha de cada nombre (anterior y nuevo)', () => {
        const html = H.hdRenderEvento(ev('REEMPLAZO', {
            jurado_anterior: { id: 'jA', nombre: 'Erik Saez', categoria: 'C', categoria_fuente: 'MOTOR', categoria_actual: 'C' },
            jurado_nuevo: { id: 'jB', nombre: 'Andrés Amor Alfaro', categoria: 'B', categoria_fuente: 'DESIGNACION', categoria_actual: 'B' },
        }));
        expect(html).toMatch(/<strong>Erik Saez<\/strong> <span class="hd-cat"[^>]*>Cat\. C<\/span> → <strong>Andrés Amor Alfaro<\/strong> <span class="hd-cat"[^>]*>Cat\. B<\/span>/);
        expect(html).toContain('title="Categoría registrada por el motor al generar la propuesta"');
        expect(html).toContain('title="Categoría aplicada al crear la designación"');
    });

    test('la categoría ACTUAL nunca se presenta como histórica; un cambio posterior se aclara', () => {
        expect(H.hdBadgeCategoria({ categoria: 'B', categoria_fuente: 'ACTUAL' })).toContain('>Cat. B · actual<');
        expect(H.hdBadgeCategoria({ categoria: 'C', categoria_fuente: 'MOTOR', categoria_actual: 'B' })).toContain('>Cat. C · hoy B<');
        // En una vista del estado presente puede omitirse el rótulo (el tooltip lo sigue explicando).
        const presente = H.hdBadgeCategoria({ categoria: 'B', categoria_fuente: 'ACTUAL' }, { marcarActual: false });
        expect(presente).toContain('>Cat. B<');
        expect(presente).toContain('Categoría actual del jurado');
    });

    test('sin categoría registrada → "Sin categoría"; respuesta sin el dato → sin badge (no se inventa)', () => {
        expect(H.hdBadgeCategoria({ categoria: null, categoria_fuente: null })).toContain('>Sin categoría<');
        expect(H.hdJuradoConCategoria({ id: 'jA', nombre: 'Jurado A' })).toBe('<strong>Jurado A</strong>');
        expect(H.hdBadgeCategoria(null)).toBe('');
    });

    test('resumen: propuesto, confirmado (con nota) y vigente con su categoría; textos sin jurado intactos', () => {
        const s = {
            jurado_propuesto_original: 'Erik Saez', jurado_propuesto_original_jurado: { id: 'j1', nombre: 'Erik Saez', categoria: 'C', categoria_fuente: 'MOTOR' },
            jurado_confirmado_admin: 'Andrés Amor Alfaro (modificado)', jurado_confirmado_admin_jurado: { id: 'j2', nombre: 'Andrés Amor Alfaro', categoria: 'B', categoria_fuente: 'DESIGNACION' }, jurado_confirmado_admin_nota: '(modificado)',
            jurado_vigente: 'Andrés Amor Alfaro', jurado_vigente_jurados: [{ id: 'j2', nombre: 'Andrés Amor Alfaro', categoria: 'B', categoria_fuente: 'DESIGNACION' }],
        };
        const html = H.hdRenderLineaTiempo({ ...base, resumen: s, eventos: [] });
        expect(html).toMatch(/<strong>Erik Saez<\/strong> <span class="hd-cat"[^>]*>Cat\. C<\/span>/);
        expect(html).toMatch(/<strong>Andrés Amor Alfaro<\/strong> <span class="hd-cat"[^>]*>Cat\. B<\/span> <strong>\(modificado\)<\/strong>/);
        expect(H.hdResumenConfirmado({ jurado_confirmado_admin: 'Sin confirmación individual registrada', jurado_confirmado_admin_jurado: null }, { negrita: false }))
            .toBe('Sin confirmación individual registrada');
        expect(H.hdResumenPropuesto(s, { negrita: false })).toMatch(/^Erik Saez <span class="hd-cat"/);
    });

    test('badge escapa el contenido', () => {
        expect(H.hdBadgeCategoria({ categoria: '<b>X</b>', categoria_fuente: 'ACTUAL' })).not.toContain('<b>X</b>');
    });

    test('propuesta-designacion.html: tarjeta, sustitución, "motor propuso", modal y V1 usan el mismo badge', () => {
        const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'propuesta-designacion.html'), 'utf8');
        expect(html).toContain('${sanitizar(j.nombre || \'—\')}${badgeCatFila(d, catEfectivoFila(d))}</div>');
        expect(html).toContain("${d.nombre_propuesto ? badgeCatFila(d, d.categoria_propuesto) : ''} · seleccionado:");
        expect(html).toContain('Motor propuso originalmente: <strong>${d.nombre_propuesto ? sanitizar(d.nombre_propuesto) : \'—\'}</strong>${d.nombre_propuesto ? badgeCatFila(d, d.categoria_propuesto) : \'\'}');
        expect(html).toContain('hdBadgeCategoria(h.categorias?.v1)');
        // Funciones reales extraídas del HTML.
        const bloque = html.slice(html.indexOf('function badgeCatFila'), html.indexOf('function renderFilaDetallePropuesta'));
        const { badgeCatFila, catEfectivoFila } = new Function('hdBadgeCategoria', bloque + '; return { badgeCatFila, catEfectivoFila };')(H.hdBadgeCategoria);
        // Borrador vivo: la categoría vigente sin rótulo; fila ya aplicada: se rotula "actual".
        const fila = { jurado_efectivo: { id: 'j1', categoria: 'B' } };
        expect(badgeCatFila(fila, catEfectivoFila(fila))).toContain('>Cat. B<');
        expect(badgeCatFila({ ...fila, aplicacion_real: { aplicada: true } }, catEfectivoFila(fila))).toContain('>Cat. B · actual<');
        // Snapshot del backend tiene prioridad sobre la categoría actual.
        expect(catEfectivoFila({ ...fila, categoria_efectivo: { categoria: 'C', categoria_fuente: 'DESIGNACION', categoria_actual: 'B' } })).toEqual({ categoria: 'C', categoria_fuente: 'DESIGNACION', categoria_actual: 'B' });
        expect(catEfectivoFila({ jurado_efectivo: null })).toBeNull();
    });
});
