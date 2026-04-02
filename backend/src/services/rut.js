// ============================================================
// Servicio de validación y normalización de RUT chileno
// ============================================================

/**
 * Elimina puntos y deja el guión: "12.345.678-9" -> "12345678-9"
 */
function normalizarRut(rut) {
    if (!rut) return null;
    // Quitar espacios, puntos; asegurar mayúscula para la K
    return rut.trim().replace(/\./g, '').toUpperCase();
}

/**
 * Valida el dígito verificador del RUT chileno.
 * Acepta con o sin puntos, con guión.
 * Retorna { valido: bool, rut: 'normalizado' }
 */
function validarRut(rutRaw) {
    const rut = normalizarRut(rutRaw);
    if (!rut) return { valido: false, rut: null, error: 'RUT vacío' };

    // Debe tener guión
    if (!rut.includes('-')) {
        return { valido: false, rut, error: 'RUT debe incluir guión verificador (ej: 12345678-9)' };
    }

    const partes = rut.split('-');
    if (partes.length !== 2) {
        return { valido: false, rut, error: 'Formato de RUT inválido' };
    }

    const cuerpo = partes[0];
    const dvIngresado = partes[1];

    // El cuerpo solo debe tener dígitos
    if (!/^\d+$/.test(cuerpo)) {
        return { valido: false, rut, error: 'El cuerpo del RUT solo puede contener números' };
    }

    // El dígito verificador puede ser 0-9 o K
    if (!/^[0-9K]$/.test(dvIngresado)) {
        return { valido: false, rut, error: 'Dígito verificador inválido' };
    }

    const dvCalculado = calcularDv(parseInt(cuerpo, 10));

    if (dvCalculado !== dvIngresado) {
        return { valido: false, rut, error: `Dígito verificador incorrecto (esperado: ${dvCalculado})` };
    }

    return { valido: true, rut, error: null };
}

/**
 * Calcula el dígito verificador dado el cuerpo numérico del RUT.
 */
function calcularDv(cuerpo) {
    let suma = 0;
    let multiplo = 2;

    for (let i = String(cuerpo).length - 1; i >= 0; i--) {
        suma += parseInt(String(cuerpo)[i], 10) * multiplo;
        multiplo = multiplo < 7 ? multiplo + 1 : 2;
    }

    const resto = suma % 11;
    if (resto === 0) return '0';
    if (resto === 1) return 'K';
    return String(11 - resto);
}

/**
 * Intenta limpiar un RUT escrito con o sin puntos y valida.
 * Puede recibir: "12.345.678-9", "12345678-9", "123456789" (sin dv separado)
 */
function procesarRutInput(input) {
    if (!input) return { valido: false, rut: null, error: 'RUT vacío' };

    let limpio = input.trim().replace(/\./g, '').toUpperCase();

    // Si no tiene guión pero tiene 8-9 caracteres, asumir que el último es el DV
    if (!limpio.includes('-') && limpio.length >= 8) {
        limpio = limpio.slice(0, -1) + '-' + limpio.slice(-1);
    }

    return validarRut(limpio);
}

module.exports = { normalizarRut, validarRut, procesarRutInput, calcularDv };
