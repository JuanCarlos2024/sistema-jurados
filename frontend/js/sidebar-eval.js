(function () {
    function inyectarNavEval() {
        var nav = document.querySelector('.sidebar-nav');
        if (!nav) return;
        if (nav.querySelector('[data-eval-nav]')) return;
        nav.insertAdjacentHTML('beforeend',
            '<div class="nav-seccion">Evaluaci\u00f3n T\u00e9cnica</div>' +
            '<a href="/admin/evaluaciones.html" class="nav-item" data-eval-nav>' +
            '<span class="icon">\ud83d\udcdd</span> An\u00e1lisis de Casos</a>' +
            '<a href="/admin/evaluacion-dashboard.html" class="nav-item" data-eval-nav>' +
            '<span class="icon">\ud83d\udcca</span> Dashboard Eval.</a>' +
            '<a href="/admin/evaluacion-reportes.html" class="nav-item" data-eval-nav>' +
            '<span class="icon">\ud83d\udccc</span> Reportes Eval.</a>'
        );
        var actual = window.location.pathname;
        nav.querySelectorAll('[data-eval-nav]').forEach(function (el) {
            var href = el.getAttribute('href');
            if (href && actual === href) {
                el.classList.add('activo');
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inyectarNavEval);
    } else {
        inyectarNavEval();
    }
})();
