/**
 * login-ux.js — UX de login con AbortController (solo timeout 35 s),
 * mensajes progresivos y proteccion ante doble submit.
 *
 * Compatible con browser (script tag) y Node.js (require para tests).
 *
 * Reglas de estado:
 *   _loading = true  → solicitud en vuelo; cualquier submit adicional es ignorado.
 *   _done    = true  → login exitoso; no se permite ningun intento posterior.
 *   AbortController  → se usa exclusivamente para el timeout de 35 s.
 *                      Un segundo submit NO aborta la solicitud activa.
 *
 * Ciclo:
 *   Idle → login() → _loading=true → {exito|error|timeout}
 *     exito:   _loading=false, _done=true  → onSuccess(), sin mas intentos.
 *     error:   _loading=false, _done=false → onStateChange(error), permite reintento.
 *     timeout: _loading=false, _done=false → onStateChange(error), permite reintento.
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

        var _loading    = false; // solicitud en vuelo
        var _done       = false; // exito ya obtenido
        var _controller = null;
        var _timers     = [];

        function _clear() {
            _timers.forEach(_clearTimeout);
            _timers = [];
        }

        async function login(credentials) {
            // Ignorar si ya hay una solicitud activa o si el login ya fue exitoso
            if (_loading || _done) return;

            _loading    = true;
            _controller = new _AbortController();
            _clear();

            onStateChange({ loading: true, text: 'Ingresando…', message: null });

            // 5 s: advertencia de demora
            _timers.push(_setTimeout(function () {
                if (!_loading) return;
                onStateChange({
                    loading:     true,
                    text:        'Ingresando…',
                    message:     'El ingreso está tardando más de lo habitual. No cierres esta ventana.',
                    messageType: 'advertencia',
                });
            }, 5000));

            // 15 s: mensaje de espera prolongada
            _timers.push(_setTimeout(function () {
                if (!_loading) return;
                onStateChange({
                    loading:     true,
                    text:        'Ingresando…',
                    message:     'Seguimos procesando tu ingreso. No vuelvas a presionar el botón.',
                    messageType: 'advertencia',
                });
            }, 15000));

            // 35 s: abortar — unico uso del AbortController
            _timers.push(_setTimeout(function () {
                if (!_loading) return;
                _controller.abort();
            }, 35000));

            try {
                var data = await apiFetch(credentials, _controller.signal);
                _clear();
                _loading = false;
                _done    = true; // impedir cualquier intento posterior
                onStateChange({ loading: false, text: 'Iniciar Sesión', message: null });
                onSuccess(data);
            } catch (err) {
                _clear();
                _loading = false;
                // _done permanece false → el usuario puede reintentar

                if (err.name === 'AbortError') {
                    /*
                     * JWT es stateless: el servidor valida credenciales y genera
                     * el token en memoria durante la solicitud. Si el navegador
                     * aborto a los 35 s, no existe sesion persistente en el servidor.
                     * El usuario simplemente no recibio el token y puede reintentar.
                     */
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
