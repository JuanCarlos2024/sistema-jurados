const { obtenerHistorialResponsables } = require('./historialResponsableInstitucional');

function crearChain(data) {
    const chain = {};
    ['select', 'eq'].forEach(m => { chain[m] = () => chain; });
    chain.order = () => Promise.resolve({ data, error: null });
    return chain;
}

describe('obtenerHistorialResponsables', () => {
    test('sin designacionId ni cartillaId -> arreglo vacío, nunca consulta nada', async () => {
        const supabase = { from: jest.fn() };
        const r = await obtenerHistorialResponsables(supabase, {});
        expect(r).toEqual([]);
        expect(supabase.from).not.toHaveBeenCalled();
    });

    test('fusiona los eventos de rodeos_delegado_institucional Y cartillas_delegado, ordenados cronológicamente', async () => {
        const eventosDesignacion = [
            { id: 'a1', tabla: 'rodeos_delegado_institucional', accion: 'confirmar_responsable_institucional', created_at: '2026-09-01T10:00:00Z' },
            { id: 'a3', tabla: 'rodeos_delegado_institucional', accion: 'reemplazar_responsable_institucional', created_at: '2026-09-03T10:00:00Z' }
        ];
        const eventosCartilla = [
            { id: 'a2', tabla: 'cartillas_delegado', accion: 'crear', created_at: '2026-09-02T10:00:00Z' },
            { id: 'a4', tabla: 'cartillas_delegado', accion: 'guardar', created_at: '2026-09-04T10:00:00Z' }
        ];
        const supabase = {
            from: jest.fn((tabla) => crearChain(tabla === 'auditoria' ? null : null))
        };
        // El mock necesita distinguir por .eq('tabla', X) — se simula con dos
        // llamadas independientes a from('auditoria') devolviendo cada una su
        // propio conjunto, en el orden en que el servicio las invoca.
        let llamada = 0;
        supabase.from = jest.fn(() => {
            llamada += 1;
            return crearChain(llamada === 1 ? eventosDesignacion : eventosCartilla);
        });

        const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1', cartillaId: 'c1' });
        expect(r.map(e => e.id)).toEqual(['a1', 'a2', 'a3', 'a4']); // orden cronológico, fusionado
    });

    test('solo designacionId (sin cartilla todavía) -> solo consulta esa fuente', async () => {
        const supabase = { from: jest.fn(() => crearChain([{ id: 'a1', created_at: '2026-09-01T10:00:00Z' }])) };
        const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1' });
        expect(supabase.from).toHaveBeenCalledTimes(1);
        expect(r).toHaveLength(1);
    });

    test('sin ningún evento auditado -> arreglo vacío (nunca fabrica un evento)', async () => {
        const supabase = { from: jest.fn(() => crearChain([])) };
        const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1', cartillaId: 'c1' });
        expect(r).toEqual([]);
    });

    // Fase 3.5.1 — sección 3: "administrador autorizante" se resuelve por
    // NOMBRE, no solo por id (UUID), para eventos de reemplazo.
    describe('resolución del nombre del administrador autorizante', () => {
        function crearSupabaseConAdmins(eventos, admins) {
            let llamada = 0;
            return {
                from: jest.fn((tabla) => {
                    llamada += 1;
                    if (tabla === 'administradores') {
                        return { select: () => ({ in: () => Promise.resolve({ data: admins, error: null }) }) };
                    }
                    return crearChain(eventos);
                })
            };
        }

        test('evento con actor_tipo=administrador -> agrega actor_nombre resuelto, en UNA sola consulta batched a administradores', async () => {
            const eventos = [{ id: 'a1', actor_id: 'admin-1', actor_tipo: 'administrador', created_at: '2026-09-03T10:00:00Z' }];
            const supabase = crearSupabaseConAdmins(eventos, [{ id: 'admin-1', nombre_completo: 'Pedro Pérez' }]);
            const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1' });
            expect(r[0].actor_nombre).toBe('Pedro Pérez');
            expect(supabase.from).toHaveBeenCalledWith('administradores');
        });

        test('evento con actor_tipo=cuenta_institucional -> NUNCA consulta administradores, nunca agrega actor_nombre', async () => {
            const eventos = [{ id: 'a1', actor_id: 'cuenta-1', actor_tipo: 'cuenta_institucional', created_at: '2026-09-01T10:00:00Z' }];
            const supabase = { from: jest.fn(() => crearChain(eventos)) };
            const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1' });
            expect(r[0].actor_nombre).toBeUndefined();
            expect(supabase.from).not.toHaveBeenCalledWith('administradores');
        });

        test('administrador cuyo id ya no resuelve (cuenta eliminada) -> actor_nombre=null, nunca se inventa un nombre', async () => {
            const eventos = [{ id: 'a1', actor_id: 'admin-fantasma', actor_tipo: 'administrador', created_at: '2026-09-03T10:00:00Z' }];
            const supabase = crearSupabaseConAdmins(eventos, []);
            const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1' });
            expect(r[0].actor_nombre).toBeNull();
        });

        test('reemplazo -> agrega delegado_anterior_nombre desde el catálogo (una consulta batched); id que no resuelve -> null', async () => {
            const eventos = [
                { id: 'a1', accion: 'reemplazar_responsable_institucional', actor_tipo: 'cuenta_x', datos_anteriores: { delegado_asociacion_id: 'del-pablo' }, created_at: '2026-11-15T10:00:00Z' },
                { id: 'a2', accion: 'reemplazar_responsable_institucional', actor_tipo: 'cuenta_x', datos_anteriores: { delegado_asociacion_id: 'del-borrado' }, created_at: '2026-11-16T10:00:00Z' },
                { id: 'a3', accion: 'guardar', actor_tipo: 'cuenta_x', created_at: '2026-11-17T10:00:00Z' }
            ];
            let consultas = 0, ids = null;
            const supabase = {
                from: jest.fn((tabla) => {
                    if (tabla === 'delegados_asociacion') {
                        consultas += 1;
                        return { select: () => ({ in: (_c, v) => { ids = v; return Promise.resolve({ data: [{ id: 'del-pablo', nombre: 'Pablo Bijit' }], error: null }); } }) };
                    }
                    return crearChain(eventos);
                })
            };
            const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1' });
            expect(consultas).toBe(1);
            expect(ids).toEqual(['del-pablo', 'del-borrado']);
            expect(r.find(e => e.id === 'a1').delegado_anterior_nombre).toBe('Pablo Bijit');
            expect(r.find(e => e.id === 'a2').delegado_anterior_nombre).toBeNull();
            expect(r.find(e => e.id === 'a3').delegado_anterior_nombre).toBeUndefined();
        });

        test('evento de la migración 102 (trae datos_anteriores.delegado_nombre) -> usa ese nombre y NO consulta el catálogo', async () => {
            const eventos = [{ id: 'a1', accion: 'reemplazar_responsable_institucional', actor_tipo: 'cuenta_x',
                datos_anteriores: { delegado_asociacion_id: 'del-pablo', delegado_nombre: 'Pablo Bijit' }, created_at: '2026-11-17T10:00:00Z' }];
            const supabase = { from: jest.fn(() => crearChain(eventos)) };
            const r = await obtenerHistorialResponsables(supabase, { designacionId: 'd1' });
            expect(r[0].delegado_anterior_nombre).toBe('Pablo Bijit');
            expect(supabase.from).not.toHaveBeenCalledWith('delegados_asociacion');
        });

        test('varios eventos del MISMO administrador -> una sola consulta con ids únicos (nunca una por evento)', async () => {
            const eventos = [
                { id: 'a1', actor_id: 'admin-1', actor_tipo: 'administrador', created_at: '2026-09-03T10:00:00Z' },
                { id: 'a2', actor_id: 'admin-1', actor_tipo: 'administrador', created_at: '2026-09-05T10:00:00Z' }
            ];
            let idsConsultados = null;
            const supabase = {
                from: jest.fn((tabla) => {
                    if (tabla === 'administradores') {
                        return { select: () => ({ in: (_col, ids) => { idsConsultados = ids; return Promise.resolve({ data: [{ id: 'admin-1', nombre_completo: 'Pedro Pérez' }], error: null }); } }) };
                    }
                    return crearChain(eventos);
                })
            };
            await obtenerHistorialResponsables(supabase, { designacionId: 'd1' });
            expect(idsConsultados).toEqual(['admin-1']); // único, sin duplicar
        });
    });
});
