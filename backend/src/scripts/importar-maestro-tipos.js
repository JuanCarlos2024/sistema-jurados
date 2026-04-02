/**
 * Script: importar-maestro-tipos.js
 *
 * Lee "Maestro de tipos de rodeo.xlsx" desde la raíz del proyecto e inserta
 * los tipos de rodeo en la tabla tipos_rodeo de Supabase.
 *
 * Uso:
 *   cd backend
 *   node src/scripts/importar-maestro-tipos.js
 *
 * Comportamiento:
 * - Si el tipo ya existe (por nombre normalizado), lo actualiza si la duración cambió.
 * - Si es nuevo, lo crea con estado activo.
 * - Columna "#" es ignorada (solo es numeración del Excel).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const XLSX   = require('xlsx');
const path   = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const ARCHIVO = path.join(__dirname, '../../../Maestro de tipos de rodeo.xlsx');

function normalizar(str) {
    if (!str) return '';
    return str.toString().trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[\s\-–]+/g, ' ')
        .replace(/\s+/g, ' ');
}

async function main() {
    console.log('\n=== Importando Maestro de Tipos de Rodeo ===');
    console.log('Archivo:', ARCHIVO, '\n');

    const wb = XLSX.readFile(ARCHIVO, { raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!filas.length) {
        console.error('El archivo está vacío.');
        process.exit(1);
    }

    // Validar columnas
    const cols = Object.keys(filas[0]);
    if (!cols.includes('TIPO_DE_RODEO') || !cols.includes('DURACION_DIAS')) {
        console.error('Columnas esperadas: TIPO_DE_RODEO, DURACION_DIAS');
        console.error('Columnas encontradas:', cols);
        process.exit(1);
    }

    console.log(`Total filas en Excel: ${filas.length}`);

    // Cargar tipos existentes
    const { data: existentes } = await supabase
        .from('tipos_rodeo')
        .select('id, nombre, duracion_dias');

    const mapaExistentes = {};
    (existentes || []).forEach(t => {
        mapaExistentes[normalizar(t.nombre)] = t;
    });

    let creados = 0, actualizados = 0, errores = 0, saltados = 0;

    for (const fila of filas) {
        const nombre    = fila.TIPO_DE_RODEO?.toString().trim();
        const duracion  = parseInt(fila.DURACION_DIAS, 10);

        if (!nombre) { saltados++; continue; }
        if (isNaN(duracion) || duracion < 1 || duracion > 5) {
            console.warn(`  ⚠ Duración inválida "${fila.DURACION_DIAS}" para: ${nombre}`);
            saltados++;
            continue;
        }

        const nombreNorm = normalizar(nombre);
        const existente  = mapaExistentes[nombreNorm];

        if (existente) {
            if (existente.duracion_dias !== duracion) {
                const { error } = await supabase
                    .from('tipos_rodeo')
                    .update({ duracion_dias: duracion, updated_at: new Date().toISOString() })
                    .eq('id', existente.id);

                if (error) {
                    console.error(`  ✗ Error al actualizar "${nombre}": ${error.message}`);
                    errores++;
                } else {
                    console.log(`  ↺ Actualizado: "${nombre}" (${existente.duracion_dias}d → ${duracion}d)`);
                    actualizados++;
                }
            } else {
                saltados++;
            }
        } else {
            const { error } = await supabase
                .from('tipos_rodeo')
                .insert({ nombre, duracion_dias: duracion, activo: true });

            if (error) {
                // Puede ser conflicto de unique en nombre
                if (error.code === '23505') {
                    console.warn(`  ⚠ Duplicado ignorado: "${nombre}"`);
                    saltados++;
                } else {
                    console.error(`  ✗ Error al crear "${nombre}": ${error.message}`);
                    errores++;
                }
            } else {
                console.log(`  ✓ Creado: "${nombre}" (${duracion} día(s))`);
                creados++;
            }
        }
    }

    console.log('\n=== Resultado ===');
    console.log(`  Creados:      ${creados}`);
    console.log(`  Actualizados: ${actualizados}`);
    console.log(`  Saltados:     ${saltados}`);
    console.log(`  Errores:      ${errores}\n`);

    process.exit(0);
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
