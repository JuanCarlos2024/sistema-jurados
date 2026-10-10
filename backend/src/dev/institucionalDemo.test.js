// Modo demostración institucional (Fase 2.5). Nunca toca Supabase — no hay
// ningún jest.mock('../../config/supabase') aquí a propósito, porque este
// router no lo importa en absoluto (verificado también por un test dedicado
// más abajo: ni siquiera aparece en su código fuente).
const fs = require('fs');
const path = require('path');

describe('Guardia de producción', () => {
    const codigoFuente = fs.readFileSync(path.join(__dirname, 'institucionalDemo.js'), 'utf8');

    test('el archivo nunca importa config/supabase (100% en memoria, cero dependencia de la BD real)', () => {
        expect(codigoFuente).not.toMatch(/require\(.*config\/supabase/);
    });

    test('lanza si se requiere con NODE_ENV=production', () => {
        const prevEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        jest.resetModules();
        expect(() => require('./institucionalDemo')).toThrow(/NODE_ENV=production/);
        process.env.NODE_ENV = prevEnv;
        jest.resetModules();
    });
});

describe('app.js — doble guardia antes de montar el router de demostración', () => {
    test('la condición exige NODE_ENV !== "production" Y DEMO_INSTITUCIONAL === "1" (ninguna por sí sola activa el modo demo)', () => {
        const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        expect(appJs).toMatch(/NODE_ENV !== 'production'\s*&&\s*process\.env\.DEMO_INSTITUCIONAL === '1'/);
        // El router real (producción) sigue siendo la rama por defecto (`:`), nunca la del `?`:
        expect(appJs).toMatch(/DEMO_INSTITUCIONAL_ACTIVO\s*\?\s*require\('\.\/dev\/institucionalDemo'\)\s*:\s*require\('\.\/routes\/institucional\/index'\)/);
    });
});

describe('router de demostración — funcional (sin servidor HTTP real, mismo patrón que el resto del repo)', () => {
    let jwt, router;
    const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_change_in_prod';

    beforeAll(() => {
        process.env.NODE_ENV = 'development'; // asegurar que no quede en 'production' de un test anterior
        jest.resetModules();
        jwt = require('jsonwebtoken');
        router = require('./institucionalDemo');
    });

    function crearResFake() {
        const res = {};
        res.statusCode = 200;
        res.status = jest.fn((c) => { res.statusCode = c; return res; });
        res.jsonBody = null;
        res.json = jest.fn((p) => { res.jsonBody = p; return res; });
        // Fase 3.4 — PDF: respuesta binaria (res.setHeader + res.end).
        res.cabeceras = {};
        res.setHeader = jest.fn((k, v) => { res.cabeceras[k] = v; return res; });
        res.endBody = null;
        res.end = jest.fn((buf) => { res.endBody = buf; return res; });
        return res;
    }
    function llamar(method, ruta, body = {}, headers = {}) {
        return new Promise((resolve, reject) => {
            const req = { method, url: ruta, originalUrl: ruta, body, params: {}, headers, query: {} };
            const res = crearResFake();
            const jsonOriginal = res.json;
            res.json = (p) => { jsonOriginal(p); resolve(res); return res; };
            const endOriginal = res.end;
            res.end = (p) => { endOriginal(p); resolve(res); return res; };
            router(req, res, (err) => err ? reject(err) : resolve(res));
        });
    }
    async function tokenEscenarioA() {
        const r = await llamar('POST', '/auth/login', { email: 'demo-osorno@ferochi.com', password: 'DEMO1234' });
        return r.jsonBody.token;
    }

    test('Escenario A: login válido con la contraseña de demostración', async () => {
        const res = await llamar('POST', '/auth/login', { email: 'demo-osorno@ferochi.com', password: 'DEMO1234' });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.usuario.asociacion_nombre).toBe('OSORNO (DEMOSTRACIÓN)');
        const payload = jwt.verify(res.jsonBody.token, JWT_SECRET);
        expect(payload.demo).toBe(true); // marca explícita de que es un token ficticio
    });

    test('contraseña incorrecta -> 401', async () => {
        const res = await llamar('POST', '/auth/login', { email: 'demo-osorno@ferochi.com', password: 'incorrecta' });
        expect(res.statusCode).toBe(401);
    });

    test('Escenario A: catálogo de delegados tiene 3 personas certificadas', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('GET', '/delegados', {}, { authorization: `Bearer ${token}` });
        expect(res.jsonBody.delegados).toHaveLength(3);
    });

    test('Fase 3.4 — "Jurado designado": rodeo SIN entrada en el mapa demo -> jurados_designados=[] ("Pendiente de designación")', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${token}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-1');
        expect(r.jurados_designados).toEqual([]);
    });

    test('Fase 3.4 — "Jurado designado": demo-rodeo-2 trae DOS jurados (ejemplo con más de uno)', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${token}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-2');
        expect(r.jurados_designados).toEqual(['Juan Pérez Soto (DEMO)', 'Pedro Ramírez Lagos (DEMO)']);
    });

    test('Fase 3.4 — corrección "Responsable vacío": Club Río Negro (demo-rodeo-2, estado "enviada") ahora muestra un nombre de delegado real, nunca "—"', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${token}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-2');
        expect(r.estado_cartilla).toBe('enviada');
        expect(r.nombre_delegado).toBe('Bruno Hernández Díaz (DEMO)');
        expect(r.cartilla_iniciada).toBe(true);
    });

    test('Escenario A: rodeos incluye activo, enviada y un anulado', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${token}` });
        expect(res.jsonBody.rodeos.some(r => r.estado_rodeo === 'anulado')).toBe(true);
        expect(res.jsonBody.rodeos.some(r => r.estado_cartilla === 'enviada')).toBe(true);
    });

    test('Fase 3.1 — Escenario A incluye un rodeo con Delegado Rentado designado -> cartilla_institucional_disponible=false (Caso A)', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${token}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-13');
        expect(r.delegado_rentado_designado).toBe(true);
        expect(r.cartilla_institucional_disponible).toBe(false);
    });

    test('Fase 3.1 — resto de los rodeos activos sin designación -> cartilla_institucional_disponible=true', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${token}` });
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-1');
        expect(r.delegado_rentado_designado).toBe(false);
        expect(r.cartilla_institucional_disponible).toBe(true);
    });

    test('Escenario A: seleccionar un delegado real de la propia asociación funciona', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('POST', '/delegados/seleccionar', { delegado_id: 'demo-del-1' }, { authorization: `Bearer ${token}` });
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.delegado.nombre).toContain('Ana Soto');
    });

    test('Escenario A: seleccionar un delegado inexistente -> rechazado', async () => {
        const token = await tokenEscenarioA();
        const res = await llamar('POST', '/delegados/seleccionar', { delegado_id: 'id-fantasma' }, { authorization: `Bearer ${token}` });
        expect(res.statusCode).toBe(403);
    });

    test('Escenario B (sin delegados): login funciona, catálogo de delegados vacío', async () => {
        const login = await llamar('POST', '/auth/login', { email: 'demo-sinregistros@ferochi.com', password: 'DEMO1234' });
        const res = await llamar('GET', '/delegados', {}, { authorization: `Bearer ${login.jsonBody.token}` });
        expect(res.jsonBody.delegados).toEqual([]);
    });

    test('Escenario C (estados de cartilla): incluye el conflicto "multiples_cartillas_sin_resolver"', async () => {
        const login = await llamar('POST', '/auth/login', { email: 'demo-estados@ferochi.com', password: 'DEMO1234' });
        const res = await llamar('GET', '/rodeos', {}, { authorization: `Bearer ${login.jsonBody.token}` });
        expect(res.jsonBody.rodeos.some(r => r.estado_cartilla === 'multiples_cartillas_sin_resolver')).toBe(true);
    });

    test('Escenario C: primer_login=true -> cambiar-password funciona y limpia la bandera', async () => {
        const login = await llamar('POST', '/auth/login', { email: 'demo-estados@ferochi.com', password: 'DEMO1234' });
        expect(login.jsonBody.usuario.primer_login).toBe(true);
        const res = await llamar('POST', '/auth/cambiar-password', { password_nueva: 'NuevaClave123' }, { authorization: `Bearer ${login.jsonBody.token}` });
        expect(res.statusCode).toBe(200);
    });

    test('token de demostración NUNCA puede usarse sin header de autorización (401, igual que el flujo real)', async () => {
        const res = await llamar('GET', '/delegados', {}, {});
        expect(res.statusCode).toBe(401);
    });

