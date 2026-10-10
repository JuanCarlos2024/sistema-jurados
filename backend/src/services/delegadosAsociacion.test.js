const { prepararCatalogoDelegados, claveExactaNombre, claveAmpliaNombre } = require('./delegadosAsociacion');

const CATALOGO = [
    { id: 'id-cardenal-caro', nombre: 'CARDENAL CARO', nombre_normalizado: 'cardenal caro' },
    { id: 'id-osorno', nombre: 'OSORNO', nombre_normalizado: 'osorno' },
    { id: 'id-valparaiso', nombre: 'VALPARAISO', nombre_normalizado: 'valparaiso' },
    { id: 'id-biobio', nombre: 'BIO BIO', nombre_normalizado: 'bio bio' }
];
const ALIAS = [
    { asociacion_id: 'id-biobio', alias: 'Biobío', alias_normalizado: 'biobio' }
];

describe('claveExactaNombre / claveAmpliaNombre', () => {
    test('claveExactaNombre colapsa espacios y pasa a minúsculas, pero conserva tildes', () => {
        expect(claveExactaNombre('  José   Pérez  ')).toBe('josé pérez');
    });
    test('claveAmpliaNombre además quita tildes', () => {
        expect(claveAmpliaNombre('José Pérez')).toBe('jose perez');
        expect(claveAmpliaNombre('Jose Perez')).toBe('jose perez');
    });
});

