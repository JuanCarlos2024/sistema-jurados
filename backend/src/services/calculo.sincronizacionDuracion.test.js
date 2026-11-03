// Tests de sincronizarAsignacionesPorCambioDuracion() — corrección del bug
// "ANCUD/CHILOÉ" (jurado Augusto González): al editar el tipo/duración de un
// rodeo ya designado, las asignaciones existentes quedaban con
// duracion_dias_aplicada/pago_base_calculado congelados del valor anterior
// indefinidamente — el portal del jurado y el admin (Total pagos, reportes,
// exportaciones, planillas: todos leen estas mismas columnas) seguían
// mostrando datos viejos. Esta función sincroniza esa copia de forma segura
// e idempotente cuando el admin cambia la duración del rodeo.
//
// Se mockea `../config/supabase` y `./auditoria`. La función bajo prueba es
// real — nunca se reimplementa su lógica.
jest.mock('../config/supabase', () => ({ from: jest.fn() }));
jest.mock('./auditoria', () => ({ registrar: jest.fn().mockResolvedValue(undefined) }));

const supabase = require('../config/supabase');
const auditoria = require('./auditoria');
const { sincronizarAsignacionesPorCambioDuracion } = require('./calculo');

// Chain mock mínimo: cada tabla responde según lo configurado en `porTabla`.
// 'asignaciones' tiene dos usos distintos (SELECT de listado y UPDATE por
// id) — se distinguen porque update() se intercepta aparte para registrar
// los payloads reales enviados (updateCalls), en vez de depender del orden.
function crearMock({ asignacionesSelect = [], importacionesSelect = [], erroresPorTabla = {} } = {}) {
    const updateCalls = [];
    supabase.from.mockImplementation((tabla) => {
        if (tabla === 'asignaciones') {
            return {
                select: () => ({
                    eq: () => ({
                        eq: () => Promise.resolve(
                            erroresPorTabla.asignaciones
                                ? { data: null, error: erroresPorTabla.asignaciones }
                                : { data: asignacionesSelect, error: null }
                        )
                    })
                }),
                update: (payload) => ({
                    eq: (_col, id) => {
                        updateCalls.push({ id, payload });
                        return Promise.resolve(
                            erroresPorTabla.update ? { error: erroresPorTabla.update } : { error: null }
                        );
                    }
                })
            };
        }
        if (tabla === 'importaciones') {
            return {
                select: () => ({
                    in: () => ({
                        eq: () => Promise.resolve(
                            erroresPorTabla.importaciones
                                ? { data: null, error: erroresPorTabla.importaciones }
                                : { data: importacionesSelect, error: null }
                        )
                    })
                })
            };
        }
        throw new Error('tabla inesperada en el mock: ' + tabla);
    });
    return { updateCalls };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Caso base: sin asignaciones para el rodeo', () => {
    test('no hace ninguna consulta de importaciones ni ningún update', async () => {
        crearMock({ asignacionesSelect: [] });
        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);
        expect(resultado).toEqual({ actualizadas: 0, omitidas_historicas: 0, sin_cambio: 0 });
        expect(supabase.from).toHaveBeenCalledTimes(1); // solo el select de asignaciones
    });
});

describe('Idempotencia (Caso 8 del pedido: no duplicar ni alterar de más)', () => {
    test('todas las asignaciones ya tienen la duración vigente -> no actualiza nada, no llama a importaciones ni a auditoría', async () => {
        crearMock({
            asignacionesSelect: [
                { id: 'a1', importacion_id: null, valor_diario_aplicado: 213500, duracion_dias_aplicada: 2, pago_base_calculado: 427000 }
            ]
        });
        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);
        expect(resultado).toEqual({ actualizadas: 0, omitidas_historicas: 0, sin_cambio: 1 });
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('llamar dos veces consecutivas con la misma duración nueva -> la segunda vez es sin_cambio (no reaplica ni reauditoría)', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'a1', importacion_id: null, valor_diario_aplicado: 213500, duracion_dias_aplicada: 1, pago_base_calculado: 213500 }
            ]
        });
        const r1 = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);
        expect(r1).toEqual({ actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 });
        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0].payload.pago_base_calculado).toBe(427000);

        jest.clearAllMocks();
        // Segunda llamada: ahora la asignación YA refleja la duración 2 (estado real tras la primera corrida)
        crearMock({
            asignacionesSelect: [
                { id: 'a1', importacion_id: null, valor_diario_aplicado: 213500, duracion_dias_aplicada: 2, pago_base_calculado: 427000 }
            ]
        });
        const r2 = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);
        expect(r2).toEqual({ actualizadas: 0, omitidas_historicas: 0, sin_cambio: 1 });
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });
});

