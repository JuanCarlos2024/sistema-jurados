// ═════════════════════════════════════════════════════════════════════════
// Informe de Gestión Deportiva — pantalla: controles, previsualización (10 páginas A4
// horizontal), gráficos (Chart.js 4.4.4, ya usado en el proyecto) e impresión.
//
// TODOS los valores vienen de UNA respuesta: GET /admin/informe-gestion/datos. Aquí no se
// recalcula ningún indicador; solo se presenta (helpers en informeGestionHelpers.js).
// ═════════════════════════════════════════════════════════════════════════
protegerRuta('administrador');

const IGP = (function () {
    const H = window.IG;
    const esc = H.esc;
    const COLOR = { azul: '#1e3a5f', azul2: '#2d5a8e', azulClaro: '#8fb3d9', gris: '#95a5a6', grisClaro: '#cfd6dc', verde: '#27ae60', amarillo: '#f39c12', rojo: '#c0392b' };
    const TIPS = {
        cobertura: 'Cobertura = registros disponibles / rodeos realizados. Con cobertura insuficiente los valores se muestran, pero no deben leerse como conclusión.',
        proyeccion: 'Estimación referencial según ritmo actual e histórico. No es certeza ni intervalo estadístico. Solo se proyecta con avance histórico suficiente.',
        muestra: 'Muestra = actuaciones del jurado. Los rankings priorizan muestra suficiente, luego limitada; la muestra insuficiente se muestra pero no se rankea.',
        alterado: H.AVISO_ALTERADOS,
        disponibilidad: 'Solo se registran días disponibles. La ausencia de registro se informa como "sin declaración registrada", nunca como "no disponible".',
        concentracion: 'Permite observar cuán distribuida está la asignación del cuerpo de jurados. No indica si la concentración es buena o mala.',
        corteAnterior: 'Corte deportivo anterior = cierre del bloque de rodeo inmediatamente anterior. No es el informe anterior emitido.',
        equivalente: 'Se compara con la misma etapa de la temporada anterior: 52 semanas antes, conservando el día de la semana.'
    };
    let DATOS = null, CHARTS = [], TEMPORADA_INICIO = null, RANGOS = null;
    // Numeración real: cada página se dibuja con su número (texto, no contador CSS) → correcta en pantalla y en el PDF.
    const TOTAL_PAGINAS = 10;
    let NUM_PAGINA = 1;

    const $ = id => document.getElementById(id);
    const tip = k => `<span class="tip" data-tip="${esc(TIPS[k])}" aria-label="${esc(TIPS[k])}">i</span>`;
    const get = (o, ruta, def = null) => ruta.split('.').reduce((a, k) => (a === null || a === undefined ? a : a[k]), o) ?? def;
    const nombreCorto = s => String(s || '—').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

    // ── Filtros ──────────────────────────────────────────────────────────
    // Los rangos vienen del backend: "último fin de semana" = bloque de rodeo (services/feriados.js), igual que la designación.
    async function rapido(tipo) {
        if (!RANGOS) { try { RANGOS = await api.get('/admin/informe-gestion/rangos-rapidos'); } catch (e) { mostrarToast('No se pudieron obtener los accesos rápidos', 'error'); return; } }
        if (!RANGOS) return;
        if (tipo === 'finde') { $('ig-desde').value = RANGOS.ultimo_fin_de_semana.desde; $('ig-hasta').value = RANGOS.ultimo_fin_de_semana.hasta; }
        else if (tipo === '30d') { $('ig-desde').value = RANGOS.ultimos_30_dias.desde; $('ig-hasta').value = RANGOS.ultimos_30_dias.hasta; }
        else { $('ig-desde').value = TEMPORADA_INICIO || `${RANGOS.hoy.slice(0, 4)}-04-01`; $('ig-hasta').value = RANGOS.hoy; }
        generar();
    }

    // ── Componentes ──────────────────────────────────────────────────────
    const AMBITO = { P: ['Período', 'per'], T: ['Temporada', 'tem'], H: ['Histórico eq.', 'his'], F: ['A la fecha', 'fec'] };
    const ambTag = k => (k && AMBITO[k] ? `<span class="amb ${AMBITO[k][1]}">${AMBITO[k][0]}</span>` : '');
    function kpi({ lbl, val, sub = '', clase = 'azul', extra = '', chico = false, tipK = null, amb = null }) {
        return `<div class="kpi ${clase}${chico ? ' chico' : ''}"><div class="lbl">${lbl}${tipK ? tip(tipK) : ''}${ambTag(amb)}</div><div class="val">${val}</div><div class="sub">${sub}</div>${extra}</div>`;
    }
    const badgeCob = b => { const c = H.estadoCobertura(b); return c.etiqueta ? `<span class="badge ${c.clase}">${c.etiqueta}</span>` : ''; };
    const varHtml = (v, texto) => `<span class="var ${H.claseVariacion(v)}">${H.flechaVariacion(v)} ${texto ?? H.fmtPctSigno(v)}</span>`;
    function cabecera(titulo, ambito = '') {
        return `<div class="pg-head"><img src="/assets/logo_V2.png" alt=""><div class="marca">Federación del Rodeo Chileno<br>Informe de Gestión Deportiva</div><h2>${titulo}${ambito ? `<small>${ambito}</small>` : ''}</h2></div>`;
    }
    function pie(d) {
        const ex = get(d, 'metadata.datos_excluidos', null);
        const hayExcluidos = ex && ((ex.usuarios_prueba || 0) + (ex.rodeos_prueba || 0)) > 0;
        return `<div class="pie"><span>Informe de Gestión Deportiva · ${H.fmtFecha(d.metadata.periodo.desde)} al ${H.fmtFecha(d.metadata.periodo.hasta)} · Temporada ${esc(d.metadata.temporada.nombre)}${hayExcluidos ? ' · Datos de prueba excluidos del análisis' : ''}</span><span class="pnum">${H.textoPagina(NUM_PAGINA, TOTAL_PAGINAS)}</span></div>`;
    }
    const pagina = (d, contenido, extraClase = '') => `<div class="pagina-wrap"><section class="pagina ${extraClase}">${contenido}${pie(d)}</section></div>`;
    const sinInfo = (t = 'Sin información disponible para el período') => `<div class="vacio">${t}</div>`;

    // ── Página 1: Portada ────────────────────────────────────────────────
    function p1(d) {
        const m = d.metadata;
        return `<div class="pagina-wrap"><section class="pagina"><div class="portada">
            <div class="izq"><div class="logo-caja"><img src="/assets/logo_V2.png" alt="Federación del Rodeo Chileno"></div></div>
            <div class="der">
                <div class="sup">Federación del Rodeo Chileno</div>
                <h1>Informe de<br>Gestión Deportiva</h1>
                <div class="sub">Federación del Rodeo Chileno</div>
                <div class="barra-a"></div>
                <div class="datos">
                    <div class="k">Período analizado</div><div class="v">${H.fmtFecha(m.periodo.desde)} al ${H.fmtFecha(m.periodo.hasta)}</div>
                    <div class="k">Temporada</div><div class="v">${esc(m.temporada.nombre)}</div>
                    <div class="k">Fecha de generación</div><div class="v">${H.fmtFecha(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date(m.generado_en)))}</div>
                </div>
                <div class="frase">Seguimiento deportivo, desempeño y evolución de temporada</div>
            </div></div></section></div>`;
    }

    // ── Página 2: Resumen ejecutivo ──────────────────────────────────────
    function p2(d) {
        const per = d.periodo.rodeos, acu = d.acumulado_temporada.rodeos;
        const cmp = d.comparacion.rodeos, cmpP = d.comparacion.rodeos_periodo;
        const evA = d.evaluaciones.acumulado_temporada, evP = d.evaluaciones.periodo;
        const cobA = d.cobertura.acumulado_temporada;
        const TS = H.temporadasComparacion(d), refT = TS.historica;
        const perEq = get(d, 'comparacion.periodo_equivalente', null);
        const perEqTxt = perEq ? ` · ${H.textoRangoFechas(perEq.desde, perEq.hasta)}${perEq.modo === 'BLOQUE_DE_RODEO' ? ' (bloque de rodeo)' : ''}` : '';
        const c = d.colleras, cc = get(c, 'comparacion.temporadas', []).find(t => t.estado === 'OK');
        const alt = evA.resultados_alterados, altP = evP.resultados_alterados, altT = H.textoIndicador(alt.cantidad, alt.denominador, alt.porcentaje);
        const covAlt = H.estadoCobertura({ ...cobA.evaluaciones_publicadas });
        const f = evA.faltas, fP = evP.faltas, g = evA.ganado;
        const cobCart = cobA.cartillas_jurado;
        const aso = d.asociaciones;

        const k1 = kpi({ lbl: 'Rodeos del período', amb: 'P', val: H.fmtEntero(per.realizados), sub: cmpP.disponible ? `vs <b>${H.fmtEntero(cmpP.historico)}</b> en ${esc(TS.historica)}${esc(perEqTxt)} ${tip('equivalente')}<br>${varHtml(cmpP.variacion_pct)}` : 'Sin dato histórico comparable', clase: 'azul' });
        const k2 = kpi({ lbl: 'Rodeos acumulados', amb: 'T', val: H.fmtEntero(acu.realizados), sub: `Temporada ${esc(d.metadata.temporada.nombre)}<br><b>${H.fmtEntero(acu.programados)}</b> programados posteriores al corte`, clase: 'azul' });
        const k3 = kpi({ lbl: `Variación ${esc(TS.actual)} vs ${esc(refT)}`, amb: 'T', val: cmp.disponible ? `${H.flechaVariacion(cmp.variacion_pct)} ${H.fmtPctSigno(cmp.variacion_pct)}` : 'Sin dato histórico comparable', sub: cmp.disponible ? `<b>${H.fmtEntero(cmp.actual)}</b> (${esc(TS.actual)}) vs <b>${H.fmtEntero(cmp.historico)}</b> (${esc(refT)}, fecha equivalente)` : '', clase: cmp.disponible ? H.claseVariacion(cmp.variacion_pct) : 'gris', tipK: 'equivalente' });
        const k4 = kpi({ lbl: 'Colleras completas', amb: 'F', val: c.actual && c.actual.total !== null ? H.fmtEntero(c.actual.total) : 'SIN DATOS', sub: cc ? `<b>${H.fmtEntero(cc.historico)}</b> en ${esc(cc.temporada)} (fecha equivalente)<br>${varHtml(cc.variacion_pct)}` : 'Sin dato histórico comparable', clase: cc ? H.claseVariacion(cc.variacion_pct) : 'azul',
            extra: c.actual && c.actual.estado && c.actual.estado !== 'actual' ? `<div class="sub"><span class="badge amarillo">Dato de respaldo (snapshot)</span></div>` : '' });
        const k5 = kpi({ lbl: 'Resultados alterados', amb: 'T', val: `${altT.fraccion}`, sub: `${altT.pct} de evaluaciones publicadas (temporada)<br>Período: ${altP.denominador ? `${H.textoNSobreTotal(altP.cantidad, altP.denominador)} · ${H.fmtPct(altP.porcentaje)}` : '<b>SIN DATOS</b> (0 publicadas)'}`,
            clase: 'gris', chico: true, tipK: 'alterado', extra: covAlt.etiqueta ? `<div class="sub"><span class="badge gris">${covAlt.etiqueta}</span></div>` : '' });
        const k6 = kpi({ lbl: 'Rodeos con falta reglamentaria', amb: 'T', val: H.fmtEntero(f.reglamentarias.rodeos_con_falta), sub: `${H.fmtPct(f.reglamentarias.porcentaje_rodeos_evaluados)} de <b>${H.fmtEntero(f.rodeos_con_evaluacion)}</b> evaluados<br><span style="color:#7f8c8d">${H.fmtEntero(f.reglamentarias.casos_total)} casos · período: ${H.fmtEntero(fP.reglamentarias.rodeos_con_falta)} rodeos</span>`, clase: 'azul' });
        const k7 = kpi({ lbl: 'Ganado fuera de peso', amb: 'T', val: H.textoNSobreTotal(g.cantidad_si, g.denominador_cartillas_con_dato), sub: `${H.fmtPct(g.porcentaje)} de las cartillas con dato<br>Cartillas recibidas ${H.textoNSobreTotal(cobCart.numerador, cobCart.denominador)}`, clase: g.interpretable === false ? 'gris' : 'azul', chico: true });
        const k8 = kpi({ lbl: 'Evaluación promedio', amb: 'T', val: H.fmtNota(evA.evaluacion.nota_promedio_publicada), sub: `Nota final · <b>${H.fmtEntero(evA.evaluacion.evaluaciones_publicadas)}</b> evaluaciones publicadas`, clase: cobA.evaluaciones_publicadas.interpretable === false ? 'gris' : 'azul', tipK: 'cobertura',
            extra: badgeCob(cobA.evaluaciones_publicadas) ? `<div class="sub">${badgeCob(cobA.evaluaciones_publicadas)}</div>` : '' });
        const sin = aso.catalogo_disponible ? aso.resumen.sin_actividad_alertables : null;
        const k9 = kpi({ lbl: 'Asociaciones sin rodeos', amb: 'T', val: sin === null ? 'SIN DATOS' : H.fmtEntero(sin), sub: sin === null ? 'Catálogo no disponible' : (aso.resumen.sin_actividad_con_historico_positivo === 0 ? (sin ? 'Todas con 0 rodeos también en el histórico equivalente' : 'Ninguna') : `<b>${aso.resumen.sin_actividad_con_historico_positivo}</b> con rodeos en el histórico equivalente`), clase: sin === null ? 'gris' : (aso.resumen.sin_actividad_con_historico_positivo > 0 ? 'amarillo' : 'azul') });

        const item = (t, b) => { const e = H.estadoCobertura(b); return `<div class="item ${e.clase}"><div>${t}</div><div class="n">${H.textoNSobreTotal(b.numerador, b.denominador)} <small style="font-size:11px;font-weight:600">${b.denominador ? H.fmtPct(b.porcentaje) : ''}</small></div>${e.etiqueta ? `<span class="badge gris">${e.etiqueta}</span>` : '<span class="badge verde">Cobertura suficiente</span>'}</div>`; };
        const banda = `<div class="banda h"><div class="tit">Cobertura de información</div>${item('Evaluaciones publicadas / rodeos ' + tip('cobertura'), cobA.evaluaciones_publicadas)}${item('Cartillas de jurado / rodeos', cobA.cartillas_jurado)}${item('Nota Comisión / evaluaciones publicadas', cobA.nota_comision)}${item('Nota Delegado / evaluaciones publicadas', cobA.nota_delegado)}</div>`;
        const ev2 = H.resumenEvolucion(d);
        const tileC = c => `<div class="cb${c.sinDato ? ' sd' : ''}"><div class="k">${esc(c.etiqueta)}</div><div class="v">${esc(c.valor)}</div><div class="s">${esc(c.detalle)}${c.advertencia ? ' <span class="badge gris">Cobertura insuficiente</span>' : ''}</div></div>`;
        const bandaC = `<div class="banda-c"><div class="tit-h">Cambios desde el corte deportivo anterior ${tip('corteAnterior')}${ev2.disponible ? `<span class="rot"><b>Corte actual:</b> ${esc(ev2.actual)} · <b>Corte anterior:</b> ${esc(ev2.anterior)}</span>` : ''}</div>${ev2.disponible ? `<div class="fila">${ev2.cambios.map(tileC).join('')}</div><div class="nota-metodo">${esc(H.NOTA_METODOLOGICA_CORTE)}</div>` : `<div class="vacio" style="padding:4px 0"><b>${esc(ev2.etiqueta)}</b></div>`}</div>`;
        const frases = get(d, 'lectura_ejecutiva', []);
        const bandaG = frases.length ? `<div class="banda-g"><div class="tit-h">Situación general de temporada ${esc(TS.actual)}</div><ul>${frases.map(f => `<li><span class="etq">${esc(f.etiqueta)}</span>${esc(f.texto)}</li>`).join('')}</ul></div>` : '';
        const rj = H.resumenCuerpoJurados(d);
        const itemJ = x => `<div class="it"><div class="k">Categoría ${x.categoria}</div><div class="v">${H.fmtEntero(x.jurados)} <small>jurados</small> · <b>${H.fmtNota(x.promedio)}</b></div></div>`;
        const bandaJ = `<div class="banda-j"><div class="tit-h">Cuerpo de jurados — actuaciones de temporada ${esc(TS.actual)}</div><div class="fila">${rj.categorias.map(itemJ).join('')}<div class="it"><div class="k">Jurados distintos con actuaciones</div><div class="v"><b>${H.fmtEntero(rj.distintos)}</b> <small>personas</small></div></div></div><div class="nota" style="margin-top:2px">Promedio = Nota Evaluación de Casos de las actuaciones (no es la nota final del rodeo). Un jurado que actuó en dos categorías se cuenta en cada una.</div></div>`;
        return pagina(d, `${cabecera('Resumen ejecutivo', 'Período seleccionado y acumulado de temporada · cada dato indica su ámbito')}<div class="kpi-grid grande" style="grid-template-columns:repeat(3,1fr)">${k1}${k2}${k3}${k4}${k5}${k6}${k7}${k8}${k9}</div>${banda}${bandaJ}${bandaC}${bandaG}
            <div class="nota">Períodos: rodeos del período = ${H.fmtFecha(d.metadata.periodo.desde)} al ${H.fmtFecha(d.metadata.periodo.hasta)}; el resto de los indicadores corresponde al acumulado de temporada al ${H.fmtFecha(d.metadata.periodo.hasta)}. Rodeo realizado = activo con fecha hasta el corte.</div>`);
    }

    // ── Página 3: Actividad deportiva ────────────────────────────────────
    function p3(d) {
        const per = d.periodo.rodeos, acu = d.acumulado_temporada.rodeos, cmp = d.comparacion;
        const TS = H.temporadasComparacion(d);
        const cats = cmp.por_categoria || [];
        const dist = acu.por_categoria.map(x => `<span class="badge azul">${esc(x.clave)} ${H.fmtEntero(x.cantidad)} · ${H.fmtPct(x.porcentaje, 0)}</span>`).join(' ');
        const filas = cats.length ? cats.map(x => `<tr><td>${esc(x.clave)}</td><td class="n">${H.fmtEntero(x.actual)}</td><td class="n">${x.disponible ? H.fmtEntero(x.historico) : '—'}</td><td class="n">${x.disponible ? H.fmtDif(x.diferencia) : '—'}</td><td class="n">${x.disponible && x.variacion_pct !== null ? varHtml(x.variacion_pct) : '<span class="var gris">·</span>'}</td></tr>`).join('') : `<tr><td colspan="5">${sinInfo('Sin dato histórico comparable')}</td></tr>`;
        const kt = cmp.rodeos;
        return pagina(d, `${cabecera('Actividad deportiva del período', 'Período seleccionado y acumulado de temporada al corte')}
            <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
                ${kpi({ lbl: 'Total rodeos del período', amb: 'P', val: H.fmtEntero(per.realizados), sub: `Rodeos realizados dentro del período seleccionado`, clase: 'azul' })}
                ${kpi({ lbl: 'Total rodeos acumulados', amb: 'T', val: H.fmtEntero(acu.realizados), sub: `Temporada ${esc(TS.actual)}<br>Calendario futuro: <b>${H.fmtEntero(acu.programados)}</b> rodeos programados posteriores al corte`, clase: 'azul' })}
                ${kpi({ lbl: `${esc(TS.historica)} a fecha equivalente`, amb: 'H', val: kt.disponible ? H.fmtEntero(kt.historico) : 'SIN DATOS', sub: kt.disponible ? `${varHtml(kt.variacion_pct)} · dif. ${H.fmtDif(kt.diferencia)}` : 'Sin dato histórico comparable', clase: kt.disponible ? H.claseVariacion(kt.variacion_pct) : 'gris', tipK: 'equivalente' })}
                ${kpi({ lbl: 'Categoría con más rodeos', amb: 'T', val: esc(get(acu, 'por_categoria.0.clave', '—')), sub: `${H.fmtEntero(get(acu, 'por_categoria.0.cantidad', null))} rodeos · ${H.fmtPct(get(acu, 'por_categoria.0.porcentaje', null))}`, clase: 'azul', chico: true })}
            </div>
            <div style="margin:7px 0 6px">${dist}</div>
            <div style="display:grid;grid-template-columns:1fr 1.05fr 1.15fr;gap:10px">
                <div class="panel"><div class="titulo-chart">Rodeos por categoría — ${esc(TS.actual)} vs ${esc(TS.historica)} (fecha equivalente)</div><div class="caja-chart" style="height:430px"><canvas id="ch-cat" role="img" aria-label="Barras: rodeos por categoría, temporada actual acumulada contra temporada anterior a fecha equivalente"></canvas></div></div>
                <div class="panel"><h3>Comparación por categoría</h3><table class="t"><thead><tr><th>Categoría</th><th class="n">${esc(TS.actual)}</th><th class="n">${esc(TS.historica)}</th><th class="n">Dif.</th><th class="n">Var.</th></tr></thead><tbody>${filas}</tbody></table>
                    <div class="nota">${esc(TS.actual)} = acumulado de temporada al corte. ${esc(TS.historica)} = misma fecha de la temporada anterior. Dif. y Var. = ${esc(TS.actual)} respecto de ${esc(TS.historica)}.</div></div>
                <div class="panel"><div class="titulo-chart">Tipos de rodeo — ${esc(TS.actual)} vs ${esc(TS.historica)} (fecha equivalente)</div><div class="caja-chart" style="height:430px"><canvas id="ch-tipos" role="img" aria-label="Barras horizontales: principales tipos de rodeo, temporada actual y temporada anterior a fecha equivalente"></canvas></div><div class="nota">Máx. 8 tipos + OTROS. Universo: rodeos realizados, acumulado de temporada al corte.</div></div>
            </div>`);
    }

    // ── Página 4: ¿Cómo vamos? ───────────────────────────────────────────
    function p4(d) {
        const cmp = d.comparacion.rodeos, pr = d.proyecciones.rodeos, ep = H.estadoProyeccion(pr);
        const TS = H.temporadasComparacion(d);
        const h = get(d, 'historico_equivalente.temporadas.0', null);
        const cierre = h ? h.rodeos_cierre_temporada : null;
        const kProy = kpi({ lbl: 'Proyección de temporada', amb: 'T', val: ep.disponible ? ep.texto : 'Sin proyección aún', sub: ep.disponible ? `<span class="badge ${pr.confianza === 'REFERENCIAL' ? 'amarillo' : 'azul'}">${ep.etiqueta}</span> ${tip('proyeccion')}<br>Estimación basada en ${pr.temporadas_comparables} temporada${pr.temporadas_comparables === 1 ? '' : 's'} histórica${pr.temporadas_comparables === 1 ? '' : 's'} comparable${pr.temporadas_comparables === 1 ? '' : 's'}` : `${esc(ep.motivo)}`, clase: ep.disponible ? 'azul' : 'gris', chico: !ep.disponible, tipK: null });
        const catRows = Object.entries(d.proyecciones.por_categoria || {}).map(([k, p]) => { const e = H.estadoProyeccion(p); return `<tr class="${e.disponible ? '' : 'gris'}"><td>${esc(k)}</td><td class="n">${e.disponible ? H.fmtEntero(p.estimacion) : 'Sin proyección aún'}</td><td class="n">${e.disponible ? `${H.fmtEntero(p.rango.minimo)}–${H.fmtEntero(p.rango.maximo)}` : esc(e.motivo)}</td></tr>`; }).join('');
        return pagina(d, `${cabecera('¿Cómo vamos esta temporada?', 'Acumulado de temporada al corte vs fecha equivalente')}
            <div class="kpi-grid" style="grid-template-columns:repeat(6,1fr)">
                ${kpi({ lbl: `Rodeos ${esc(TS.actual)}`, amb: 'T', val: H.fmtEntero(cmp.actual), sub: 'Realizados al corte de la temporada', clase: 'azul' })}
                ${kpi({ lbl: `${esc(TS.historica)} a fecha equivalente`, amb: 'H', val: cmp.disponible ? H.fmtEntero(cmp.historico) : 'SIN DATOS', sub: 'Rodeos a la misma etapa de la temporada anterior', clase: cmp.disponible ? 'azul' : 'gris', tipK: 'equivalente' })}
                ${kpi({ lbl: 'Diferencia', amb: 'T', val: cmp.disponible ? H.fmtDif(cmp.diferencia) : '—', sub: cmp.disponible ? `${H.flechaVariacion(cmp.diferencia)} ${esc(H.textoDiferencia(cmp.diferencia))}` : '', clase: cmp.disponible ? H.claseVariacion(cmp.variacion_pct) : 'gris' })}
                ${kpi({ lbl: 'Variación', amb: 'T', val: cmp.disponible ? `${H.flechaVariacion(cmp.variacion_pct)} ${H.fmtPctSigno(cmp.variacion_pct)}` : '—', sub: `${esc(TS.actual)} sobre ${esc(TS.historica)} (fecha equivalente)`, clase: cmp.disponible ? H.claseVariacion(cmp.variacion_pct) : 'gris' })}
                ${kProy}
                ${kpi({ lbl: 'Referencia cierre anterior', amb: 'H', val: cierre !== null ? H.fmtEntero(cierre) : 'SIN DATOS', sub: `Total de la temporada ${esc(TS.historica)} completa`, clase: cierre !== null ? 'azul' : 'gris' })}
            </div>
            <div style="display:grid;grid-template-columns:2.1fr 1fr;gap:10px;margin-top:9px">
                <div class="panel"><div class="titulo-chart">Curva acumulativa de rodeos — ${esc(TS.actual)} vs ${esc(get(d, 'series.rodeos_acumulados.temporada_referencia', TS.historica))} (fecha equivalente)</div>
                    <div class="caja-chart" style="height:430px"><canvas id="ch-curva" role="img" aria-label="Línea acumulativa de rodeos por semana: temporada actual contra temporada de referencia"></canvas></div>
                    <div class="nota">Cada punto es el conteo acumulado exacto al cierre de cada fin de semana. La línea punteada azul es el calendario ya cargado (rodeos programados, aún no realizados).</div></div>
                <div style="display:flex;flex-direction:column;gap:9px">
                    <div class="panel"><h3>Proyección ${tip('proyeccion')}${ep.disponible ? '' : '<span class="badge gris">Sin proyección aún</span>'}</h3>
                        ${ep.disponible ? `<div class="referencial">${esc(ep.etiqueta)}</div>` : ''}
                        ${ep.disponible ? `<div style="font-size:26px;font-weight:800;color:#1e3a5f">${ep.texto}</div><div class="nota" style="font-size:10px">Estimación basada en ${pr.temporadas_comparables} temporada${pr.temporadas_comparables === 1 ? '' : 's'} histórica${pr.temporadas_comparables === 1 ? '' : 's'} comparable${pr.temporadas_comparables === 1 ? '' : 's'}. Rango ${H.fmtEntero(pr.rango.minimo)}–${H.fmtEntero(pr.rango.maximo)}.</div>` : `<div class="vacio">${esc(ep.motivo)}</div>`}
                        <div style="margin-top:6px;font-size:11px"><b>Piso conocido:</b> ${H.fmtEntero(get(pr, 'datos_base.piso_calendario_conocido', null))} <span style="color:#7f8c8d">(realizados + programados)</span></div>
                        <div class="nota">${esc(pr.aviso || '')}</div></div>
                    <div class="panel"><h3>Por categoría</h3><table class="t"><thead><tr><th>Categoría</th><th class="n">Proyección</th><th class="n">Rango / motivo</th></tr></thead><tbody>${catRows || `<tr><td colspan="3">${sinInfo()}</td></tr>`}</tbody></table></div>
                </div>
            </div>`);
    }

    // ── Página 5: Colleras completas ─────────────────────────────────────
    function p5(d) {
        const c = d.colleras, ac = c.actual || {};
        const TS = H.temporadasComparacion(d);
        const rh = H.referenciaHistoricaColleras(c.comparacion);
        const filas = get(c, 'comparacion.temporadas', []);
        const ok = filas.find(t => t.estado === 'OK');
        const pr = d.proyecciones.colleras, ep = H.estadoProyeccion(pr);
        const ritmo = c.ritmo_actual || d.series.colleras_acumuladas.ritmo_actual;
        const tabla = filas.length ? filas.map(t => `<tr class="${t.estado === 'OK' ? '' : 'gris'}"><td class="nw">${esc(t.temporada)}</td><td class="nw">${H.fmtFechaCorta(t.fecha_objetivo)}</td><td class="n">${t.estado === 'OK' ? `${H.fmtFechaCorta(t.medicion.fecha_medicion)} · <b>${H.fmtEntero(t.historico)}</b>` : 'Sin dato histórico comparable'}</td><td class="n">${t.estado === 'OK' ? varHtml(t.variacion_pct) : '·'}</td></tr>`).join('') : `<tr><td colspan="4">${sinInfo('Sin dato histórico comparable')}</td></tr>`;
        return pagina(d, `${cabecera('Evolución de colleras completas', 'Dato a la fecha vs histórico equivalente')}
            <div class="kpi-grid" style="grid-template-columns:repeat(5,1fr)">
                ${kpi({ lbl: 'Colleras completas actual', amb: 'F', val: ac.total !== null && ac.total !== undefined ? H.fmtEntero(ac.total) : 'SIN DATOS', sub: `${ac.estado === 'actual' ? 'Fuente en vivo' : ac.estado === 'fallback' ? '<span class="badge amarillo">Snapshot de respaldo</span>' : '<span class="badge gris">Sin dato actual</span>'} · ${H.fmtFecha(c.fecha_dato_iso)}`, clase: 'azul' })}
                ${kpi({ lbl: `${esc(ok ? ok.temporada : TS.historica)} a fecha equivalente`, amb: 'H', val: ok ? H.fmtEntero(ok.historico) : 'SIN DATOS', sub: ok ? `Medición del ${H.fmtFecha(ok.medicion.fecha_medicion)}` : 'Sin dato histórico comparable', clase: ok ? 'azul' : 'gris', tipK: 'equivalente' })}
                ${kpi({ lbl: 'Diferencia', amb: 'T', val: ok ? H.fmtDif(ok.diferencia) : '—', sub: ok ? `${H.flechaVariacion(ok.diferencia)} ${esc(H.textoDiferencia(ok.diferencia, { uno: 'collera', varios: 'colleras', referencia: `histórico equivalente (${ok.temporada})` }))}` : '', clase: ok ? H.claseVariacion(ok.variacion_pct) : 'gris' })}
                ${kpi({ lbl: 'Variación', amb: 'T', val: ok ? `${H.flechaVariacion(ok.variacion_pct)} ${H.fmtPctSigno(ok.variacion_pct)}` : '—', sub: ok ? `${esc(TS.actual)} sobre ${esc(ok.temporada)} (fecha equivalente)` : 'Sobre el histórico equivalente', clase: ok ? H.claseVariacion(ok.variacion_pct) : 'gris' })}
                ${kpi({ lbl: rh.titulo, amb: 'H', val: rh.valor, sub: rh.modo === 'PROMEDIO_MAXIMO' ? `${rh.tituloMaximo}: <b>${rh.valorMaximo}</b><br>${esc(rh.subtexto)}` : esc(rh.subtexto), clase: rh.modo === 'SIN_REFERENCIA' ? 'gris' : 'azul', chico: rh.modo === 'SIN_REFERENCIA' })}
            </div>
            <div style="display:grid;grid-template-columns:2.1fr 1fr;gap:10px;margin-top:9px">
                <div class="panel"><div class="titulo-chart">Colleras completas acumuladas — ${esc(TS.actual)} vs temporadas anteriores (eje: fecha equivalente)</div>
                    <div class="caja-chart" style="height:425px"><canvas id="ch-colleras" role="img" aria-label="Líneas de colleras completas acumuladas por temporada, con la temporada actual y las anteriores a fecha equivalente"></canvas></div>
                    <div class="nota">Solo puntos reales (mediciones históricas confirmadas, snapshots y dato en vivo). Sin interpolación. La temporada actual comenzará a acumular puntos con cada actualización de colleras.</div></div>
                <div style="display:flex;flex-direction:column;gap:9px">
                    <div class="panel"><h3>Ritmo de crecimiento</h3>${ritmo && ritmo.disponible ? `<div style="font-size:24px;font-weight:800;color:#1e3a5f">+${H.fmtDecimal(ritmo.por_semana, 1)} <small style="font-size:12px;color:#7f8c8d">colleras / semana</small></div><div class="nota">Entre ${H.fmtFecha(ritmo.desde)} y ${H.fmtFecha(ritmo.hasta)} (${ritmo.delta >= 0 ? '+' : ''}${ritmo.delta} en ${ritmo.dias} días).</div>` : `<div class="vacio">${esc((ritmo && ritmo.motivo) || 'Se requieren al menos 2 mediciones actuales')}</div><div class="nota">Mediciones actuales registradas: ${H.fmtEntero(ritmo ? ritmo.mediciones_actuales : 0)}.</div>`}</div>
                    <div class="panel"><h3>Proyección ${tip('proyeccion')}<span class="badge ${ep.disponible ? (pr.confianza === 'REFERENCIAL' ? 'gris' : 'azul') : 'gris'}">${ep.disponible ? esc(ep.etiqueta) : 'No disponible'}</span></h3>
                        ${ep.disponible ? `<div style="font-size:24px;font-weight:800;color:#1e3a5f">${ep.texto}</div><div class="nota">Rango ${H.fmtEntero(pr.rango.minimo)}–${H.fmtEntero(pr.rango.maximo)} · ${pr.temporadas_comparables} temporada(s)</div>` : `<div style="font-size:13px;font-weight:700;color:#7f8c8d">Proyección aún no disponible</div><div class="nota" style="font-size:10px">Motivo: ${esc(ep.motivo)}${get(pr, 'datos_base.descartadas.0.avance_historico', null) !== null ? ` (${H.fmtPct(pr.datos_base.descartadas[0].avance_historico * 100)} del cierre histórico a esta fecha)` : ''}.</div>`}
                        <div class="nota">${esc(pr.aviso || '')}</div></div>
                    <div class="panel"><h3>Comparación por temporada</h3><table class="t"><thead><tr><th>Temporada</th><th>Fecha eq.</th><th class="n">Medición</th><th class="n">Var. de ${esc(TS.actual)}</th></tr></thead><tbody>${tabla}</tbody></table></div>
                </div>
            </div>`);
    }

    // ── Página 6: Evaluación de rodeos ───────────────────────────────────
    function filaRank(x, i) {
        const jur = (x.jurados || []).map(nombreCorto).join(', ') || '—';
        return `<li><span class="pos">${i + 1}</span><div class="txt"><div class="a cortar">${esc(nombreCorto(x.club))}</div><div class="b cortar">${esc(nombreCorto(x.asociacion))} · ${esc(x.tipo || '—')} · ${H.fmtFecha(x.fecha)}</div><div class="b cortar">Jurado(s): ${esc(jur)}</div></div>
            <div class="nota-g">${H.fmtNota(x.nota_final)}<small>Nota final</small><small>Com. ${x.nota_comision === null ? '—' : H.fmtNota(x.nota_comision)} · Del. ${x.nota_delegado === null ? '—' : H.fmtNota(x.nota_delegado)}</small></div></li>`;
    }
    function p6(d) {
        const ev = d.evaluaciones.acumulado_temporada, cob = d.cobertura.acumulado_temporada, rk = d.rodeos.ranking.acumulado_temporada;
        const cobP = cob.evaluaciones_publicadas, clsProm = cobP.interpretable === false ? 'gris' : 'azul';
        const lista = (arr, vacio) => (arr && arr.length ? `<ul class="rank">${arr.map(filaRank).join('')}</ul>` : sinInfo(vacio));
        return pagina(d, `${cabecera('Evaluación de rodeos', 'Acumulado de temporada al corte')}
            <div class="kpi-grid" style="grid-template-columns:repeat(5,1fr)">
                ${kpi({ lbl: 'Promedio nota final publicada', amb: 'T', val: H.fmtNota(ev.evaluacion.nota_promedio_publicada), sub: 'Evaluaciones publicadas (temporada)', clase: clsProm, tipK: 'cobertura' })}
                ${kpi({ lbl: 'Evaluaciones publicadas', amb: 'T', val: H.fmtEntero(ev.evaluacion.evaluaciones_publicadas), sub: `de ${H.fmtEntero(ev.evaluacion.rodeos_realizados)} rodeos realizados`, clase: 'azul' })}
                ${kpi({ lbl: 'Cobertura', amb: 'T', val: H.fmtPct(cobP.porcentaje), sub: `${H.textoNSobreTotal(cobP.numerador, cobP.denominador)}${badgeCob(cobP) ? `<br>${badgeCob(cobP)}` : ''}`, clase: cobP.interpretable === false ? 'gris' : 'azul', chico: true })}
                ${kpi({ lbl: 'Nota Comisión (indicador separado)', amb: 'T', val: ev.notas_secundarias.nota_comision.promedio !== null ? H.fmtNota(ev.notas_secundarias.nota_comision.promedio) : 'SIN DATOS', sub: `${H.textoNSobreTotal(cob.nota_comision.numerador, cob.nota_comision.denominador)} · ${H.fmtPct(cob.nota_comision.porcentaje)}<br>${badgeCob(cob.nota_comision)}`, clase: 'gris', chico: true })}
                ${kpi({ lbl: 'Nota Delegado (indicador separado)', amb: 'T', val: ev.notas_secundarias.nota_delegado.promedio !== null ? H.fmtNota(ev.notas_secundarias.nota_delegado.promedio) : 'SIN DATOS', sub: `${H.textoNSobreTotal(cob.nota_delegado.numerador, cob.nota_delegado.denominador)} · ${H.fmtPct(cob.nota_delegado.porcentaje)}<br>${badgeCob(cob.nota_delegado)}`, clase: 'gris', chico: true })}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:9px">
                <div class="panel"><h3>Top 5 mayor evaluación <span class="badge azul">N elegibles: ${H.fmtEntero(rk.n_elegibles)}</span></h3>${lista(rk.top, 'Sin evaluaciones publicadas en la temporada')}</div>
                <div class="panel"><h3>5 menores evaluaciones <span class="badge azul">N elegibles: ${H.fmtEntero(rk.n_elegibles)}</span></h3>${lista(rk.bottom, 'Sin evaluaciones publicadas en la temporada')}</div>
            </div>
            <div style="display:grid;grid-template-columns:1.1fr 1.4fr;gap:10px;margin-top:9px">
                <div class="panel"><div class="titulo-chart">Distribución de notas (solo evaluaciones publicadas)</div><div class="caja-chart" style="height:158px"><canvas id="ch-notas" role="img" aria-label="Barras: distribución de notas finales por banda"></canvas></div></div>
                <div class="panel"><h3>Cómo leer este ranking</h3><div class="nota" style="font-size:10px"><b>Universo:</b> ${H.fmtEntero(ev.evaluacion.evaluaciones_publicadas)} evaluaciones publicadas de ${H.fmtEntero(ev.evaluacion.rodeos_realizados)} rodeos realizados (temporada ${esc(d.metadata.temporada.nombre)}, al corte). La nota final es del <b>rodeo</b>, no de un jurado. El ranking usa exclusivamente <b>evaluaciones.nota_final</b> de evaluaciones <b>publicadas</b>; no se crea ningún promedio nuevo. Nota Comisión y Nota Delegado son indicadores separados y hoy tienen cobertura baja: se muestran como información secundaria, no como conclusión. Se ordena por la evaluación disponible; no equivale a un juicio sobre la calidad del rodeo.</div></div>
            </div>`);
    }

    // ── Página 7: Situaciones deportivas ─────────────────────────────────
    function bloqueSit(titulo, principal, sub, cobBloque, clase = 'azul', tipK = null) {
        const ambito = ambTag('T');
        const e = cobBloque ? H.estadoCobertura(cobBloque) : { clase: '', etiqueta: '' };
        return `<div class="kpi ${e.clase === 'gris' ? 'gris' : clase}"><div class="lbl">${titulo}${tipK ? tip(tipK) : ''}${ambito}</div><div class="val" style="font-size:24px">${principal}</div><div class="sub">${sub}</div>${e.etiqueta ? `<div class="sub"><span class="badge gris">${e.etiqueta}</span></div>` : ''}</div>`;
    }
    function p7(d) {
        const ev = d.evaluaciones.acumulado_temporada, evP = d.evaluaciones.periodo, cob = d.cobertura.acumulado_temporada;
        const f = ev.faltas, a = ev.resultados_alterados, ap = evP.resultados_alterados, g = ev.ganado, cs = ev.caseta;
        const ta = H.textoIndicador(a.cantidad, a.denominador, a.porcentaje);
        const tg = H.textoIndicador(g.cantidad_si, g.denominador_cartillas_con_dato, g.porcentaje);
        const td = H.textoIndicador(f.disciplinarias.rodeos_con_falta, f.disciplinarias.denominador_cartillas, f.disciplinarias.porcentaje);
        const TS = H.temporadasComparacion(d);
        const ALTO_BLOQUES = 205;
        const nbp = H.notaBloquePeriodo(d);   // solo existe si el bloque y el período seleccionado difieren
        const puntosBq = get(d, 'series.situaciones_por_bloque.puntos', []);
        const lb = H.lecturaBloque(puntosBq[puntosBq.length - 1]);
        const lecturaUlt = lb ? `<div class="lectura-bloque"><b>Lectura del último bloque (${esc(lb.titulo)}):</b> ${esc(lb.total)} · ${esc(lb.faltas)} · ${esc(lb.cobertura)} · ${esc(lb.alterados)}</div>` : '';
        const cn = d.concentracion;
        const filaF = x => `<tr><td class="cortar" style="max-width:150px">${esc(x.asociacion)}</td><td class="n">${H.fmtEntero(x.rodeos_afectados)}</td><td class="n">${H.fmtPct(x.porcentaje_del_total)}</td></tr>`;
        const filaA = x => `<tr><td class="cortar" style="max-width:130px">${esc(x.asociacion)}</td><td class="n">${H.fmtEntero(x.alterados)} de ${H.fmtEntero(x.publicadas)}</td><td class="n">${H.fmtPct(x.porcentaje_de_publicadas, 0)}</td><td class="n">${H.fmtPct(x.porcentaje_del_total)}</td></tr>`;
        const cobA7 = cn && cn.resultados_alterados.cobertura_publicadas;
        const concentracion = cn ? `<div class="panel conc" style="margin-top:6px"><h3>Dónde se concentran las situaciones <span class="badge azul">Por asociación · temporada ${esc(TS.actual)}</span></h3>
                <div class="conc-grid">
                    <div><div class="conc-t">Faltas reglamentarias — top ${cn.top_n} asociaciones</div>
                        <table class="t compacta"><thead><tr><th>Asociación</th><th class="n">Rodeos afectados</th><th class="n">% del total</th></tr></thead><tbody>${cn.faltas_reglamentarias.top.map(filaF).join('') || `<tr><td colspan="3">${sinInfo('Sin rodeos con falta reglamentaria')}</td></tr>`}</tbody></table>
                        <div class="nota">${esc(H.textoConcentracionFaltas(cn.faltas_reglamentarias))} ${H.fmtEntero(cn.faltas_reglamentarias.asociaciones_con_rodeos_afectados)} asociaciones tienen al menos un rodeo afectado.</div></div>
                    <div><div class="conc-t">Resultados alterados (solo evaluaciones publicadas) — top ${cn.top_n} asociaciones ${cn.resultados_alterados.lectura_referencial ? '<span class="badge gris">Lectura referencial por cobertura insuficiente</span>' : ''}</div>
                        <table class="t compacta"><thead><tr><th>Asociación</th><th class="n">Alterados / publicadas</th><th class="n">%</th><th class="n">% del total</th></tr></thead><tbody>${cn.resultados_alterados.top.map(filaA).join('') || `<tr><td colspan="4">${sinInfo('SIN DATOS')}</td></tr>`}</tbody></table>
                        <div class="nota">${esc(H.textoConcentracionAlterados(cn.resultados_alterados))} Cobertura de evaluaciones publicadas: ${cobA7 ? `${H.textoNSobreTotal(cobA7.numerador, cobA7.denominador)} (${H.fmtPct(cobA7.porcentaje)})` : 'SIN DATOS'}. No se atribuye a jurados.</div></div>
                </div></div>` : '';
        return pagina(d, `${cabecera('Situaciones deportivas', `Acumulado de temporada ${esc(TS.actual)} al corte · el período se indica aparte`)}
            <div class="kpi-grid c6" style="grid-template-columns:repeat(6,1fr)">
                ${bloqueSit('Resultados alterados', ta.fraccion, `${ta.pct} de evaluaciones publicadas · temporada<br>Período: ${ap.denominador ? `${H.textoNSobreTotal(ap.cantidad, ap.denominador)} (${H.fmtPct(ap.porcentaje)})` : '<b>SIN DATOS</b>'}<br><span style="color:#7f8c8d">Indicador del rodeo, no del jurado.</span>`, cob.evaluaciones_publicadas, 'azul', 'alterado')}
                ${bloqueSit('Faltas reglamentarias', `${H.fmtEntero(f.reglamentarias.rodeos_con_falta)} <small>rodeos afectados</small>`, `<b>${H.fmtEntero(f.reglamentarias.casos_total)}</b> casos reglamentarios<br>${H.fmtPct(f.reglamentarias.porcentaje_rodeos_evaluados)} de los <b>${H.fmtEntero(f.rodeos_con_evaluacion)}</b> rodeos evaluados`, cob.evaluaciones_existentes)}
                ${bloqueSit('Casos de apreciación', `${H.fmtEntero(f.apreciacion.rodeos_con_falta)} <small>rodeos afectados</small>`, `<b>${H.fmtEntero(f.apreciacion.casos_total)}</b> casos de apreciación<br>${H.fmtPct(f.apreciacion.porcentaje_rodeos_evaluados)} de los evaluados`, cob.evaluaciones_existentes)}
                ${bloqueSit('Faltas disciplinarias/reglamentarias según cartilla', td.fraccion, `${td.pct} de las cartillas con dato<br><span style="color:#7f8c8d">El campo de la cartilla agrupa ambos tipos; no se pueden separar.</span>`, cob.cartillas_jurado)}
                ${bloqueSit('Ganado fuera de peso', tg.fraccion, `${tg.pct} de las cartillas con dato<br>Período: ${H.textoNSobreTotal(evP.ganado.cantidad_si, evP.ganado.denominador_cartillas_con_dato)}`, cob.cartillas_jurado)}
                ${bloqueSit('Caseta del jurado', `${H.fmtEntero(cs.no_cumple)} <small>no cumple</small>`, `Cumple <b>${H.fmtEntero(cs.cumple)}</b> · No cumple <b>${H.fmtEntero(cs.no_cumple)}</b> · Sin dato <b>${H.fmtEntero(cs.sin_dato)}</b><br>Denominador: ${H.fmtEntero(cs.denominador)} cartillas con dato`, cob.cartillas_jurado)}
            </div>
            <div class="panel" style="margin-top:8px"><div class="titulo-chart">Situaciones por bloque de rodeo — ${esc(TS.actual)} <span class="sub-pregunta">De todos los rodeos realizados en cada bloque, ¿qué ocurrió?</span></div>
                <div class="caja-chart" style="height:${ALTO_BLOQUES}px"><canvas id="ch-bloques" role="img" aria-label="Barras por bloque de rodeo: total de rodeos realizados; marcadores independientes para rodeos con falta reglamentaria y rodeos con resultado alterado"></canvas></div>
                <div class="leyenda-bloques"><span><i class="sw barra"></i><b>Barra</b> = total de rodeos realizados del bloque</span><span><i class="sw naranja"></i><b>Naranja</b> = rodeos con falta reglamentaria</span><span><i class="sw azul"></i><b>Azul</b> = rodeos con resultado alterado entre evaluaciones publicadas</span><span><i class="sw gris"></i><b>Gris</b> = cobertura insuficiente / sin información</span></div>
                ${lecturaUlt}
                ${nbp ? `<div class="nota-bloque">${esc(nbp.texto)}</div>` : ''}
                <div class="nota">Bloque = sábado, domingo y feriados consecutivos (un fin de semana largo es un solo bloque). ${esc(H.TEXTO_BLOQUE_VS_PERIODO)} Faltas: % sobre rodeos con evaluación. Resultados alterados: % sobre evaluaciones publicadas, no sobre el total de rodeos; sin publicadas = SIN DATOS (no 0 %). Un mismo rodeo puede tener ambas situaciones: los indicadores no se suman.</div></div>
            ${concentracion}`);
    }

    // ── Página 8: Desempeño de jurados ───────────────────────────────────
    // pos = número (muestra suficiente, ranking) o null (muestra limitada: referencia, SIN numeración).
    function filaJurado(j, pos) {
        return `<li><span class="pos${pos === null ? ' ref' : ''}">${pos === null ? '·' : pos}</span><div class="txt"><div class="a cortar" style="font-size:11px">${esc(nombreCorto(j.jurado))}</div><div class="b">${H.fmtEntero(j.tamano_muestra)} actuaciones · <b>${H.etiquetaMuestra(j.nivel_muestra)}</b></div></div><div class="nota-g" style="font-size:17px">${H.fmtNota(j.nota_promedio)}</div></li>`;
    }
    function p8(d) {
        const cols = ['A', 'B', 'C'].map(k => {
            const c = get(d, `jurados.por_categoria.${k}`, null);
            if (!c) return `<div class="panel"><h3>Categoría ${k}</h3>${sinInfo()}</div>`;
            // Muestra suficiente = ranking numerado. Muestra limitada = bloque aparte de REFERENCIA, sin numeración continua.
            const numerada = arr => `<ul class="rank c8">${arr.map((x, i) => filaJurado(x, i + 1)).join('')}</ul>`;
            const referencia = arr => `<ul class="rank c8">${arr.map(x => filaJurado(x, null)).join('')}</ul>`;
            const lista = (arr) => (arr && arr.length ? numerada(arr) : sinInfo('Sin jurados con muestra suficiente o limitada'));
            const grupo = (arr, titulo) => { const g = H.agruparPorMuestra(arr); return `${sub(titulo)}${g.suficiente.length ? numerada(g.suficiente) : sinInfo('Sin jurados con muestra suficiente en este grupo')}${g.limitada.length ? `${sub('Muestra limitada — referencia')}${referencia(g.limitada)}` : ''}`; };
            const sub = t => `<div style="font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:#1e3a5f;font-weight:700;margin:7px 0 2px">${t}</div>`;
            const cuerpo = c.modo_ranking === 'TOP_BOTTOM'
                ? `${grupo(c.mejor_evaluados, `Mayor promedio — muestra suficiente ${tip('muestra')}`)}${grupo(c.menor_evaluacion, 'Menor promedio — muestra suficiente')}`
                : `${sub(`Desempeño de la categoría · ordenado de mayor a menor ${tip('muestra')}`)}${lista(c.desempeno_categoria)}<div class="nota">Categoría con menos de 6 jurados con muestra suficiente o limitada (${H.fmtEntero(c.elegibles_ranking)}): se muestra una tabla única en lugar de un ranking dividido.</div>`;
            return `<div class="panel">
                <h3>Categoría ${k}</h3>
                <div class="kpi-grid" style="grid-template-columns:1fr 1fr 1fr;gap:6px">
                    ${kpi({ lbl: 'Promedio categoría', val: H.fmtNota(c.nota_promedio), sub: '', clase: 'azul', chico: true })}
                    ${kpi({ lbl: 'Jurados', val: H.fmtEntero(c.cantidad_jurados), sub: '', clase: 'azul', chico: true })}
                    ${kpi({ lbl: 'Actuaciones', val: H.fmtEntero(c.actuaciones), sub: '', clase: 'azul', chico: true })}
                </div>
                ${cuerpo}
                <div class="nota">${H.fmtEntero(c.excluidos_por_muestra)} jurado(s) con muestra insuficiente no se rankean. Notas Comisión/Delegado de la categoría: ${c.promedio_comision === null ? '—' : H.fmtNota(c.promedio_comision)} / ${c.promedio_delegado === null ? '—' : H.fmtNota(c.promedio_delegado)} (cobertura baja, referencial).</div></div>`;
        }).join('');
        const r = get(d, 'jurados.resumen', {});
        return pagina(d, `${cabecera('Desempeño de jurados', `Acumulado de temporada ${esc(d.metadata.temporada.nombre)} al corte · Nota Evaluación de Casos de cada jurado`)}<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${cols}</div>
            <div class="nota" style="margin-top:6px">Ranking por categoría aplicada en cada actuación (A, B y C no se mezclan). Promedio = Nota Evaluación de Casos de cada jurado. Con 6 o más elegibles: mayor y menor promedio sin repetir personas; con menos, tabla única. Muestra suficiente = ranking numerado; muestra limitada = referencia aparte. ${H.fmtEntero(r.filas_jurado_categoria)} filas jurado×categoría = ${H.fmtEntero(r.jurados_distintos_con_actuaciones)} jurados con actuaciones (${H.fmtEntero(r.jurados_en_mas_de_una_categoria)} actuaron en más de una categoría).</div>`);
    }

    // ── Página 9: Seguimiento y disponibilidad ───────────────────────────
    function segCards(d) {
        const s = (d.senales || []).find(x => x.codigo === 'JURADO_REINCIDENCIA');
        const ev = s && Array.isArray(s.evidencia) ? s.evidencia.slice(0, 6) : [];
        if (!ev.length) return { html: sinInfo('Sin jurados en seguimiento para el período'), lista: [] };
        const lista = ev.map(e => { const j = d.jurados.detalle.find(x => x.jurado === e.jurado && x.categoria === e.categoria) || {}; return { e, j }; });
        const html = lista.map(({ e, j }, i) => {
            const pc = get(d, `jurados.por_categoria.${e.categoria}.nota_promedio`, null);
            const motivo = H.motivoSeguimiento(e);
            return `<div class="seg-card"><div class="nom"><span class="cortar">${esc(nombreCorto(e.jurado))}</span><span class="badge azul">Cat. ${esc(e.categoria)}</span></div>
                <div class="meta">${H.fmtEntero(e.actuaciones)} actuaciones · ${H.etiquetaMuestra(e.nivel_muestra)} · Promedio <b>${H.fmtNota(j.nota_promedio)}</b> · categoría <b>${H.fmtNota(pc)}</b></div>
                <div class="lin">${esc(H.textoParticipacionAlterados(j))}<span class="aviso"> Indicador del rodeo; no atribuye la causa al jurado.</span></div>
                <div class="motivo"><div class="etq">Motivo de seguimiento</div>${motivo ? esc(motivo) : 'Racha reciente registrada'}</div>
                <div class="spark-row"><div class="etq-spark">Últimas notas</div><div class="spark"><canvas id="sp-${i}" role="img" aria-label="Últimas notas de ${esc(e.jurado)}"></canvas></div></div></div>`;
        }).join('');
        return { html: `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">${html}</div>`, lista };
    }
    function p9(d) {
        const seg = segCards(d);
        const disp = get(d, 'disponibilidad.acumulado_temporada', null);
        const u = get(d, 'metadata.universos_jurados', null);
        const ALTO_DISP = 215;
        let bloqueDisp = sinInfo();
        if (disp) {
            const dest = disp.destacados.mayor_disponibilidad_sin_utilizar;
            const filas = dest.length ? dest.map(x => `<tr><td class="cortar" style="max-width:120px">${esc(nombreCorto(x.jurado))}</td><td>${esc(x.categoria || '—')}</td><td class="n">${H.fmtEntero(x.bloques_con_disponibilidad_declarada)} / ${H.fmtEntero(disp.bloques_posibles)}</td><td class="n">${H.fmtEntero(x.designaciones)}</td><td class="n">${x.utilizacion_sobre_disponibilidad_declarada === null ? '<span class="badge gris">SIN DECLARACIÓN REGISTRADA</span>' : H.fmtPct(x.utilizacion_sobre_disponibilidad_declarada, 0)}</td></tr>`).join('') : `<tr><td colspan="5">${sinInfo('Sin casos con disponibilidad declarada sin utilizar')}</td></tr>`;
            bloqueDisp = `<div style="display:grid;grid-template-columns:1.25fr 1fr;gap:10px">
                <div class="panel"><div class="titulo-chart">Disponibilidad declarada vs designaciones — 10 mayores brechas ${tip('disponibilidad')}</div><div class="nota" style="margin:0 0 3px">Jurados con mayor diferencia entre fines de semana declarados disponibles y fines de semana designados. No constituye una evaluación negativa del jurado.</div><div class="caja-chart" style="height:${ALTO_DISP}px"><canvas id="ch-disp" role="img" aria-label="Barras horizontales: fines de semana con disponibilidad declarada contra designados, diez jurados"></canvas></div></div>
                <div class="panel"><h3>Disponibilidad declarada ${tip('disponibilidad')}</h3>
                    <div style="display:flex;gap:6px;margin-bottom:3px;flex-wrap:wrap"><span class="badge azul">${H.fmtEntero(disp.resumen.con_declaracion)} con declaración</span><span class="badge gris">${H.fmtEntero(disp.resumen.sin_declaracion_registrada)} SIN DECLARACIÓN REGISTRADA</span><span class="badge azul">Utilización ${H.fmtPct(disp.resumen.utilizacion_global_sobre_disponibilidad_declarada, 0)}</span></div>
                    <table class="t compacta"><thead><tr><th>Jurado</th><th>Cat.</th><th class="n">Disponibilidad</th><th class="n">Designaciones</th><th class="n">Utilización</th></tr></thead><tbody>${filas}</tbody></table>
                    <div class="nota"><b>Disponibilidad</b> = fines de semana (bloques de rodeo) con disponibilidad declarada, de ${H.fmtEntero(disp.bloques_posibles)} posibles. <b>Utilización</b> = fines de semana designado / fines de semana con disponibilidad declarada. Sin declaración registrada no significa que el jurado haya informado no disponibilidad. ${u ? `Universos: ${H.fmtEntero(u.con_actuaciones.jurados_distintos)} jurados con actuaciones · ${H.fmtEntero(u.activos_para_disponibilidad.jurados)} activos considerados para disponibilidad.` : ''}</div></div></div>`;
        }
        const ut = H.resumenUtilizacion(d);
        const kUso = ut ? `<div class="uso"><div class="uso-t">Utilización del cuerpo de jurados <span>indicadores de uso; no evalúan la calidad de las personas</span></div><div class="uso-g">
                <div class="ku"><div class="k">Con disponibilidad y sin designación</div><div class="v">${ut.sinDesignacion.valor}</div><div class="s">${esc(ut.sinDesignacion.sub)}</div></div>
                <div class="ku"><div class="k">Alta disponibilidad / baja utilización</div><div class="v">${ut.altaBaja.valor}</div><div class="s">${esc(ut.altaBaja.sub)}</div></div>
                <div class="ku"><div class="k">Concentración de designaciones ${tip('concentracion')}</div><div class="v">${esc(ut.concentracion.valor)}</div><div class="s">${esc(ut.concentracion.sub)}</div></div></div></div>` : '';
        return pagina(d, `${cabecera('Jurados: seguimiento y disponibilidad', `Acumulado de temporada ${esc(d.metadata.temporada.nombre)} al corte`)}
            <div class="panel" style="margin-bottom:7px"><h3>Jurados en seguimiento <span class="badge azul">Señal de seguimiento</span> ${tip('alterado')}</h3>
                <div class="criterio"><b>Criterio de inclusión:</b> jurados que presentan actuaciones consecutivas recientes en rodeos con resultado alterado y/o rodeos con casos reglamentarios. La participación en un rodeo con resultado alterado no atribuye individualmente la causa al jurado.</div>${seg.html}</div>
            ${kUso}${bloqueDisp}`);
    }

    // ── Página 10: Asociaciones y señales ────────────────────────────────
    function p10(d) {
        const a = d.asociaciones;
        if (!a.catalogo_disponible) return pagina(d, `${cabecera('Actividad por asociación')}${sinInfo('Catálogo de asociaciones no disponible')}`);
        const r = a.resumen;
        const TS = H.temporadasComparacion(d);
        const sinR = a.sin_rodeos.length ? a.sin_rodeos.map(x => { const sim = x.rodeos_historicos_equivalentes === 0; return `<tr><td class="cortar" style="max-width:110px">${esc(x.asociacion)}</td><td class="n">${H.fmtEntero(x.rodeos_actuales)}</td><td class="n">${H.fmtEntero(x.rodeos_historicos_equivalentes)}</td><td><span class="badge ${sim ? 'azul' : 'amarillo'}">${sim ? 'Histórico similar' : 'Atención'}</span></td></tr>`; }).join('') : `<tr><td colspan="4">${sinInfo('Todas las asociaciones activas registran rodeos')}</td></tr>`;
        const sen = H.senalesParaPantalla(d.senales, 6).map(s => {
            const n = H.nivelSenal(s.nivel), et = H.etiquetaTipoSenal(s.codigo);
            const ch = H.chipEstadoSenal(s.codigo, d.estado_senales);
            return `<div class="senal ${n.clase}"><div class="t1"><span class="badge ${n.clase}" style="margin-right:4px">${et || n.etiqueta}</span>${ch ? `<span class="chip-es ${ch.clase}">${ch.texto}</span>` : ''}${esc(s.titulo)}${ch && ch.detalle ? ` <span class="ch-det">(${esc(ch.detalle)})</span>` : ''}</div><div class="t2">${esc(s.detalle)}</div><div class="t3">Dato: ${esc(H.valorSenal(s))} · Ref.: ${esc(s.referencia)}</div></div>`;
        }).join('') || sinInfo('Sin señales para el período');
        const es = H.resumenEstadoSenales(d.estado_senales, 3);
        const evA = get(d, 'evolucion_corte.asociaciones', null);
        const notaEvA = evA && evA.disponible ? `<div class="nota"><b>Desde el corte anterior:</b> ${evA.nuevas_caidas.length} ${evA.nuevas_caidas.length === 1 ? 'nueva' : 'nuevas'} · ${evA.caidas_persistentes.length} ${evA.caidas_persistentes.length === 1 ? 'se mantiene' : 'se mantienen'} · ${evA.caidas_resueltas.length} ${evA.caidas_resueltas.length === 1 ? 'salió' : 'salieron'} de menor actividad${evA.caidas_resueltas.length ? ` (${esc(evA.caidas_resueltas.slice(0, 3).map(x => x.asociacion).join(', '))}${evA.caidas_resueltas.length > 3 ? ` +${evA.caidas_resueltas.length - 3}` : ''})` : ''}.</div>` : '';
        const contEs = es.disponible ? `<div class="ev-cont"><span class="n1"><b>${H.fmtEntero(es.nuevas)}</b> Nuevas</span><span class="n2"><b>${H.fmtEntero(es.persistentes)}</b> Se mantienen</span><span class="n3"><b>${H.fmtEntero(es.resueltas)}</b> Resueltas</span></div><div class="nota" style="margin:0 0 4px">Respecto del corte deportivo anterior (${esc(get(d, 'evolucion_corte.anterior.bloque.etiqueta', ''))}); cada señal se identifica por código y entidad.</div>` : `<div class="vacio" style="padding:2px 0"><b>${esc(es.etiqueta)}</b></div>`;
        const resBloque = es.disponible && es.resueltas > 0 ? `<div class="resueltas"><b>Señales resueltas desde el corte anterior:</b> ${es.resueltasVisibles.map(t => esc(t)).join(' · ')}${es.resueltasExtra > 0 ? ` <span class="mas">· +${H.fmtEntero(es.resueltasExtra)} adicionales</span>` : ''}</div>` : '';
        return pagina(d, `${cabecera('Actividad por asociación y señales', 'Acumulado de temporada vs fecha equivalente')}
            <div class="kpi-grid c4" style="grid-template-columns:repeat(4,1fr)">
                ${kpi({ lbl: 'Asociaciones activas del catálogo', amb: 'T', val: H.fmtEntero(r.activas), sub: `${H.fmtEntero(r.especiales_excluidas_de_alertas)} institucional excluida de alertas`, clase: 'azul', chico: true })}
                ${kpi({ lbl: 'Sin rodeos', amb: 'T', val: H.fmtEntero(r.sin_actividad_alertables), sub: r.sin_actividad_con_historico_positivo === 0 ? 'Todas con 0 rodeos también en el histórico' : `${r.sin_actividad_con_historico_positivo} con rodeos en el histórico`, clase: r.sin_actividad_con_historico_positivo > 0 ? 'amarillo' : 'azul', chico: true })}
                ${kpi({ lbl: 'Con menor actividad vs fecha equivalente', amb: 'T', val: H.fmtEntero(r.caida_relevante_alertables), sub: `${esc(TS.actual)} ≤ −${H.fmtEntero(r.umbral_caida_relevante_pct)} % vs ${esc(TS.historica)}`, clase: r.caida_relevante_alertables > 0 ? 'amarillo' : 'azul', chico: true })}
                ${kpi({ lbl: 'Con aumento', amb: 'T', val: H.fmtEntero(r.aumento_alertables), sub: `${esc(TS.actual)} ≥ +${H.fmtEntero(r.umbral_aumento_pct)} % vs ${esc(TS.historica)}`, clase: r.aumento_alertables > 0 ? 'verde' : 'azul', chico: true })}
            </div>
            <div style="display:grid;grid-template-columns:0.95fr 1.05fr 1.3fr;gap:10px;margin-top:6px">
                <div class="panel"><h3>Asociaciones sin rodeos</h3><table class="t"><thead><tr><th>Asociación</th><th class="n">${esc(TS.actual)}</th><th class="n">${esc(TS.historica)}</th><th>Estado</th></tr></thead><tbody>${sinR}</tbody></table>
                    <div class="nota">Rodeos por temporada (${esc(TS.actual)} / ${esc(TS.historica)}). 0 / 0 = comportamiento histórico similar (no es alerta). 0 / &gt;0 = atención. ${esc(TS.historica)} = fecha equivalente de la temporada anterior. La Federación no figura en este listado.</div>
                    <h3 style="margin-top:10px">Menor actividad vs fecha equivalente <span class="badge azul">${H.fmtEntero((a.menor_actividad || []).length)}</span></h3>
                    <table class="t compacta"><thead><tr><th>Asociación</th><th class="n">${esc(TS.actual)}</th><th class="n">${esc(TS.historica)}</th><th class="n">Variación</th></tr></thead><tbody>${(a.menor_actividad || []).map(x => `<tr><td class="cortar" style="max-width:105px">${esc(x.asociacion)}</td><td class="n">${H.fmtEntero(x.rodeos_actuales)}</td><td class="n">${H.fmtEntero(x.rodeos_historicos_equivalentes)}</td><td class="n"><span class="var amarillo">↓ ${H.fmtPctSigno(x.variacion_pct, 0)}</span></td></tr>`).join('') || `<tr><td colspan="4">${sinInfo('Ninguna asociación con menor actividad relevante')}</td></tr>`}</tbody></table>
                    <div class="nota">Variación ≤ −${H.fmtEntero(a.resumen.umbral_caida_relevante_pct)} % de ${esc(TS.actual)} respecto de ${esc(TS.historica)} (misma fecha de la temporada anterior). Es una comparación de actividad, no una evaluación de la asociación.</div>${notaEvA}</div>
                <div class="panel"><div class="titulo-chart">Menor actividad vs fecha equivalente — 10 mayores diferencias (${esc(TS.actual)} vs ${esc(TS.historica)})</div><div class="caja-chart" style="height:430px"><canvas id="ch-caidas" role="img" aria-label="Barras horizontales: diez asociaciones con menor actividad respecto de la fecha equivalente, actual contra histórico"></canvas></div></div>
                <div class="panel"><h3>Señales del período</h3>${contEs}${sen}${resBloque}</div>
            </div>`);
    }

    // ── Gráficos ─────────────────────────────────────────────────────────
    const etiquetasValor = { id: 'etiquetasValor', afterDatasetsDraw(chart, _a, opts) {
        if (!opts || opts.mostrar === false) return;
        const { ctx } = chart; ctx.save(); ctx.font = '600 10px Segoe UI, Arial'; ctx.fillStyle = '#2c3e50'; ctx.textBaseline = 'middle';
        chart.data.datasets.forEach((ds, i) => { const meta = chart.getDatasetMeta(i); if (meta.hidden) return; meta.data.forEach((el, k) => { const v = ds.data[k]; if (v === null || v === undefined) return; const horiz = chart.options.indexAxis === 'y'; ctx.textAlign = horiz ? 'left' : 'center'; ctx.fillText(H.fmtEntero(v), horiz ? el.x + 4 : el.x, horiz ? el.y : el.y - 8); }); });
        ctx.restore();
    } };
    function nuevo(id, cfg) { const el = $(id); if (!el) return; CHARTS.push(new Chart(el, cfg)); }
    const base = { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } } };

    function graficos(d) {
        Chart.defaults.animation = false; Chart.defaults.font.family = "'Segoe UI', Tahoma, sans-serif";
        const TS = H.temporadasComparacion(d), ref = TS.historica, actualNom = TS.actual;
        const cats = d.comparacion.por_categoria || [];
        nuevo('ch-cat', { type: 'bar', plugins: [etiquetasValor], data: { labels: cats.map(x => x.clave), datasets: [
            { label: `${actualNom} (acumulado)`, data: cats.map(x => x.actual), backgroundColor: COLOR.azul },
            { label: `${ref} (fecha equivalente)`, data: cats.map(x => (x.disponible ? x.historico : null)), backgroundColor: COLOR.grisClaro }] },
            options: { ...base, scales: { y: { beginAtZero: true, grace: '12%' } } } });

        const tipos = H.agruparTiposOtros(d.comparacion.por_tipo || [], 8);
        nuevo('ch-tipos', { type: 'bar', plugins: [etiquetasValor], data: { labels: tipos.map(x => x.clave.length > 26 ? x.clave.slice(0, 25) + '…' : x.clave), datasets: [
            { label: `${actualNom} (acumulado)`, data: tipos.map(x => x.actual), backgroundColor: COLOR.azul }, { label: `${ref} (fecha equivalente)`, data: tipos.map(x => x.historico), backgroundColor: COLOR.grisClaro }] },
            options: { ...base, indexAxis: 'y', scales: { x: { beginAtZero: true, grace: '14%' }, y: { ticks: { font: { size: 9 }, autoSkip: false } } } } });

        const cu = H.datasetsRodeosAcumulados(d.series.rodeos_acumulados);
        nuevo('ch-curva', { type: 'line', data: { labels: cu.labels, datasets: [
            { label: `${actualNom} (realizados)`, data: cu.actual, borderColor: COLOR.azul, backgroundColor: COLOR.azul, borderWidth: 3, pointRadius: 3, tension: 0, spanGaps: false },
            { label: 'Calendario ya cargado (programados)', data: cu.calendario, borderColor: COLOR.azulClaro, borderDash: [3, 3], borderWidth: 2, pointRadius: 2, tension: 0, spanGaps: false },
            { label: `${cu.referencia || 'Referencia'} (fecha equivalente)`, data: cu.historico, borderColor: COLOR.gris, borderDash: [6, 4], borderWidth: 2, pointRadius: 2, tension: 0, spanGaps: false }] },
            options: { ...base, scales: { y: { beginAtZero: true, title: { display: true, text: 'Rodeos acumulados', font: { size: 10 } } }, x: { ticks: { maxTicksLimit: 14, font: { size: 9 } }, title: { display: true, text: 'Cierre de cada fin de semana (fecha)', font: { size: 10 } } } } } });

        const col = H.datasetsColleras(d.series.colleras_acumuladas);
        const colorPorK = k => (k === 1 ? COLOR.azulClaro : k === 2 ? COLOR.gris : '#c3cbd3');
        const inicio = new Date(d.metadata.temporada.inicio + 'T00:00:00Z');
        const todosX = col.flatMap(t => t.puntos.map(p => p.x));
        nuevo('ch-colleras', { type: 'line', data: { datasets: col.map(t => ({ label: t.actual ? `${t.temporada} (actual)` : t.temporada, data: t.puntos, borderColor: t.actual ? COLOR.azul : colorPorK(t.k), backgroundColor: t.actual ? COLOR.azul : colorPorK(t.k), borderWidth: t.actual ? 4 : 2, pointRadius: t.actual ? 6 : 3, tension: 0, spanGaps: false, showLine: t.puntos.length > 1 })) },
            options: { ...base, parsing: false, scales: { x: { type: 'linear', min: todosX.length ? Math.min(...todosX) - 7 : undefined, max: todosX.length ? Math.max(...todosX) + 7 : undefined, ticks: { stepSize: 14, font: { size: 9 }, callback: v => { const dt = new Date(inicio.getTime() + v * 86400000); return `${String(dt.getUTCDate()).padStart(2, '0')}/${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; } }, title: { display: true, text: 'Fecha equivalente en la temporada actual', font: { size: 10 } } }, y: { beginAtZero: true, title: { display: true, text: 'Colleras completas', font: { size: 10 } } } },
                plugins: { ...base.plugins, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y} colleras (${H.fmtFecha(c.raw.fecha)})` } } } } });

        const nd = d.evaluaciones.acumulado_temporada.distribucion_notas;
        nuevo('ch-notas', { type: 'bar', plugins: [etiquetasValor], data: { labels: nd.bandas.map(b => b.banda), datasets: [{ label: 'Evaluaciones publicadas', data: nd.bandas.map(b => b.cantidad), backgroundColor: COLOR.azul2 }] },
            options: { ...base, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grace: '18%', ticks: { font: { size: 9 } } }, x: { ticks: { font: { size: 10 } } } } } });

        // Situaciones por BLOQUE de rodeo: una barra principal (total de rodeos) + marcadores independientes (NO apilados).
        const bq = H.datasetsBloques(d.series.situaciones_por_bloque);
        const totalesEnBarra = { id: 'totalesEnBarra', afterDatasetsDraw(chart) { const m = chart.getDatasetMeta(0), ds = chart.data.datasets[0], { ctx } = chart; ctx.save(); ctx.font = '700 9.5px Segoe UI, Arial'; ctx.fillStyle = '#1e3a5f'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; m.data.forEach((el, k) => { if (ds.data[k] === null || ds.data[k] === undefined) return; ctx.fillText(H.fmtEntero(ds.data[k]), el.x, el.y - 9); }); ctx.restore(); } };
        nuevo('ch-bloques', { type: 'bar', plugins: [totalesEnBarra], data: { labels: bq.labels, datasets: [
            { type: 'bar', label: 'Total de rodeos realizados del bloque', data: bq.totales, backgroundColor: COLOR.azulClaro, barPercentage: 0.72, categoryPercentage: 0.9, order: 3 },
            { type: 'line', label: 'Rodeos con falta reglamentaria', data: bq.faltas, showLine: false, pointStyle: 'circle', pointRadius: 6, pointHoverRadius: 8, pointBorderColor: '#fff', pointBorderWidth: 1, pointBackgroundColor: bq.faltasInterpretables.map(ok => (ok ? COLOR.amarillo : COLOR.gris)), order: 1 },
            { type: 'line', label: 'Rodeos con resultado alterado (evaluaciones publicadas)', data: bq.alterados, showLine: false, pointStyle: 'rectRot', pointRadius: 7, pointHoverRadius: 9, pointBorderColor: '#fff', pointBorderWidth: 1, pointBackgroundColor: bq.alteradosInterpretables.map(ok => (ok ? COLOR.azul2 : COLOR.gris)), order: 1 }] },
            options: { ...base, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => bq.puntos[it[0].dataIndex].etiqueta, label: () => null, afterBody: it => { const l = H.lecturaBloque(bq.puntos[it[0].dataIndex]); const lineas = [l.total, l.evaluaciones, l.faltas, l.cobertura, l.alterados]; const nb = H.notaBloquePeriodo(d); if (nb && bq.puntos[it[0].dataIndex].bloque_inicio === nb.bloque.inicio) lineas.push(`Bloque: ${nb.bloque.etiqueta} · Rodeos del bloque: ${nb.bloque.total}`, `Período seleccionado: ${nb.periodo.etiqueta} · Rodeos del período: ${nb.periodo.total}`); return lineas; } } } },
                scales: { y: { beginAtZero: true, grace: '10%', ticks: { precision: 0, font: { size: 9 } }, title: { display: true, text: 'Rodeos', font: { size: 10 } } }, x: { ticks: { font: { size: 9 }, autoSkip: false, maxRotation: 90, minRotation: 60 } } } } });
        // Sparklines de jurados en seguimiento
        segCards(d).lista.forEach(({ j }, i) => {
            const pts = H.sparkline(j.ultimas_notas);
            const fechas = (j.ultimas_notas || []).filter(x => x.nota !== null && x.nota !== undefined).map(x => H.fmtFecha(x.fecha));
            nuevo('sp-' + i, { type: 'line', data: { labels: fechas.length ? fechas : pts.map((_, k) => k + 1), datasets: [{ data: pts, borderColor: COLOR.azul2, borderWidth: 2, pointRadius: 2, tension: 0 }] },
                options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false }, tooltip: { enabled: true, displayColors: false, callbacks: { title: it => it[0].label, label: c => `Nota ${H.fmtNota(c.parsed.y)}` } } }, scales: { x: { display: false }, y: { display: false, min: pts.length ? Math.min(...pts) - 0.4 : 1, max: pts.length ? Math.max(...pts) + 0.4 : 7 } } } });
        });

        const dd = get(d, 'disponibilidad.acumulado_temporada.destacados.mayor_disponibilidad_sin_utilizar', []);
        const LARGO_MAX_NOMBRE = 34;
        nuevo('ch-disp', { type: 'bar', data: { labels: dd.map(x => nombreCorto(x.jurado)), datasets: [
            { label: 'Fines de semana con disponibilidad declarada', data: dd.map(x => x.bloques_con_disponibilidad_declarada), backgroundColor: COLOR.azulClaro, barPercentage: 0.9, categoryPercentage: 0.82 },
            { label: 'Designados en esos fines de semana', data: dd.map(x => x.bloques_designados_con_disponibilidad_declarada), backgroundColor: COLOR.azul, barPercentage: 0.9, categoryPercentage: 0.82 }] },
            options: { ...base, indexAxis: 'y', layout: { padding: { left: 2, right: 8 } },
                plugins: { ...base.plugins, legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 9.5 }, padding: 8 } }, tooltip: { callbacks: { title: it => nombreCorto(dd[it[0].dataIndex].jurado) } } },
                scales: { x: { beginAtZero: true, ticks: { precision: 0, font: { size: 9 } } }, y: { grid: { display: false }, ticks: { font: { size: 9.5 }, autoSkip: false, padding: 4, callback(v) { const l = String(this.getLabelForValue(v)); return l.length > LARGO_MAX_NOMBRE ? l.slice(0, LARGO_MAX_NOMBRE - 1) + '…' : l; } } } } } });

        const cd = get(d, 'asociaciones.mayores_caidas', []);
        nuevo('ch-caidas', { type: 'bar', plugins: [etiquetasValor], data: { labels: cd.map(x => [x.asociacion, H.fmtPctSigno(x.variacion_pct, 0)]), datasets: [
            { label: `${actualNom} (acumulado)`, data: cd.map(x => x.rodeos_actuales), backgroundColor: COLOR.azul },
            { label: `${ref} (fecha equivalente)`, data: cd.map(x => x.rodeos_historicos_equivalentes), backgroundColor: COLOR.grisClaro }] },
            options: { ...base, indexAxis: 'y', scales: { x: { beginAtZero: true, grace: '14%', ticks: { precision: 0, font: { size: 9 } } }, y: { ticks: { font: { size: 9 }, autoSkip: false } } } } });
    }

    // ── Ciclo de vida ────────────────────────────────────────────────────
    function ajustarEscala() {
        const cont = $('ig-preview'); if (!cont) return;
        const w = cont.clientWidth - 20;
        const escala = Math.max(0.3, Math.min(1, w / (297 * 96 / 25.4)));
        document.documentElement.style.setProperty('--escala', String(escala));
    }
    function destruir() { CHARTS.forEach(c => { try { c.destroy(); } catch (e) { /* noop */ } }); CHARTS = []; }
    function pintar(d) {
        destruir();
        $('ig-preview').innerHTML = [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10].map((f, i) => { NUM_PAGINA = i + 1; return f(d); }).join('');
        $('ig-preview').setAttribute('data-listo', '0');
        requestAnimationFrame(() => { ajustarEscala(); try { graficos(d); } catch (e) { console.error('Error al construir gráficos', e); } $('ig-preview').setAttribute('data-listo', '1'); });
    }
    function estado(msg) { $('ig-estado').textContent = msg; }

    async function generar() {
        const desde = $('ig-desde').value, hasta = $('ig-hasta').value;
        if (!desde || !hasta) { mostrarToast('Indique fecha desde y hasta', 'error'); return; }
        if (desde > hasta) { mostrarToast('"Desde" no puede ser posterior a "hasta"', 'error'); return; }
        const btn = $('ig-btn-generar'); btn.disabled = true; $('ig-btn-imprimir').disabled = true;
        $('ig-preview').innerHTML = `<div class="ig-cargando">Generando informe…<div class="barra"></div></div>`;
        try {
            DATOS = await api.get(`/admin/informe-gestion/datos?desde=${encodeURIComponent(desde)}&hasta=${encodeURIComponent(hasta)}`);
            if (!DATOS) return;
            TEMPORADA_INICIO = get(DATOS, 'metadata.temporada.inicio', TEMPORADA_INICIO);
            pintar(DATOS);
            $('ig-btn-imprimir').disabled = false;
            const adv = get(DATOS, 'metadata.advertencias', []);
            estado(`Informe generado ${new Date().toLocaleTimeString('es-CL')}. ${adv.length ? adv.length + ' advertencia(s) de cobertura/datos incluidas en el informe.' : ''}`);
        } catch (e) {
            $('ig-preview').innerHTML = `<div class="ig-error"><div><b>No se pudo generar el informe.</b><br>${esc(e.message || 'Error desconocido')}</div><button class="btn btn-primario" onclick="IGP.generar()">Reintentar</button></div>`;
            estado('Error al generar el informe.');
        } finally { btn.disabled = false; }
    }

    async function actualizarColleras() {
        const b = $('ig-btn-colleras'); b.disabled = true; const t = b.textContent; b.textContent = 'Consultando fuente...';
        try {
            const r = await api.post('/admin/informe-gestion/colleras/snapshot', {});
            const msg = { SNAPSHOT_GUARDADO: `Snapshot guardado: ${r.total_fuente} colleras completas`, YA_EXISTE_SNAPSHOT_VALIDO_DEL_DIA: `Ya existe un snapshot válido de hoy (${r.total_fuente} en la fuente); no se duplicó`, FUENTE_NO_DISPONIBLE: 'La fuente de colleras no respondió; no se guardó nada' }[r.motivo] || 'Operación finalizada';
            mostrarToast(msg, r.guardado || r.motivo === 'YA_EXISTE_SNAPSHOT_VALIDO_DEL_DIA' ? 'success' : 'error', 5000);
            if (r.guardado) generar();
        } catch (e) { mostrarToast(e.message || 'No se pudo actualizar colleras', 'error'); }
        finally { b.disabled = false; b.textContent = t; }
    }

    async function imprimir() {
        if (!DATOS) return;
        Chart.defaults.animation = false;
        document.documentElement.style.setProperty('--escala', '1');
        CHARTS.forEach(c => { c.options.animation = false; c.resize(); c.update('none'); });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        window.print();
    }
    window.addEventListener('beforeprint', () => { document.documentElement.style.setProperty('--escala', '1'); CHARTS.forEach(c => c.resize()); });
    window.addEventListener('afterprint', () => { ajustarEscala(); CHARTS.forEach(c => c.resize()); });
    window.addEventListener('resize', ajustarEscala);

    function iniciar() {
        const u = api.getUsuario();
        $('nombre-admin').textContent = (u && u.nombre) || '';
        if (u && !u.rol_evaluacion) $('ig-btn-colleras').style.display = '';   // solo administrador pleno (el backend también lo exige)
        rapido('finde');
    }
    document.addEventListener('DOMContentLoaded', iniciar);
    return { rapido, generar, actualizarColleras, imprimir, _datos: () => DATOS };
})();
window.IGP = IGP;
