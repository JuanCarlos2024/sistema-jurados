const { claveClubAsociacion, sugerirComunaParaClub } = require('./clubUbicaciones');

const catalogo = {
    comunas: [
        { id: 'c-sancarlos', nombre: 'San Carlos', nombre_normalizado: 'san carlos', region: 'Bío Bío', latitud: -36.4, longitud: -71.9 },
        { id: 'c-petorca', nombre: 'Petorca', nombre_normalizado: 'petorca', region: 'Valparaíso', latitud: -32.25, longitud: -70.73 },
        { id: 'c-casablanca', nombre: 'Casablanca', nombre_normalizado: 'casablanca', region: 'Valparaíso', latitud: -33.32, longitud: -71.41 }
    ],
    alias: [
        { alias_normalizado: 'san vicente de tagua tagua', comuna_id: 'c-sanvicente' }
    ]
};

describe('sugerirComunaParaClub — sugerencias seguras, sin fuzzy matching', () => {
    test('CASO 5: coincidencia exacta club=comuna → sugiere', () => {
        const s = sugerirComunaParaClub('SAN CARLOS', 'ÑUBLE', new Map(), catalogo);
        expect(s).not.toBeNull();
        expect(s.comuna_id).toBe('c-sancarlos');
        expect(s.origen).toBe('coincidencia_exacta');
    });

    test('CASO 6/7: club que es una localidad, no una comuna (CHINCOLCO) → NO sugiere nada (no fuzzy, no inventa)', () => {
        const s = sugerirComunaParaClub('CHINCOLCO', 'PETORCA', new Map(), catalogo);
        expect(s).toBeNull();
    });

    test('club_ubicacion (relación confirmada) tiene prioridad sobre la coincidencia exacta por nombre', () => {
        const mapa = new Map();
        mapa.set(claveClubAsociacion('SAN CARLOS', 'ÑUBLE'), { comuna_id: 'c-casablanca', comuna_nombre: 'Casablanca' });
        // Aunque "SAN CARLOS" coincidiría exacto con la comuna San Carlos, si el
        // administrador ya confirmó una ubicación habitual distinta, esa gana.
        const s = sugerirComunaParaClub('SAN CARLOS', 'ÑUBLE', mapa, catalogo);
        expect(s.comuna_id).toBe('c-casablanca');
        expect(s.origen).toBe('club_ubicacion');
    });

    test('club_ubicacion resuelve localidades sin coincidencia de nombre (CHINCOLCO confirmado → Petorca)', () => {
        const mapa = new Map();
        mapa.set(claveClubAsociacion('CHINCOLCO', 'PETORCA'), { comuna_id: 'c-petorca', comuna_nombre: 'Petorca' });
        const s = sugerirComunaParaClub('CHINCOLCO', 'PETORCA', mapa, catalogo);
        expect(s.comuna_id).toBe('c-petorca');
        expect(s.origen).toBe('club_ubicacion');
    });

    test('la relación es por CLUB + ASOCIACIÓN: la misma comuna habitual no aplica a otra asociación distinta', () => {
        const mapa = new Map();
        mapa.set(claveClubAsociacion('SAN CARLOS', 'ÑUBLE'), { comuna_id: 'c-casablanca', comuna_nombre: 'Casablanca' });
        // Mismo nombre de club, asociación distinta → no hereda la relación de ÑUBLE.
        // Sin coincidencia exacta explícita tampoco (para no encubrir el caso con
        // el fallback), se usa una asociación que no tiene relación registrada.
        const s = sugerirComunaParaClub('SAN CARLOS', 'OTRA ASOCIACION', mapa, catalogo);
        // No hay club_ubicacion para esta asociación, pero SAN CARLOS sigue
        // coincidiendo exacto con la comuna San Carlos vía catálogo.
        expect(s.origen).toBe('coincidencia_exacta');
        expect(s.comuna_id).toBe('c-sancarlos');
    });

    test('"Sin club" nunca genera sugerencia, aunque coincidiera por casualidad', () => {
        expect(sugerirComunaParaClub('Sin club', 'Cualquiera', new Map(), catalogo)).toBeNull();
        expect(sugerirComunaParaClub('SIN CLUB', 'Cualquiera', new Map(), catalogo)).toBeNull();
    });

    test('club vacío o nulo → sin sugerencia', () => {
        expect(sugerirComunaParaClub('', 'X', new Map(), catalogo)).toBeNull();
        expect(sugerirComunaParaClub(null, 'X', new Map(), catalogo)).toBeNull();
    });

    test('no hace fuzzy matching de nombres parecidos', () => {
        // "Casa Blanca" (con espacio) no es exactamente "Casablanca" tras normalizar
        const s = sugerirComunaParaClub('Casa Blanca Rural', 'X', new Map(), catalogo);
        expect(s).toBeNull();
    });

    test('claveClubAsociacion normaliza de forma consistente (mayúsculas/tildes/espacios)', () => {
        expect(claveClubAsociacion('San Carlos', 'Ñuble')).toBe(claveClubAsociacion('SAN CARLOS', 'ÑUBLE'));
        expect(claveClubAsociacion('  San Carlos  ', 'Ñuble')).toBe(claveClubAsociacion('San Carlos', 'ÑUBLE'));
    });

    test('CASO — actualizar ubicación habitual: guardar dos veces el mismo club+asociación con distinta comuna produce la MISMA clave (precondición de la actualización sin duplicados)', () => {
        // El endpoint POST /club-ubicacion hace upsert sobre
        // (club_nombre_normalizado, asociacion_normalizada) — índice único NO
        // parcial en la migración 046 (corregido: la versión inicial usaba un
        // índice parcial WHERE activo=true, que Postgres no puede usar como
        // "arbiter" de ON CONFLICT vía PostgREST/Supabase-js, y el upsert
        // fallaba en vez de actualizar). La condición necesaria para que el
        // upsert actualice la misma fila en vez de intentar duplicarla es que
        // ambas llamadas generen la MISMA clave — verificado aquí. El
        // resultado real (una sola fila, comuna_id actualizado, mismo id y
        // created_at) fue validado en vivo contra la base de datos real tras
        // aplicar la migración corregida (ver informe de la Etapa de cierre).
        const claveAntes = claveClubAsociacion('CASABLANCA', 'VALPARAÍSO');
        const claveDespues = claveClubAsociacion('CASABLANCA', 'VALPARAÍSO');
        expect(claveAntes).toBe(claveDespues);

        const mapa = new Map();
        mapa.set(claveAntes, { comuna_id: 'c-casablanca', comuna_nombre: 'Casablanca' });
        const sugerenciaConValorViejo = sugerirComunaParaClub('CASABLANCA', 'VALPARAÍSO', mapa, catalogo);
        expect(sugerenciaConValorViejo.comuna_id).toBe('c-casablanca');

        // Simula la actualización: se reemplaza el valor en el mapa para la
        // MISMA clave (esto es exactamente lo que hace el UPDATE del upsert
        // sobre la fila existente, sin crear una segunda fila).
        mapa.set(claveDespues, { comuna_id: 'c-petorca', comuna_nombre: 'Petorca' });
        expect(mapa.size).toBe(1); // sigue habiendo una sola entrada para esta clave
        const sugerenciaConValorNuevo = sugerirComunaParaClub('CASABLANCA', 'VALPARAÍSO', mapa, catalogo);
        expect(sugerenciaConValorNuevo.comuna_id).toBe('c-petorca');
    });
});
