// Protección estática (regex sobre el código fuente — este proyecto no tiene
// entorno DOM para frontend, mismo patrón que institucionalPortal.test.js)
// de renderHistorialResponsablesCd() en admin/rodeos.html (Fase 3.5.1,
// sección 3: historial de responsables en la pantalla EXISTENTE donde se
// revisan las Cartillas de Delegado — nunca un módulo nuevo).
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin', 'rodeos.html'), 'utf8').replace(/\r\n/g, '\n');

function extraerFuncion(nombre, contextoExtra = '') {
    const inicio = html.indexOf(`function ${nombre}`);
    const fin = html.indexOf('\n}', inicio) + 2;
    const texto = html.slice(inicio, fin);
    return new Function(`${contextoExtra}\n${texto}; return ${nombre};`)();
}
const STUB = "function sanitizar(s){ if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#039;'); }";

describe('rodeos.html (admin) — se agrega al bloque EXISTENTE de revisión de Cartillas de Delegado, nunca un módulo nuevo', () => {
    test('la llamada a renderHistorialResponsablesCd(c) está en la MISMA plantilla que ya usa verCartillaDelegadoDigital (modal existente)', () => {
        const bloqueModal = html.slice(html.indexOf('async function verCartillaDelegadoDigital'), html.indexOf('async function verCartillaDelegadoDigital') + 9000);
        expect(bloqueModal).toMatch(/\$\{renderHistorialResponsablesCd\(c\)\}/);
        // Siempre después del historial de observaciones existente, nunca antes.
        expect(bloqueModal.indexOf('renderHistorialObsCd(c)')).toBeLessThan(bloqueModal.indexOf('renderHistorialResponsablesCd(c)'));
    });
});

describe('renderHistorialResponsablesCd — Delegado Rentado (nunca un bloque institucional, ni vacío)', () => {
    test('cartilla de Delegado Rentado (delegado_asociacion_id ausente) -> string vacío, sin excepción', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        expect(fn({ delegado_asociacion_id: null, historial_responsables: [] })).toBe('');
        expect(fn({})).toBe('');
    });
});

describe('renderHistorialResponsablesCd — cartilla institucional, sin historial todavía', () => {
    test('historial_responsables=[] -> indicación honesta, nunca fabrica un evento', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const html_ = fn({ delegado_asociacion_id: 'del-1', historial_responsables: [] });
        expect(html_).toMatch(/Sin eventos de responsable registrados todavía/);
        expect(html_).toContain('Historial de responsables de la cartilla');
    });

    test('incluye la nota honesta sobre la cuenta institucional compartida', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const html_ = fn({ delegado_asociacion_id: 'del-1', historial_responsables: [] });
        expect(html_).toContain('credencial compartida');
        expect(html_).toContain('no certifica la identidad individual');
    });
});

describe('renderHistorialResponsablesCd — cartilla institucional CON historial (confirmación + reemplazo)', () => {
    const EVENTOS = [
        { accion: 'confirmar_responsable_institucional', datos_nuevos: { delegado_nombre: 'Ana Soto' }, created_at: '2026-01-01T10:00:00Z' },
        { accion: 'crear', descripcion: 'Creación de cartilla institucional — delegado: Ana Soto', created_at: '2026-01-01T10:05:00Z' },
        { accion: 'reemplazar_responsable_institucional', actor_nombre: 'Pedro Pérez', actor_id: 'admin-1', datos_nuevos: { delegado_nombre: 'Bruno Hernández', motivo: 'Ana no puede continuar' }, created_at: '2026-01-10T09:00:00Z' }
    ];

    test('muestra el delegado original (Ana Soto)', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const html_ = fn({ delegado_asociacion_id: 'del-2', delegado_nombre: 'Bruno Hernández', historial_responsables: EVENTOS });
        expect(html_).toContain('Delegado original');
        expect(html_).toContain('Ana Soto');
    });

    test('muestra el reemplazo con delegado anterior Y nuevo, motivo, y el administrador autorizante POR NOMBRE', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const html_ = fn({ delegado_asociacion_id: 'del-2', delegado_nombre: 'Bruno Hernández', historial_responsables: EVENTOS });
        expect(html_).toMatch(/De\s*<strong>Ana Soto<\/strong>\s*a\s*<strong>Bruno Hernández<\/strong>/);
        expect(html_).toContain('Ana no puede continuar');
        expect(html_).toContain('Pedro Pérez');
        expect(html_).not.toMatch(/Administrador \(ID/); // tenía nombre resuelto, nunca debió caer al fallback por id
    });

    test('administrador SIN nombre resuelto -> cae al fallback "Administrador (ID ...)", nunca se inventa un nombre', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const eventosSinNombre = EVENTOS.map(e => e.accion === 'reemplazar_responsable_institucional' ? { ...e, actor_nombre: null } : e);
        const html_ = fn({ delegado_asociacion_id: 'del-2', delegado_nombre: 'Bruno Hernández', historial_responsables: eventosSinNombre });
        expect(html_).toContain('Administrador (ID admin-1)');
    });

    test('muestra el responsable VIGENTE al final (Bruno Hernández, no Ana)', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const html_ = fn({ delegado_asociacion_id: 'del-2', delegado_nombre: 'Bruno Hernández', historial_responsables: EVENTOS });
        expect(html_).toMatch(/Responsable vigente:[\s\S]{0,40}Bruno Hernández/);
    });

    test('muestra el evento de creación de la cartilla (eventos relevantes), con su descripción real', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const html_ = fn({ delegado_asociacion_id: 'del-2', delegado_nombre: 'Bruno Hernández', historial_responsables: EVENTOS });
        expect(html_).toContain('Creación de la cartilla');
        expect(html_).toContain('Creación de cartilla institucional — delegado: Ana Soto');
    });

    test('es de solo lectura: ningún botón ni input para editar/eliminar un registro histórico', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const html_ = fn({ delegado_asociacion_id: 'del-2', delegado_nombre: 'Bruno Hernández', historial_responsables: EVENTOS });
        expect(html_).not.toMatch(/<button/);
        expect(html_).not.toMatch(/<input/);
        expect(html_).not.toMatch(/onclick=/);
    });

    test('sanitiza los campos insertados (motivo, nombres, descripcion) — nunca XSS', () => {
        const fn = extraerFuncion('renderHistorialResponsablesCd', STUB);
        const eventosXss = [
            { accion: 'confirmar_responsable_institucional', datos_nuevos: { delegado_nombre: '<img src=x onerror=alert(1)>' }, created_at: '2026-01-01T10:00:00Z' }
        ];
        const html_ = fn({ delegado_asociacion_id: 'del-2', historial_responsables: eventosXss });
        expect(html_).not.toContain('<img src=x onerror=alert(1)>');
        expect(html_).toContain('&lt;img');
    });
});
