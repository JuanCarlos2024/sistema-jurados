const { firmarPreview, verificarPreviewToken, mapaPorRodeo } = require('./previewIntegridad');

const snapshotEjemplo = {
    temporada_id: 't1',
    rodeos: [
        { rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' },
        { rodeo_id: 'r2', estado: 'SIN_PROPUESTA', jurado_id_propuesto: null },
        { rodeo_id: 'r3', estado: 'NO_EVALUABLE', jurado_id_propuesto: null }
    ]
};

describe('firmarPreview / verificarPreviewToken', () => {
    test('un token recién firmado se verifica correctamente y devuelve el mismo snapshot', () => {
        const token = firmarPreview(snapshotEjemplo);
        expect(typeof token).toBe('string');
        expect(token).toContain('.');
        const verificado = verificarPreviewToken(token);
        expect(verificado).not.toBeNull();
        expect(verificado.temporada_id).toBe('t1');
        expect(verificado.rodeos).toEqual(snapshotEjemplo.rodeos);
    });

    // TEST 6 de la revisión: firma de longitud DISTINTA a la esperada — el
    // camino que ejercita explícitamente el chequeo de largo previo a
    // timingSafeEqual (que lanza si los buffers no miden lo mismo). Debe
    // rechazarse de forma controlada, nunca una excepción sin capturar.
    test('TEST 6: firma de longitud inválida (más corta) → rechazo controlado, sin excepción', () => {
        const token = firmarPreview(snapshotEjemplo);
        const idx = token.lastIndexOf('.');
        const tokenFirmaCorta = token.slice(0, idx) + '.' + 'ab12';
        expect(() => verificarPreviewToken(tokenFirmaCorta)).not.toThrow();
        expect(verificarPreviewToken(tokenFirmaCorta)).toBeNull();
    });

    test('TEST 6b: firma de longitud inválida (más larga) → rechazo controlado, sin excepción', () => {
        const token = firmarPreview(snapshotEjemplo);
        const idx = token.lastIndexOf('.');
        const tokenFirmaLarga = token.slice(0, idx) + '.' + 'f'.repeat(200);
        expect(() => verificarPreviewToken(tokenFirmaLarga)).not.toThrow();
        expect(verificarPreviewToken(tokenFirmaLarga)).toBeNull();
    });

    // TEST G del pedido: firma/token modificado → rechazado
    test('TEST G: alterar la firma (último segmento, misma longitud) → rechazado', () => {
        const token = firmarPreview(snapshotEjemplo);
        const idx = token.lastIndexOf('.');
        const tokenAlterado = token.slice(0, idx) + '.' + 'f'.repeat(64);
        expect(verificarPreviewToken(tokenAlterado)).toBeNull();
    });

    // TEST H del pedido: jurado_id_propuesto alterado por el frontend → no se acepta
    test('TEST H: alterar jurado_id_propuesto dentro del payload (sin recalcular firma) → rechazado', () => {
        const token = firmarPreview(snapshotEjemplo);
        const idx = token.lastIndexOf('.');
        const payload = JSON.parse(Buffer.from(token.slice(0, idx), 'base64url').toString('utf8'));
        payload.rodeos[0].jurado_id_propuesto = 'j-otro-jurado-que-el-admin-quiere-hacer-pasar-por-original';
        const payloadAlterado = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const tokenAlterado = payloadAlterado + '.' + token.slice(idx + 1); // firma vieja, payload nuevo
        expect(verificarPreviewToken(tokenAlterado)).toBeNull();
    });

    test('alterar el estado de un rodeo (PROPUESTO → SIN_PROPUESTA) sin refirmar → rechazado', () => {
        const token = firmarPreview(snapshotEjemplo);
        const idx = token.lastIndexOf('.');
        const payload = JSON.parse(Buffer.from(token.slice(0, idx), 'base64url').toString('utf8'));
        payload.rodeos[1].estado = 'PROPUESTO';
        const payloadAlterado = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const tokenAlterado = payloadAlterado + '.' + token.slice(idx + 1);
        expect(verificarPreviewToken(tokenAlterado)).toBeNull();
    });

    test('agregar un rodeo extra al payload sin refirmar → rechazado', () => {
        const token = firmarPreview(snapshotEjemplo);
        const idx = token.lastIndexOf('.');
        const payload = JSON.parse(Buffer.from(token.slice(0, idx), 'base64url').toString('utf8'));
        payload.rodeos.push({ rodeo_id: 'r-inventado', estado: 'PROPUESTO', jurado_id_propuesto: 'j-cualquiera' });
        const payloadAlterado = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        const tokenAlterado = payloadAlterado + '.' + token.slice(idx + 1);
        expect(verificarPreviewToken(tokenAlterado)).toBeNull();
    });

    test('token vacío/null/undefined/basura → rechazado sin lanzar error', () => {
        expect(verificarPreviewToken('')).toBeNull();
        expect(verificarPreviewToken(null)).toBeNull();
        expect(verificarPreviewToken(undefined)).toBeNull();
        expect(verificarPreviewToken('esto-no-es-un-token')).toBeNull();
        expect(verificarPreviewToken('sin-punto-separador')).toBeNull();
        expect(verificarPreviewToken('.')).toBeNull();
    });

    test('separación de dominio: una firma HMAC calculada SIN el prefijo de dominio no verifica', () => {
        const crypto = require('crypto');
        const token = firmarPreview(snapshotEjemplo);
        const idx = token.lastIndexOf('.');
        const payloadB64 = token.slice(0, idx);
        const firmaSinDominio = crypto.createHmac('sha256', process.env.JWT_SECRET || 'fallback_secret_change_in_prod').update(payloadB64).digest('hex');
        const tokenSinDominio = payloadB64 + '.' + firmaSinDominio;
        expect(verificarPreviewToken(tokenSinDominio)).toBeNull();
    });

    test('el snapshot firmado no contiene campos ajenos a v/temporada_id/rodeos (nada sensible)', () => {
        const token = firmarPreview(snapshotEjemplo);
        const verificado = verificarPreviewToken(token);
        expect(Object.keys(verificado).sort()).toEqual(['rodeos', 'temporada_id', 'v']);
        verificado.rodeos.forEach(r => expect(Object.keys(r).sort()).toEqual(['estado', 'jurado_id_propuesto', 'rodeo_id']));
    });

    test('dos snapshots distintos producen tokens distintos (no hay colisión trivial)', () => {
        const tokenA = firmarPreview(snapshotEjemplo);
        const tokenB = firmarPreview({ ...snapshotEjemplo, temporada_id: 't2' });
        expect(tokenA).not.toBe(tokenB);
    });
});

describe('mapaPorRodeo', () => {
    test('indexa el snapshot por rodeo_id', () => {
        const mapa = mapaPorRodeo(snapshotEjemplo);
        expect(mapa.get('r1')).toEqual({ rodeo_id: 'r1', estado: 'PROPUESTO', jurado_id_propuesto: 'j1' });
        expect(mapa.get('r-inexistente')).toBeUndefined();
        expect(mapa.size).toBe(3);
    });

    test('snapshot vacío/null → mapa vacío, sin lanzar error', () => {
        expect(mapaPorRodeo(null).size).toBe(0);
        expect(mapaPorRodeo({ rodeos: [] }).size).toBe(0);
    });
});
