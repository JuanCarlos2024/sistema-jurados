/**
 * login-ux.js — UX de login con AbortController, mensajes progresivos
 * y proteccion ante race conditions.
 *
 * Compatible con browser (script tag) y Node.js (require para tests).
 *
 * Comportamiento:
 *   - Deshabilita el boton y muestra "Ingresando..." inmediatamente.
 *   - A los 5 s muestra advertencia de demora.
 *   - A los 15 s muestra mensaje de espera prolongada.
 *   - A los 35 s aborta via AbortController y habilita el reintento.
 *   - Si llega una respuesta de una solicitud anterior (cancelada), la ignora.
 *   - Exito: cancela timers, redirige una sola vez.
 *   - Error: cancela timers, muestra mensaje, habilita reintento.
 */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.LoginUX = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    /**
     * @param {Object} opts
     * @param {Function} opts.apiFetch      (credentials, signal) => Promise<data>
     * @param {Function} opts.onStateChange ({ loading, text, message, messageType }) => void
     * @param {Function} opts.onSuccess     (data) => void
     * @param {Function} [opts._setTimeout]
     * @param {Function} [opts._clearTimeout]
     * @param {Function} [opts._AbortController]
     */
    function createLoginHandler(opts) {
        var apiFetch         = opts.apiFetch;
        var onStateChange    = opts.onStateChange;
        var onSuccess        = opts.onSuccess;
        var _setTimeout      = opts._setTimeout      || setTimeout;
        var _clearTimeout    = opts._clearTimeout    || clearTimeout;
        var _AbortController = opts._AbortController || AbortController;

        var _requestId  = 0;
        var _controller = null;
        var _timers     = [];

        function _clear() {
            _timers.forEach(_clearTimeout);
            _timers = [];
        }

        async function login(credentials) {
            // Cancelar solicitud anterior (proteccion doble clic / doble Enter)
            if (_controller) {
                _controller.abort();
            }

            var requestId = ++_requestId;
            _controller = new _AbortController();
            _clear();

            onStateChange({ loading: true, text: 'Ingresando…', message: null });

            // 5 s: advertencia de demora
            _timers.push(_setTimeout(function () {
                if (_requestId !== requestId) return;
                onStateChange({
                    loading:     true,
                    text:        'Ingresando…',
                    message:     'El ingreso está tardando más de lo habitual. No cierres esta ventana.',
                    messageType: 'advertencia',
                });
            }, 5000));

            // 15 s: mensaje de espera prolongada
            _timers.push(_setTimeout(function () {
                if (_requestId !== requestId) return;
                onStateChange({
                    loading:     true,
                    text:        'Ingresando…',
                    message:     'Seguimos procesando tu ingreso. No vuelvas a presionar el botón.',
                    messageType: 'advertencia',
                });
            }, 15000));

            // 35 s: abortar via AbortController
            _timers.push(_setTimeout(function () {
                if (_requestId !== requestId) return;
                _controller.abort();
                // El catch recibe AbortError y muestra el mensaje
            }, 35000));

            try {
                var data = await apiFetch(credentials, _controller.signal);

                if (_requestId !== requestId) return; // respuesta de solicitud anterior — ignorar

                _clear();
                onStateChange({ loading: false, text: 'Iniciar Sesión', message: null });
                onSuccess(data);

            } catch (err) {
                if (_requestId !== requestId) return; // respuesta abortada de solicitud anterior

                _clear();

                if (err.name === 'AbortError') {
                    onStateChange({
                        loading:     false,
                        text:        'Iniciar Sesión',
                        message:     'El ingreso tardó más de 35 segundos. El servidor puede estar bajo alta demanda. Puedes intentar nuevamente.',
                        messageType: 'error',
                    });
                } else {
                    onStateChange({
                        loading:     false,
                        text:        'Iniciar Sesión',
                        message:     err.message || 'Error al iniciar sesión.',
                        messageType: 'error',
                    });
                }
            }
        }

        return { login: login };
    }

    return { createLoginHandler: createLoginHandler };
}));