describe('prepararCatalogoDelegados — nunca escribe nada, es función pura', () => {
    test('CASO real de la auditoría: misma persona + misma asociación en 2 filas (evaluaciones distintas) se consolida en UN solo registro', () => {
        // Mismo caso que "Patricio Olguin" en LISTADELEGADOS.xlsx: 2 filas, misma
        // persona, misma asociación, puntaje distinto en el excel (ignorado aquí).
        const filas = [
            { nombre: 'Patricio Olguin', asociacion: 'Cardenal Caro' },
            { nombre: 'Patricio Olguin', asociacion: 'Cardenal Caro' }
        ];
        const r = prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        expect(r.listos).toHaveLength(1);
        expect(r.listos[0]).toMatchObject({ nombre: 'Patricio Olguin', asociacion_id: 'id-cardenal-caro', ocurrencias: 2 });
        expect(r.duplicados_exactos_consolidados).toBe(1);
        expect(r.pendientes).toHaveLength(0);
    });

    test('NO importa columnas de evaluación: aunque la fila traiga buenas/porcentaje/nota, el resultado solo usa nombre+asociación', () => {
        const filas = [
            { nombre: 'Juan Pérez', asociacion: 'Osorno', buenas: 16, porcentaje: 0.8, nota: 5.8 }
        ];
        const r = prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        expect(r.listos[0]).toEqual({ nombre: 'Juan Pérez', asociacion_id: 'id-osorno', asociacion_nombre: 'OSORNO', ocurrencias: 1 });
        expect(r.listos[0].buenas).toBeUndefined();
        expect(r.listos[0].nota).toBeUndefined();
    });

    test('asociación SIN equivalencia en el catálogo real queda pendiente, NUNCA se descarta ni se adivina', () => {
        // Ejemplo genérico (no "Cuyo": confirmado por el usuario que SÍ existe en el
        // catálogo real y SÍ tiene delegados certificados — ver test dedicado abajo).
        const filas = [{ nombre: 'Alguien de Asociación Inexistente', asociacion: 'Asociación Inexistente XYZ' }];
        const r = prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        expect(r.listos).toHaveLength(0);
        expect(r.pendientes).toEqual([{ nombre: 'Alguien de Asociación Inexistente', asociacion_texto_original: 'Asociación Inexistente XYZ', motivo: 'sin_equivalencia_en_catalogo' }]);
    });

    test('CONFIRMADO por el usuario: los 11 delegados reales de CUYO quedan certificados, vinculados a CUYO, sin duplicados', () => {
        // Nombres reales verificados en LISTADELEGADOS.xlsx (filas 107-117). CUYO sí
        // existe en el catálogo real de producción (confirmado por consulta de solo
        // lectura) — a diferencia del ejemplo genérico de "sin equivalencia" de arriba.
        const catalogoConCuyo = [...CATALOGO, { id: 'id-cuyo', nombre: 'CUYO', nombre_normalizado: 'cuyo' }];
        const nombresCuyo = [
            'Alejandro Martín Livellara', 'Celasso Nicolas', 'César Baigorri',
            'Daniel Ángel Vicente Martínez', 'Daniel Mut', 'Darío Leonardo Guillén',
            'Donnici Mauricio', 'Fabian Horacio Gomez', 'Santiago Gomez Vidal',
            'Varas Javier', 'Walter Luna'
        ];
        const filas = nombresCuyo.map(nombre => ({ nombre, asociacion: 'Cuyo' }));
        const r = prepararCatalogoDelegados(filas, catalogoConCuyo, ALIAS);

        expect(r.pendientes).toHaveLength(0); // ninguno queda pendiente de validación
        expect(r.listos).toHaveLength(11);    // los 11, certificados
        for (const l of r.listos) expect(l.asociacion_id).toBe('id-cuyo'); // vinculados exclusivamente a CUYO
        expect(new Set(r.listos.map(l => l.nombre)).size).toBe(11); // sin duplicados
        expect(r.listos.map(l => l.nombre).sort()).toEqual([...nombresCuyo].sort()); // nombres originales conservados
    });

    test('resuelve correctamente vía ALIAS (ej. "Biobío" -> catálogo real "BIO BIO"), sin ILIKE ni fuzzy matching', () => {
        const filas = [{ nombre: 'Delegado X', asociacion: 'Biobío' }];
        const r = prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        expect(r.listos).toEqual([{ nombre: 'Delegado X', asociacion_id: 'id-biobio', asociacion_nombre: 'BIO BIO', ocurrencias: 1 }]);
    });

    test('variante sospechosa (tildes/mayúsculas distintas, misma asociación) se reporta pero NUNCA se fusiona automáticamente', () => {
        const filas = [
            { nombre: 'José Pérez', asociacion: 'Osorno' },
            { nombre: 'Jose Perez', asociacion: 'Osorno' }
        ];
        const r = prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        // Dos registros DISTINTOS en "listos" (no se fusionaron):
        expect(r.listos).toHaveLength(2);
        expect(r.listos.map(l => l.nombre).sort()).toEqual(['Jose Perez', 'José Pérez']);
        // Pero sí quedan marcados como variante sospechosa para revisión humana:
        expect(r.variantes_sospechosas).toHaveLength(1);
        expect(r.variantes_sospechosas[0].sort()).toEqual(['Jose Perez', 'José Pérez']);
    });

    test('misma persona en DOS asociaciones distintas no se trata como duplicado (puede ser legítimo)', () => {
        const filas = [
            { nombre: 'Ana Soto', asociacion: 'Osorno' },
            { nombre: 'Ana Soto', asociacion: 'Valparaiso' }
        ];
        const r = prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        expect(r.listos).toHaveLength(2);
        expect(r.duplicados_exactos_consolidados).toBe(0);
    });

    test('filas con nombre o asociación vacíos/solo espacios se descartan y se cuentan, sin romper el resto', () => {
        const filas = [
            { nombre: '  ', asociacion: 'Osorno' },
            { nombre: 'Juan Pérez', asociacion: '' },
            { nombre: 'Juan Pérez', asociacion: 'Osorno' }
        ];
        const r = prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        expect(r.filas_descartadas_vacias).toBe(2);
        expect(r.listos).toHaveLength(1);
    });

    test('catálogo vacío/no disponible -> todo queda pendiente, nunca se asume un universo improvisado', () => {
        const filas = [{ nombre: 'Juan Pérez', asociacion: 'Osorno' }];
        const r = prepararCatalogoDelegados(filas, [], []);
        expect(r.listos).toHaveLength(0);
        expect(r.pendientes).toEqual([{ nombre: 'Juan Pérez', asociacion_texto_original: 'Osorno', motivo: 'sin_equivalencia_en_catalogo' }]);
    });

    test('CONFIRMADO por el usuario: BÍO BÍO y RÍO BÍO BÍO son asociaciones independientes y NUNCA se fusionan, aunque ambas existan en el catálogo', () => {
        const catalogoReal = [
            ...CATALOGO,
            { id: 'id-bio-bio', nombre: 'BÍO-BÍO', nombre_normalizado: 'bio bio' },
            { id: 'id-rio-bio-bio', nombre: 'RIO BIO-BIO', nombre_normalizado: 'rio bio bio' }
        ];
        // Sin alias para "Biobío" (estado REAL verificado en producción: 0 filas en
        // asociacion_alias con "bio") -> queda pendiente, nunca se adivina a cuál de
        // las dos pertenece.
        const filas = [{ nombre: 'Alvaro Torres Ibañez', asociacion: 'Biobío' }];
        const r = prepararCatalogoDelegados(filas, catalogoReal, []);
        expect(r.listos).toHaveLength(0);
        expect(r.pendientes).toEqual([{ nombre: 'Alvaro Torres Ibañez', asociacion_texto_original: 'Biobío', motivo: 'sin_equivalencia_en_catalogo' }]);
    });

    test('CONFIRMADO por el usuario: con el alias propuesto (migración 063, NO ejecutada), "Biobío" resuelve a BÍO BÍO — NUNCA a RÍO BÍO BÍO', () => {
        const catalogoReal = [
            ...CATALOGO,
            { id: 'id-bio-bio', nombre: 'BÍO-BÍO', nombre_normalizado: 'bio bio' },
            { id: 'id-rio-bio-bio', nombre: 'RIO BIO-BIO', nombre_normalizado: 'rio bio bio' }
        ];
        const aliasPropuesto = [{ asociacion_id: 'id-bio-bio', alias: 'Biobío', alias_normalizado: 'biobio' }];
        const filas = [
            { nombre: 'Alvaro Torres Ibañez', asociacion: 'Biobío' },
            { nombre: 'Cristian Garcia Moreira', asociacion: 'Biobío' }
        ];
        const r = prepararCatalogoDelegados(filas, catalogoReal, aliasPropuesto);
        expect(r.listos).toHaveLength(2);
        for (const l of r.listos) expect(l.asociacion_id).toBe('id-bio-bio'); // nunca id-rio-bio-bio
        expect(r.pendientes).toHaveLength(0);
    });

    test('CONFIRMADO por el usuario: RÍO BÍO BÍO no tiene ningún delegado en LISTADELEGADOS.xlsx -> queda con listado vacío, nunca se le asignan los de Biobío por error', () => {
        const catalogoReal = [
            { id: 'id-bio-bio', nombre: 'BÍO-BÍO', nombre_normalizado: 'bio bio' },
            { id: 'id-rio-bio-bio', nombre: 'RIO BIO-BIO', nombre_normalizado: 'rio bio bio' }
        ];
        const aliasPropuesto = [{ asociacion_id: 'id-bio-bio', alias: 'Biobío', alias_normalizado: 'biobio' }];
        const filas = [{ nombre: 'Alvaro Torres Ibañez', asociacion: 'Biobío' }];
        const r = prepararCatalogoDelegados(filas, catalogoReal, aliasPropuesto);
        expect(r.listos.filter(l => l.asociacion_id === 'id-rio-bio-bio')).toHaveLength(0);
    });

    test('es una función PURA: no muta los arreglos de entrada', () => {
        const filas = [{ nombre: 'Juan Pérez', asociacion: 'Osorno' }];
        const filasCopia = JSON.parse(JSON.stringify(filas));
        const catalogoCopia = JSON.parse(JSON.stringify(CATALOGO));
        prepararCatalogoDelegados(filas, CATALOGO, ALIAS);
        expect(filas).toEqual(filasCopia);
        expect(CATALOGO).toEqual(catalogoCopia);
    });
});
