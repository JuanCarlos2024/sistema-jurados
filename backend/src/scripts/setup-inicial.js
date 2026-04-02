/**
 * Script: setup-inicial.js
 *
 * Ejecuta toda la configuración inicial del sistema en orden:
 *   1. Crea el administrador principal
 *   2. Importa los tipos de rodeo desde "Maestro de tipos de rodeo.xlsx"
 *   3. Importa los jurados desde "Maestro de jurados.xlsx"
 *
 * Uso (ejecutar UNA SOLA VEZ al instalar):
 *   cd backend
 *   node src/scripts/setup-inicial.js
 *
 * Antes de ejecutar:
 *   - Configure backend/.env con sus credenciales de Supabase
 *   - Ejecute el schema.sql en Supabase SQL Editor
 *   - Asegúrese de que los archivos xlsx estén en la carpeta raíz del proyecto
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { execSync } = require('child_process');
const path = require('path');

const SCRIPTS = path.join(__dirname);

function ejecutar(script, descripcion) {
    console.log('\n' + '─'.repeat(60));
    console.log(`▶ ${descripcion}`);
    console.log('─'.repeat(60));
    try {
        execSync(`node "${path.join(SCRIPTS, script)}"`, { stdio: 'inherit' });
    } catch (e) {
        console.error(`\n✗ Error en ${script}:`, e.message);
        process.exit(1);
    }
}

console.log('\n' + '═'.repeat(60));
console.log('  SETUP INICIAL — Sistema de Jurados Rodeo Chileno');
console.log('═'.repeat(60));

ejecutar('crear-admin.js',           'Paso 1/3: Crear administrador');
ejecutar('importar-maestro-tipos.js','Paso 2/3: Importar tipos de rodeo');
ejecutar('importar-maestro-jurados.js','Paso 3/3: Importar jurados');

console.log('\n' + '═'.repeat(60));
console.log('  ✅ Setup completado exitosamente');
console.log('  → Inicie el servidor: npm run dev');
console.log('  → Abra: http://localhost:3000');
console.log('  → Admin: admin@rodeo.cl / Admin2024!');
console.log('═'.repeat(60) + '\n');