describe('Caso 1 del pedido: de un día a dos días (ANCUD, categoría C)', () => {
    test('recalcula pago_base_calculado = valor_diario_aplicado × nueva duración, preservando la tarifa ya aplicada', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'asig-ancud', importacion_id: null, valor_diario_aplicado: 213500, duracion_dias_aplicada: 1, pago_base_calculado: 213500 }
            ]
        });
        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-ancud', 2, { actor_id: 'admin-1', ip_address: '10.0.0.1' });

        expect(resultado).toEqual({ actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 });
        expect(updateCalls).toEqual([{
            id: 'asig-ancud',
            payload: expect.objectContaining({ duracion_dias_aplicada: 2, pago_base_calculado: 427000 })
        }]);
        expect(auditoria.registrar).toHaveBeenCalledWith(expect.objectContaining({
            tabla: 'asignaciones', registro_id: 'asig-ancud', accion: 'editar',
            datos_anteriores: { duracion_dias_aplicada: 1, pago_base_calculado: 213500 },
            datos_nuevos: { duracion_dias_aplicada: 2, pago_base_calculado: 427000 },
            actor_id: 'admin-1', ip_address: '10.0.0.1'
        }));
    });
});

describe('Caso 2 del pedido: de dos días a un día', () => {
    test('reduce pago_base_calculado a la mitad (no conserva el valor anterior)', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'a1', importacion_id: null, valor_diario_aplicado: 245000, duracion_dias_aplicada: 2, pago_base_calculado: 490000 }
            ]
        });
        await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 1);
        expect(updateCalls[0].payload.pago_base_calculado).toBe(245000);
        expect(updateCalls[0].payload.duracion_dias_aplicada).toBe(1);
    });
});

describe('Caso 4 del pedido: override manual de tarifa se preserva', () => {
    test('valor_diario_aplicado manualmente distinto de la tarifa estándar de la categoría se mantiene intacto al recalcular', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                // Override manual admin: 300000/día en vez del estándar de su categoría — nunca se reemplaza por el de catálogo
                { id: 'a1', importacion_id: null, valor_diario_aplicado: 300000, duracion_dias_aplicada: 1, pago_base_calculado: 300000 }
            ]
        });
        await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);
        expect(updateCalls[0].payload.pago_base_calculado).toBe(600000);
        expect(updateCalls[0].payload).not.toHaveProperty('valor_diario_aplicado');
        expect(updateCalls[0].payload).not.toHaveProperty('categoria_aplicada');
    });
});

describe('Caso 5 del pedido: varios jurados/delegados asignados al mismo rodeo', () => {
    test('todas se actualizan de forma independiente, con su propia tarifa, sin duplicar ni alterar la identidad', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'jurado-A', importacion_id: null, valor_diario_aplicado: 292000, duracion_dias_aplicada: 1, pago_base_calculado: 292000 },
                { id: 'jurado-B', importacion_id: null, valor_diario_aplicado: 245000, duracion_dias_aplicada: 1, pago_base_calculado: 245000 },
                { id: 'delegado-rentado', importacion_id: null, valor_diario_aplicado: 180000, duracion_dias_aplicada: 1, pago_base_calculado: 180000 }
            ]
        });
        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);

        expect(resultado.actualizadas).toBe(3);
        expect(updateCalls).toHaveLength(3);
        expect(updateCalls.find(u => u.id === 'jurado-A').payload.pago_base_calculado).toBe(584000);
        expect(updateCalls.find(u => u.id === 'jurado-B').payload.pago_base_calculado).toBe(490000);
        expect(updateCalls.find(u => u.id === 'delegado-rentado').payload.pago_base_calculado).toBe(360000);
    });
});

describe('Caso 7 del pedido: pagos históricos (importación histórica) nunca se alteran', () => {
    test('asignación con importacion_id de tipo historico_rodeos -> se omite, no se actualiza ni se audita', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'historica-1', importacion_id: 'imp-1', valor_diario_aplicado: 0, duracion_dias_aplicada: 1, pago_base_calculado: 0 }
            ],
            importacionesSelect: [{ id: 'imp-1' }]
        });
        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);

        expect(resultado).toEqual({ actualizadas: 0, omitidas_historicas: 1, sin_cambio: 0 });
        expect(updateCalls).toHaveLength(0);
        expect(auditoria.registrar).not.toHaveBeenCalled();
    });

    test('mixta: una histórica + una normal en el mismo rodeo -> solo se actualiza la normal', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'historica-1', importacion_id: 'imp-1', valor_diario_aplicado: 0, duracion_dias_aplicada: 1, pago_base_calculado: 0 },
                { id: 'normal-1', importacion_id: null, valor_diario_aplicado: 213500, duracion_dias_aplicada: 1, pago_base_calculado: 213500 }
            ],
            importacionesSelect: [{ id: 'imp-1' }]
        });
        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);

        expect(resultado).toEqual({ actualizadas: 1, omitidas_historicas: 1, sin_cambio: 0 });
        expect(updateCalls).toEqual([{ id: 'normal-1', payload: expect.objectContaining({ pago_base_calculado: 427000 }) }]);
    });

    test('importacion_id presente pero NO es de tipo historico_rodeos (otra importación cualquiera) -> se sincroniza igual, nunca se bloquea por error', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'a1', importacion_id: 'imp-no-historica', valor_diario_aplicado: 213500, duracion_dias_aplicada: 1, pago_base_calculado: 213500 }
            ],
            importacionesSelect: [] // la query con .eq('tipo','historico_rodeos') no devuelve esta importación
        });
        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2);
        expect(resultado.actualizadas).toBe(1);
        expect(updateCalls[0].payload.pago_base_calculado).toBe(427000);
    });
});

