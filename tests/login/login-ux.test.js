#!/usr/bin/env node
/**
 * Tests para frontend/js/login-ux.js
 * Ejecutar: node tests/login/login-ux.test.js
 *
 * Sin dependencias externas. Compatible con Node.js 16+.
 *
 * Casos cubiertos:
 *   1.  Login rapido (< 1 s)
 *   2.  Login de 6 s -> mensaje advertencia a los 5 s
 *   3.  Login de 16 s -> mensaje "Seguimos procesando" a los 15 s
 *   4.  Timeout de 35 s -> AbortError -> mensaje error, boton habilitado
 *   5.  Doble clic -> segunda solicitud cancela la primera
 *   6.  Reintento despues de timeout
 *   7.  Respuesta tardia de solicitud anterior ignorada
 *   8.  Error 401 -> mensaje especifico
 *   9.  Error 500 -> mensaje generico
 *   10. Error de red (TypeError) -> mensaje error
 */

'use strict';

const path   = require('path');
const { createLoginHandler } = require(path.join(__dirname, '../../frontend/js/login-ux.js'));

// ── Runner minimo ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
    try {
        await fn();
        console.log('  ✓ ' + name);
        passed++;
        results.push({ name, ok: true });
    } catch (err) {
        console.error('  ✗ ' + name + ': ' + err.message);
        failed++;
        results.push({ name, ok: false, error: err.message });
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a));
}

// ── Fake AbortController ──────────────────────────────────────────────────────
class FakeAbortController {
    constructor() {
        this._listeners = [];
        this.signal = {
            aborted: false,
            _listeners: this._listeners,
            addEventListener: function(evt, fn) {
                if (evt === 'abort') this._listeners.push(fn);
            },
        };
        const self = this;
        this.signal._listeners = this._listeners;
    }
    abort() {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        this._listeners.forEach(function(fn) { fn(); });
    }
}

// ── Fake timers (control manual del tiempo) ───────────────────────────────────
function makeFakeTimers() {
    const pending = new Map();
    let nextId = 1;
    let now    = 0;

    function _setTimeout(fn, ms) {
        const id = nextId++;
        pending.set(id, { fn, fireAt: now + ms, fired: false });
        return id;
    }

    function _clearTimeout(id) {
        pending.delete(id);
    }

    async function advance(ms) {
        now += ms;
        // Disparar todos los que vencieron (en orden cronologico)
        const due = Array.from(pending.entries())
            .filter(function(e) { return e[1].fireAt <= now; })
            .sort(function(a, b) { return a[1].fireAt - b[1].fireAt; });
        for (const [id, entry] of due) {
            pending.delete(id);
            entry.fn();
        }
        // Dejar que las promesas se resuelvan
        await new Promise(function(r) { setImmediate(r); });
        await new Promise(function(r) { setImmediate(r); });
    }

    return { _setTimeout, _clearTimeout, advance };
}

// ── Factories de fetch y handler ──────────────────────────────────────────────

/** fetch que resuelve tras delayMs milisegundos reales */
function makeFetch({ delayMs = 0, response = null, error = null } = {}) {
    const defaultResp = { token: 'tok', usuario: { primer_login: false } };
    return function(credentials, signal) {
        return new Promise(function(resolve, reject) {
            const t = setTimeout(function() {
                if (error) reject(error); else resolve(response || defaultResp);
            }, delayMs);
            if (signal) {
                signal.addEventListener('abort', function() {
                    clearTimeout(t);
                    const e = new Error('The user aborted a request.');
                    e.name = 'AbortError';
                    reject(e);
                });
            }
        });
    };
}

