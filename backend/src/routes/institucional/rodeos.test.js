// GET /institucional/rodeos (Fase 2, solo lectura). Mismo patrón de mock que
// el resto del repo. Usa resolverTemporada() REAL (informeGestion/cargaDatos)
// y resolverAsociacion()/construirIndiceCatalogo() REALES (informeGestion/
// asociaciones) — nunca reimplementados, para que el test ejerza el mismo
// código que correría en producción.
const jwt = require('jsonwebtoken');

jest.mock('../../config/supabase', () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require('../../config/supabase');
const router = require('./rodeos');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';

const ID_OSORNO = 'id-osorno';
const ID_VALDIVIA = 'id-valdivia';
const ID_BIO_BIO = 'id-bio-bio';
const ID_RIO_BIO_BIO = 'id-rio-bio-bio';

const TEMPORADA = { id: 'temp-1', nombre: '2026-2027', fecha_inicio: '2026-07-01', fecha_fin: '2027-06-30', activa: true };

const CATALOGO = [
    { id: ID_OSORNO, nombre: 'OSORNO', nombre_normalizado: 'osorno', activa: true },
    { id: ID_VALDIVIA, nombre: 'VALDIVIA', nombre_normalizado: 'valdivia', activa: true },
    { id: ID_BIO_BIO, nombre: 'BÍO-BÍO', nombre_normalizado: 'bio bio', activa: true },
    { id: ID_RIO_BIO_BIO, nombre: 'RIO BIO-BIO', nombre_normalizado: 'rio bio bio', activa: true }
];

let respuestas;
// Acepta DOS formatos en `respuestas[tabla]`: el plano original ({data,error},
// usado igual por .single()/.then()) y uno enriquecido por método
// ({list,single,maybeSingle}) para los casos nuevos (Fase 3.3) que necesitan
// una forma distinta según el método — sin tocar ninguna de las ~15
// asignaciones planas ya existentes en este archivo.
function respuestaPara(tabla, metodo) {
    const r = respuestas[tabla];
    if (!r) return metodo === 'then' ? { data: [], error: null } : { data: null, error: null };
    if ('data' in r || 'error' in r) return r; // formato plano
    return r[metodo] ?? (metodo === 'then' ? { data: [], error: null } : { data: null, error: null });
}
function crearChain(tabla) {
    const chain = {};
    const filtros = {}; // registra cada .eq(campo, valor) de ESTA cadena en particular
    ['select', 'gte', 'lte', 'limit', 'order', 'in', 'neq', 'not', 'upsert', 'insert', 'update'].forEach(m => { chain[m] = () => chain; });
    chain.eq = (campo, valor) => { filtros[campo] = valor; return chain; };
    // Fase 3.4: `asignaciones` ahora se consulta DOS veces en la misma
    // petición (Rentado y jurado) con el MISMO nombre de tabla — se distingue
    // por el filtro tipo_persona de ESTA cadena: 'jurado' usa
    // `respuestas.asignaciones_jurado` (si existe), cualquier otro valor usa
    // el `respuestas.asignaciones` de siempre (compatibilidad retro total).
    function tablaEfectiva() {
        if (tabla === 'asignaciones' && filtros.tipo_persona === 'jurado' && respuestas.asignaciones_jurado !== undefined) {
            return 'asignaciones_jurado';
        }
        return tabla;
    }
    chain.single = () => Promise.resolve(respuestaPara(tablaEfectiva(), 'single'));
    chain.maybeSingle = () => Promise.resolve(respuestaPara(tablaEfectiva(), 'maybeSingle'));
    chain.then = (resolve, reject) => Promise.resolve(respuestaPara(tablaEfectiva(), 'list')).then(resolve, reject);
    return chain;
}

beforeEach(() => {
    respuestas = {
        cuentas_institucionales: { data: { activo: true, asociaciones: { activa: true } }, error: null },
        temporadas: { data: [TEMPORADA], error: null },
        asociaciones: { data: CATALOGO, error: null },
        asociacion_alias: { data: [], error: null },
        rodeos: {
            data: [
                { id: 'rodeo-osorno-1', fecha: '2026-09-18', club: 'SAN CARLOS', asociacion: 'OSORNO', tipo_rodeo_nombre: 'Provincial', estado: 'activo' },
                { id: 'rodeo-valdivia-1', fecha: '2026-09-19', club: 'OTRO CLUB', asociacion: 'VALDIVIA', tipo_rodeo_nombre: 'Provincial', estado: 'activo' },
                { id: 'rodeo-biobio-1', fecha: '2026-09-20', club: 'CLUB BB', asociacion: 'BÍO-BÍO', tipo_rodeo_nombre: 'Provincial', estado: 'activo' },
                { id: 'rodeo-riobiobio-1', fecha: '2026-09-21', club: 'CLUB RBB', asociacion: 'RIO BIO-BIO', tipo_rodeo_nombre: 'Provincial', estado: 'activo' },
                { id: 'rodeo-osorno-anulado', fecha: '2026-09-22', club: 'CLUB ANULADO', asociacion: 'OSORNO', tipo_rodeo_nombre: 'Provincial', estado: 'anulado' },
                { id: 'rodeo-ambiguo', fecha: '2026-09-23', club: 'CLUB X', asociacion: 'Asociación Fantasma Sin Catalogar', tipo_rodeo_nombre: 'Provincial', estado: 'activo' }
            ],
            error: null
        },
        cartillas_delegado: { data: [], error: null },
        asignaciones: { data: [], error: null } // sin designaciones vigentes de Rentado por defecto
    };
    supabase.from.mockReset();
    supabase.from.mockImplementation(tabla => crearChain(tabla));
    // Fase 3.5: confirmar_delegado_institucional_rodeo por defecto "gana" con
    // el delegado solicitado (simula que no había ninguna confirmación previa
    // — mismo comportamiento de éxito que la Fase 3.3 ya probaba). Los tests
    // que necesiten simular "ya había otro confirmado" sobreescriben esto.
    supabase.rpc.mockReset();
    supabase.rpc.mockImplementation((_fn, args) => Promise.resolve({
        data: { id: 'desig-1', rodeo_id: args.p_rodeo_id, delegado_asociacion_id: args.p_delegado_asociacion_id },
        error: null
    }));
});

function crearResFake() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.jsonBody = null;
    res.json = jest.fn((p) => { res.jsonBody = p; return res; });
    return res;
}