describe('Escenario ANCUD completo (1 día -> 2 días) y su inverso — todas las invariantes pedidas explícitamente', () => {
    test('estado inicial 1 día/$213.500 -> Provincial 3 series/2 días: tipo ya actualizado por el admin (no es responsabilidad de esta función), duración aplicada 1->2, pago 213.500->427.000, y el payload del UPDATE NUNCA toca identidad/aceptación/cartillas/evaluaciones', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'asig-ancud-augusto', importacion_id: null, valor_diario_aplicado: 213500, duracion_dias_aplicada: 1, pago_base_calculado: 213500 }
            ]
        });

        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-ancud', 2, { actor_id: 'admin-1' });

        expect(resultado).toEqual({ actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 });
        expect(updateCalls).toHaveLength(1); // no se duplica ninguna asignación: un único UPDATE, nunca un INSERT
        const payload = updateCalls[0].payload;
        expect(payload.duracion_dias_aplicada).toBe(2);
        expect(payload.pago_base_calculado).toBe(427000);
        // Nunca cambia identidad, aceptación/rechazo, publicación, ni toca evaluaciones/cartillas/antecedentes:
        // el UPDATE solo contiene estas 3 claves, nunca más.
        expect(Object.keys(payload).sort()).toEqual(['duracion_dias_aplicada', 'pago_base_calculado', 'updated_at']);
        expect(payload).not.toHaveProperty('usuario_pagado_id');
        expect(payload).not.toHaveProperty('estado_designacion');
        expect(payload).not.toHaveProperty('aceptado_en');
        expect(payload).not.toHaveProperty('publicado');
        expect(payload).not.toHaveProperty('categoria_aplicada');
        expect(payload).not.toHaveProperty('valor_diario_aplicado');
    });

    test('inverso: Provincial 3 series/2 días -> Provincial 1 día: duración aplicada 2->1, pago 427.000->213.500, mismas invariantes de identidad intactas', async () => {
        const { updateCalls } = crearMock({
            asignacionesSelect: [
                { id: 'asig-ancud-augusto', importacion_id: null, valor_diario_aplicado: 213500, duracion_dias_aplicada: 2, pago_base_calculado: 427000 }
            ]
        });

        const resultado = await sincronizarAsignacionesPorCambioDuracion('rodeo-ancud', 1, { actor_id: 'admin-1' });

        expect(resultado).toEqual({ actualizadas: 1, omitidas_historicas: 0, sin_cambio: 0 });
        const payload = updateCalls[0].payload;
        expect(payload.duracion_dias_aplicada).toBe(1);
        expect(payload.pago_base_calculado).toBe(213500);
        expect(Object.keys(payload).sort()).toEqual(['duracion_dias_aplicada', 'pago_base_calculado', 'updated_at']);
    });

    // Nota: "el tipo de rodeo se mantiene correctamente actualizado", "el
    // portal del jurado muestra 2 días", "el resumen financiero muestra el
    // pago actualizado", "el administrador muestra el total correcto" y
    // "las exportaciones y reportes utilizan el monto actualizado" no se
    // vuelven a probar aquí: todos esos consumidores (dashboard.html,
    // calculo.js#calcularResumenMensual, rodeosListado.js, exportacion.js,
    // reportes.js) leen directamente rodeos.duracion_dias/tipo_rodeo_nombre
    // y asignaciones.duracion_dias_aplicada/pago_base_calculado — las mismas
    // columnas que este test confirma arriba que quedan sincronizadas. No
    // existe una copia adicional en ningún otro lugar (confirmado por
    // revisión de código): una vez estas dos columnas están correctas, todos
    // esos consumidores lo están automáticamente, sin cambios propios.
});

describe('Manejo de errores — nunca se ocultan silenciosamente', () => {
    test('error al leer asignaciones -> lanza, no devuelve un resultado falso de éxito', async () => {
        crearMock({ erroresPorTabla: { asignaciones: { message: 'DB caída' } } });
        await expect(sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2)).rejects.toThrow('DB caída');
    });

    test('error al verificar importaciones históricas -> lanza', async () => {
        crearMock({
            asignacionesSelect: [{ id: 'a1', importacion_id: 'imp-1', valor_diario_aplicado: 100, duracion_dias_aplicada: 1, pago_base_calculado: 100 }],
            erroresPorTabla: { importaciones: { message: 'timeout' } }
        });
        await expect(sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2)).rejects.toThrow('timeout');
    });

    test('error al actualizar una asignación -> lanza (no sigue silenciosamente con las demás a mitad de camino)', async () => {
        crearMock({
            asignacionesSelect: [{ id: 'a1', importacion_id: null, valor_diario_aplicado: 100, duracion_dias_aplicada: 1, pago_base_calculado: 100 }],
            erroresPorTabla: { update: { message: 'constraint violada' } }
        });
        await expect(sincronizarAsignacionesPorCambioDuracion('rodeo-1', 2)).rejects.toThrow('constraint violada');
    });
});
