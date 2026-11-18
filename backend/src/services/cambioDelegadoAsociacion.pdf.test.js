// Cambio de Delegado de Asociación — el PDF que se genera DESPUÉS del cambio
// (GET /admin/cartillas-delegado/:id/pdf y el del portal institucional usan
// la fila viva de cartillas_delegado) muestra al NUEVO Delegado Oficial,
// porque el generador lee cartilla.delegado_nombre, que la RPC 069
// actualiza. Se genera un PDF real y se extrae su texto visible.
const zlib = require('zlib');
jest.setTimeout(60000);
const { generarCartillaDelegadoPDF } = require('./cartilla-delegado-pdf');

function textoVisiblePDF(buffer) {
    const txt = buffer.toString('latin1');
    const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m, salida = '';
    while ((m = streamRe.exec(txt))) {
        let contenido;
        try { contenido = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (e) { continue; }
        const tokenRe = /<([0-9A-Fa-f]+)>/g;
        let t;
        while ((t = tokenRe.exec(contenido))) {
            for (let i = 0; i < t[1].length; i += 2) salida += String.fromCharCode(parseInt(t[1].substr(i, 2), 16));
        }
        salida += '\n';
    }
    return salida;
}

const RODEO = { id: 'rodeo-1', club: 'VALPARAISO', asociacion: 'VALPARAISO', fecha: '2026-11-14', tipo_rodeo_nombre: 'Provincial' };
const BASE = {
    id: 'cart-1', rodeo_id: 'rodeo-1', estado: 'borrador', version: 8, delegado_asociacion_id: 'del-nuevo',
    temporada: '2026-2027', fecha_rodeo: '2026-11-14', respuestas_json: {}
};

test('tras el cambio, el PDF muestra al nuevo Delegado Oficial y no al anterior', async () => {
    const buffer = await generarCartillaDelegadoPDF({ ...BASE, delegado_nombre: 'Pedro Soto' }, RODEO, {
        historialResponsables: [
            { accion: 'reemplazar_responsable_institucional', created_at: '2026-11-17T10:00:00Z', descripcion: 'Reemplazo de responsable autorizado — motivo: error de la asociacion' }
        ]
    });
    const texto = textoVisiblePDF(buffer);
    expect(texto).toContain('Pedro Soto');
    expect(texto).not.toContain('Pablo Bijit');
    expect(texto).toContain('HISTORIAL DE RESPONSABLES DE LA CARTILLA');
});
