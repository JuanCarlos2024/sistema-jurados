/**
 * Script para crear el primer administrador del sistema.
 * Ejecutar UNA SOLA VEZ al instalar el sistema:
 *
 *   cd backend
 *   node src/scripts/crear-admin.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function crearAdmin() {
    const nombre = 'Administrador Principal';
    const email  = 'admin@rodeo.cl';
    const password = 'Admin2024!';   // <-- Cambie esto antes de ejecutar

    console.log('\n=== Creando administrador inicial ===\n');
    console.log(`Nombre  : ${nombre}`);
    console.log(`Email   : ${email}`);
    console.log(`Password: ${password}`);
    console.log('');

    // Verificar si ya existe
    const { data: existe } = await supabase
        .from('administradores')
        .select('id')
        .eq('email', email)
        .limit(1);

    if (existe && existe.length > 0) {
        console.log('⚠️  Ya existe un administrador con ese email.');
        console.log('    Edite el script para usar otro email o elimine el registro primero.\n');
        process.exit(0);
    }

    const hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
        .from('administradores')
        .insert({ nombre_completo: nombre, email, password_hash: hash })
        .select('id, nombre_completo, email')
        .single();

    if (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }

    console.log('✅ Administrador creado exitosamente:');
    console.log(`   ID    : ${data.id}`);
    console.log(`   Nombre: ${data.nombre_completo}`);
    console.log(`   Email : ${data.email}`);
    console.log('');
    console.log('⚠️  IMPORTANTE: Cambie la contraseña después del primer ingreso.');
    console.log('    URL: http://localhost:3000\n');

    process.exit(0);
}

crearAdmin().catch(err => {
    console.error('Error fatal:', err.message);
    process.exit(1);
});
