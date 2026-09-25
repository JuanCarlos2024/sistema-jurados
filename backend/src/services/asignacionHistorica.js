// ¿Esta asignación proviene de una IMPORTACIÓN HISTÓRICA de rodeos (importaciones.tipo = 'historico_rodeos')?
// Las asignaciones históricas se crean con pago 0 (ya se pagaron fuera del sistema) y NO deben recalcularse con la tarifa actual.
//
// Identificación inequívoca (esquema real auditado): asignaciones.importacion_id → importaciones.tipo = 'historico_rodeos'.
// La RPC importar_rodeos_historicos fija asignaciones.importacion_id en CADA asignación que crea (también en rodeos que YA existían).
// NO se usa rodeos.importacion_id como respaldo: una asignación normal creada después en un rodeo histórico (con pago real) no debe bloquearse.
// Otras importaciones (tipo 'rodeos', 'control_gestion', ...) NO se bloquean, y rodeos.origen = 'importado' por sí solo NO es criterio.
const TIPO_IMPORTACION_HISTORICA = 'historico_rodeos';
const MENSAJE_ASIGNACION_HISTORICA = 'No se puede recalcular el pago de una asignación histórica importada.';
const MENSAJE_PAGO_ASIGNACION_HISTORICA = 'No se pueden modificar datos de pago de una asignación histórica importada.';

async function esAsignacionHistoricaImportada(supabase, asignacion) {
    const id = asignacion && asignacion.importacion_id;
    if (!id) return false;
    const { data, error } = await supabase.from('importaciones').select('id').eq('id', id).eq('tipo', TIPO_IMPORTACION_HISTORICA);
    if (error) throw new Error(error.message);
    return (data || []).length > 0;
}

module.exports = { esAsignacionHistoricaImportada, TIPO_IMPORTACION_HISTORICA, MENSAJE_ASIGNACION_HISTORICA, MENSAJE_PAGO_ASIGNACION_HISTORICA };
