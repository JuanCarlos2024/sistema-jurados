// Renderiza el menú lateral del admin de forma centralizada.
// Cada HTML admin debe tener <nav class="sidebar-nav"></nav> vacío y cargar este script.
// Para páginas de detalle (no en el menú), usar data-active en el <nav>:
//   <nav class="sidebar-nav" data-active="/admin/evaluaciones.html"></nav>
(function () {
    var NAV = [
        { s: 'Principal' },
        { href: '/admin/dashboard.html',           icon: '📊', label: 'Dashboard' },
        { s: 'Personas' },
        { href: '/admin/usuarios.html',            icon: '👥', label: 'Jurados y Delegados' },
        { href: '/admin/disponibilidad.html',      icon: '📅', label: 'Disponibilidad' },
        { s: 'Rodeos' },
        { href: '/admin/rodeos.html',              icon: '🏆', label: 'Rodeos' },
        { href: '/admin/importacion.html',         icon: '📥', label: 'Importar Excel' },
        { s: 'Pagos' },
        { href: '/admin/bonos.html',               icon: '💰', label: 'Bonos' },
        { s: 'Reportes' },
        { href: '/admin/reportes.html',            icon: '📈', label: 'Reportes' },
        { href: '/admin/exportacion-pagos.html',   icon: '💳', label: 'Exportación de Pagos' },
        { href: '/admin/reporte-cartillas.html',   icon: '📋', label: 'Reporte Cartillas Jurado' },
        { href: '/admin/reporte-deportivo.html',   icon: '🏇', label: 'Reporte Deportivo' },
        { s: 'Sistema' },
        { href: '/admin/configuracion.html',       icon: '⚙️',  label: 'Configuración' },
        { href: '/admin/auditoria.html',           icon: '📋', label: 'Auditoría' },
        { s: 'Evaluación Técnica' },
        { href: '/admin/evaluaciones.html',        icon: '📝', label: 'Análisis de Casos' },
        { href: '/admin/evaluacion-dashboard.html',icon: '📊', label: 'Dashboard Eval.' },
        { href: '/admin/evaluacion-reportes.html', icon: '📌', label: 'Reportes Eval.' },
    ];

    function render() {
        var nav = document.querySelector('.sidebar-nav');
        if (!nav) return;

        var path = window.location.pathname;
        // data-active permite forzar qué item queda activo (p.ej. en páginas de detalle)
        var forcedActive = nav.getAttribute('data-active') || null;

        var html = '';
        NAV.forEach(function (item) {
            if (item.s) {
                html += '<div class="nav-seccion">' + item.s + '</div>';
                return;
            }
            var isActive = forcedActive
                ? (path === forcedActive || path.endsWith(forcedActive.split('/').pop()))
                    && item.href === forcedActive
                : (path === item.href || path.endsWith('/' + item.href.split('/').pop()));
            html += '<a href="' + item.href + '" class="nav-item' + (isActive ? ' activo' : '') + '">'
                + '<span class="icon">' + item.icon + '</span> ' + item.label + '</a>';
        });

        nav.innerHTML = html;
    }

    // Ejecutar de inmediato si el <nav> ya existe en el DOM (script al final del body)
    if (document.querySelector('.sidebar-nav')) {
        render();
    } else {
        document.addEventListener('DOMContentLoaded', render);
    }
})();