function tokenInstitucional(asociacion_id) {
    return jwt.sign({ id: 'inst-1', tipo: 'cuenta_institucional', rol_institucional: 'delegado_asociacion', asociacion_id }, JWT_SECRET, { expiresIn: '8h' });
}

function llamar(headers = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: 'GET', url: '/', originalUrl: '/', body: {}, params: {}, headers, query: {}, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

function llamarPost(ruta, body = {}, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = { method: 'POST', url: ruta, originalUrl: ruta, body, params: {}, headers, query: {}, ip: '127.0.0.1' };
        const res = crearResFake();
        const jsonOriginal = res.json;
        res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
        router(req, res, (err) => err ? reject(err) : resolve(res));
    });
}

describe('GET /institucional/rodeos', () => {
    test('sin token -> 401', async () => {
        const res = await llamar({});
        expect(res.statusCode).toBe(401);
    });

    test('Caso A: Osorno solo ve SUS rodeos, nunca los de Valdivia ni de otra asociación', async () => {
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(200);
        const ids = res.jsonBody.rodeos.map(r => r.id);
        expect(ids).toContain('rodeo-osorno-1');
        expect(ids).toContain('rodeo-osorno-anulado'); // anulado: se muestra, con su estado
        expect(ids).not.toContain('rodeo-valdivia-1');
        expect(ids).not.toContain('rodeo-biobio-1');
        expect(ids).not.toContain('rodeo-riobiobio-1');
        expect(ids).not.toContain('rodeo-ambiguo');
    });

    test('rodeo anulado se muestra CON su estado, no se oculta (columna "Estado rodeo")', async () => {
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const anulado = res.jsonBody.rodeos.find(r => r.id === 'rodeo-osorno-anulado');
        expect(anulado.estado_rodeo).toBe('anulado');
    });

    test('BÍO-BÍO y RÍO BÍO-BÍO independientes: cada cuenta ve SOLO los rodeos de su propia asociación, nunca los de la otra', async () => {
        const resBio = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_BIO_BIO)}` });
        expect(resBio.jsonBody.rodeos.map(r => r.id)).toEqual(['rodeo-biobio-1']);

        const resRio = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_RIO_BIO_BIO)}` });
        expect(resRio.jsonBody.rodeos.map(r => r.id)).toEqual(['rodeo-riobiobio-1']);
    });

    test('Caso H: rodeo con asociación ambigua/sin equivalencia en el catálogo NO aparece para NADIE', async () => {
        for (const id of [ID_OSORNO, ID_VALDIVIA, ID_BIO_BIO, ID_RIO_BIO_BIO]) {
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(id)}` });
            expect(res.jsonBody.rodeos.map(r => r.id)).not.toContain('rodeo-ambiguo');
        }
    });

    test('asociación sin rodeos en la temporada -> lista vacía, no error', async () => {
        respuestas.rodeos = { data: [], error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.rodeos).toEqual([]);
    });

    test('sin temporada vigente configurada -> lista vacía con mensaje, nunca error 500', async () => {
        respuestas.temporadas = { data: [], error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.rodeos).toEqual([]);
        expect(res.jsonBody.temporada).toBeNull();
    });

    test('estado_cartilla = "sin_cartilla" cuando no hay ninguna cartilla para ese rodeo', async () => {
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.estado_cartilla).toBe('sin_cartilla');
    });

    test('estado_cartilla refleja el estado real cuando hay EXACTAMENTE una cartilla', async () => {
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'rodeo-osorno-1', estado: 'enviada' }], error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.estado_cartilla).toBe('enviada');
    });

    test('más de una cartilla para el mismo rodeo -> estado controlado "multiples_cartillas_sin_resolver", NUNCA se elige una arbitrariamente', async () => {
        respuestas.cartillas_delegado = {
            data: [
                { rodeo_id: 'rodeo-osorno-1', estado: 'borrador' },
                { rodeo_id: 'rodeo-osorno-1', estado: 'enviada' }
            ],
            error: null
        };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.estado_cartilla).toBe('multiples_cartillas_sin_resolver');
    });

    test('Fase 3.1 — rodeo sin designación vigente de Rentado -> cartilla_institucional_disponible=true, delegado_rentado_designado=false (Caso B)', async () => {
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.delegado_rentado_designado).toBe(false);
        expect(r.cartilla_institucional_disponible).toBe(true);
    });

    test('Fase 3.1 — rodeo CON designación vigente de Rentado -> cartilla_institucional_disponible=false, delegado_rentado_designado=true (Caso A)', async () => {
        respuestas.asignaciones = { data: [{ rodeo_id: 'rodeo-osorno-1' }], error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.delegado_rentado_designado).toBe(true);
        expect(r.cartilla_institucional_disponible).toBe(false);
    });

    test('Fase 3.1 — ya existe cartilla de Delegado Rentado (sin designación vigente, p.ej. anulada después) -> igual no disponible', async () => {
        respuestas.cartillas_delegado = { data: [{ rodeo_id: 'rodeo-osorno-1', estado: 'borrador', delegado_id: 'usr-1', delegado_asociacion_id: null }], error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.delegado_rentado_designado).toBe(false);
        expect(r.cartilla_institucional_disponible).toBe(false);
    });

    test('Fase 3.1 — rodeo anulado -> cartilla_institucional_disponible=false aunque no haya designación (compatibilidad con el bloqueo ya existente por anulado)', async () => {
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-anulado');
        expect(r.cartilla_institucional_disponible).toBe(false);
    });

    test('Caso F: cuenta institucional desactivada -> 401, ni siquiera llega a consultar rodeos', async () => {
        respuestas.cuentas_institucionales = { data: { activo: false, asociaciones: { activa: true } }, error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(401);
    });

    test('alias oficial registrado: un rodeo con el texto de alias resuelve a la asociación correcta', async () => {
        respuestas.asociacion_alias = { data: [{ asociacion_id: ID_OSORNO, alias: 'OSORNO RODEO CLUB', alias_normalizado: 'osorno rodeo club' }], error: null };
        respuestas.rodeos = {
            data: [{ id: 'rodeo-alias', fecha: '2026-09-18', club: 'X', asociacion: 'OSORNO RODEO CLUB', tipo_rodeo_nombre: 'Provincial', estado: 'activo' }],
            error: null
        };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.jsonBody.rodeos.map(r => r.id)).toEqual(['rodeo-alias']);
    });

    describe('Fase 3.3 — "Tipo de Delegado" / "Nombre del Delegado"', () => {
        test('Caso A: Rentado vigente -> tipo_delegado="delegado_rentado", nombre_delegado = nombre real (usuarios_pagados)', async () => {
            respuestas.asignaciones = { data: [{ rodeo_id: 'rodeo-osorno-1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Pedro González' } }], error: null };
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.tipo_delegado).toBe('delegado_rentado');
            expect(r.nombre_delegado).toBe('Pedro González');
        });

        test('Caso A: Rentado vigente pero la relación con usuarios_pagados no resuelve -> nombre_delegado=null, nunca se inventa un nombre', async () => {
            respuestas.asignaciones = { data: [{ rodeo_id: 'rodeo-osorno-1', nombre_importado: null, usuarios_pagados: null }], error: null };
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.tipo_delegado).toBe('delegado_rentado');
            expect(r.nombre_delegado).toBeNull();
        });

        test('Caso B: sin Rentado, sin cartilla, sin selección previa -> tipo_delegado="delegado_asociacion", nombre_delegado=null ("Seleccionar delegado" en el frontend)', async () => {
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.tipo_delegado).toBe('delegado_asociacion');
            expect(r.nombre_delegado).toBeNull();
            expect(r.delegado_asociacion_id_seleccionado).toBeNull();
        });

        test('Caso B: con una selección previa guardada (sin cartilla todavía) -> nombre_delegado refleja esa selección', async () => {
            respuestas.rodeos_delegado_institucional = { list: { data: [{ rodeo_id: 'rodeo-osorno-1', delegado_asociacion_id: 'del-1', delegados_asociacion: { nombre: 'Ana Soto' } }], error: null } };
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.tipo_delegado).toBe('delegado_asociacion');
            expect(r.nombre_delegado).toBe('Ana Soto');
            expect(r.delegado_asociacion_id_seleccionado).toBe('del-1');
            expect(r.cartilla_iniciada).toBe(false);
        });

        test('Fase 3.4 — cartilla institucional ya iniciada -> expone cartilla_id (necesario para "Descargar PDF")', async () => {
            respuestas.cartillas_delegado = { data: [{ id: 'cart-xyz', rodeo_id: 'rodeo-osorno-1', estado: 'enviada', delegado_id: null, delegado_asociacion_id: 'del-1', delegado_nombre: 'Ana Soto' }], error: null };
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.cartilla_id).toBe('cart-xyz');
        });

        test('sin cartilla iniciada -> cartilla_id=null', async () => {
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.cartilla_id).toBeNull();
        });

        test('cartilla institucional ya iniciada -> su delegado_nombre manda sobre la selección previa (pueden haber divergido)', async () => {
            respuestas.cartillas_delegado = { data: [{ rodeo_id: 'rodeo-osorno-1', estado: 'borrador', delegado_id: null, delegado_asociacion_id: 'del-2', delegado_nombre: 'Bruno Díaz' }], error: null };
            respuestas.rodeos_delegado_institucional = { list: { data: [{ rodeo_id: 'rodeo-osorno-1', delegado_asociacion_id: 'del-1', delegados_asociacion: { nombre: 'Ana Soto' } }], error: null } };
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.nombre_delegado).toBe('Bruno Díaz');
            expect(r.cartilla_iniciada).toBe(true);
        });

        test('conflicto (cartilla Rentado histórica sin designación vigente) -> tipo_delegado="conflicto", nunca se inventa una modalidad', async () => {
            respuestas.cartillas_delegado = { data: [{ rodeo_id: 'rodeo-osorno-1', estado: 'borrador', delegado_id: 'usr-1', delegado_asociacion_id: null }], error: null };
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.tipo_delegado).toBe('conflicto');
        });

        test('Fase 3.4 — rodeo sin ninguna designación de jurado publicada -> jurados_designados=[] (el frontend muestra "Pendiente de designación")', async () => {
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.jurados_designados).toEqual([]);
    });

    test('Fase 3.4 — rodeo con UN jurado publicado y no rechazado -> jurados_designados=["Nombre"]', async () => {
        respuestas.asignaciones_jurado = { data: [{ rodeo_id: 'rodeo-osorno-1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Juan Pérez' } }], error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.jurados_designados).toEqual(['Juan Pérez']);
    });

    test('Fase 3.4 — rodeo con DOS jurados publicados -> jurados_designados trae ambos nombres', async () => {
        respuestas.asignaciones_jurado = {
            data: [
                { rodeo_id: 'rodeo-osorno-1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Juan Pérez' } },
                { rodeo_id: 'rodeo-osorno-1', nombre_importado: null, usuarios_pagados: { nombre_completo: 'Pedro González' } }
            ],
            error: null
        };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.jurados_designados).toEqual(['Juan Pérez', 'Pedro González']);
    });

    test('Fase 3.4 — jurado sin relación usuarios_pagados resuelta (ni nombre_importado) -> se excluye, nunca se inventa un nombre', async () => {
        respuestas.asignaciones_jurado = { data: [{ rodeo_id: 'rodeo-osorno-1', nombre_importado: null, usuarios_pagados: null }], error: null };
        const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
        expect(r.jurados_designados).toEqual([]);
    });

    test('conflicto (múltiples cartillas sin resolver) -> tipo_delegado="conflicto"', async () => {
            respuestas.cartillas_delegado = {
                data: [
                    { rodeo_id: 'rodeo-osorno-1', estado: 'borrador', delegado_id: 'usr-1', delegado_asociacion_id: null },
                    { rodeo_id: 'rodeo-osorno-1', estado: 'enviada', delegado_id: 'usr-2', delegado_asociacion_id: null }
                ],
                error: null
            };
            const res = await llamar({ authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
            const r = res.jsonBody.rodeos.find(x => x.id === 'rodeo-osorno-1');
            expect(r.tipo_delegado).toBe('conflicto');
        });
    });
});

describe('POST /institucional/rodeos/:rodeo_id/seleccionar-delegado (Fase 3.3)', () => {
    const RODEO = { id: 'rodeo-osorno-1', club: 'SAN CARLOS', asociacion: 'OSORNO', fecha: '2026-09-18', estado: 'activo' };
    const DELEGADO = { id: 'del-1', nombre: 'Ana Soto', asociacion_id: ID_OSORNO, activo: true, certificado: true };

    beforeEach(() => {
        respuestas.rodeos = { maybeSingle: { data: RODEO, error: null } };
        respuestas.delegados_asociacion = { maybeSingle: { data: DELEGADO, error: null } };
        respuestas.asignaciones = { maybeSingle: { data: null, error: null } }; // sin designación vigente de Rentado
        respuestas.cartillas_delegado = { maybeSingle: { data: null, error: null } }; // sin cartilla iniciada todavía
        respuestas.rodeos_delegado_institucional = { single: { data: { rodeo_id: RODEO.id, delegado_asociacion_id: DELEGADO.id }, error: null } };
    });

    test('guarda la selección -> 200 con la selección y sin crear ninguna cartilla', async () => {
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.seleccion).toEqual({ rodeo_id: 'rodeo-osorno-1', delegado_asociacion_id: 'del-1', nombre: 'Ana Soto', designacion_id: 'desig-1' });
    });

    test('sin delegado_asociacion_id -> 400', async () => {
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', {}, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(400);
    });

    test('rodeo de OTRA asociación -> 404, nunca permite seleccionar para un rodeo ajeno', async () => {
        respuestas.rodeos = { maybeSingle: { data: null, error: null } };
        const res = await llamarPost('/rodeo-valdivia-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_VALDIVIA)}` });
        expect(res.statusCode).toBe(404);
    });

    test('delegado de OTRA asociación -> 403', async () => {
        respuestas.delegados_asociacion = { maybeSingle: { data: { ...DELEGADO, asociacion_id: ID_VALDIVIA }, error: null } };
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(403);
    });

    test('delegado inactivo o no certificado -> 403', async () => {
        respuestas.delegados_asociacion = { maybeSingle: { data: { ...DELEGADO, certificado: false }, error: null } };
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(403);
    });

    test('Rentado vigente para este rodeo -> 409, nunca permite declarar una preferencia institucional', async () => {
        respuestas.asignaciones = { maybeSingle: { data: { id: 'asig-1' }, error: null } };
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('DELEGADO_RENTADO_DESIGNADO');
    });

    // ── Fase 3.5 — bloqueo del responsable confirmado ───────────────────
    test('RPC confirma con el MISMO delegado solicitado (nadie se adelantó) -> 200, incluye designacion_id', async () => {
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.seleccion).toEqual({ rodeo_id: 'rodeo-osorno-1', delegado_asociacion_id: 'del-1', nombre: 'Ana Soto', designacion_id: 'desig-1' });
    });

    test('RPC devuelve un responsable YA confirmado con OTRO delegado (ya existía, o ganó una confirmación concurrente) -> 409 RESPONSABLE_YA_CONFIRMADO, nunca lo sobrescribe', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'desig-1', rodeo_id: 'rodeo-osorno-1', delegado_asociacion_id: 'del-2' }, error: null });
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');
        expect(res.jsonBody.responsable_actual.delegado_asociacion_id).toBe('del-2');
    });

    test('re-confirmar el MISMO delegado ya vigente -> 200 idempotente (no es un error)', async () => {
        supabase.rpc.mockResolvedValue({ data: { id: 'desig-1', rodeo_id: 'rodeo-osorno-1', delegado_asociacion_id: 'del-1' }, error: null });
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(200);
    });

    test('la RPC propaga un error de base de datos -> 500, nunca se trata como confirmado', async () => {
        supabase.rpc.mockResolvedValue({ data: null, error: { message: 'db error' } });
        const res = await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(res.statusCode).toBe(500);
    });

    test('llama a la RPC (nunca un upsert directo) con los parámetros correctos', async () => {
        await llamarPost('/rodeo-osorno-1/seleccionar-delegado', { delegado_asociacion_id: 'del-1' }, { authorization: `Bearer ${tokenInstitucional(ID_OSORNO)}` });
        expect(supabase.rpc).toHaveBeenCalledWith('confirmar_delegado_institucional_rodeo', expect.objectContaining({
            p_rodeo_id: 'rodeo-osorno-1', p_delegado_asociacion_id: 'del-1', p_delegado_nombre: 'Ana Soto', p_cuenta_institucional_id: 'inst-1'
        }));
    });
});