/** fetch controlado manualmente: promete hasta que llamas resolve/reject */
function makeManualFetch() {
    let _resolve, _reject, _signal;
    const apiFetch = function(credentials, signal) {
        _signal = signal;
        return new Promise(function(resolve, reject) {
            _resolve = resolve;
            _reject  = reject;
            if (signal) {
                signal.addEventListener('abort', function() {
                    const e = new Error('The user aborted a request.');
                    e.name = 'AbortError';
                    reject(e);
                });
            }
        });
    };
    return {
        apiFetch,
        resolve: function(v) { if (_resolve) _resolve(v || { token: 'tok', usuario: { primer_login: false } }); },
        reject:  function(e) { if (_reject) _reject(e); },
        getSignal: function() { return _signal; },
    };
}

/** Crea un handler con fake timers y captura de estados */
function makeHandlerWithFakeTimers(apiFetch, fakeTimers) {
    const states    = [];
    const successes = [];
    const handler   = createLoginHandler({
        apiFetch,
        onStateChange: function(s) { states.push(Object.assign({}, s)); },
        onSuccess:     function(d) { successes.push(d); },
        _setTimeout:      fakeTimers._setTimeout,
        _clearTimeout:    fakeTimers._clearTimeout,
        _AbortController: FakeAbortController,
    });
    return { handler, states, successes };
}

/** Crea un handler con timers reales (para casos < 100 ms) */
function makeHandlerReal(apiFetch) {
    const states    = [];
    const successes = [];
    const handler   = createLoginHandler({
        apiFetch,
        onStateChange: function(s) { states.push(Object.assign({}, s)); },
        onSuccess:     function(d) { successes.push(d); },
        _AbortController: FakeAbortController,
    });
    return { handler, states, successes };
}

// ═════════════════════════════════════════════════════════════════════════════
// CASOS DE PRUEBA
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n=== Tests de Login UX — Sistema Jurados ===\n');

