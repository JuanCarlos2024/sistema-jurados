/**
 * Script: importar-maestro-jurados.js
 *
 * Lee "Maestro de jurados.xlsx" desde la raíz del proyecto e inserta
 * los jurados en la tabla usuarios_pagados de Supabase.
 *
 * Uso:
 *   cd backend
 *   node src/scripts/importar-maestro-jurados.js
 *
 * Comportamiento:
 * - Si el jurado ya existe (por nombre normalizado), lo actualiza si la categoría cambió.
 * - Si es nuevo, lo crea con contraseña inicial "jurados" y código USR-XXXX.
 * - Los nombres se guardan tal como vienen en el Excel (respetando mayúsculas originales).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const XLSX    = require('xlsx');
const bcrypt  = require('bcryptjs');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const ARCHIVO = path.join(__dirname, '../../../Maestro de jurados.xlsx');
const PASS_INICIAL = 'jurados';

// Misma función de normalización que usa el importador
function normalizar(str) {
    if (!str) return '';
    return str.toString().trim().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[\s\-–]+/g, ' ')
        .replace(/\s+/g, ' ');
}

async function generarCodigo(offset = 0) {
    const { data } = await supabase
        .from('usuarios_pagados')
        .select('codigo_interno')
        .order('created_at', { ascending: false })
        .limit(1);

    const ultimo = data && data.length > 0 ? data[0].codigo_interno : 'USR-0000';
    const num = parseInt(ultimo.replace('USR-', ''), 10) + 1 + offset;
    return 'USR-' + String(num).padStart(4, '0');
}

async function main() {
    console.log('\n=== Importando Maestro de Jurados ===');
    console.log('Archivo:', ARCHIVO, '\n');

    // Leer Excel
    const wb = XLSX.readFile(ARCHIVO, { raw: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const filas = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!filas.length) {
        console.error('El archivo está vacío.');
        process.exit(1);
    }

    // Validar columnas
    const cols = Object.keys(filas[0]);
    if (!cols.includes('NOMBRE_JURADO') || !cols.includes('CATEGORIA_JURADO')) {
        console.error('Columnas esperadas: NOMBRE_JURADO, CATEGORIA_JURADO');
        console.error('Columnas encontradas:', cols);
        process.exit(1);
    }

    console.log(`Total filas en Excel: ${filas.length}`);

    // Cargar jurados existentes para detectar duplicados
    const { data: existentes } = await supabase
        .from('usuarios_pagados')
        .select('id, nombre_completo, categoria, codigo_interno')
        .eq('tipo_persona', 'jurado');

    const mapaExistentes = {};
    (existentes || []).forEach(u => {
        mapaExistentes[normalizar(u.nombre_completo)] = u;
    });

    let creados = 0, actualizados = 0, errores = 0, saltados = 0;
    const passwordHash = await bcrypt.hash(PASS_INICIAL, 12);
    let offsetCodigo = 0;

    for (const fila of filas) {
        const nombre = fila.NOMBRE_JURADO?.toString().trim();
        const categoria = fila.CATEGORIA_JURADO?.toString().trim().toUpperCase();

        if (!nombre) { saltados++; continue; }
        if (!['A', 'B', 'C'].includes(categoria)) {
            console.warn(`  ⚠ Categoría inválida "${categoria}" para: ${nombre}`);
            saltados++;
            continue;
        }

        const nombreNorm = normalizar(nombre);
        const existente = mapaExistentes[nombreNorm];

        if (existente) {
            // Ya existe: actualizar categoría si cambió
            if (existente.categoria !== categoria) {
                const { error } = await supabase
                    .from('usuarios_pagados')
                    .update({ categoria, updated_at: new Date().toISOString() })
                    .eq('id', existente.id);

                if (error) {
                    console.error(`  ✗ Error al actualizar ${nombre}: ${error.message}`);
                    errores++;
                } else {
                    console.log(`  ↺ Actualizado: ${nombre} (${existente.categoria} → ${categoria})`);
                    actualizados++;
                }
            } else {
                saltados++;
            }
        } else {
            // Nuevo jurado
            const codigo = await generarCodigo(offsetCodigo++);
            const { error } = await supabase
                .from('usuarios_pagados')
                .insert({
                    codigo_interno:  codigo,
                    tipo_persona:    'jurado',
                    nombre_completo: nombre,
                    categoria,
                    password_hash:   passwordHash
                });

            if (error) {
                console.error(`  ✗ Error al crear ${nombre}: ${error.message}`);
                errores++;
            } else {
                console.log(`  ✓ Creado: ${codigo} — ${nombre} (Cat. ${categoria})`);
                creados++;
            }
        }
    }

    console.log('\n=== Resultado ===');
    console.log(`  Creados:      ${creados}`);
    console.log(`  Actualizados: ${actualizados}`);
    console.log(`  Saltados:     ${saltados}`);
    console.log(`  Errores:      ${errores}`);
    console.log('\nContraseña inicial de todos los usuarios: "jurados"');
    console.log('Los usuarios deberán cambiarla en su primer ingreso.\n');

    process.exit(0);
}

main().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
