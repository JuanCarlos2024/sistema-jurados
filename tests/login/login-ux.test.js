#!/usr/bin/env node
/**
 * Tests para frontend/js/login-ux.js
 * Ejecutar: node tests/login/login-ux.test.js
 *
 * Sin dependencias externas. Compatible con Node.js 16+.
 *
 * Regla central verificada en los tests 5, 11, 12 y 16:
 *   Un segundo submit mientras _loading=true es ignorado completamente.
 *   El AbortController NO se usa para cancelar por doble clic.
 *   fetch se llama exactamente UNA vez.
 *
 * Casos:
 *   1.  Login rapido (< 1 s) -> exito
 *   2.  Login de 6 s -> advertencia a los 5 s
 *   3.  Login de 16 s -> "Seguimos procesando" a los 15 s
 *   4.  Timeout de 35 s -> AbortError -> mensaje, boton habilitado
 *   5.  Doble clic -> segundo ignorado, fetch una vez, sin abort
 *   6.  Reintento despues de timeout -> segundo intento exitoso
 *   7.  Segunda llamada durante carga activa -> ignorada completamente
 *   8.  Error 401 -> mensaje especifico, permite reintento
 *   9.  Error 500 -> mensaje generico, permite reintento
 *   10. Error de red -> mensaje error, permite reintento
 *   11. Doble clic rapido -> fetch llamado exactamente una vez
 *   12. Enter repetido -> segunda llamada ignorada, sin segunda solicitud
 *   13. Admin login exitoso -> onSuccess con token de admin
 *   14. Usuario login exitoso -> onSuccess con primer_login=false
 *   15. Redireccion unica -> onSuccess llamado exactamente una vez tras exito
 *   16. Solicitud original NO abortada por segundo submit
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
function makeFakeAbortController() {
    let aborted = false;
    let abortCalled = 0;
    const listeners = [];
    const ctrl = {
        abortCalled: 0,
        signal: {
            get aborted() { return aborted; },
            addEventListener: function(evt, fn) {
                if (evt === 'abort') listeners.push(fn);
            },
        },
        abort: function() {
            abortCalled++;
            ctrl.abortCalled = abortCalled;
            if (aborted) return;
            aborted = true;
            listeners.forEach(function(fn) { fn(); });
        },
    };
    return ctrl;
}

function FakeAbortControllerFactory() {
    this.instances = [];
    const self = this;
    this.Class = function() {
        const ctrl = makeFakeAbortController();
        self.instances.push(ctrl);
        return ctrl;
    };
    Object.defineProperty(this, 'last',  { get: function() { return self.instances[self.instances.length - 1]; } });
    Object.defineProperty(this, 'count', { get: function() { return self.instances.length; } });
}

// ── Fake timers ───────────────────────────────────────────────────────────────
function makeFakeTimers() {
    const pending = new Map();
    let nextId = 1;
    let now    = 0;

    function _setTimeout(fn, ms) {
        const id = nextId++;
        pending.set(id, { fn, fireAt: now + ms });
        return id;
    }

    function _clearTimeout(id) {
        pending.delete(id);
    }

    async function advance(ms) {
        now += ms;
        const due = Array.from(pending.entries())
            .filter(function(e) { return e[1].fireAt <= now; })
            .sort(function(a, b) { return a[1].fireAt - b[1].fireAt; });
        for (const [id, entry] of due) {
            pending.delete(id);
            entry.fn();
        }
        await new Promise(function(r) { setImmediate(r); });
        await new Promise(function(r) { setImmediate(r); });
    }

    return { _setTimeout, _clearTimeout, advance };
}

// ── Factories ─────────────────────────────────────────────────────────────────
function makeHandlerWithFakeTimers(apiFetch, fakeTimers, factory) {
    const states    = [];
    const successes = [];
    const abortCtrl = factory || { Class: function() { return makeFakeAbortController(); } };
    const handler   = createLoginHandler({
        apiFetch,
        onStateChange: function(s) { states.push(Object.assign({}, s)); },
        onSuccess:     function(d) { successes.push(d); },
        _setTimeout:      fakeTimers._setTimeout,
        _clearTimeout:    fakeTimers._clearTimeout,
        _AbortController: abortCtrl.Class,
    });
    return { handler, states, successes };
}

function makeHandlerReal(apiFetch, factory) {
    const states    = [];
    const successes = [];
    const abortCtrl = factory || { Class: function() { return makeFakeAbortController(); } };
    const handler   = createLoginHandler({
        apiFetch,
        onStateChange: function(s) { states.push(Object.assign({}, s)); },
        onSuccess:     function(d) { successes.push(d); },
        _AbortController: abortCtrl.Class,
    });
    return { handler, states, successes };
}

function makeManualFetch() {
    let _resolve, _reject;
    const apiFetch = function(credentials, signal) {
        return new Promise(function(resolve, reject) {
            _resolve = resolve;
            _reject  = reject;
            if (signal) {
                signal.addEventListener('abort', function() {
                    const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
                });
            }
        });
    };
    return {
        apiFetch,
        resolve: function(v) { if (_resolve) _resolve(v || { token: 'tok', usuario: { primer_login: false } }); },
        reject:  function(e) { if (_reject) _reject(e); },
    };
}

const DEFAULT_RESP = { token: 'tok',       usuario: { tipo: 'jurado',         primer_login: false } };
const ADMIN_RESP   = { token: 'admin-tok', usuario: { tipo: 'administrador',  rol_evaluacion: 'admin' } };
const USUARIO_RESP = { token: 'usr-tok',   usuario: { tipo: 'jurado',         primer_login: false } };

// =============================================================================
console.log('\n=== Tests de Login UX — Sistema Jurados ===\n');

(async function run() {

// ── 1. Login rapido ──────────────────────────────────────────────────────────
await test('1. Login rapido (< 1 s) → exito, onSuccess llamado', async function() {
    const { handler, states, successes } = makeHandlerReal(
        function() { return Promise.resolve(DEFAULT_RESP); }
    );
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    assert(successes.length === 1,       'onSuccess debe llamarse una vez');
    assertEqual(states[0].loading, true,          'Primer estado: loading=true');
    assertEqual(states[0].text,   'Ingresando…', 'Primer estado: texto Ingresando');
    const last = states[states.length - 1];
    assertEqual(last.loading, false, 'Ultimo estado: loading=false');
    assert(!last.message, 'Sin mensaje de error');
});

// ── 2. Login de 6 s → advertencia a los 5 s ─────────────────────────────────
await test('2. Login 6 s → muestra advertencia a los 5 s mientras sigue pendiente', async function() {
    const timers = makeFakeTimers();
    const manual = makeManualFetch();
    const { handler, states, successes } = makeHandlerWithFakeTimers(manual.apiFetch, timers);

    const p = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    await timers.advance(5000);
    const msg5 = states.find(function(s) { return s.message && s.message.includes('tardando'); });
    assert(msg5, 'Debe aparecer advertencia a los 5 s');
    assertEqual(msg5.messageType, 'advertencia', 'messageType=advertencia');
    assertEqual(msg5.loading,     true,           'Sigue en loading');

    manual.resolve();
    await p;
    assert(successes.length === 1, 'onSuccess tras resolucion');
});

// ── 3. Login de 16 s → "Seguimos procesando" a los 15 s ─────────────────────
await test('3. Login 16 s → muestra "Seguimos procesando" a los 15 s', async function() {
    const timers = makeFakeTimers();
    const manual = makeManualFetch();
    const { handler, states, successes } = makeHandlerWithFakeTimers(manual.apiFetch, timers);

    const p = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    await timers.advance(5000);
    await timers.advance(10000);

    const msg15 = states.filter(function(s) { return s.message && s.message.includes('Seguimos'); });
    assert(msg15.length > 0, 'Debe aparecer "Seguimos procesando" a los 15 s');
    assertEqual(msg15[msg15.length - 1].messageType, 'advertencia', 'messageType=advertencia');

    manual.resolve();
    await p;
    assert(successes.length === 1, 'onSuccess tras resolucion');
});

// ── 4. Timeout de 35 s → AbortError → boton habilitado ──────────────────────
await test('4. Timeout 35 s → mensaje timeout, loading=false, texto restaurado', async function() {
    const timers  = makeFakeTimers();
    const factory = new FakeAbortControllerFactory();
    const manual  = makeManualFetch();
    const { handler, states } = makeHandlerWithFakeTimers(manual.apiFetch, timers, factory);

    const p = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    await timers.advance(35000);
    await p;

    const last = states[states.length - 1];
    assertEqual(last.loading, false,           'loading=false tras timeout');
    assertEqual(last.text,    'Iniciar Sesión', 'Texto restaurado');
    assert(last.message && last.message.includes('35 segundos'), 'Mensaje menciona 35 segundos');
    assertEqual(last.messageType, 'error', 'messageType=error');
    assertEqual(factory.last.abortCalled, 1, 'AbortController.abort() llamado una vez (por timeout)');
});

// ── 5. Doble clic → segundo ignorado, sin abort ──────────────────────────────
await test('5. Doble clic → segunda llamada ignorada, sin abort de la primera solicitud', async function() {
    let fetchCalls = 0;
    const factory  = new FakeAbortControllerFactory();
    const manual   = makeManualFetch();

    const { handler, successes } = makeHandlerReal(function(credentials, signal) {
        fetchCalls++;
        return manual.apiFetch(credentials, signal);
    }, factory);

    const p1 = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    // Segundo clic mientras loading=true
    handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    manual.resolve();
    await p1;

    assertEqual(fetchCalls,              1, 'fetch llamado exactamente una vez');
    assertEqual(factory.count,           1, 'Solo un AbortController creado');
    assertEqual(factory.last.abortCalled, 0, 'AbortController NO fue abortado');
    assertEqual(successes.length,        1, 'onSuccess llamado una vez');
});

// ── 6. Reintento despues de timeout ──────────────────────────────────────────
await test('6. Reintento despues de timeout → segundo intento exitoso', async function() {
    let callCount  = 0;
    const timers1  = makeFakeTimers();
    const manual1  = makeManualFetch();
    const states   = [];
    const successes = [];

    const h1 = createLoginHandler({
        apiFetch: function(creds, signal) {
            callCount++;
            return manual1.apiFetch(creds, signal);
        },
        onStateChange: function(s) { states.push(Object.assign({}, s)); },
        onSuccess:     function(d) { successes.push(d); },
        _setTimeout:      timers1._setTimeout,
        _clearTimeout:    timers1._clearTimeout,
        _AbortController: function() { return makeFakeAbortController(); },
    });

    const p1 = h1.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });
    await timers1.advance(35000);
    await p1;

    assertEqual(states[states.length - 1].loading, false, 'loading=false tras timeout');

    // Nuevo handler fresco para el reintento
    const timers2 = makeFakeTimers();
    const h2 = createLoginHandler({
        apiFetch: function() {
            callCount++;
            return Promise.resolve(DEFAULT_RESP);
        },
        onStateChange: function(s) { states.push(Object.assign({}, s)); },
        onSuccess:     function(d) { successes.push(d); },
        _setTimeout:      timers2._setTimeout,
        _clearTimeout:    timers2._clearTimeout,
        _AbortController: function() { return makeFakeAbortController(); },
    });

    await h2.login({ identificador: 'USR-001', password: 'pw' });
    assertEqual(successes.length, 1, 'Segundo intento tiene exito');
    assertEqual(callCount,        2, '2 llamadas fetch totales');
});

// ── 7. Segunda llamada durante carga activa → ignorada ───────────────────────
await test('7. Segunda llamada login() durante carga activa → ignorada completamente', async function() {
    let fetchCalls = 0;
    const manual   = makeManualFetch();

    const { handler, states, successes } = makeHandlerReal(function(creds, signal) {
        fetchCalls++;
        return manual.apiFetch(creds, signal);
    });

    const p1 = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    // Tres llamadas adicionales mientras loading=true
    await handler.login({ identificador: 'USR-001', password: 'pw' });
    await handler.login({ identificador: 'USR-001', password: 'pw' });
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    assertEqual(fetchCalls, 1, 'fetch llamado solo una vez');

    manual.resolve();
    await p1;

    assertEqual(successes.length, 1,    'onSuccess llamado una vez');
    assertEqual(fetchCalls,       1,    'fetch sigue siendo 1 despues de resolver');
});

// ── 8. Error 401 → mensaje especifico, permite reintento ─────────────────────
await test('8. Error 401 → mensaje de credenciales, loading=false, permite reintento', async function() {
    const err401  = new Error('Código o contraseña incorrectos.');
    err401.status = 401;
    let callCount = 0;

    const { handler, states, successes } = makeHandlerReal(function() {
        callCount++;
        if (callCount === 1) return Promise.reject(err401);
        return Promise.resolve(DEFAULT_RESP);
    });

    await handler.login({ identificador: 'USR-001', password: 'wrong' });

    const last = states[states.length - 1];
    assertEqual(last.loading,     false,   'loading=false tras 401');
    assertEqual(last.messageType, 'error', 'messageType=error');
    assert(last.message && last.message.length > 0, 'Hay mensaje');

    // Reintento debe funcionar
    await handler.login({ identificador: 'USR-001', password: 'correct' });
    assertEqual(successes.length, 1, 'Reintento exitoso tras 401');
});

// ── 9. Error 500 → mensaje generico ──────────────────────────────────────────
await test('9. Error 500 → mensaje generico, loading=false', async function() {
    const err500  = new Error('Error interno del servidor');
    err500.status = 500;

    const { handler, states } = makeHandlerReal(function() { return Promise.reject(err500); });
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    const last = states[states.length - 1];
    assertEqual(last.loading,     false,   'loading=false tras 500');
    assertEqual(last.messageType, 'error', 'messageType=error');
    assert(last.message && last.message.length > 0, 'Hay mensaje');
});

// ── 10. Error de red ─────────────────────────────────────────────────────────
await test('10. Error de red (TypeError) → mensaje error, loading=false', async function() {
    const { handler, states } = makeHandlerReal(function() {
        return Promise.reject(new TypeError('Failed to fetch'));
    });
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    const last = states[states.length - 1];
    assertEqual(last.loading,     false,   'loading=false tras error de red');
    assertEqual(last.messageType, 'error', 'messageType=error');
});

// ── 11. Doble clic rapido → fetch exactamente una vez ────────────────────────
await test('11. Doble clic rapido → fetch llamado exactamente una vez', async function() {
    let fetchCalls = 0;
    const manual   = makeManualFetch();

    const { handler, successes } = makeHandlerReal(function(creds, signal) {
        fetchCalls++;
        return manual.apiFetch(creds, signal);
    });

    // Tres clics rapidos sin await
    handler.login({ identificador: 'USR-001', password: 'pw' });
    handler.login({ identificador: 'USR-001', password: 'pw' });
    handler.login({ identificador: 'USR-001', password: 'pw' });

    await new Promise(function(r) { setImmediate(r); });
    manual.resolve();
    await new Promise(function(r) { setTimeout(r, 20); });

    assertEqual(fetchCalls,       1, 'fetch llamado una vez aunque se cliqueó 3 veces');
    assertEqual(successes.length, 1, 'onSuccess una sola vez');
});

// ── 12. Enter repetido → segunda llamada ignorada ────────────────────────────
await test('12. Enter repetido mientras login pendiente → sin segunda solicitud', async function() {
    let fetchCalls = 0;
    const manual   = makeManualFetch();

    const { handler, successes } = makeHandlerReal(function(creds, signal) {
        fetchCalls++;
        return manual.apiFetch(creds, signal);
    });

    // 4 submit via Enter rapidos
    const promises = [
        handler.login({ identificador: 'USR-001', password: 'pw' }),
        handler.login({ identificador: 'USR-001', password: 'pw' }),
        handler.login({ identificador: 'USR-001', password: 'pw' }),
        handler.login({ identificador: 'USR-001', password: 'pw' }),
    ];

    await new Promise(function(r) { setImmediate(r); });
    manual.resolve();
    await Promise.all(promises);

    assertEqual(fetchCalls,       1, 'fetch una sola vez aunque Enter se presiono 4 veces');
    assertEqual(successes.length, 1, 'onSuccess una vez');
});

// ── 13. Admin login exitoso ───────────────────────────────────────────────────
await test('13. Admin login exitoso → onSuccess recibe token y datos de admin', async function() {
    const { handler, successes } = makeHandlerReal(function(creds) {
        assert(creds.email    === 'admin@rodeo.cl', 'email correcto');
        assert(creds.password === 'Admin2024!',     'password correcto');
        return Promise.resolve(ADMIN_RESP);
    });

    await handler.login({ email: 'admin@rodeo.cl', password: 'Admin2024!' });

    assertEqual(successes.length,         1,              'onSuccess llamado');
    assertEqual(successes[0].token,       'admin-tok',    'Token de admin');
    assertEqual(successes[0].usuario.tipo, 'administrador', 'tipo=administrador');
});

// ── 14. Usuario login exitoso ─────────────────────────────────────────────────
await test('14. Usuario login exitoso → onSuccess con primer_login=false', async function() {
    const { handler, successes } = makeHandlerReal(function(creds) {
        assert(creds.identificador === 'USR-0001', 'identificador correcto');
        return Promise.resolve(USUARIO_RESP);
    });

    await handler.login({ identificador: 'USR-0001', password: 'jurados' });

    assertEqual(successes.length,              1,         'onSuccess llamado');
    assertEqual(successes[0].token,           'usr-tok',  'Token de usuario');
    assertEqual(successes[0].usuario.primer_login, false, 'primer_login=false');
});

// ── 15. Redireccion unica → onSuccess exactamente una vez ────────────────────
await test('15. Redireccion unica → onSuccess exactamente una vez, llama posteriores ignoradas', async function() {
    let onSuccessCalls = 0;
    const states  = [];

    const handler = createLoginHandler({
        apiFetch:      function() { return Promise.resolve(DEFAULT_RESP); },
        onStateChange: function(s) { states.push(s); },
        onSuccess:     function() { onSuccessCalls++; },
        _AbortController: function() { return makeFakeAbortController(); },
    });

    // Primera llamada: login exitoso (_done=true)
    await handler.login({ identificador: 'USR-001', password: 'pw' });
    // Llamadas posteriores: deben ser ignoradas porque _done=true
    await handler.login({ identificador: 'USR-001', password: 'pw' });
    await handler.login({ identificador: 'USR-001', password: 'pw' });

    assertEqual(onSuccessCalls, 1, 'onSuccess llamado exactamente una vez');
});

// ── 16. Solicitud original NO abortada por segundo submit ────────────────────
await test('16. Solicitud original NO abortada por segundo submit', async function() {
    const factory  = new FakeAbortControllerFactory();
    const manual   = makeManualFetch();
    let fetchCalls = 0;

    const { handler, successes } = makeHandlerReal(function(creds, signal) {
        fetchCalls++;
        return manual.apiFetch(creds, signal);
    }, factory);

    // Primer submit
    const p1 = handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    // Segundo submit: ignorado — NO debe abortar el AbortController activo
    handler.login({ identificador: 'USR-001', password: 'pw' });
    handler.login({ identificador: 'USR-001', password: 'pw' });
    await new Promise(function(r) { setImmediate(r); });

    assertEqual(factory.count,            1, 'Solo un AbortController fue creado');
    assertEqual(factory.last.abortCalled, 0, 'AbortController NO abortado por segundo submit');
    assertEqual(fetchCalls,               1, 'fetch llamado una sola vez');

    // Resolver normalmente
    manual.resolve();
    await p1;

    assertEqual(successes.length,         1, 'onSuccess llamado una vez');
    assertEqual(factory.last.abortCalled, 0, 'AbortController sigue intacto (sin timeout)');
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