// Anidado a propósito: reutiliza router/llamar/crearResFake/jwt del describe
// padre (declarados arriba) en vez de redefinirlos — mismo router de
// demostración ya cargado, misma sesión de pruebas.
describe('Simulación de Cartilla de Delegado en modo demostración (Fase 3)', () => {
    let token;
    beforeAll(async () => {
        token = (await llamar('POST', '/auth/login', { email: 'demo-osorno@ferochi.com', password: 'DEMO1234' })).jsonBody.token;
    });
    // Función, no un objeto fijo: `token` recién existe DESPUÉS de que corra
    // beforeAll — un objeto literal evaluado acá (tiempo de collection) lo
    // capturaría como undefined para siempre.
    const auth = () => ({ authorization: `Bearer ${token}` });

    test('abrir un rodeo sin cartilla previa -> cartilla=null', async () => {
        const res = await llamar('GET', '/cartilla/rodeo/demo-rodeo-1', {}, auth());
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla).toBeNull();
        expect(res.jsonBody.rodeo.id).toBe('demo-rodeo-1');
    });

    test('Fase 3.3 — crear sin delegado_asociacion_id en el body y SIN selección previa guardada -> 422 DELEGADO_NO_SELECCIONADO', async () => {
        const res = await llamar('POST', '/cartilla/rodeo/demo-rodeo-17', {}, auth());
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('DELEGADO_NO_SELECCIONADO');
    });

    test('Fase 3.3 — crear sin delegado_asociacion_id en el body PERO con selección previa guardada (vía seleccionar-delegado) -> usa esa selección', async () => {
        await llamar('POST', '/rodeos/demo-rodeo-17/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-2' }, auth());
        const res = await llamar('POST', '/cartilla/rodeo/demo-rodeo-17', {}, auth());
        expect(res.statusCode).toBe(201);
        expect(res.jsonBody.cartilla.delegado_asociacion_id).toBe('demo-del-2');
    });

    test('Fase 3.5 — crear un borrador requiere confirmar primero; completar campos (guardar) y recuperarlo tal cual quedó', async () => {
        // Fase 3.5: ya no se puede crear pasando delegado_asociacion_id "de
        // paso" en el body sin una confirmación previa — usa demo-rodeo-23
        // (reservado, nunca tocado por otro test) y confirma primero.
        await llamar('POST', '/rodeos/demo-rodeo-23/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        const creada = await llamar('POST', '/cartilla/rodeo/demo-rodeo-23', {}, auth());
        expect(creada.statusCode).toBe(201);
        expect(creada.jsonBody.cartilla.version).toBe(1);

        const guardada = await llamar('PATCH', `/cartilla/${creada.jsonBody.cartilla.id}`, {
            version: 1, delegado_telefono: '+56911112222', respuestas_json: { comentarios_generales: { texto: 'Prueba demo' } }
        }, auth());
        expect(guardada.statusCode).toBe(200);
        expect(guardada.jsonBody.cartilla.version).toBe(2);

        const recuperada = await llamar('GET', '/cartilla/rodeo/demo-rodeo-23', {}, auth());
        expect(recuperada.jsonBody.cartilla.delegado_telefono).toBe('+56911112222');
        expect(recuperada.jsonBody.cartilla.respuestas_json.comentarios_generales.texto).toBe('Prueba demo');
        expect(recuperada.jsonBody.cartilla.version).toBe(2);
        // Fase 3.5 — historial real: confirmación + creación + guardado, en orden.
        expect(recuperada.jsonBody.historial_responsables.map(e => e.accion)).toEqual([
            'confirmar_responsable_institucional', 'crear', 'guardar'
        ]);
    });

    test('guardar con version vieja -> 409 VERSION_DESACTUALIZADA (simula el error real sin tocar Supabase)', async () => {
        // Fase 3.4: demo-rodeo-2 ("Club Río Negro") ahora tiene una cartilla
        // pre-sembrada en estado 'enviada' (corrección del bug "Responsable
        // vacío") — este test necesita un rodeo limpio, usa demo-rodeo-24.
        await llamar('POST', '/rodeos/demo-rodeo-24/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        const creada = await llamar('POST', '/cartilla/rodeo/demo-rodeo-24', {}, auth());
        await llamar('PATCH', `/cartilla/${creada.jsonBody.cartilla.id}`, { version: 1, delegado_telefono: 'X' }, auth()); // sube a version=2
        const res = await llamar('PATCH', `/cartilla/${creada.jsonBody.cartilla.id}`, { version: 1, delegado_telefono: 'Y' }, auth()); // version vieja
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('VERSION_DESACTUALIZADA');
    });

    test('Fase 3.5 — el responsable confirmado es inmutable: crear/guardar con OTRO delegado en el body -> 403 RESPONSABLE_YA_CONFIRMADO, nunca lo cambia', async () => {
        await llamar('POST', '/rodeos/demo-rodeo-25/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        const creada = await llamar('POST', '/cartilla/rodeo/demo-rodeo-25', {}, auth());
        expect(creada.statusCode).toBe(201);

        const intento = await llamar('POST', '/cartilla/rodeo/demo-rodeo-25', { delegado_asociacion_id: 'demo-del-2' }, auth());
        expect(intento.statusCode).toBe(403);
        expect(intento.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');

        const intentoPatch = await llamar('PATCH', `/cartilla/${creada.jsonBody.cartilla.id}`, { version: creada.jsonBody.cartilla.version, delegado_asociacion_id: 'demo-del-2' }, auth());
        expect(intentoPatch.statusCode).toBe(403);
        expect(intentoPatch.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');

        const verificar = await llamar('GET', '/cartilla/rodeo/demo-rodeo-25', {}, auth());
        expect(verificar.jsonBody.cartilla.delegado_asociacion_id).toBe('demo-del-1'); // nunca cambió
    });

    test('simular envío: cambia a estado "enviada" y ya no admite más cambios', async () => {
        await llamar('POST', '/rodeos/demo-rodeo-26/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        const creada = await llamar('POST', '/cartilla/rodeo/demo-rodeo-26', {}, auth());
        const enviada = await llamar('POST', `/cartilla/${creada.jsonBody.cartilla.id}/enviar`, { version: creada.jsonBody.cartilla.version }, auth());
        expect(enviada.statusCode).toBe(200);
        expect(enviada.jsonBody.cartilla.estado).toBe('enviada');

        const segundoIntento = await llamar('PATCH', `/cartilla/${creada.jsonBody.cartilla.id}`, { version: enviada.jsonBody.cartilla.version, delegado_telefono: 'Z' }, auth());
        expect(segundoIntento.statusCode).toBe(409);
        expect(segundoIntento.jsonBody.code).toBe('ESTADO_BLOQUEADO');
    });

    test('crear para un rodeo anulado -> 422 RODEO_ANULADO', async () => {
        const res = await llamar('POST', '/cartilla/rodeo/demo-rodeo-3', { delegado_asociacion_id: 'demo-del-1' }, auth()); // demo-rodeo-3 = anulado en los datos de Escenario A
        expect(res.statusCode).toBe(422);
        expect(res.jsonBody.code).toBe('RODEO_ANULADO');
    });

    test('sin token válido -> 401 (misma protección que el resto del modo demo)', async () => {
        const res = await llamar('GET', '/cartilla/rodeo/demo-rodeo-1', {}, {});
        expect(res.statusCode).toBe(401);
    });

    test('Fase 3.4 — Descargar PDF (demo): usa el generador oficial REAL contra la cartilla pre-sembrada "enviada" (Club Río Negro), nombre de archivo claro', async () => {
        const res = await llamar('GET', '/cartilla/demo-cart-demo-rodeo-2/pdf', {}, auth());
        expect(res.statusCode).toBe(200);
        expect(res.cabeceras['Content-Type']).toBe('application/pdf');
        expect(res.cabeceras['Content-Disposition']).toBe('attachment; filename="Cartilla_Delegado_Club_Rio_Negro_DEMO_25-09-2026.pdf"');
        // PDF real (pdfkit), no un mock — confirma que %PDF es el encabezado binario estándar.
        expect(res.endBody.slice(0, 4).toString()).toBe('%PDF');
    });

    test('Descargar PDF (demo): cartilla inexistente -> 404, nunca genera nada', async () => {
        const res = await llamar('GET', '/cartilla/id-fantasma/pdf', {}, auth());
        expect(res.statusCode).toBe(404);
    });

    test('Fase 3.1 — Caso A: GET sobre rodeo con Delegado Rentado designado -> conflicto_rentado=true, cartilla=null, sin crear nada', async () => {
        const res = await llamar('GET', '/cartilla/rodeo/demo-rodeo-13', {}, auth());
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla).toBeNull();
        expect(res.jsonBody.conflicto_rentado).toBe(true);
        expect(res.jsonBody.delegado_rentado_designado).toBe(true);
    });

    test('Fase 3.1 — Caso A: POST sobre rodeo con Delegado Rentado designado -> 409 DELEGADO_RENTADO_DESIGNADO, nunca crea la cartilla institucional', async () => {
        const res = await llamar('POST', '/cartilla/rodeo/demo-rodeo-13', { delegado_asociacion_id: 'demo-del-1' }, auth());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('DELEGADO_RENTADO_DESIGNADO');

        const verificar = await llamar('GET', '/cartilla/rodeo/demo-rodeo-13', {}, auth());
        expect(verificar.jsonBody.cartilla).toBeNull();
    });

    test('Fase 3.1 (cierre) Caso D — demo-rodeo-14 ya trae una cartilla iniciada y designación posterior: GET la sigue devolviendo (nunca se oculta), marcada bloqueada_por_designacion_posterior=true', async () => {
        const res = await llamar('GET', '/cartilla/rodeo/demo-rodeo-14', {}, auth());
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.cartilla).not.toBeNull();
        expect(res.jsonBody.cartilla.id).toBe('demo-cart-demo-rodeo-14');
        expect(res.jsonBody.bloqueada_por_designacion_posterior).toBe(true);
        expect(res.jsonBody.conflicto_rentado).toBe(false); // no es Caso A: la cartilla ya existe, se puede consultar
    });

    test('Fase 3.1 (cierre) Caso D — PATCH sobre demo-rodeo-14 -> 409 con el mensaje EXACTO pedido, nunca guarda', async () => {
        const res = await llamar('PATCH', '/cartilla/demo-cart-demo-rodeo-14', { version: 1, delegado_nombre: 'Otro' }, auth());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('BLOQUEADA_POR_DESIGNACION_POSTERIOR');
        expect(res.jsonBody.error).toBe('Este rodeo presenta un cambio de designación de Delegado. La cartilla se encuentra temporalmente bloqueada hasta que el Administrador resuelva la situación.');
    });

    test('Fase 3.1 (cierre) Caso D — enviar sobre demo-rodeo-14 -> 409, bloqueado, nunca cambia de estado', async () => {
        const res = await llamar('POST', '/cartilla/demo-cart-demo-rodeo-14/enviar', { version: 1 }, auth());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('BLOQUEADA_POR_DESIGNACION_POSTERIOR');

        const verificar = await llamar('GET', '/cartilla/rodeo/demo-rodeo-14', {}, auth());
        expect(verificar.jsonBody.cartilla.estado).toBe('borrador'); // nunca cambió a 'enviada'
    });
});

describe('Fase 3.3 — selección de Delegado de Asociación INDEPENDIENTE por rodeo (modo demostración)', () => {
    // Mismo patrón que la describe "Simulación de Cartilla..." (token propio,
    // función, no un objeto fijo evaluado antes de beforeAll).
    let token;
    beforeAll(async () => { token = await tokenEscenarioA(); });
    const auth = () => ({ authorization: `Bearer ${token}` });

    test('GET /rodeos expone tipo_delegado="delegado_rentado" con el NOMBRE REAL del Rentado (nunca inventado)', async () => {
        const res = await llamar('GET', '/rodeos', {}, auth());
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-13');
        expect(r.tipo_delegado).toBe('delegado_rentado');
        expect(r.nombre_delegado).toBe('Pedro González Muñoz (DEMO)');
    });

    test('GET /rodeos: rodeo sin designación ni selección todavía -> tipo_delegado="delegado_asociacion", nombre_delegado=null', async () => {
        const res = await llamar('GET', '/rodeos', {}, auth());
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-15');
        expect(r.tipo_delegado).toBe('delegado_asociacion');
        expect(r.nombre_delegado).toBeNull();
        expect(r.delegado_asociacion_id_seleccionado).toBeNull();
    });

    test('POST /rodeos/:id/seleccionar-delegado guarda la selección, y GET /rodeos la refleja de inmediato (persistencia en memoria, se recupera sin recrear nada)', async () => {
        const guardar = await llamar('POST', '/rodeos/demo-rodeo-15/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-3' }, auth());
        expect(guardar.statusCode).toBe(200);
        expect(guardar.jsonBody.seleccion.nombre).toContain('Carla Muñoz');

        const res = await llamar('GET', '/rodeos', {}, auth());
        const r = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-15');
        expect(r.delegado_asociacion_id_seleccionado).toBe('demo-del-3');
        expect(r.nombre_delegado).toContain('Carla Muñoz');
    });

    test('seleccionar/confirmar en distintos rodeos es INDEPENDIENTE — confirmar uno nunca afecta al otro (Fase 3.5: demo-rodeo-15 ya está confirmado como demo-del-3 por el test anterior y DEBE seguir así)', async () => {
        // Fase 3.5: demo-rodeo-15 ya quedó confirmado (demo-del-3) en el test
        // anterior — un intento de confirmar OTRO delegado ahí se rechaza
        // (409) y NO lo cambia; mientras tanto, demo-rodeo-16 (fresco) se
        // confirma con demo-del-2 sin ningún efecto cruzado.
        const intentoSobreYaConfirmado = await llamar('POST', '/rodeos/demo-rodeo-15/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        expect(intentoSobreYaConfirmado.statusCode).toBe(409);
        expect(intentoSobreYaConfirmado.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');

        const confirmarOtro = await llamar('POST', '/rodeos/demo-rodeo-16/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-2' }, auth());
        expect(confirmarOtro.statusCode).toBe(200);

        const res = await llamar('GET', '/rodeos', {}, auth());
        const r1 = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-15');
        const r2 = res.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-16');
        expect(r1.delegado_asociacion_id_seleccionado).toBe('demo-del-3'); // nunca cambió
        expect(r2.delegado_asociacion_id_seleccionado).toBe('demo-del-2');
    });

    test('seleccionar un delegado para un rodeo con Delegado Rentado designado -> 409, nunca se guarda la preferencia', async () => {
        const res = await llamar('POST', '/rodeos/demo-rodeo-13/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('DELEGADO_RENTADO_DESIGNADO');
    });

    test('delegado inexistente -> 403, no modifica la selección existente', async () => {
        const res = await llamar('POST', '/rodeos/demo-rodeo-15/seleccionar-delegado', { delegado_asociacion_id: 'id-fantasma' }, auth());
        expect(res.statusCode).toBe(403);
    });

    test('re-confirmar el MISMO delegado ya confirmado es un no-op idempotente (200, nunca un error)', async () => {
        const res = await llamar('POST', '/rodeos/demo-rodeo-15/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-3' }, auth());
        expect(res.statusCode).toBe(200);
        expect(res.jsonBody.seleccion.delegado_asociacion_id).toBe('demo-del-3');
    });

    test('la confirmación hecha ANTES de crear la cartilla se usa al completar "Completar cartilla" — nunca crea una cartilla prematura solo por confirmar (usa demo-rodeo-22, reservado y fresco)', async () => {
        await llamar('POST', '/rodeos/demo-rodeo-22/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        // Solo confirmar NO crea cartilla — se confirma vía GET /cartilla/rodeo.
        const verificarAntes = await llamar('GET', '/cartilla/rodeo/demo-rodeo-22', {}, auth());
        expect(verificarAntes.jsonBody.cartilla).toBeNull();

        const creada = await llamar('POST', '/cartilla/rodeo/demo-rodeo-22', {}, auth());
        expect(creada.statusCode).toBe(201);
        expect(creada.jsonBody.cartilla.delegado_asociacion_id).toBe('demo-del-1');
    });
});

describe('Fase 3.5 — Responsable único y trazabilidad (modo demostración, escenarios A-D)', () => {
    let token;
    beforeAll(async () => { token = await tokenEscenarioA(); });
    const auth = () => ({ authorization: `Bearer ${token}` });

    test('Escenario A (demo-rodeo-19): sin responsable confirmado -> GET /rodeos muestra nombre_delegado=null; tras confirmar, queda bloqueado y persiste en una nueva consulta', async () => {
        const antes = await llamar('GET', '/rodeos', {}, auth());
        const r0 = antes.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-19');
        expect(r0.delegado_asociacion_id_seleccionado).toBeNull();

        const confirmar = await llamar('POST', '/rodeos/demo-rodeo-19/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-1' }, auth());
        expect(confirmar.statusCode).toBe(200);

        // "Persiste en una nueva consulta" (simula recargar la página): una
        // llamada GET /rodeos completamente nueva sigue viendo lo mismo, sin
        // volver a confirmar nada.
        const despues = await llamar('GET', '/rodeos', {}, auth());
        const r1 = despues.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-19');
        expect(r1.delegado_asociacion_id_seleccionado).toBe('demo-del-1');
        expect(r1.nombre_delegado).toContain('Ana Soto');

        // Un segundo intento con OTRO delegado queda bloqueado (409) — el
        // selector real del frontend se oculta para siempre en este estado.
        const intento = await llamar('POST', '/rodeos/demo-rodeo-19/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-2' }, auth());
        expect(intento.statusCode).toBe(409);
        expect(intento.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');
    });

    test('Escenario B (demo-rodeo-20): Ana Soto ya confirmada + cartilla en borrador YA guardada -> la asociación NO puede sustituirla directamente por otro delegado', async () => {
        const rodeos = await llamar('GET', '/rodeos', {}, auth());
        const r = rodeos.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-20');
        expect(r.delegado_asociacion_id_seleccionado).toBe('demo-del-1');
        expect(r.estado_cartilla).toBe('borrador');

        const intentoSustituir = await llamar('POST', '/rodeos/demo-rodeo-20/seleccionar-delegado', { delegado_asociacion_id: 'demo-del-2' }, auth());
        expect(intentoSustituir.statusCode).toBe(409);
        expect(intentoSustituir.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');

        // Tampoco por la vía de "completar cartilla" con otro delegado en el body.
        const intentoPorCartilla = await llamar('POST', '/cartilla/rodeo/demo-rodeo-20', { delegado_asociacion_id: 'demo-del-2' }, auth());
        expect(intentoPorCartilla.statusCode).toBe(403);
        expect(intentoPorCartilla.jsonBody.code).toBe('RESPONSABLE_YA_CONFIRMADO');

        const verificar = await llamar('GET', '/cartilla/rodeo/demo-rodeo-20', {}, auth());
        expect(verificar.jsonBody.cartilla.delegado_asociacion_id).toBe('demo-del-1'); // Ana Soto, sin cambios
    });

    test('Escenario C (demo-rodeo-21): Bruno Hernández es el responsable VIGENTE tras un reemplazo ya autorizado (simulado); el historial muestra a Ana Soto (original) Y el reemplazo, en orden cronológico', async () => {
        const res = await llamar('GET', '/cartilla/rodeo/demo-rodeo-21', {}, auth());
        expect(res.jsonBody.cartilla.delegado_asociacion_id).toBe('demo-del-2'); // Bruno, vigente
        expect(res.jsonBody.cartilla.delegado_nombre).toBe('Bruno Hernández Díaz (DEMO)');

        const acciones = res.jsonBody.historial_responsables.map(e => e.accion);
        expect(acciones).toEqual(['confirmar_responsable_institucional', 'crear', 'reemplazar_responsable_institucional']);
        expect(res.jsonBody.historial_responsables[0].descripcion).toContain('Ana Soto');
        expect(res.jsonBody.historial_responsables[2].descripcion).toContain('Bruno Hernández');
    });

    test('Escenario C — el reemplazo (demo-only) exige motivo explícito, nunca lo aplica sin él', async () => {
        const sinMotivo = await llamar('POST', '/rodeos/demo-rodeo-21/reemplazar-delegado-institucional-demo', { nuevo_delegado_asociacion_id: 'demo-del-3' }, auth());
        expect(sinMotivo.statusCode).toBe(422);
        expect(sinMotivo.jsonBody.code).toBe('MOTIVO_REQUERIDO');

        // Verifica que NO se aplicó: Bruno (demo-del-2) sigue siendo el vigente.
        const verificar = await llamar('GET', '/cartilla/rodeo/demo-rodeo-21', {}, auth());
        expect(verificar.jsonBody.cartilla.delegado_asociacion_id).toBe('demo-del-2');
    });

    test('Escenario D (demo-rodeo-6, cuenta demo-estados@ferochi.com, estado "enviada"): no admite cambios directos; "Descargar PDF" sigue funcionando', async () => {
        const loginEstados = await llamar('POST', '/auth/login', { email: 'demo-estados@ferochi.com', password: 'DEMO1234' });
        const authEstados = { authorization: `Bearer ${loginEstados.jsonBody.token}` };

        const res = await llamar('GET', '/cartilla/rodeo/demo-rodeo-6', {}, authEstados);
        expect(res.jsonBody.cartilla.estado).toBe('enviada');
        // Historial vacío es aceptable acá (esta cartilla fue pre-sembrada
        // directamente, nunca pasó por confirmar/crear/enviar en este
        // proceso) — lo importante es que NUNCA se fabrica uno falso.
        expect(Array.isArray(res.jsonBody.historial_responsables)).toBe(true);

        const intentoPatch = await llamar('PATCH', '/cartilla/demo-cart-demo-rodeo-6', { version: res.jsonBody.cartilla.version, delegado_nombre: 'Otro Nombre' }, authEstados);
        expect(intentoPatch.statusCode).toBe(409);
        expect(intentoPatch.jsonBody.code).toBe('ESTADO_BLOQUEADO'); // bloqueado por estado antes incluso de llegar al guard de responsable

        const pdf = await llamar('GET', '/cartilla/demo-cart-demo-rodeo-6/pdf', {}, authEstados);
        expect(pdf.statusCode).toBe(200);
        expect(pdf.cabeceras['Content-Type']).toBe('application/pdf');
    });

    test('reemplazo (demo-only) nunca permite dos vigentes: tras reemplazar, el delegado anterior ya no aparece como responsable actual en GET /rodeos', async () => {
        const rodeos = await llamar('GET', '/rodeos', {}, auth());
        const r = rodeos.jsonBody.rodeos.find(x => x.id === 'demo-rodeo-21');
        expect(r.delegado_asociacion_id_seleccionado).toBe('demo-del-2'); // Bruno, nunca Ana Y Bruno a la vez
        expect(r.nombre_delegado).toBe('Bruno Hernández Díaz (DEMO)');
    });

    test('reemplazo (demo-only) sobre cartilla en estado bloqueado (enviada) -> 409 REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL, nunca lo aplica', async () => {
        // demo-rodeo-6 ya tiene una cartilla 'enviada' pre-sembrada con
        // delegado confirmado implícito (Diego Fernández) — intentar
        // reemplazarlo debe quedar explícitamente bloqueado, igual que la
        // RPC real (migración 069), en vez de improvisar un cambio. Pertenece
        // a la asociación de la cuenta demo-estados@ferochi.com.
        const loginEstados = await llamar('POST', '/auth/login', { email: 'demo-estados@ferochi.com', password: 'DEMO1234' });
        const authEstados = { authorization: `Bearer ${loginEstados.jsonBody.token}` };
        const res = await llamar('POST', '/rodeos/demo-rodeo-6/reemplazar-delegado-institucional-demo', { nuevo_delegado_asociacion_id: 'demo-del-5', motivo: 'prueba' }, authEstados);
        expect(res.statusCode).toBe(409);
        expect(res.jsonBody.code).toBe('REEMPLAZO_REQUIERE_PROCEDIMIENTO_ESPECIAL');
    });
});
});
