(function () {
    // Aplicar estado guardado de inmediato para evitar flash visual
    if (localStorage.getItem('sidebarCollapsed') === 'true') {
        document.body.classList.add('sidebar-collapsed');
    }

    function icono(collapsed) { return collapsed ? '☰' : '◄'; }
    function titulo(collapsed) { return collapsed ? 'Mostrar menú' : 'Ocultar menú'; }

    function init() {
        var topbarFlex = document.querySelector('.topbar .flex');
        if (!topbarFlex) return;

        var btn = document.createElement('button');
        btn.className = 'btn-sidebar-collapse';
        var col = document.body.classList.contains('sidebar-collapsed');
        btn.innerHTML = icono(col);
        btn.title = titulo(col);
        btn.setAttribute('aria-label', 'Alternar menú lateral');

        btn.addEventListener('click', function () {
            var ahora = document.body.classList.toggle('sidebar-collapsed');
            localStorage.setItem('sidebarCollapsed', ahora);
            btn.innerHTML = icono(ahora);
            btn.title = titulo(ahora);
        });

        // Insertar antes del primer hijo (antes del btn-menu-movil o del h1)
        topbarFlex.insertBefore(btn, topbarFlex.firstChild);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