(async function run() {

// ── 1. Login rapido ──────────────────────────────────────────────────────────
await test('1. Login rapido (< 1 s) → exito, onSuccess llamado', async function() {
    const { handler, states, successes } = makeHandlerReal(makeFetch({ delayMs: 10 }));
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    assert(successes.length === 1, 'onSuccess debe llamarse una vez');
    assertEqual(states[0].loading,  true,         'Primer estado: loading=true');
    assertEqual(states[0].text,     'Ingresando…', 'Primer estado: texto "Ingresando..."');
    const last = states[states.length - 1];
    assertEqual(last.loading,  false, 'Ultimo estado: loading=false');
    assert(last.message === null || last.message === undefined, 'Sin mensaje de error');
});

// ── 2. Login de 6 s → advertencia a los 5 s ─────────────────────────────────
await test('2. Login 6 s → muestra advertencia a los 5 s mientras sigue pendiente', async function() {
    const timers  = makeFakeTimers();
    const manual  = makeManualFetch();
    const { handler, states, successes } = makeHandlerWithFakeTimers(manual.apiFetch, timers);

    const loginPromise = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    // Avanzar 5 s → mensaje de advertencia
    await timers.advance(5000);
    const msg5 = states.find(function(s) { return s.message && s.message.includes('tardando'); });
    assert(msg5, 'Debe aparecer mensaje de advertencia a los 5 s');
    assertEqual(msg5.messageType, 'advertencia', 'messageType=advertencia');
    assertEqual(msg5.loading, true, 'Sigue cargando');

    // Resolver el fetch → exito
    manual.resolve();
    await loginPromise;
    assert(successes.length === 1, 'onSuccess despues de respuesta tardia');
});

// ── 3. Login de 16 s → "Seguimos procesando" a los 15 s ─────────────────────
await test('3. Login 16 s → muestra "Seguimos procesando" a los 15 s', async function() {
    const timers = makeFakeTimers();
    const manual = makeManualFetch();
    const { handler, states, successes } = makeHandlerWithFakeTimers(manual.apiFetch, timers);

    const loginPromise = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    await timers.advance(5000);   // mensaje 5 s
    await timers.advance(10000);  // ahora son 15 s

    const msg15 = states.filter(function(s) { return s.message && s.message.includes('Seguimos'); });
    assert(msg15.length > 0, 'Debe aparecer "Seguimos procesando" a los 15 s');
    assertEqual(msg15[msg15.length - 1].messageType, 'advertencia', 'messageType=advertencia');

    manual.resolve();
    await loginPromise;
    assert(successes.length === 1, 'onSuccess tras resolucion tardia');
});

// ── 4. Timeout de 35 s → AbortError → boton habilitado ──────────────────────
await test('4. Timeout 35 s → mensaje de timeout, loading=false, texto restaurado', async function() {
    const timers = makeFakeTimers();
    const manual = makeManualFetch();
    const { handler, states } = makeHandlerWithFakeTimers(manual.apiFetch, timers);

    const loginPromise = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    // Avanzar 35 s → AbortController.abort() → catch AbortError
    await timers.advance(35000);
    await loginPromise;

    const last = states[states.length - 1];
    assertEqual(last.loading, false, 'loading=false tras timeout');
    assertEqual(last.text, 'Iniciar Sesión', 'Texto restaurado a "Iniciar Sesion"');
    assert(last.message && last.message.includes('35 segundos'), 'Mensaje menciona 35 segundos');
    assertEqual(last.messageType, 'error', 'messageType=error');
});

// ── 5. Doble clic → segunda solicitud cancela la primera ─────────────────────
await test('5. Doble clic → primera solicitud cancelada, solo un onSuccess', async function() {
    let callCount   = 0;
    let firstAborted = false;

    const apiFetch = function(credentials, signal) {
        const mine = ++callCount;
        return new Promise(function(resolve, reject) {
            if (signal) {
                signal.addEventListener('abort', function() {
                    if (mine === 1) firstAborted = true;
                    const e = new Error('abort'); e.name = 'AbortError'; reject(e);
                });
            }
            // Primera tarda 200 ms; segunda es inmediata
            setTimeout(function() {
                resolve({ token: 'tok' + mine, usuario: { primer_login: false } });
            }, mine === 1 ? 200 : 5);
        });
    };

    const { handler, successes } = makeHandlerReal(apiFetch);

    // Dos llamadas casi simultaneas
    const p1 = handler.login({ identificador: 'USR-001', password: 'pw' });
    const p2 = handler.login({ identificador: 'USR-001', password: 'pw' });

    await Promise.allSettled([p1, p2]);

    assert(firstAborted, 'Primera solicitud debe ser abortada');
    assertEqual(successes.length, 1, 'Un solo onSuccess (de la segunda solicitud)');
});

// ── 6. Reintento despues de timeout ──────────────────────────────────────────
await test('6. Reintento despues de timeout → segundo intento exitoso', async function() {
    const timers = makeFakeTimers();
    let callCount = 0;
    let firstReject;

    const apiFetch = function(credentials, signal) {
        callCount++;
        if (callCount === 1) {
            return new Promise(function(resolve, reject) {
                firstReject = reject;
                if (signal) {
                    signal.addEventListener('abort', function() {
                        const e = new Error('abort'); e.name = 'AbortError'; reject(e);
                    });
                }
            });
        }
        // Segunda llamada → exito inmediato
        return Promise.resolve({ token: 'tok2', usuario: { primer_login: false } });
    };

    const { handler, states, successes } = makeHandlerWithFakeTimers(apiFetch, timers);

    // Primer intento → timeout
    const p1 = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });
    await timers.advance(35000);
    await p1;

    const afterTimeout = states[states.length - 1];
    assertEqual(afterTimeout.loading, false, 'loading=false tras timeout');

    // Segundo intento con el mismo handler
    const timers2 = makeFakeTimers();
    const h2 = createLoginHandler({
        apiFetch:         apiFetch,
        onStateChange:    function(s) { states.push(Object.assign({}, s)); },
        onSuccess:        function(d) { successes.push(d); },
        _setTimeout:      timers2._setTimeout,
        _clearTimeout:    timers2._clearTimeout,
        _AbortController: FakeAbortController,
    });

    await h2.login({ identificador: 'USR-001', password: 'pw' });
    assertEqual(successes.length, 1, 'Segundo intento tiene exito');
    assertEqual(callCount, 2, '2 llamadas totales');
});

