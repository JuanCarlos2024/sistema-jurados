// ============================================================
// Validación de "Corre por los premios" / "Deja puntos para la
// próxima temporada" — defensa en profundidad del lado del
// backend (Requisito F), mismo criterio que ya valida el
// formulario (frontend/usuario/cartilla-delegado.html:
// validarSeccionColleraNueve) — reimplementado acá porque este
// proyecto no comparte código entre navegador y Node, mismo
// patrón que ya existe para desempeno_jurado (validarAspectosDesempeno
// en cartillaDelegadoNotas.js, duplicado conceptualmente en el
// formulario). Reutiliza el validador de RUT YA existente
// (./rut.js) en vez de reimplementar el dígito verificador.
// ============================================================
const { validarRut } = require('./rut');

const CAMPOS_OBLIGATORIOS = [
    'rut1', 'nombre1', 'rut2', 'nombre2',
    'num_caballo1', 'nombre_caballo1', 'num_caballo2', 'nombre_caballo2', 'lugar'
];

/**
 * @param {{respuesta?: string, items?: object[]}} estado
 * @param {string} nombreSeccion - para el mensaje de error (ej. "Corre por los premios")
 * @returns {{valido: true} | {valido: false, error: string}}
 */
function validarSeccionColleraNueva(estado, nombreSeccion) {
    if (!estado || estado.respuesta !== 'si') return { valido: true };

    const items = Array.isArray(estado.items) ? estado.items : [];
    if (items.length === 0) {
        return { valido: false, error: `Ha indicado "Sí" en "${nombreSeccion}". Debe agregar al menos una collera.` };
    }

    const hayCompleta = items.some(c => CAMPOS_OBLIGATORIOS.every(k => c && c[k] && String(c[k]).trim() !== ''));
    if (!hayCompleta) {
        return { valido: false, error: `En "${nombreSeccion}" debe haber al menos una collera con todos sus datos completos.` };
    }

    const rutsInvalidos = [];
    items.forEach((c, i) => {
        [['rut1', 'RUT Jinete 1'], ['rut2', 'RUT Jinete 2']].forEach(([k, label]) => {
            const v = c && c[k];
            if (v && String(v).trim() !== '' && !validarRut(v).valido) {
                rutsInvalidos.push(`Collera ${i + 1} — ${label}`);
            }
        });
    });
    if (rutsInvalidos.length > 0) {
        return { valido: false, error: `${nombreSeccion}: RUT con dígito verificador inválido en ${rutsInvalidos.join(', ')}.` };
    }

    return { valido: true };
}

module.exports = { validarSeccionColleraNueva };
