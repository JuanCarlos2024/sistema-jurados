// Lógica pura (sin DOM) para la corrección administrativa de una Nota
// Comisión protegida desde Rodeos → Ver → Notas secundarias.
// admin/rodeos.html delega acá la decisión para poder testearla sin DOM.
//
// Reglas (backend ya existente, nunca duplicadas ni reinterpretadas acá):
//   - El código NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION solo lo emite
//     el backend para Nota Comisión histórica/completa/ya corregida — Nota
//     Delegado nunca usa este mecanismo reactivo de confirmación tras un
//     409 (el administrador SIEMPRE puede modificarla, nunca se bloquea),
//     así que este módulo nunca puede activarse por un cambio de solo
//     Delegado.
//   - Sobrescribir una Nota Comisión protegida es exclusivo de administrador
//     pleno (el backend ya responde 403 a Monitor/Director) — el frontend
//     nunca ofrece el modal de confirmación a esos roles, para no mostrar
//     una acción que el servidor rechazaría igual.
//   - Protección (088): Nota Delegado tiene su PROPIO mecanismo, distinto e
//     independiente — un comentario obligatorio en cada registro/
//     modificación manual (nunca un bloqueo ni una confirmación reactiva).
//     Ese comentario viaja en el payload como `comentario_delegado`,
//     validado con el mismo `motivoValido` de abajo (reutilizado, no
//     duplicado).
(function (global) {
    const CODIGO_PROTEGIDA = 'NOTA_COMISION_PROTEGIDA_REQUIERE_CONFIRMACION';

    function decidirAccionError({ codigo, esMonitor, esDirector }) {
        if (codigo !== CODIGO_PROTEGIDA) return 'error_generico';
        if (esMonitor || esDirector) return 'error_bloqueado_rol';
        return 'pedir_confirmacion';
    }

    // Body EXACTO que recibe PUT /admin/rodeos/:id/notas-secundarias — nunca
    // incluye nada más (ni criterios individuales de Comisión, ni datos de
    // otros rodeos): el backend ya es responsable de todo lo demás.
    // `comentarioDelegado` (088) solo se agrega al body cuando se pasa un
    // valor real — así el payload sigue siendo mínimo cuando no se está
    // tocando Delegado, exactamente igual que confirma_sobrescritura_historica/motivo.
    function construirPayload({ notaComision, notaDelegado, confirmaSobrescritura, motivo, comentarioDelegado }) {
        const body = { nota_comision: notaComision, nota_delegado: notaDelegado };
        if (confirmaSobrescritura) {
            body.confirma_sobrescritura_historica = true;
            body.motivo = motivo;
        }
        if (notaDelegado !== null && comentarioDelegado) {
            body.comentario_delegado = comentarioDelegado;
        }
        return body;
    }

    function cambioDelegado({ delegadoAntes, delegadoDespues }) {
        return delegadoDespues !== delegadoAntes;
    }

    function motivoValido(texto) {
        return !!(texto && texto.trim().length > 0);
    }

    const API = { CODIGO_PROTEGIDA, decidirAccionError, construirPayload, cambioDelegado, motivoValido };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = API;
    } else {
        global.NotasSecundariasSobrescritura = API;
    }
})(typeof window !== 'undefined' ? window : globalThis);
