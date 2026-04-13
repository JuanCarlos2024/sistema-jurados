#!/usr/bin/env node
/**
 * reset-operativo.js
 * Script de mantenimiento: limpia datos operativos de prueba.
 *
 * USO:
 *   node scripts/reset-operativo.js              # dry-run (solo muestra counts)
 *   node scripts/reset-operativo.js --ejecutar   # ejecuta el reset + backup JSON
 *
 * El script SIEMPRE hace dry-run antes de ejecutar.
 * El backup JSON se guarda en scripts/backup/reset-YYYY-MM-DD-HHMMSS/
 *
 * IMPORTANTE: Ejecutar desde la raíz del proyecto.
 *   cd "c:\...\SISTEMA_JURADOS"
 *   node scripts/reset-operativo.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// Resolver módulos desde backend/node_modules (donde están instalados)
const NM = path.join(__dirname, '../backend/node_modules');

require(path.join(NM, 'dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const { createClient } = require(path.join(NM, '@supabase/supabase-js'));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[ERROR] SUPABASE_URL o SUPABASE_SERVICE_KEY no configurados en backend/.env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MODO_EJECUTAR = process.argv.includes('--ejecutar');

// ── Tablas a limpiar (en orden de borrado, leaf-first por FK) ────────────────
const TABLAS_LIMPIAR = [
    {
        nombre: 'bonos_solicitados',
        razon:  'FK NOT NULL → asignaciones; bonos de distancia de prueba'
    },
    {
        nombre: 'rodeo_adjuntos',
        razon:  'FK CASCADE → rodeos; archivos adjuntos de prueba'
    },
    {
        nombre: 'rodeo_links',
        razon:  'FK CASCADE → rodeos; links YouTube de prueba'
    },
    {
        nombre: 'importaciones_pendientes',
        razon:  'FK NOT NULL → importaciones; filas pendientes de Excel de prueba'
    },
    {
        nombre: 'asignaciones',
        razon:  'FK NOT NULL → rodeos; asignaciones de prueba'
    },
    {
        nombre: 'rodeos',
        razon:  'Eventos/rodeos cargados durante pruebas'
    },
    {
        nombre: 'importaciones',
        razon:  'Historial de cargas de Excel de prueba'
    },
];

// ── Tablas conservadas (solo se cuentan para verificar integridad) ────────────
const TABLAS_CONSERVAR = [
    'administradores',
    'usuarios_pagados',
    'configuracion_tarifas',
    'configuracion_retencion',
    'bonos_config',
    'tipos_rodeo',
    'categorias_rodeo',
    'disponibilidad_usuarios',
];

// ── Filtro de auditoría: solo logs de entidades operativas ───────────────────
const AUDITORIA_TABLAS_BORRAR = [
    'asignaciones', 'rodeos', 'importaciones', 'bonos_solicitados',
    'importaciones_pendientes', 'rodeo_adjuntos', 'rodeo_links'
];

// ─────────────────────────────────────────────────────────────────────────────

async function contarFilas(tabla) {
    const { count, error } = await supabase
        .from(tabla)
        .select('*', { count: 'exact', head: true });
    if (error) throw new Error(`Error contando ${tabla}: ${error.message}`);
    return count || 0;
}

async function exportarTabla(tabla) {
    const { data, error } = await supabase.from(tabla).select('*');
    if (error) throw new Error(`Error exportando ${tabla}: ${error.message}`);
    return data || [];
}

async function dryRun() {
    console.log('\n' + '═'.repeat(60));
    console.log('  DRY-RUN — Sistema de Jurados — Reset Operativo');
    console.log('  ' + new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }));
    console.log('═'.repeat(60));

    console.log('\n📋 TABLAS QUE SE LIMPIARÁN:');
    console.log('─'.repeat(60));

    let totalBorrar = 0;
    const counts = {};

    for (const t of TABLAS_LIMPIAR) {
        const n = await contarFilas(t.nombre);
        counts[t.nombre] = n;
        totalBorrar += n;
        const flag = n > 0 ? '⚠️ ' : '✓  ';
        console.log(`  ${flag}${t.nombre.padEnd(28)} ${String(n).padStart(6)} fila(s)`);
        console.log(`     → ${t.razon}`);
    }

    // Auditoría operativa
    const { count: nAudit } = await supabase
        .from('auditoria')
        .select('*', { count: 'exact', head: true })
        .in('tabla', AUDITORIA_TABLAS_BORRAR);
    counts['auditoria (operativa)'] = nAudit || 0;
    totalBorrar += nAudit || 0;
    console.log(`  ⚠️  auditoria (operativa)        ${String(nAudit||0).padStart(6)} fila(s)`);
    console.log(`     → Logs de entidades que serán borradas`);

    console.log('─'.repeat(60));
    console.log(`  TOTAL a borrar: ${totalBorrar} fila(s)`);

    console.log('\n🔒 TABLAS CONSERVADAS (no se tocan):');
    console.log('─'.repeat(60));

    for (const tabla of TABLAS_CONSERVAR) {
        const n = await contarFilas(tabla);
        const flag = n === 0 ? '❌ ' : '✓  ';
        console.log(`  ${flag}${tabla.padEnd(28)} ${String(n).padStart(6)} fila(s)`);
        if (n === 0 && ['administradores','usuarios_pagados'].includes(tabla)) {
            console.log(`     ⚠️  ATENCIÓN: esta tabla crítica está vacía`);
        }
    }

    console.log('─'.repeat(60));
    console.log('');

    return { counts, totalBorrar };
}

async function hacerBackup(counts) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(__dirname, 'backup', `reset-${ts}`);
    fs.mkdirSync(backupDir, { recursive: true });

    console.log(`\n💾 Exportando backup en: ${backupDir}`);

    for (const t of TABLAS_LIMPIAR) {
        if (counts[t.nombre] === 0) {
            console.log(`   → ${t.nombre}: vacía, sin backup necesario`);
            continue;
        }
        process.stdout.write(`   → ${t.nombre}: exportando ${counts[t.nombre]} fila(s)...`);
        const data = await exportarTabla(t.nombre);
        fs.writeFileSync(
            path.join(backupDir, `${t.nombre}.json`),
            JSON.stringify(data, null, 2)
        );
        console.log(' OK');
    }

    // Backup auditoría operativa
    const { data: auditData } = await supabase
        .from('auditoria')
        .select('*')
        .in('tabla', AUDITORIA_TABLAS_BORRAR);
    if (auditData && auditData.length > 0) {
        fs.writeFileSync(
            path.join(backupDir, 'auditoria_operativa.json'),
            JSON.stringify(auditData, null, 2)
        );
        console.log(`   → auditoria (operativa): ${auditData.length} fila(s) exportadas`);
    }

    // Guardar manifiesto
    const manifiesto = {
        timestamp:     new Date().toISOString(),
        timezone:      'America/Santiago',
        modo:          'reset-operativo',
        tablas_backup: TABLAS_LIMPIAR.map(t => t.nombre),
        counts
    };
    fs.writeFileSync(
        path.join(backupDir, '_manifiesto.json'),
        JSON.stringify(manifiesto, null, 2)
    );

    console.log(`   ✓ Backup completo en: ${backupDir}`);
    return backupDir;
}

async function ejecutarReset() {
    console.log('\n🗑️  Ejecutando reset (orden FK leaf-first)...');
    console.log('─'.repeat(60));

    // 1–7: tablas operativas
    for (const t of TABLAS_LIMPIAR) {
        process.stdout.write(`   DELETE ${t.nombre}...`);
        const { error } = await supabase.from(t.nombre).delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if (error) throw new Error(`Error borrando ${t.nombre}: ${error.message}`);
        console.log(' OK');
    }

    // 8: auditoría operativa
    process.stdout.write(`   DELETE auditoria (operativa)...`);
    const { error: errAudit } = await supabase
        .from('auditoria')
        .delete()
        .in('tabla', AUDITORIA_TABLAS_BORRAR);
    if (errAudit) throw new Error(`Error borrando auditoria: ${errAudit.message}`);
    console.log(' OK');

    // Registrar el reset en auditoría
    await supabase.from('auditoria').insert({
        tabla:       'sistema',
        accion:      'reset_operativo',
        actor_id:    'sistema',
        actor_tipo:  'administrador',
        descripcion: `Reset de datos operativos ejecutado via CLI: ${new Date().toISOString()}`
    });

    console.log('─'.repeat(60));
}

async function verificarPostReset() {
    console.log('\n✅ VERIFICACIÓN POST-RESET:');
    console.log('─'.repeat(60));

    let todo_ok = true;

    for (const t of TABLAS_LIMPIAR) {
        const n = await contarFilas(t.nombre);
        const ok = n === 0;
        if (!ok) todo_ok = false;
        console.log(`   ${ok ? '✓' : '❌'} ${t.nombre.padEnd(30)} ${n} fila(s) restantes`);
    }

    console.log('\n   Tablas conservadas:');
    for (const tabla of TABLAS_CONSERVAR) {
        const n = await contarFilas(tabla);
        const ok = n > 0 || !['administradores','usuarios_pagados'].includes(tabla);
        if (!ok) todo_ok = false;
        console.log(`   ${ok ? '✓' : '❌'} ${tabla.padEnd(30)} ${n} fila(s)`);
    }

    console.log('─'.repeat(60));
    if (todo_ok) {
        console.log('   ✓ RESET EXITOSO — Sistema listo para uso en producción');
    } else {
        console.log('   ❌ VERIFICACIÓN FALLIDA — Revisar errores arriba');
    }
    return todo_ok;
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
    try {
        if (!MODO_EJECUTAR) {
            // Solo dry-run
            await dryRun();
            console.log('ℹ️  Modo DRY-RUN: no se borró nada.');
            console.log('   Para ejecutar el reset real: node scripts/reset-operativo.js --ejecutar\n');
            return;
        }

        // Ejecutar
        console.log('\n⚠️  MODO EJECUCIÓN — Iniciando reset de datos operativos');
        console.log('   Este proceso es irreversible sin backup. Continuando...\n');

        // 1. Dry-run para mostrar qué se borrará
        const { counts } = await dryRun();

        // 2. Backup
        const backupDir = await hacerBackup(counts);

        // 3. Reset
        await ejecutarReset();

        // 4. Verificación
        const ok = await verificarPostReset();

        if (!ok) {
            console.error('\n❌ Verificación fallida. Revisar logs arriba.');
            console.error(`   Backup disponible en: ${backupDir}`);
            process.exit(1);
        }

        console.log(`\n💾 Backup guardado en: ${backupDir}`);
        console.log('   Para restaurar: importar los JSON en orden inverso al borrado.');
        console.log('   Orden de restauración: importaciones → rodeos → asignaciones');
        console.log('   → importaciones_pendientes → rodeo_adjuntos → rodeo_links → bonos_solicitados\n');

    } catch (err) {
        console.error('\n❌ ERROR:', err.message);
        console.error('   El reset puede estar incompleto. Verificar estado de tablas.');
        console.error('   Para reset atómico garantizado, usar el script SQL con BEGIN…COMMIT.');
        process.exit(1);
    }
}

main();