// ── 7. Respuesta tardia de solicitud anterior ignorada ───────────────────────
await test('7. Respuesta tardia de solicitud anterior → ignorada, no llama onSuccess extra', async function() {
    let firstResolve;
    let callCount = 0;

    const apiFetch = function(credentials, signal) {
        callCount++;
        if (callCount === 1) {
            // Primera: tarda — controlada manualmente
            return new Promise(function(resolve, reject) {
                firstResolve = resolve;
                if (signal) {
                    signal.addEventListener('abort', function() {
                        const e = new Error('abort'); e.name = 'AbortError'; reject(e);
                    });
                }
            });
        }
        // Segunda: exito inmediato
        return Promise.resolve({ token: 'tok2', usuario: { primer_login: false } });
    };

    const { handler, successes } = makeHandlerReal(apiFetch);

    // Primera solicitud (lenta)
    const p1 = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    // Segunda solicitud cancela la primera y triunfa
    await handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    const successesBefore = successes.length;
    assertEqual(successesBefore, 1, 'Un solo onSuccess hasta ahora');

    // Ahora resolver la primera (cuya promesa fue abortada por la FakeAbortController)
    // Como ya fue cancelada, no deberia afectar el estado
    firstResolve && firstResolve({ token: 'tok1-late', usuario: { primer_login: false } });
    await Promise.allSettled([p1]);
    await new Promise(function(r) { setImmediate(r); });

    assertEqual(successes.length, successesBefore, 'Respuesta tardia no llama onSuccess de nuevo');
});

// ── 8. Error 401 → mensaje especifico ────────────────────────────────────────
await test('8. Error 401 → mensaje de credenciales incorrectas, loading=false', async function() {
    const err401 = new Error('Código o contraseña incorrectos.');
    err401.status = 401;

    const { handler, states } = makeHandlerReal(function() { return Promise.reject(err401); });
    await handler.login({ identificador: 'USR-001', password: 'wrong' });

    const last = states[states.length - 1];
    assertEqual(last.loading, false, 'loading=false tras 401');
    assert(last.message && last.message.length > 0, 'Hay mensaje de error');
    assertEqual(last.messageType, 'error', 'messageType=error');
});

// ── 9. Error 500 → mensaje generico ──────────────────────────────────────────
await test('9. Error 500 → mensaje de error generico, loading=false', async function() {
    const err500 = new Error('Error interno del servidor');
    err500.status = 500;

    const { handler, states } = makeHandlerReal(function() { return Promise.reject(err500); });
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    const last = states[states.length - 1];
    assertEqual(last.loading, false, 'loading=false tras 500');
    assert(last.message && last.message.length > 0, 'Hay mensaje de error');
    assertEqual(last.messageType, 'error', 'messageType=error');
});

// ── 10. Error de red ─────────────────────────────────────────────────────────
await test('10. Error de red (TypeError: Failed to fetch) → mensaje error, loading=false', async function() {
    const netErr = new TypeError('Failed to fetch');

    const { handler, states } = makeHandlerReal(function() { return Promise.reject(netErr); });
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    const last = states[states.length - 1];
    assertEqual(last.loading, false, 'loading=false tras error de red');
    assertEqual(last.messageType, 'error', 'messageType=error');
});

// ── Reporte ───────────────────────────────────────────────────────────────────
console.log('');
console.log('Resultados: ' + passed + ' APROBADO, ' + failed + ' FALLIDO');

if (failed > 0) {
    console.error('\nFALLIDOS:');
    results.filter(function(r) { return !r.ok; }).forEach(function(r) {
        console.error('  - ' + r.name + ': ' + r.error);
    });
    process.exit(1);
} else {
    console.log('\nTodas las pruebas APROBADAS.');
    process.exit(0);
}

})();
